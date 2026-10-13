import { createReadStream, createWriteStream } from 'node:fs'
import { PassThrough, Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import tarStream from 'tar-stream'
import yauzl from 'yauzl'
import yazl from 'yazl'
import type { ArchiveInfo, ArchiveLimits } from '../server/inspect/types'
import { SandboxError, type Progress } from './errors'

export type ArchiveFormat = 'zip' | 'tar' | 'tgz'

interface Entry {
  name: string
  type: 'file' | 'directory'
  size: number
  mode: number
  mtime: Date
  /** Present for files; must be fully consumed before the next entry is requested. */
  open?: () => Promise<Readable>
}

const S_IFMT = 0o170000
const S_IFLNK = 0o120000
const S_IFDIR = 0o040000

/**
 * Normalises an entry path. Returns null for paths that would escape the
 * archive root (absolute, drive letters, `..` segments).
 */
export function safeEntryName(raw: string): string | null {
  const name = raw.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null
  const parts = name.split('/')
  if (parts.some((p) => p === '..')) return null
  return parts.filter((p) => p !== '' && p !== '.').join('/') + (name.endsWith('/') ? '/' : '')
}

function limitError(limits: ArchiveLimits, what: 'entries' | 'bytes'): SandboxError {
  return what === 'entries'
    ? new SandboxError('ARCHIVE_LIMIT', `This archive has more than ${limits.maxEntries} entries.`)
    : new SandboxError('ARCHIVE_LIMIT', `This archive expands to more than ${Math.round(limits.maxUnpackedBytes / 1024 / 1024)} MB.`)
}

// ---------------------------------------------------------------------------
// Readers: each yields entries one at a time.

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true }, (err, zip) =>
      err || !zip ? reject(err) : resolve(zip),
    ),
  )
}

function zipError(err: unknown): SandboxError {
  const msg = err instanceof Error ? err.message : String(err)
  if (/relative path|absolute path|invalid characters/i.test(msg)) {
    return new SandboxError('UNSAFE_ARCHIVE', 'This archive contains entries with unsafe paths (absolute or "..").')
  }
  return new SandboxError('CORRUPT_MEDIA', 'This archive could not be read. It may be damaged or truncated.')
}

async function* zipEntries(file: string): AsyncGenerator<Entry & { encrypted: boolean; special: boolean }> {
  let zip: yauzl.ZipFile
  try {
    zip = await openZip(file)
  } catch (err) {
    throw zipError(err)
  }
  const next = () =>
    new Promise<yauzl.Entry | null>((resolve, reject) => {
      const onEntry = (e: yauzl.Entry) => cleanup(() => resolve(e))
      const onEnd = () => cleanup(() => resolve(null))
      const onError = (err: unknown) => cleanup(() => reject(zipError(err)))
      const cleanup = (fn: () => void) => {
        zip.off('entry', onEntry).off('end', onEnd).off('error', onError)
        fn()
      }
      zip.on('entry', onEntry).on('end', onEnd).on('error', onError)
      zip.readEntry()
    })
  try {
    for (let e = await next(); e; e = await next()) {
      const entry = e
      const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
      const isDir = entry.fileName.endsWith('/') || (unixMode & S_IFMT) === S_IFDIR
      yield {
        name: entry.fileName,
        type: isDir ? 'directory' : 'file',
        size: entry.uncompressedSize,
        mode: unixMode & 0o777 || (isDir ? 0o755 : 0o644),
        mtime: entry.getLastModDate(),
        encrypted: entry.isEncrypted(),
        special: (unixMode & S_IFMT) === S_IFLNK,
        open: isDir
          ? undefined
          : () =>
              new Promise<Readable>((resolve, reject) =>
                zip.openReadStream(entry, (err, stream) => (err || !stream ? reject(zipError(err)) : resolve(stream))),
              ),
      }
    }
  } finally {
    zip.close()
  }
}

async function* tarEntries(file: string, gzip: boolean): AsyncGenerator<Entry & { special: boolean }> {
  const extract = tarStream.extract()
  const source = createReadStream(file)
  const feeding = (gzip ? pipeline(source, createGunzip(), extract) : pipeline(source, extract)).catch((err) => {
    extract.destroy(err)
  })
  let completed = false
  try {
    for await (const entry of extract) {
      const h = entry.header
      const type = h.type === 'directory' ? 'directory' : h.type === 'file' || h.type === 'contiguous-file' ? 'file' : null
      if (!type) {
        entry.resume()
        yield { name: h.name, type: 'file', size: 0, mode: 0, mtime: new Date(0), special: true }
        continue
      }
      let consumed = false
      yield {
        name: h.name,
        type,
        size: h.size ?? 0,
        mode: (h.mode ?? (type === 'directory' ? 0o755 : 0o644)) & 0o777,
        mtime: h.mtime ?? new Date(0),
        special: false,
        open: type === 'file' ? async () => ((consumed = true), entry as unknown as Readable) : undefined,
      }
      if (!consumed) entry.resume()
    }
    completed = true
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (/header|unexpected end|incorrect header|invalid/i.test(msg)) {
      throw new SandboxError('CORRUPT_MEDIA', 'This archive could not be read. It may be damaged or not a TAR archive.')
    }
    throw err
  } finally {
    // Stopped early (limit hit or consumer error): tear the pipeline down instead of waiting on it.
    if (!completed) {
      extract.destroy()
      source.destroy()
    }
    await feeding
  }
}

function entriesOf(file: string, format: ArchiveFormat) {
  return format === 'zip' ? zipEntries(file) : tarEntries(file, format === 'tgz')
}

// ---------------------------------------------------------------------------

/** Lists an archive without extracting it, enforcing entry and size limits. */
export async function inspectArchive(file: string, family: 'zip' | 'gzip' | 'tar', limits: ArchiveLimits): Promise<ArchiveInfo> {
  const info: ArchiveInfo = {
    format: family === 'zip' ? 'zip' : family === 'tar' ? 'tar' : 'tgz',
    documentType: null,
    files: 0,
    directories: 0,
    skipped: 0,
    unpackedBytes: 0,
    encrypted: false,
    unsafePaths: false,
  }
  const names = new Set<string>()
  try {
    for await (const e of entriesOf(file, info.format!)) {
      if (info.files + info.directories + info.skipped >= limits.maxEntries) throw limitError(limits, 'entries')
      if (names.size < 64) names.add(e.name)
      if ('encrypted' in e && e.encrypted) info.encrypted = true
      if (safeEntryName(e.name) === null) info.unsafePaths = true
      if (e.special) {
        info.skipped++
        continue
      }
      if (e.type === 'directory') info.directories++
      else {
        info.files++
        info.unpackedBytes += e.size
        if (info.unpackedBytes > limits.maxUnpackedBytes) throw limitError(limits, 'bytes')
      }
    }
  } catch (err) {
    if (err instanceof SandboxError && err.code === 'UNSAFE_ARCHIVE') return { ...info, unsafePaths: true }
    if (family === 'gzip' && err instanceof SandboxError && err.code === 'CORRUPT_MEDIA') {
      // A gzip stream that does not contain a tar archive.
      return { ...info, format: null }
    }
    throw err
  }
  if (family === 'zip') {
    if (names.has('[Content_Types].xml')) info.documentType = 'office'
    else if (names.has('mimetype') && names.has('META-INF/container.xml')) info.documentType = 'epub'
    if (info.documentType) info.format = null
  }
  return info
}

function byteCounter(limit: number, state: { total: number }, limits: ArchiveLimits) {
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      state.total += chunk.length
      if (state.total > limit) cb(limitError(limits, 'bytes'))
      else cb(null, chunk)
    },
  })
}

export interface ArchiveResult {
  files: number
  directories: number
  skipped: number
  unpackedBytes: number
}

/**
 * Streams entries from one archive format into another without touching the
 * filesystem. Special entries are skipped; unsafe paths abort the conversion.
 */
export async function convertArchive(
  a: { input: string; inputFormat: ArchiveFormat; output: string; outputFormat: ArchiveFormat; limits: ArchiveLimits; expectedBytes: number },
  onProgress: Progress,
): Promise<ArchiveResult> {
  const result: ArchiveResult = { files: 0, directories: 0, skipped: 0, unpackedBytes: 0 }
  const counter = { total: 0 }

  let addDir: (name: string, e: Entry) => Promise<void>
  let addFile: (name: string, e: Entry, stream: Readable) => Promise<void>
  let finish: () => Promise<void>

  if (a.outputFormat === 'zip') {
    const zip = new yazl.ZipFile()
    const written = pipeline(zip.outputStream, createWriteStream(a.output))
    addDir = async (name, e) => zip.addEmptyDirectory(name, { mtime: e.mtime, mode: e.mode | 0o40000 })
    addFile = (name, e, stream) =>
      new Promise((resolve, reject) => {
        const pass = new PassThrough()
        pass.on('end', () => resolve())
        stream.on('error', reject)
        pass.on('error', reject)
        zip.addReadStream(pass, name, { mtime: e.mtime, mode: e.mode | 0o100000 })
        stream.pipe(byteCounter(a.limits.maxUnpackedBytes, counter, a.limits)).on('error', reject).pipe(pass)
      })
    finish = async () => {
      zip.end()
      await written
    }
  } else {
    const pack = tarStream.pack()
    const written = a.outputFormat === 'tgz' ? pipeline(pack, createGzip({ level: 6 }), createWriteStream(a.output)) : pipeline(pack, createWriteStream(a.output))
    addDir = (name, e) =>
      new Promise((resolve, reject) => pack.entry({ name, type: 'directory', mode: e.mode, mtime: e.mtime }, (err) => (err ? reject(err) : resolve())))
    addFile = async (name, e, stream) => {
      const sink = pack.entry({ name, type: 'file', size: e.size, mode: e.mode, mtime: e.mtime })
      await pipeline(stream, byteCounter(a.limits.maxUnpackedBytes, counter, a.limits), sink)
    }
    finish = async () => {
      pack.finalize()
      await written
    }
  }

  let entries = 0
  for await (const e of entriesOf(a.input, a.inputFormat)) {
    if (++entries > a.limits.maxEntries) throw limitError(a.limits, 'entries')
    if ('encrypted' in e && e.encrypted) throw new SandboxError('PROTECTED_FILE', 'This archive is encrypted. ANYFORM does not remove encryption.')
    const name = safeEntryName(e.name)
    if (name === null) throw new SandboxError('UNSAFE_ARCHIVE', 'This archive contains entries with unsafe paths (absolute or "..").')
    if (e.special || !name.replace(/\/$/, '')) {
      result.skipped++
      continue
    }
    if (e.type === 'directory') {
      await addDir(name.endsWith('/') ? name : `${name}/`, e)
      result.directories++
    } else {
      await addFile(name.replace(/\/$/, ''), e, await e.open!())
      result.files++
      result.unpackedBytes += e.size
    }
    if (a.expectedBytes > 0) onProgress(Math.min(1, counter.total / a.expectedBytes))
  }
  await finish()
  return result
}

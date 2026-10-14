import { createReadStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { displayFilename, outputFilename } from '@/lib/filename'
import { FORMATS, formatFromFilename, type FormatId } from '@/lib/formats'
import { assertUploadTransition, isActiveJob, type UploadStatus } from '@/lib/states'
import { describePlan, type OutputChoice } from '../conversions/registry'
import { getConfig } from '../config'
import { AppError, isAppError } from '../errors'
import { isId, newId } from '../ids'
import { logger } from '../logger'
import { metrics } from '../metrics'
import { inspectFile, unsupportedReason, type FileInfo } from '../inspect'
import { sniffFile } from '../media/sniff'
import { fetchRemote, parseImportUrl } from '../imports/fetch'
import { classifyMediaSite, parseSpotifyTrackPage, spotifySearchQuery, unwrapImageSearchLink, type MediaSite } from '../imports/media-sites'
import { downloadWithYtDlp } from '../imports/ytdlp'
import { findPageMedia, isHtmlContentType, MAX_PAGE_BYTES } from '../imports/page'
import { serveObject } from './serve'
import type { Runtime } from '../runtime'
import { storageKey } from '../storage'
import type { UploadRecord } from '../store/types'

export interface UploadView {
  id: string
  filename: string
  sizeBytes: number
  /** Download of the original file (validated uploads only). */
  originalUrl: string | null
  /** Where the file came from; for links only the host is kept. */
  origin: NonNullable<UploadRecord['origin']>
  status: UploadStatus
  /** Format implied by the filename extension (informational only). */
  extensionFormat: FormatId | null
  createdAt: number
  expiresAt: number
  info: FileInfo | null
  error: { code: string; message: string } | null
  outputs: OutputChoice[]
  warnings: string[]
}

type RT = Pick<Runtime, 'store' | 'storage' | 'registry'>

export async function sessionUsageBytes(rt: Pick<Runtime, 'store'>, sessionId: string): Promise<number> {
  const uploads = (await rt.store.listUploads()).filter((u) => u.sessionId === sessionId && u.status !== 'expired' && u.status !== 'rejected')
  const jobs = (await rt.store.listJobsForSession(sessionId)).filter((j) => j.status === 'completed' && j.output)
  return uploads.reduce((n, u) => n + u.sizeBytes, 0) + jobs.reduce((n, j) => n + (j.output?.sizeBytes ?? 0), 0)
}

function decodeFilenameHeader(value: string | null): string {
  if (!value) return 'upload'
  try {
    return displayFilename(decodeURIComponent(value))
  } catch {
    return displayFilename(value)
  }
}

/** Checks size, quota and free disk before any bytes are accepted. Returns the byte budget. */
async function admit(rt: RT, sessionId: string, declared: number | null): Promise<{ maxBytes: number; quotaLimited: boolean }> {
  const cfg = getConfig()
  if (declared !== null && declared > cfg.maxUploadBytes) {
    throw new AppError('UPLOAD_TOO_LARGE', `Files can be at most ${Math.round(cfg.maxUploadBytes / 1024 / 1024)} MB.`, {
      details: { maxBytes: cfg.maxUploadBytes },
    })
  }
  const remainingQuota = cfg.sessionQuotaBytes - (await sessionUsageBytes(rt, sessionId))
  if (remainingQuota <= 0 || (declared !== null && declared > remainingQuota)) {
    throw new AppError('QUOTA_EXCEEDED', 'You have reached your storage limit. Delete earlier conversions or wait for them to expire.')
  }
  const reserve = declared ?? cfg.maxUploadBytes
  if ((await rt.storage.freeBytes()) - reserve < cfg.minFreeDiskBytes) {
    throw new AppError('INSUFFICIENT_STORAGE', 'The server is temporarily low on storage. Please try again later.')
  }
  return { maxBytes: Math.min(cfg.maxUploadBytes, remainingQuota), quotaLimited: remainingQuota < cfg.maxUploadBytes }
}

interface PersistMeta {
  filename: string
  declared: number | null
  budget: { maxBytes: number; quotaLimited: boolean }
  origin: NonNullable<UploadRecord['origin']>
  mapStreamError?: (err: unknown) => AppError
}

/**
 * Streams bytes into private storage under a byte budget, sniffs the content
 * and records the upload. Shared by direct uploads and URL imports.
 */
async function persist(rt: RT, sessionId: string, source: Readable, meta: PersistMeta): Promise<UploadView> {
  const cfg = getConfig()
  const id = newId('upl')
  const key = storageKey('uploads', id)
  let sizeBytes: number
  try {
    ;({ sizeBytes } = await rt.storage.write(key, source, { maxBytes: meta.budget.maxBytes }))
  } catch (err) {
    await rt.storage.delete(key).catch(() => undefined)
    metrics.inc('upload_failures_total', { reason: isAppError(err) ? err.code : 'stream_error' })
    if (isAppError(err)) {
      if (err.code === 'UPLOAD_TOO_LARGE' && meta.budget.quotaLimited) {
        throw new AppError('QUOTA_EXCEEDED', 'This file would exceed your storage limit.')
      }
      throw err
    }
    if ((err as NodeJS.ErrnoException).code === 'ENOSPC') {
      throw new AppError('INSUFFICIENT_STORAGE', 'The server ran out of storage while receiving the file.')
    }
    throw meta.mapStreamError?.(err) ?? new AppError('UPLOAD_INCOMPLETE', 'The upload was interrupted before it finished. Please try again.')
  }

  const reject = async (err: AppError) => {
    await rt.storage.delete(key)
    metrics.inc('upload_failures_total', { reason: err.code })
    throw err
  }
  if (sizeBytes === 0) await reject(new AppError('UPLOAD_EMPTY', 'The file is empty.'))
  if (meta.declared !== null && sizeBytes !== meta.declared) {
    await reject(new AppError('UPLOAD_INCOMPLETE', 'The transfer was incomplete. Please try again.'))
  }
  // Content is inspected immediately; files of no recognised type are not kept.
  if (!(await sniffFile(await rt.storage.localPath(key)))) {
    await reject(
      new AppError(
        'UNSUPPORTED_FORMAT',
        meta.origin.kind === 'url'
          ? 'The link did not lead to a supported file. It may be a web page rather than a direct link to a file.'
          : 'This file type is not supported. Its contents do not match any format ANYFORM can read.',
      ),
    )
  }

  const now = Date.now()
  const rec: UploadRecord = {
    id,
    sessionId,
    originalName: displayFilename(meta.filename),
    sizeBytes,
    storageKey: key,
    origin: meta.origin,
    status: 'uploaded',
    info: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + cfg.uploadTtlMs,
  }
  await rt.store.createUpload(rec)
  metrics.inc('uploads_total', { origin: meta.origin.kind })
  metrics.observe('upload_bytes', sizeBytes)
  return uploadView(rt, rec)
}

/**
 * Streams a raw request body (the file bytes) into private storage while
 * enforcing size, quota and free-disk limits. The body is never buffered whole.
 */
export async function receiveUpload(rt: RT, sessionId: string, req: Request): Promise<UploadView> {
  const lengthHeader = req.headers.get('content-length')
  const declared = lengthHeader !== null ? Number(lengthHeader) : null
  if (declared !== null && (!Number.isFinite(declared) || declared < 0)) {
    throw new AppError('INVALID_REQUEST', 'Invalid Content-Length header.')
  }
  if (declared === 0 || !req.body) throw new AppError('UPLOAD_EMPTY', 'The selected file is empty.')
  const budget = await admit(rt, sessionId, declared)
  const source = Readable.fromWeb(req.body as unknown as NodeWebReadableStream<Uint8Array>)
  return persist(rt, sessionId, source, {
    filename: decodeFilenameHeader(req.headers.get('x-file-name')),
    declared,
    budget,
    origin: { kind: 'file' },
  })
}

/**
 * Downloads a file from a user-supplied link and stores it exactly like an
 * upload. Direct files and web pages go through the SSRF-protected fetcher
 * (imports/fetch.ts); YouTube and Spotify links go through yt-dlp
 * (imports/media-sites.ts).
 */
export async function importFromUrl(rt: RT, sessionId: string, rawUrl: string): Promise<UploadView> {
  const cfg = getConfig()
  if (!cfg.importEnabled) throw new AppError('IMPORT_DISABLED', 'Importing from links is disabled on this server.')
  // Quota and disk are checked before contacting the remote server.
  const budget = await admit(rt, sessionId, null)
  const fetchOpts = {
    maxBytes: budget.maxBytes,
    timeoutMs: cfg.importTimeoutMs,
    maxRedirects: cfg.importMaxRedirects,
    allowPrivate: cfg.importAllowPrivateNetworks,
    allowedHosts: cfg.importAllowedHosts,
  }
  let url = parseImportUrl(rawUrl, fetchOpts)
  // Image-search result links wrap the real image: go straight to it.
  const wrapped = unwrapImageSearchLink(url)
  if (wrapped) url = parseImportUrl(wrapped, fetchOpts)

  const site = classifyMediaSite(url)
  if (site) return importFromMediaSite(rt, sessionId, site, budget, fetchOpts)

  let remote = await fetchRemote(url.href, fetchOpts)
  let page: string | undefined
  if (isHtmlContentType(remote.contentType)) {
    // A page rather than a file: download the media the page itself declares.
    page = remote.host
    const found = await mediaFromPage(remote, fetchOpts)
    if ('site' in found) return importFromMediaSite(rt, sessionId, found.site, budget, fetchOpts, page)
    remote = found.remote
  }
  try {
    if (remote.declaredLength !== null) await admit(rt, sessionId, remote.declaredLength)
    return await persist(rt, sessionId, remote.body, {
      filename: remote.filename,
      declared: remote.declaredLength,
      budget,
      // Only the host is kept: full URLs can carry access tokens.
      origin: page ? { kind: 'url', host: remote.host, page } : { kind: 'url', host: remote.host },
      mapStreamError: () =>
        remote.timedOut()
          ? new AppError('IMPORT_TIMEOUT', 'The download took too long and was stopped.')
          : new AppError('REMOTE_FETCH_FAILED', 'The download was interrupted. Please try again.'),
    })
  } finally {
    remote.finish()
    remote.body.destroy()
  }
}

/**
 * YouTube video → MP4 (YouTube Music → MP3); Spotify track → MP3 of the same
 * recording found on YouTube. Spotify's DRM-protected stream is never used:
 * only the public track page is read, for the title and artist.
 */
async function importFromMediaSite(
  rt: RT,
  sessionId: string,
  site: MediaSite,
  budget: { maxBytes: number; quotaLimited: boolean },
  fetchOpts: Parameters<typeof fetchRemote>[1],
  foundOnPage?: string,
): Promise<UploadView> {
  const cfg = getConfig()
  if (!cfg.mediaSitesEnabled) throw new AppError('IMPORT_DISABLED', 'YouTube and Spotify links are disabled on this server.')

  let target: string
  let mode: 'video' | 'audio'
  let name: string | null = null
  let page = foundOnPage
  if (site.kind === 'youtube') {
    target = site.canonical
    mode = site.audioOnly ? 'audio' : 'video'
  } else {
    const track = parseSpotifyTrackPage(await readHtml(await fetchRemote(site.pageUrl, { ...fetchOpts, maxBytes: MAX_PAGE_BYTES })))
    if (!track) throw new AppError('REMOTE_FETCH_FAILED', 'The Spotify track details could not be read.')
    target = spotifySearchQuery(track)
    mode = 'audio'
    name = track.artist ? `${track.artist} - ${track.title}` : track.title
    page = 'open.spotify.com'
  }

  const outDir = path.join(cfg.scratchDir, `import-${newId('upl')}`)
  await mkdir(outDir, { recursive: true, mode: 0o700 })
  try {
    const result = await downloadWithYtDlp({
      target,
      mode,
      outDir,
      maxBytes: budget.maxBytes,
      maxDurationSec: mode === 'video' ? cfg.maxVideoDurationSeconds : cfg.maxDurationSeconds,
    })
    const size = (await stat(result.filePath)).size
    await admit(rt, sessionId, size)
    return await persist(rt, sessionId, createReadStream(result.filePath), {
      filename: `${name ?? result.title}${path.extname(result.filePath)}`,
      declared: size,
      budget,
      origin: page ? { kind: 'url', host: 'www.youtube.com', page } : { kind: 'url', host: 'www.youtube.com' },
    })
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
}

export async function getOwnedUpload(rt: Pick<Runtime, 'store'>, sessionId: string, uploadId: unknown): Promise<UploadRecord> {
  if (!isId(uploadId, 'upl')) throw new AppError('NOT_FOUND', 'Upload not found.')
  const upload = await rt.store.getUpload(uploadId)
  // Other sessions' uploads are indistinguishable from missing ones.
  if (!upload || upload.sessionId !== sessionId) throw new AppError('NOT_FOUND', 'Upload not found.')
  if (upload.status === 'expired' || upload.expiresAt <= Date.now()) {
    throw new AppError('UPLOAD_EXPIRED', 'This upload has expired. Please upload the file again.')
  }
  return upload
}

/** Valid conversion targets for an inspected upload, with the reason when there are none. */
function computeOutputs(rt: RT, info: FileInfo): { outputs: OutputChoice[]; firstError: AppError | null } {
  if (!info.format) return { outputs: [], firstError: new AppError('UNSUPPORTED_FORMAT', unsupportedReason(info)) }
  const plans = rt.registry.reachable(info.format)
  if (plans.length === 0) {
    return {
      outputs: [],
      firstError: new AppError('UNSUPPORTED_CONVERSION', `${FORMATS[info.format].label} files cannot be converted yet.`),
    }
  }
  const outputs: OutputChoice[] = []
  let firstError: AppError | null = null
  for (const plan of plans) {
    try {
      plan.steps[0]!.validateInput(info)
      outputs.push(describePlan(plan, info))
    } catch (err) {
      if (!isAppError(err)) throw err
      firstError ??= err
    }
  }
  return { outputs, firstError }
}

export function uploadView(rt: RT, u: UploadRecord): UploadView {
  const extensionFormat = formatFromFilename(u.originalName)
  const warnings: string[] = []
  const info = u.info
  if (info?.format && extensionFormat && extensionFormat !== info.format && !sameFamily(extensionFormat, info.format)) {
    warnings.push(`The file is named .${FORMATS[extensionFormat].extension} but its contents are ${FORMATS[info.format].label}. ANYFORM uses the actual contents.`)
  }
  if (u.status === 'validated' && info?.kind === 'av') {
    const skipped = info.media.audioStreams.filter((s) => s.decodable === false).length
    if (skipped > 0) warnings.push(`${skipped} audio track${skipped > 1 ? 's' : ''} could not be decoded and ${skipped > 1 ? 'are' : 'is'} not offered.`)
  }
  if (u.status === 'validated' && info?.kind === 'archive' && info.archive.skipped > 0) {
    warnings.push(`${info.archive.skipped} special entr${info.archive.skipped > 1 ? 'ies' : 'y'} (symbolic links, devices) will be skipped.`)
  }
  if (u.status === 'validated' && info?.kind === 'pdf' && (!info.pdf.permissions.copy || !info.pdf.permissions.print)) {
    warnings.push('The author of this PDF restricted some uses; only permitted conversions are offered.')
  }
  return {
    id: u.id,
    filename: u.originalName,
    sizeBytes: u.sizeBytes,
    origin: u.origin ?? { kind: 'file' },
    originalUrl: u.status === 'validated' && u.info?.format ? `/api/v1/uploads/${u.id}/download` : null,
    status: u.status,
    extensionFormat,
    createdAt: u.createdAt,
    expiresAt: u.expiresAt,
    info: u.info,
    error: u.error,
    outputs: u.status === 'validated' && u.info ? computeOutputs(rt, u.info).outputs : [],
    warnings,
  }
}

/** M4A inside an .mp4 name (and similar) is the same container, not a mismatch worth flagging. */
function sameFamily(a: FormatId, b: FormatId): boolean {
  const iso: FormatId[] = ['mp4', 'm4a', 'mov']
  return iso.includes(a) && iso.includes(b)
}

/**
 * Inspects an upload's real contents and determines which conversions apply.
 * Results are cached on the upload record; repeated calls are cheap.
 */
export async function validateUpload(rt: RT, sessionId: string, uploadId: unknown): Promise<UploadView> {
  const upload = await getOwnedUpload(rt, sessionId, uploadId)
  if (upload.status === 'validated' || upload.status === 'rejected') return uploadView(rt, upload)

  await rt.store.updateUpload(upload.id, (u) => {
    assertUploadTransition(u.status, 'validating')
    return { ...u, status: 'validating', updatedAt: Date.now() }
  })
  const log = logger.child({ uploadId: upload.id })
  const path = await rt.storage.localPath(upload.storageKey)

  let info: FileInfo | null = null
  let failure: AppError | null = null
  try {
    info = await inspectFile(path)
    const { outputs, firstError } = computeOutputs(rt, info)
    failure = outputs.length === 0 ? firstError : null
  } catch (err) {
    if (!isAppError(err) || err.code === 'SERVICE_UNAVAILABLE') {
      // Infrastructure problem, not the file's fault: allow a retry.
      await rt.store.updateUpload(upload.id, (u) => ({ ...u, status: 'uploaded', updatedAt: Date.now() }))
      throw err
    }
    failure = err
  }

  const now = Date.now()
  const updated = await rt.store.updateUpload(upload.id, (u) => {
    const status: UploadStatus = failure ? 'rejected' : 'validated'
    assertUploadTransition(u.status, status)
    return {
      ...u,
      status,
      info,
      error: failure ? { code: failure.code, message: failure.message } : null,
      updatedAt: now,
    }
  })
  if (!updated) throw new AppError('NOT_FOUND', 'Upload not found.')
  if (failure) {
    // Rejected files are useless; remove them right away.
    await rt.storage.delete(upload.storageKey)
    metrics.inc('validation_failures_total', { code: failure.code })
    log.info('upload rejected', { code: failure.code, family: info?.family })
  } else {
    metrics.inc('validations_total', { format: info?.format ?? 'unknown' })
  }
  return uploadView(rt, updated)
}

/** Reads a page body as text, bounded to MAX_PAGE_BYTES. */
async function readHtml(pageFile: Awaited<ReturnType<typeof fetchRemote>>): Promise<string> {
  let html = ''
  try {
    for await (const chunk of pageFile.body) {
      html += (chunk as Buffer).toString('utf8')
      if (html.length >= MAX_PAGE_BYTES) break
    }
  } catch {
    throw new AppError('REMOTE_FETCH_FAILED', 'The page could not be read completely.')
  } finally {
    pageFile.finish()
    pageFile.body.destroy()
  }
  return html
}

/**
 * Picks the media a page declares and fetches it under the same SSRF rules,
 * or hands back a YouTube/Spotify link for the media-site path.
 */
async function mediaFromPage(
  pageFile: Awaited<ReturnType<typeof fetchRemote>>,
  opts: Parameters<typeof fetchRemote>[1],
): Promise<{ remote: Awaited<ReturnType<typeof fetchRemote>> } | { site: MediaSite }> {
  const candidates = findPageMedia(await readHtml(pageFile), pageFile.url).slice(0, 4)
  if (candidates.length === 0) {
    throw new AppError('UNSUPPORTED_FORMAT', "This page doesn't contain a downloadable image, video or audio file. Paste a direct link to the file instead.")
  }
  let lastError: unknown = null
  for (const candidate of candidates) {
    try {
      // An embedded YouTube video (e.g. og:video) is downloaded through yt-dlp.
      const site = classifyMediaSite(candidate.url)
      if (site) return { site }
      const media = await fetchRemote(candidate.url.href, opts)
      if (isHtmlContentType(media.contentType)) {
        // Never follow page → page chains.
        media.finish()
        media.body.destroy()
        continue
      }
      return { remote: media }
    } catch (err) {
      // e.g. the page points at a streaming service or a private address: try the next candidate.
      lastError = err
    }
  }
  if (isAppError(lastError) && (lastError.code === 'UNSUPPORTED_SOURCE' || lastError.code === 'URL_NOT_ALLOWED')) throw lastError
  throw new AppError('UNSUPPORTED_FORMAT', "The media on this page couldn't be downloaded. It may be streamed or protected; try a direct link to the file.")
}

/**
 * Serves the original file "as is". Only validated uploads qualify, so the
 * bytes have passed content inspection and the MIME type comes from what the
 * file really is, never from the remote server or the browser.
 */
export async function downloadOriginal(rt: Pick<Runtime, 'store' | 'storage'>, sessionId: string, uploadId: unknown, req: Request): Promise<Response> {
  const upload = await getOwnedUpload(rt, sessionId, uploadId)
  if (upload.status !== 'validated' || !upload.info?.format) {
    throw new AppError('UPLOAD_NOT_VALIDATED', 'Only files that passed inspection can be downloaded.')
  }
  const format = FORMATS[upload.info.format]
  const served = await serveObject(rt.storage, upload.storageKey, { mime: format.mime, filename: outputFilename(upload.originalName, format.extension) }, req)
  if (!served) throw new AppError('UPLOAD_EXPIRED', 'This file is no longer available. Please import it again.')
  return served
}

/** Deletes an upload's file when no live job still needs it. */
export async function releaseUpload(rt: Pick<Runtime, 'store' | 'storage'>, uploadId: string): Promise<void> {
  const others = (await rt.store.listJobs()).filter((j) => j.uploadId === uploadId && (isActiveJob(j.status) || j.status === 'completed'))
  if (others.length > 0) return
  const upload = await rt.store.getUpload(uploadId)
  if (!upload) return
  await rt.storage.delete(upload.storageKey)
  await rt.store.updateUpload(uploadId, (u) => (u.status === 'expired' ? u : { ...u, status: 'expired', updatedAt: Date.now() }))
}

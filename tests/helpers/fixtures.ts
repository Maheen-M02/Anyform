import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import sharp from 'sharp'
import tarStream from 'tar-stream'
import yazl from 'yazl'

/**
 * Synthetic fixtures generated locally (FFmpeg lavfi sources, sharp, pdf-lib,
 * yazl, tar-stream), so tests never depend on copyrighted samples or network
 * access. Generated once per machine; bump the version when recipes change.
 */
export const FIXTURE_DIR = path.join(os.tmpdir(), 'anyform-fixtures-v2')

const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg'
const video = (size = '160x120') => ['-f', 'lavfi', '-i', `testsrc=size=${size}:rate=15`]
const sine = (freq: number, rate = 48000) => ['-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=${rate}`]
const h264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']

const AV_RECIPES: Record<string, string[]> = {
  // 3 s H.264 video + stereo AAC.
  'video-audio.mp4': [...video(), ...sine(440), '-t', '3', ...h264, '-c:a', 'aac', '-ac', '2', '-shortest'],
  'audio-only.mp4': [...sine(440, 44100), '-t', '2', '-c:a', 'aac'],
  'audio.m4a': [...sine(330, 44100), '-t', '2', '-c:a', 'aac', '-f', 'ipod'],
  'video-only.mp4': [...video(), '-t', '2', ...h264],
  'multi-audio.mp4': [
    ...video(), ...sine(440), ...sine(880), '-t', '3',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', ...h264, '-c:a', 'aac',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=fra', '-shortest',
  ],
  'offset-audio.mp4': [...video(), '-itsoffset', '1', ...sine(440), '-t', '3', '-map', '0:v', '-map', '1:a', ...h264, '-c:a', 'aac'],
  'surround.mp4': [...sine(440), '-t', '2', '-af', 'pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0', '-c:a', 'aac'],
  'mono-22k.wav': [...sine(440, 22050), '-t', '2', '-c:a', 'pcm_s16le'],
  'stereo-96k.wav': [...sine(440, 96000), '-t', '2', '-ac', '2', '-c:a', 'pcm_s24le'],
  'faststart.mp4': [...video(), ...sine(440), '-t', '6', ...h264, '-c:a', 'aac', '-movflags', '+faststart', '-shortest'],
  'long.wav': [...sine(440, 48000), '-t', '20', '-c:a', 'pcm_s16le'],
  // New containers
  'clip.mov': [...video(), ...sine(440), '-t', '2', ...h264, '-c:a', 'aac', '-shortest', '-f', 'mov'],
  'clip.mkv': [...video(), ...sine(440), '-t', '2', ...h264, '-c:a', 'libvorbis', '-shortest'],
  'clip.webm': [...video(), ...sine(440), '-t', '2', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest'],
  'clip.avi': [...video(), ...sine(440), '-t', '2', '-c:v', 'mpeg4', '-c:a', 'libmp3lame', '-shortest'],
  'tone.flac': [...sine(523, 44100), '-t', '2', '-c:a', 'flac'],
  'tone.ogg': [...sine(523, 44100), '-t', '2', '-c:a', 'libvorbis'],
  'tone.mp3': [...sine(523, 44100), '-t', '2', '-c:a', 'libmp3lame', '-b:a', '128k'],
  // Animated GIF (10 frames) for animation-preserving conversions.
  'animated.gif': [...video('80x60'), '-frames:v', '10'],
  // Phone-style location and title tags, for the hidden-data scan and clean copies.
  'located.mp4': [...video(), ...sine(440), '-t', '2', ...h264, '-c:a', 'aac', '-shortest', '-metadata', 'location=+48.8584+002.2945/', '-metadata', 'title=Holiday'],
}

export function fixture(name: string): string {
  return path.join(FIXTURE_DIR, name)
}

async function zipOf(file: string, entries: [string, Buffer | null][]) {
  const zip = new yazl.ZipFile()
  for (const [name, data] of entries) {
    if (data === null) zip.addEmptyDirectory(name)
    else zip.addBuffer(data, name)
  }
  zip.end()
  await pipeline(zip.outputStream, createWriteStream(file))
}

async function tarOf(file: string, gzip: boolean, entries: { name: string; data?: Buffer; type?: 'file' | 'directory' | 'symlink'; linkname?: string }[]) {
  const pack = tarStream.pack()
  const done = gzip ? pipeline(pack, createGzip(), createWriteStream(file)) : pipeline(pack, createWriteStream(file))
  for (const e of entries) {
    if (e.type === 'directory') pack.entry({ name: e.name, type: 'directory' })
    else if (e.type === 'symlink') pack.entry({ name: e.name, type: 'symlink', linkname: e.linkname })
    else pack.entry({ name: e.name, size: e.data!.length }, e.data!)
  }
  pack.finalize()
  await done
}

const ARCHIVE_CONTENT: [string, Buffer | null][] = [
  ['docs/', null],
  ['docs/readme.txt', Buffer.from('Hello from ANYFORM\n'.repeat(100))],
  ['docs/nested/data.json', Buffer.from(JSON.stringify({ ok: true, n: [1, 2, 3] }))],
  ['image.bin', Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31) % 256))],
  ['ünïcödé name.txt', Buffer.from('unicode names survive\n')],
]

let ready: Promise<void> | null = null

export function ensureFixtures(): Promise<void> {
  ready ??= generate()
  return ready
}

async function generate(): Promise<void> {
  mkdirSync(FIXTURE_DIR, { recursive: true })
  const make = async (name: string, fn: (out: string) => Promise<void> | void) => {
    const out = fixture(name)
    if (!existsSync(out)) await fn(out)
  }

  for (const [name, args] of Object.entries(AV_RECIPES)) {
    await make(name, (out) => void execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', '-y', ...args, out]))
  }
  await make('not-media.mp4', (out) => writeFileSync(out, 'This is a plain text file pretending to be an MP4.\n'.repeat(50)))
  await make('corrupt.mp4', (out) => {
    const real = readFileSync(fixture('video-audio.mp4'))
    writeFileSync(out, Buffer.concat([real.subarray(0, 32), Buffer.alloc(8192, 0x5a)]))
  })
  await make('truncated.mp4', (out) => {
    const real = readFileSync(fixture('faststart.mp4'))
    writeFileSync(out, real.subarray(0, Math.floor(real.length * 0.5)))
  })

  // --- Images ---------------------------------------------------------------
  const gradient = () =>
    sharp({ create: { width: 320, height: 200, channels: 4, background: { r: 30, g: 120, b: 220, alpha: 0.5 } } })
  await make('alpha.png', async (out) => void (await gradient().png().toFile(out)))
  // Stored landscape (300×200) but EXIF orientation 6: displays as portrait 200×300.
  await make('rotated.jpg', async (out) =>
    void (await sharp({ create: { width: 300, height: 200, channels: 3, background: '#c33' } }).jpeg().withMetadata({ orientation: 6 }).toFile(out)),
  )
  await make('photo.webp', async (out) => void (await gradient().webp().toFile(out)))
  await make('photo.avif', async (out) => void (await gradient().avif().toFile(out)))
  await make('photo.tiff', async (out) => void (await gradient().tiff().toFile(out)))
  await make('huge-header.png', async (out) => {
    // A valid PNG whose IHDR claims 30000×30000 (900 MP): must be refused before decoding.
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } }).png().toBuffer()
    png.writeUInt32BE(30000, 16)
    png.writeUInt32BE(30000, 20)
    writeFileSync(out, png)
  })

  await make('gps.jpg', async (out) =>
    void (await sharp({ create: { width: 320, height: 200, channels: 3, background: '#486' } })
      .jpeg()
      .withExif({
        IFD0: { Make: 'Canon', Model: 'EOS R5', Artist: 'Jane Doe' },
        IFD2: { BodySerialNumber: '0123456789' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '48/1 51/1 3024/100', GPSLongitudeRef: 'E', GPSLongitude: '2/1 17/1 4020/100' },
      })
      .toFile(out)),
  )
  // Random noise barely compresses, so size targets must really work for it.
  await make('noise.png', async (out) => {
    const pixels = Buffer.alloc(800 * 600 * 3)
    for (let i = 0, x = 12345; i < pixels.length; i++) pixels[i] = (x = (x * 1103515245 + 12345) & 0x7fffffff) >> 16
    await sharp(pixels, { raw: { width: 800, height: 600, channels: 3 } }).png().toFile(out)
  })

  // --- PDFs -----------------------------------------------------------------
  await make('authored.pdf', async (out) => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (let i = 1; i <= 2; i++) doc.addPage([612, 792]).drawText(`Contract draft, page ${i}`, { x: 72, y: 700, size: 18, font })
    doc.setAuthor('Jane Doe')
    doc.setCreator('Microsoft Word')
    doc.setProducer('Acrobat Distiller')
    doc.setKeywords(['confidential'])
    // A trailing second "%%EOF" is how an incrementally saved (edited) PDF ends.
    writeFileSync(out, Buffer.concat([Buffer.from(await doc.save()), Buffer.from('\n% edited\n%%EOF\n')]))
  })
  await make('text.pdf', async (out) => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (let i = 1; i <= 3; i++) {
      const page = doc.addPage([612, 792])
      page.drawText(`ANYFORM test document page ${i}`, { x: 72, y: 700, size: 18, font })
      page.drawText('The quick brown fox jumps over the lazy dog.', { x: 72, y: 660, size: 12, font })
    }
    doc.setTitle('ANYFORM fixture')
    writeFileSync(out, await doc.save())
  })
  await make('scanned.pdf', async (out) => {
    // Image-only PDF: there is no text layer to extract.
    const doc = await PDFDocument.create()
    const png = await doc.embedPng(await gradient().png().toBuffer())
    doc.addPage([320, 200]).drawImage(png, { x: 0, y: 0, width: 320, height: 200 })
    writeFileSync(out, await doc.save())
  })

  // --- Archives -------------------------------------------------------------
  await make('bundle.zip', (out) => zipOf(out, ARCHIVE_CONTENT))
  await make('bundle.tar', (out) =>
    tarOf(out, false, ARCHIVE_CONTENT.map(([name, data]) => (data === null ? { name, type: 'directory' as const } : { name, data }))),
  )
  await make('bundle.tar.gz', (out) =>
    tarOf(out, true, [
      ...ARCHIVE_CONTENT.map(([name, data]) => (data === null ? { name, type: 'directory' as const } : { name, data })),
      { name: 'docs/link-to-readme', type: 'symlink' as const, linkname: 'readme.txt' },
    ]),
  )
  await make('traversal.zip', async (out) => {
    // Written with a harmless name, then patched so the entry escapes the root.
    const tmp = `${out}.tmp`
    await zipOf(tmp, [['aa/evil.txt', Buffer.from('pwned')]])
    const buf = readFileSync(tmp)
    let idx = buf.indexOf('aa/evil.txt')
    while (idx !== -1) {
      buf.write('../evil.txt', idx, 'latin1')
      idx = buf.indexOf('aa/evil.txt', idx + 1)
    }
    writeFileSync(out, buf)
  })
  await make('encrypted.zip', async (out) => {
    const tmp = `${out}.tmp`
    await zipOf(tmp, [['secret.txt', Buffer.from('secret')]])
    const buf = readFileSync(tmp)
    // Set the "encrypted" general-purpose flag in the local and central headers.
    for (const [sig, offset] of [[Buffer.from([0x50, 0x4b, 0x03, 0x04]), 6], [Buffer.from([0x50, 0x4b, 0x01, 0x02]), 8]] as const) {
      const at = buf.indexOf(sig)
      buf[at + offset] = buf[at + offset]! | 0x01
    }
    writeFileSync(out, buf)
  })
  await make('document.docx', (out) =>
    zipOf(out, [
      ['[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>')],
      ['word/document.xml', Buffer.from('<w:document/>')],
    ]),
  )
  // 8 MB of zeros compresses to a few KB: used with a lowered unpacked-size limit.
  await make('bomb.zip', (out) => zipOf(out, [['zeros.bin', Buffer.alloc(8 * 1024 * 1024)]]))
  await make('plain.gz', async (out) => {
    const gz = createGzip()
    const done = pipeline(gz, createWriteStream(out))
    gz.end('just some gzipped text, not a tar archive\n'.repeat(20))
    await done
  })
}

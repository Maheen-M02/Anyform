import { open } from 'node:fs/promises'

/**
 * Content families recognised from magic bytes. The family decides which
 * parser is allowed to touch the file; filenames and MIME types are ignored.
 */
export type ContainerFamily =
  // Audio/video, parsed by FFmpeg
  | 'isobmff'
  | 'wav'
  | 'mp3'
  | 'flac'
  | 'ogg'
  | 'matroska'
  | 'avi'
  // Images, parsed by libvips (sharp)
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'avif'
  | 'tiff'
  // Documents and archives
  | 'pdf'
  | 'zip'
  | 'gzip'
  | 'tar'

export type FamilyKind = 'av' | 'image' | 'pdf' | 'archive'

export const FAMILY_KIND: Record<ContainerFamily, FamilyKind> = {
  isobmff: 'av',
  wav: 'av',
  mp3: 'av',
  flac: 'av',
  ogg: 'av',
  matroska: 'av',
  avi: 'av',
  png: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  tiff: 'image',
  pdf: 'pdf',
  zip: 'archive',
  gzip: 'archive',
  tar: 'archive',
}

/** ffprobe/ffmpeg demuxers allowed for each audio/video family; anything else is never parsed. */
export const DEMUXER_WHITELIST: Partial<Record<ContainerFamily, string>> = {
  isobmff: 'mov,mp4,m4a,3gp,3g2,mj2',
  wav: 'wav',
  mp3: 'mp3',
  flac: 'flac',
  ogg: 'ogg',
  matroska: 'matroska,webm',
  avi: 'avi',
}

const ISO_BOX_TYPES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide'])
const AVIF_BRANDS = new Set(['avif', 'avis'])

/** Bytes needed for every check below (tar magic sits at offset 257). */
export const SNIFF_BYTES = 512

export function sniffBytes(buf: Uint8Array): ContainerFamily | null {
  const ascii = (start: number, end: number) => Buffer.from(buf.subarray(start, end)).toString('latin1')
  const at = (i: number) => buf[i] ?? -1

  if (buf.length >= 12) {
    const riff = ascii(0, 4) === 'RIFF' || ascii(0, 4) === 'RF64'
    if (riff && ascii(8, 12) === 'WAVE') return 'wav'
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp'
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'AVI ') return 'avi'
    if (ascii(4, 8) === 'ftyp' && AVIF_BRANDS.has(ascii(8, 12))) return 'avif'
    if (ISO_BOX_TYPES.has(ascii(4, 8))) return 'isobmff'
  }
  if (buf.length >= 8 && at(0) === 0x89 && ascii(1, 4) === 'PNG' && at(4) === 0x0d && at(5) === 0x0a) return 'png'
  if (buf.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpeg'
  if (buf.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'gif'
  if (buf.length >= 4 && (ascii(0, 4) === 'II*\0' || ascii(0, 4) === 'MM\0*')) return 'tiff'
  if (buf.length >= 4 && ascii(0, 4) === 'fLaC') return 'flac'
  if (buf.length >= 4 && ascii(0, 4) === 'OggS') return 'ogg'
  if (buf.length >= 4 && at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) return 'matroska'
  if (buf.length >= 4 && ascii(0, 2) === 'PK' && ((at(2) === 3 && at(3) === 4) || (at(2) === 5 && at(3) === 6))) return 'zip'
  if (buf.length >= 3 && at(0) === 0x1f && at(1) === 0x8b && at(2) === 0x08) return 'gzip'
  if (buf.length >= 262 && ascii(257, 262) === 'ustar') return 'tar'
  // Checked after archives (which may store a PDF uncompressed near the start).
  // The header may be preceded by junk; readers accept it within the first bytes.
  if (buf.length >= 5 && ascii(0, Math.min(buf.length, SNIFF_BYTES)).includes('%PDF-')) return 'pdf'
  if (buf.length >= 3) {
    if (ascii(0, 3) === 'ID3') return 'mp3'
    // MPEG audio frame sync: 11 set bits, layer III.
    if (at(0) === 0xff && (at(1) & 0xe6) === 0xe2) return 'mp3'
  }
  return null
}

/** Matroska DocType ("webm" or "matroska") from the EBML header. */
export function matroskaDocType(buf: Uint8Array): 'webm' | 'matroska' | null {
  const head = Buffer.from(buf.subarray(0, 64)).toString('latin1')
  if (head.includes('webm')) return 'webm'
  if (head.includes('matroska')) return 'matroska'
  return null
}

export async function readHead(filePath: string, bytes = SNIFF_BYTES): Promise<Buffer> {
  const fh = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

export async function sniffFile(filePath: string): Promise<ContainerFamily | null> {
  return sniffBytes(await readHead(filePath))
}

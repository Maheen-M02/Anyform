/**
 * Catalogue of file formats ANYFORM can identify. A format being listed here
 * does not mean it can be converted: only registered adapters define that.
 */
export type FormatKind = 'video' | 'audio' | 'image' | 'document' | 'archive'

interface FormatDef {
  id: string
  label: string
  kind: FormatKind
  /** Canonical extension (without dot) used for output filenames. */
  extension: string
  /** Other extensions recognised when guessing from a filename. */
  aliases?: readonly string[]
  mime: string
  description: string
}

export const FORMATS = {
  mp4: { id: 'mp4', label: 'MP4', kind: 'video', extension: 'mp4', aliases: ['m4v'], mime: 'video/mp4', description: 'MPEG-4 video (H.264/AAC)' },
  mov: { id: 'mov', label: 'MOV', kind: 'video', extension: 'mov', mime: 'video/quicktime', description: 'QuickTime movie' },
  mkv: { id: 'mkv', label: 'MKV', kind: 'video', extension: 'mkv', mime: 'video/x-matroska', description: 'Matroska video' },
  webm: { id: 'webm', label: 'WebM', kind: 'video', extension: 'webm', mime: 'video/webm', description: 'WebM video (VP9/Opus)' },
  avi: { id: 'avi', label: 'AVI', kind: 'video', extension: 'avi', mime: 'video/x-msvideo', description: 'Audio Video Interleave' },

  mp3: { id: 'mp3', label: 'MP3', kind: 'audio', extension: 'mp3', mime: 'audio/mpeg', description: 'MPEG-1 Audio Layer III' },
  wav: { id: 'wav', label: 'WAV', kind: 'audio', extension: 'wav', mime: 'audio/wav', description: 'Uncompressed PCM audio' },
  flac: { id: 'flac', label: 'FLAC', kind: 'audio', extension: 'flac', mime: 'audio/flac', description: 'Free Lossless Audio Codec' },
  m4a: { id: 'm4a', label: 'M4A', kind: 'audio', extension: 'm4a', aliases: ['aac'], mime: 'audio/mp4', description: 'AAC audio in MPEG-4' },
  ogg: { id: 'ogg', label: 'OGG', kind: 'audio', extension: 'ogg', aliases: ['oga', 'opus'], mime: 'audio/ogg', description: 'Ogg Vorbis audio' },

  png: { id: 'png', label: 'PNG', kind: 'image', extension: 'png', mime: 'image/png', description: 'Lossless image with transparency' },
  jpg: { id: 'jpg', label: 'JPG', kind: 'image', extension: 'jpg', aliases: ['jpeg', 'jfif'], mime: 'image/jpeg', description: 'Photographic JPEG image' },
  webp: { id: 'webp', label: 'WebP', kind: 'image', extension: 'webp', mime: 'image/webp', description: 'Modern web image' },
  gif: { id: 'gif', label: 'GIF', kind: 'image', extension: 'gif', mime: 'image/gif', description: 'Animated 256-colour image' },
  avif: { id: 'avif', label: 'AVIF', kind: 'image', extension: 'avif', mime: 'image/avif', description: 'AV1 image, very small files' },
  tiff: { id: 'tiff', label: 'TIFF', kind: 'image', extension: 'tiff', aliases: ['tif'], mime: 'image/tiff', description: 'Tagged image for print/archival' },

  pdf: { id: 'pdf', label: 'PDF', kind: 'document', extension: 'pdf', mime: 'application/pdf', description: 'Portable Document Format' },
  txt: { id: 'txt', label: 'TXT', kind: 'document', extension: 'txt', mime: 'text/plain; charset=utf-8', description: 'Plain UTF-8 text' },

  zip: { id: 'zip', label: 'ZIP', kind: 'archive', extension: 'zip', mime: 'application/zip', description: 'ZIP archive' },
  tar: { id: 'tar', label: 'TAR', kind: 'archive', extension: 'tar', mime: 'application/x-tar', description: 'Uncompressed tape archive' },
  tgz: { id: 'tgz', label: 'TAR.GZ', kind: 'archive', extension: 'tar.gz', aliases: ['tgz'], mime: 'application/gzip', description: 'Gzip-compressed tar archive' },
} as const satisfies Record<string, FormatDef>

export type FormatId = keyof typeof FORMATS
export type FormatInfo = (typeof FORMATS)[FormatId]

export const FORMAT_KIND_LABELS: Record<FormatKind, string> = {
  video: 'Video',
  audio: 'Audio',
  image: 'Image',
  document: 'Document',
  archive: 'Archive',
}

export const VIDEO_FORMATS = ['mp4', 'mov', 'mkv', 'webm', 'avi'] as const satisfies readonly FormatId[]
export const AUDIO_FORMATS = ['mp3', 'wav', 'flac', 'm4a', 'ogg'] as const satisfies readonly FormatId[]
export const IMAGE_FORMATS = ['png', 'jpg', 'webp', 'gif', 'avif', 'tiff'] as const satisfies readonly FormatId[]
export const ARCHIVE_FORMATS = ['zip', 'tar', 'tgz'] as const satisfies readonly FormatId[]

export function isFormatId(value: string): value is FormatId {
  return Object.hasOwn(FORMATS, value)
}

/** Lower-case extension of a filename, treating `.tar.gz` as one extension. */
export function fileExtension(name: string): string | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.tar.gz')) return 'tar.gz'
  return lower.match(/\.([a-z0-9]{1,8})$/)?.[1] ?? null
}

/** Best-effort guess from a filename extension. Display-only: never used for trust decisions. */
export function formatFromFilename(name: string): FormatId | null {
  const ext = fileExtension(name)
  if (!ext) return null
  for (const f of Object.values(FORMATS) as FormatDef[]) {
    if (f.extension === ext || f.aliases?.includes(ext)) return f.id as FormatId
  }
  return null
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

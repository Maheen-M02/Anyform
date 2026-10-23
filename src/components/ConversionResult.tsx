import type { Job } from '@/lib/api'
import { FORMATS, formatBytes, formatDuration } from '@/lib/formats'
import { Button, Fact, Tag } from './ui'
import { VerificationReceipt } from './VerificationReceipt'

/** In-browser preview for formats browsers can display natively. */
export function Preview({ src, job }: { src: string; job: Job }) {
  const out = job.output!
  const kind = FORMATS[out.format].kind
  if (kind === 'audio' && out.format !== 'flac') {
    return (
      <audio controls preload="metadata" src={src} className="w-full" aria-label={`Preview of ${out.filename}`}>
        Your browser cannot play this audio preview.
      </audio>
    )
  }
  if (kind === 'video') {
    return (
      <video controls preload="metadata" src={src} className="max-h-72 w-full rounded-xl bg-ink" aria-label={`Preview of ${out.filename}`}>
        Your browser cannot play this video preview.
      </video>
    )
  }
  if (kind === 'image' && out.format !== 'tiff') {
    return (
      <div className="flex max-h-72 justify-center overflow-hidden rounded-xl border border-line bg-[repeating-conic-gradient(#1b1b1f_0%_25%,#141417_0%_50%)] bg-[length:16px_16px]">
        {/* eslint-disable-next-line @next/next/no-img-element -- private, session-scoped output; not optimisable */}
        <img src={src} alt={`Preview of ${out.filename}`} className="max-h-72 object-contain" />
      </div>
    )
  }
  return null
}

export function DownloadButton({ href, filename }: { href: string; filename: string }) {
  const ext = filename.toLowerCase().endsWith('.tar.gz') ? 'TAR.GZ' : filename.split('.').pop()?.toUpperCase()
  return (
    <a
      href={href}
      download={filename}
      className="inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-accent px-6 font-medium text-accent-ink transition-[filter] hover:brightness-110"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M12 4v12m0 0 5-5m-5 5-5-5M5 20h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Download {ext}
    </a>
  )
}

const DETAIL_LABELS: Record<string, string> = {
  bitrateKbps: 'Bitrate',
  targetKbps: 'Bitrate',
  bitDepth: 'Bit depth',
  sampleRate: 'Sample rate',
  channels: 'Channels',
  resolution: 'Resolution',
  videoCodec: 'Video',
  audioCodec: 'Audio',
  encoding: 'Encoding',
  dimensions: 'Dimensions',
  frames: 'Frames',
  quality: 'Quality',
  pages: 'Pages',
  page: 'Page',
  dpi: 'Resolution',
  images: 'Images',
  characters: 'Characters',
  pageSize: 'Page size',
  files: 'Files',
  folders: 'Folders',
  unpackedBytes: 'Unpacked',
  skipped: 'Skipped',
  streams: 'Streams',
}

export function formatDetail(key: string, value: string | number): string {
  switch (key) {
    case 'bitrateKbps':
      return `${value} kbps`
    case 'targetKbps':
      return `~${value} kbps (VBR)`
    case 'bitDepth':
      return `${value}-bit`
    case 'sampleRate':
      return `${Number(value) / 1000} kHz`
    case 'channels':
      return value === 1 ? 'mono' : value === 2 ? 'stereo' : `${value} ch`
    case 'dpi':
      return `${value} DPI`
    case 'unpackedBytes':
      return formatBytes(Number(value))
    case 'characters':
      return Number(value).toLocaleString()
    default:
      return String(value)
  }
}

function expiresIn(ts: number | null): string {
  if (!ts) return ''
  const minutes = Math.max(0, Math.round((ts - Date.now()) / 60_000))
  return minutes >= 60 ? `${Math.round(minutes / 60)} h` : `${minutes} min`
}

/** Shown only after the server has verified the output. */
export function ConversionResult({ job, onConvertAnother, onAdjust }: { job: Job; onConvertAnother: () => void; onAdjust: () => void }) {
  const out = job.output!
  const facts: [string, string][] = [['Size', formatBytes(out.sizeBytes)]]
  if (out.durationSec !== null) facts.push(['Duration', formatDuration(out.durationSec)])
  for (const [k, v] of Object.entries(out.details)) facts.push([DETAIL_LABELS[k] ?? k, formatDetail(k, v)])

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex flex-wrap items-center gap-3">
        <Tag tone="ok">✓ Verified output</Tag>
        {out.format !== job.outputFormat && <Tag>{FORMATS[out.format].label} bundle</Tag>}
        {job.expiresAt && <span className="font-mono text-xs text-faint">deleted automatically in {expiresIn(job.expiresAt)}</span>}
      </div>
      <p className="truncate text-lg font-medium" title={out.filename}>
        {out.filename}
      </p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        {facts.slice(0, 8).map(([label, value]) => (
          <Fact key={label} label={label} value={value} />
        ))}
      </dl>
      {out.report && <VerificationReceipt report={out.report} />}
      {job.previewUrl && <Preview src={job.previewUrl} job={job} />}
      <div className="flex flex-wrap items-center gap-3">
        {job.downloadUrl && <DownloadButton href={job.downloadUrl} filename={out.filename} />}
        <Button variant="secondary" size="lg" onClick={onAdjust}>
          Change settings
        </Button>
        <Button variant="ghost" size="lg" onClick={onConvertAnother}>
          Convert another file
        </Button>
      </div>
    </div>
  )
}

import type { FileInfo, Upload } from '@/lib/api'
import { FORMATS, formatBytes, formatDuration, formatFromFilename } from '@/lib/formats'
import type { LocalFile, Workflow } from '@/lib/workflow'
import { ValidationStatus } from './ValidationStatus'
import { Fact, Tag } from './ui'

function channelsLabel(n: number, layout: string | null) {
  if (layout) return layout
  return n === 1 ? 'mono' : n === 2 ? 'stereo' : `${n} ch`
}

function detectedLabel(info: FileInfo): string {
  if (info.format) return FORMATS[info.format].label
  return info.kind === 'av' ? info.media.formatName : 'unsupported'
}

/** Kind-specific facts discovered by inspecting the real contents. */
function Facts({ info }: { info: FileInfo }) {
  const detected = <Fact label="Detected" value={detectedLabel(info)} />
  switch (info.kind) {
    case 'av': {
      const m = info.media
      const video = m.videoStreams.find((v) => !v.isAttachedPicture)
      return (
        <>
          {detected}
          <Fact label="Duration" value={formatDuration(m.durationSec)} />
          <Fact
            label="Video"
            value={video ? `${video.codec}${video.width ? ` · ${video.width}×${video.height}` : ''}${video.frameRate ? ` · ${Math.round(video.frameRate)} fps` : ''}` : 'none'}
          />
          <Fact label="Audio" value={m.audioStreams.length === 0 ? 'none' : `${m.audioStreams.length} track${m.audioStreams.length > 1 ? 's' : ''}`} />
        </>
      )
    }
    case 'image':
      return (
        <>
          {detected}
          <Fact label="Dimensions" value={`${info.image.width}×${info.image.height}`} />
          <Fact label="Frames" value={info.image.frames > 1 ? `${info.image.frames} (animated)` : '1'} />
          <Fact label="Transparency" value={info.image.hasAlpha ? 'yes' : 'no'} />
        </>
      )
    case 'pdf':
      return (
        <>
          {detected}
          <Fact label="Pages" value={info.pdf.pages} />
          <Fact label="Title" value={info.pdf.title ?? '—'} />
          <Fact
            label="Restrictions"
            value={info.pdf.permissions.copy && info.pdf.permissions.print ? 'none' : [!info.pdf.permissions.copy && 'no copying', !info.pdf.permissions.print && 'no printing'].filter(Boolean).join(', ')}
          />
        </>
      )
    case 'archive':
      return (
        <>
          {detected}
          <Fact label="Files" value={info.archive.files} />
          <Fact label="Folders" value={info.archive.directories} />
          <Fact label="Unpacked" value={formatBytes(info.archive.unpackedBytes)} />
        </>
      )
  }
}

/** The selected file: what the browser says, then what the server actually found. */
export function FileMetadataCard({ file, upload, state }: { file: LocalFile; upload: Upload | null; state: Workflow }) {
  const info = upload?.info
  const name = upload?.filename ?? file.name
  const size = upload?.sizeBytes ?? (file.size || null)
  const claimed = formatFromFilename(name)

  return (
    <div className="rounded-2xl border border-line bg-surface p-5 animate-fade-in">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate font-medium text-fg" title={name}>
            {name}
          </p>
          <p className="mt-1 font-mono text-xs text-muted">
            {size !== null ? formatBytes(size) : 'size unknown'}
            {claimed && ` · named .${FORMATS[claimed].extension}`}
            {upload?.origin.kind === 'url' &&
              (upload.origin.page ? ` · found on ${upload.origin.page}` : ` · from ${upload.origin.host}`)}
            {!upload && file.source === 'url' && ' · downloading on the server'}
          </p>
        </div>
        <ValidationStatus state={state} />
      </div>

      {state.phase === 'uploading' && (
        <div
          className="mt-4 h-1 overflow-hidden rounded-full bg-raised"
          role="progressbar"
          aria-label="Upload progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={state.progress === null ? undefined : Math.round(state.progress * 100)}
          aria-valuetext={state.progress === null ? 'Downloading' : undefined}
        >
          {state.progress === null ? (
            <div className="relative h-full">
              <div className="absolute inset-y-0 w-2/5 rounded-full bg-accent/70 animate-indeterminate" />
            </div>
          ) : (
            <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${state.progress * 100}%` }} />
          )}
        </div>
      )}

      {info && (
        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-4 sm:grid-cols-4">
          <Facts info={info} />
        </dl>
      )}

      {info?.kind === 'av' && info.media.audioStreams.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {info.media.audioStreams.map((s) => (
            <li key={s.index} className="flex flex-wrap items-center gap-2 font-mono text-xs text-muted">
              <span className="text-faint">#{s.ordinal + 1}</span>
              <span className="text-fg">{s.codec}</span>
              <span>{channelsLabel(s.channels, s.channelLayout)}</span>
              <span>{s.sampleRate ? `${(s.sampleRate / 1000).toFixed(1)} kHz` : ''}</span>
              {s.language && <span>{s.language}</span>}
              {s.title && <span className="truncate">“{s.title}”</span>}
              {s.decodable === false && <Tag tone="warn">undecodable</Tag>}
            </li>
          ))}
        </ul>
      )}

      {upload?.originalUrl && info?.format && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <p className="text-xs text-muted">
            {upload.origin.kind === 'url' ? 'Downloaded and checked. Save it as is, or convert it.' : 'Checked and ready to convert.'}
          </p>
          {upload.origin.kind === 'url' && (
            <a
              href={upload.originalUrl}
              download={upload.filename}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink transition-[filter] hover:brightness-110"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M12 4v12m0 0 5-5m-5 5-5-5M5 20h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Download {FORMATS[info.format].label}
            </a>
          )}
        </div>
      )}

      {upload?.warnings.map((w) => (
        <p key={w} className="mt-4 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-sm text-warn">
          {w}
        </p>
      ))}
    </div>
  )
}

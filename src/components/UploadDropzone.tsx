'use client'

import { useRef, useState } from 'react'
import { FORMAT_KIND_LABELS, FORMATS, formatBytes, type FormatId, type FormatKind } from '@/lib/formats'
import { Spotlight } from './motion/Spotlight'
import { Button, cx } from './ui'

interface Props {
  accepted: FormatId[]
  maxBytes: number | null
  disabled?: boolean
  compact?: boolean
  onFile: (file: File) => void
}

const KIND_ORDER: FormatKind[] = ['video', 'audio', 'image', 'document', 'archive']

function UploadIcon({ active }: { active: boolean }) {
  return (
    <span className="relative grid size-16 place-items-center">
      {/* Expanding rings while a file hovers over the drop zone. */}
      <span className={cx('absolute inset-0 rounded-full border border-accent/40', active ? 'animate-ping' : 'opacity-0')} />
      <span
        className={cx(
          'relative grid size-16 place-items-center rounded-full border transition-all duration-300',
          active ? 'scale-110 border-accent bg-accent/15 text-accent' : 'border-line-strong bg-raised text-muted group-hover:border-faint group-hover:text-fg',
        )}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden className={active ? '' : 'animate-float'}>
          <path d="M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </span>
    </span>
  )
}

/** Drag-and-drop target with a conventional file picker fallback. */
export function UploadDropzone({ accepted, maxBytes, disabled, compact, onFile }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const accept = accepted.flatMap((f) => [`.${FORMATS[f].extension}`, FORMATS[f].mime]).join(',')
  const groups = KIND_ORDER.map((kind) => ({ kind, formats: accepted.filter((f) => FORMATS[f].kind === kind) })).filter((g) => g.formats.length)

  const pick = (files: FileList | null) => {
    const file = files?.[0]
    if (file && !disabled) onFile(file)
  }

  return (
    <Spotlight
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled) setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        pick(e.dataTransfer.files)
      }}
      onClick={(e) => {
        // The whole surface opens the picker (buttons inside handle themselves).
        if (!disabled && !(e.target as HTMLElement).closest('button, input')) input.current?.click()
      }}
      className={cx(
        'group relative cursor-pointer overflow-hidden rounded-2xl text-center transition-[transform,background-color,box-shadow] duration-300',
        compact ? 'px-4 py-6' : 'px-6 py-12 sm:py-14',
        dragging ? 'scale-[1.01] bg-accent/[0.06] shadow-[0_0_60px_-12px_rgba(200,245,60,0.35)]' : 'bg-surface hover:-translate-y-0.5',
        disabled && 'pointer-events-none opacity-50',
      )}
    >
      {/* Animated dashed border: slow at rest, fast and lime while dragging. */}
      <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full">
        <rect
          x="1"
          y="1"
          rx="15"
          style={{ width: 'calc(100% - 2px)', height: 'calc(100% - 2px)' }}
          fill="none"
          strokeWidth="1.2"
          strokeDasharray="7 7"
          className={cx('marching-ants transition-[stroke] duration-300', dragging ? 'marching-ants-fast stroke-accent' : 'stroke-line-strong group-hover:stroke-faint')}
        />
      </svg>

      <div className={cx('relative z-10 flex flex-col items-center', compact ? 'gap-3' : 'gap-5')}>
        {!compact && <UploadIcon active={dragging} />}
        <div>
          <p className={cx('font-medium text-fg transition-colors', compact ? 'text-sm' : 'text-xl', dragging && 'text-accent')}>
            {dragging ? 'Release to upload' : compact ? 'Drop another file here' : 'Drop a file to begin'}
          </p>
          {!compact && (
            <p className="mt-1.5 text-sm text-muted">
              or click to browse{maxBytes ? ` · up to ${formatBytes(maxBytes)}` : ''}
            </p>
          )}
        </div>

        {!compact && groups.length > 0 && (
          <div className="mx-auto grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-left">
            {groups.map((g, gi) => (
              <div key={g.kind} className="contents">
                <span className="text-right font-mono text-[10px] tracking-wider text-faint uppercase">{FORMAT_KIND_LABELS[g.kind]}</span>
                <span className="flex flex-wrap gap-1.5">
                {g.formats.map((f, fi) => (
                  <span
                    key={f}
                    className={cx(
                      'chip-in rounded-md border px-1.5 py-0.5 font-mono text-[11px] transition-colors duration-300',
                      dragging ? 'border-accent/40 text-accent' : 'border-line text-muted group-hover:border-line-strong group-hover:text-fg/80',
                    )}
                    style={{ animationDelay: `${gi * 80 + fi * 35}ms` }}
                  >
                    {FORMATS[f].label}
                  </span>
                ))}
                </span>
              </div>
            ))}
          </div>
        )}

        <Button
          variant={compact ? 'secondary' : 'primary'}
          size={compact ? 'sm' : 'md'}
          disabled={disabled}
          onClick={() => input.current?.click()}
          className={compact ? '' : 'shadow-[0_8px_30px_-10px_rgba(200,245,60,0.6)] transition-transform hover:-translate-y-0.5 active:translate-y-0'}
        >
          Browse files
        </Button>
      </div>
      <input
        ref={input}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose a file to convert"
        accept={accept}
        disabled={disabled}
        onChange={(e) => {
          pick(e.target.files)
          e.target.value = ''
        }}
      />
    </Spotlight>
  )
}

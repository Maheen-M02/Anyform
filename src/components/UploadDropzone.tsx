'use client'

import { useRef, useState } from 'react'
import { FORMATS, formatBytes, type FormatId } from '@/lib/formats'
import { Button, cx } from './ui'

interface Props {
  accepted: FormatId[]
  maxBytes: number | null
  disabled?: boolean
  compact?: boolean
  onFile: (file: File) => void
}

/** Drag-and-drop target with a conventional file picker fallback. */
export function UploadDropzone({ accepted, maxBytes, disabled, compact, onFile }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const accept = accepted.flatMap((f) => [`.${FORMATS[f].extension}`, FORMATS[f].mime]).join(',')

  const pick = (files: FileList | null) => {
    const file = files?.[0]
    if (file && !disabled) onFile(file)
  }

  return (
    <div
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
      className={cx(
        'relative flex flex-col items-center justify-center rounded-2xl border border-dashed text-center transition-colors duration-150',
        compact ? 'gap-3 px-4 py-6' : 'gap-5 px-6 py-14 sm:py-20',
        dragging ? 'border-accent bg-accent/5' : 'border-line-strong bg-surface',
        disabled && 'opacity-50',
      )}
    >
      {!compact && (
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden className={dragging ? 'text-accent' : 'text-faint'}>
          <path d="M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )}
      <div>
        <p className={cx('font-medium text-fg', compact ? 'text-sm' : 'text-lg')}>
          {dragging ? 'Release to upload' : compact ? 'Drop another file here' : 'Drop a file to begin'}
        </p>
        {!compact && (
          <p className="mt-1.5 text-sm text-muted">
            {accepted.map((f) => FORMATS[f].label).join(', ')}
            {maxBytes ? ` · up to ${formatBytes(maxBytes)}` : ''}
          </p>
        )}
      </div>
      <Button variant={compact ? 'secondary' : 'primary'} size={compact ? 'sm' : 'md'} disabled={disabled} onClick={() => input.current?.click()}>
        Browse files
      </Button>
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
    </div>
  )
}

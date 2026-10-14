'use client'

import { useEffect, useState } from 'react'
import { cx } from './ui'

/** Real conversions ANYFORM performs, cycled as a live preview of what the panel will do. */
const EXAMPLES = [
  { from: 'MOV', to: 'MP4', note: 'Lossless stream copy' },
  { from: 'PDF', to: 'TXT', note: 'Text extraction' },
  { from: 'PNG', to: 'WEBP', note: 'Resize and compress' },
  { from: 'MKV', to: 'MP3', note: 'Audio from video' },
  { from: 'ZIP', to: 'TAR.GZ', note: 'Repacked byte for byte' },
  { from: 'JPG', to: 'AVIF', note: 'Next-gen image' },
  { from: 'WAV', to: 'FLAC', note: 'Lossless audio' },
] as const

const STEPS = [
  { title: 'Drop or paste', body: 'A file, or a link to one.' },
  { title: 'Inspected', body: 'Contents checked, not the file name.' },
  { title: 'Choose', body: 'Only conversions that will work.' },
  { title: 'Verified', body: 'Every output checked before download.' },
] as const

const CYCLE_MS = 2600

/** Empty-state preview for the output panel: an animated conversion "pipeline". */
export function PipelineDemo({ conversionCount }: { conversionCount: number | null }) {
  const [i, setI] = useState(0)

  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const t = setInterval(() => setI((n) => (n + 1) % EXAMPLES.length), CYCLE_MS)
    return () => clearInterval(t)
  }, [])

  const ex = EXAMPLES[i]!
  const step = i % STEPS.length

  return (
    <div className="flex min-h-72 flex-col justify-between gap-8">
      <div>
        {/* key={i} restarts the chip and beam animations on every cycle. */}
        <div key={i} className="flex items-center gap-3">
          <span className="pipe-chip-in rounded-xl border border-line-strong bg-raised px-4 py-2.5 font-mono text-lg font-semibold tracking-wider text-fg">
            {ex.from}
          </span>
          <span className="relative h-px flex-1 overflow-hidden bg-line-strong" aria-hidden>
            <span className="pipe-beam absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-accent to-transparent" />
          </span>
          <span className="pipe-chip-in rounded-xl border border-accent/50 bg-accent/10 px-4 py-2.5 font-mono text-lg font-semibold tracking-wider text-accent [animation-delay:700ms]">
            {ex.to}
          </span>
        </div>
        <p key={`note-${i}`} className="mt-3 animate-fade-in font-mono text-xs tracking-wide text-muted">
          {ex.note}
        </p>
      </div>

      <ol className="grid grid-cols-2 gap-3">
        {STEPS.map((s, n) => (
          <li
            key={s.title}
            className={cx(
              'rounded-xl border p-3 transition-all duration-500',
              n === step ? 'border-accent/40 bg-accent/[0.06]' : 'border-line bg-transparent',
            )}
          >
            <p className="flex items-center gap-2 text-sm text-fg">
              <span className={cx('font-mono text-[11px] transition-colors duration-500', n === step ? 'text-accent' : 'text-faint')}>0{n + 1}</span>
              {s.title}
            </p>
            <p className="mt-1 text-xs text-muted">{s.body}</p>
          </li>
        ))}
      </ol>

      <p className="text-xs text-faint">
        {conversionCount !== null ? `${conversionCount} conversions across video, audio, images, PDFs and archives.` : ' '} Options appear once a
        file has been checked.
      </p>
    </div>
  )
}

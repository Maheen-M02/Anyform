import type { Job } from '@/lib/api'
import type { JobStatus } from '@/lib/states'
import { Button, cx, Spinner } from './ui'

const STEPS: { status: JobStatus; label: string }[] = [
  { status: 'queued', label: 'Queued' },
  { status: 'processing', label: 'Converting' },
  { status: 'verifying', label: 'Verifying' },
]

/**
 * Shows the real job status. A percentage is shown only when the encoder
 * reports it; otherwise the bar is an honest indeterminate indicator.
 */
export function ConversionProgress({ job, cancelling, onCancel }: { job: Job | null; cancelling: boolean; onCancel: () => void }) {
  const status = job?.status ?? 'queued'
  const current = STEPS.findIndex((s) => s.status === status)
  const percent = status === 'processing' && job?.progress != null ? Math.round(job.progress * 100) : null

  return (
    <div className="space-y-5 animate-fade-in" aria-live="polite">
      <ol className="flex items-center gap-2 font-mono text-xs">
        {STEPS.map((s, i) => (
          <li key={s.status} className="flex items-center gap-2">
            <span
              className={cx(
                'inline-flex items-center gap-1.5 rounded-md px-2 py-1',
                i < current && 'text-ok',
                i === current && 'bg-raised text-fg',
                i > current && 'text-faint',
              )}
            >
              {i === current && <Spinner className="size-2.5" />}
              {i < current && <span aria-hidden>✓</span>}
              {s.label}
            </span>
            {i < STEPS.length - 1 && <span aria-hidden className="text-line-strong">/</span>}
          </li>
        ))}
      </ol>

      <div>
        <div
          className="relative h-1.5 overflow-hidden rounded-full bg-raised"
          role="progressbar"
          aria-label="Conversion progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
          aria-valuetext={percent === null ? 'In progress' : `${percent}%`}
        >
          {percent === null ? (
            <div className="absolute inset-y-0 w-2/5 rounded-full bg-accent/70 animate-indeterminate" />
          ) : (
            <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${percent}%` }} />
          )}
        </div>
        <div className="mt-2 flex items-center justify-between font-mono text-xs text-muted">
          <span>
            {status === 'queued' && 'Waiting for a worker…'}
            {status === 'processing' && (percent === null ? 'Working…' : 'Converting')}
            {status === 'verifying' && 'Checking the output file'}
          </span>
          {percent !== null && <span className="tabular-nums text-fg">{percent}%</span>}
        </div>
      </div>

      <Button variant="ghost" size="sm" onClick={onCancel} disabled={!job || cancelling}>
        {cancelling ? 'Cancelling…' : 'Cancel conversion'}
      </Button>
    </div>
  )
}

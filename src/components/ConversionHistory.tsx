'use client'

import { useState } from 'react'
import type { Job } from '@/lib/api'
import { FORMATS, formatBytes } from '@/lib/formats'
import { isActiveJob } from '@/lib/states'
import { Button, Panel, Tag } from './ui'

const TONE = {
  queued: 'neutral',
  processing: 'accent',
  verifying: 'accent',
  completed: 'ok',
  failed: 'danger',
  cancelled: 'neutral',
  expired: 'neutral',
} as const

function when(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Conversions made in this browser session. */
export function ConversionHistory({ jobs, onDelete }: { jobs: Job[]; onDelete: (id: string) => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null)
  if (jobs.length === 0) return null

  return (
    <Panel title="This session" aside={<span className="font-mono text-xs text-faint">{jobs.length}</span>}>
      <ul className="-my-2 divide-y divide-line">
        {jobs.map((job) => (
          <li key={job.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-fg" title={job.output?.filename ?? job.inputName}>
                {job.output?.filename ?? job.inputName}
              </p>
              <p className="mt-0.5 font-mono text-xs text-faint">
                {FORMATS[job.inputFormat].label} → {FORMATS[job.outputFormat].label}
                {typeof job.options.bitrate === 'number' && ` · ${job.options.bitrate} kbps`}
                {job.output && ` · ${formatBytes(job.output.sizeBytes)}`} · {when(job.createdAt)}
              </p>
            </div>
            <Tag tone={TONE[job.status]}>{job.status}</Tag>
            <div className="flex items-center gap-1">
              {job.downloadUrl && job.output && (
                <a
                  href={job.downloadUrl}
                  download={job.output.filename}
                  className="inline-flex h-8 items-center rounded-lg px-3 text-sm text-fg hover:bg-raised"
                >
                  Download
                </a>
              )}
              {!isActiveJob(job.status) && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy === job.id}
                  aria-label={`Delete ${job.output?.filename ?? job.inputName}`}
                  onClick={async () => {
                    setBusy(job.id)
                    try {
                      await onDelete(job.id)
                    } finally {
                      setBusy(null)
                    }
                  }}
                >
                  Delete
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

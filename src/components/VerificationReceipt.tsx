'use client'

import { useState } from 'react'
import type { HiddenItem, VerificationReport } from '@/lib/api'
import { FORMATS, formatBytes } from '@/lib/formats'
import { receiptText } from '@/lib/receipt'
import { formatTarget } from '@/lib/size-targets'
import { Button, cx } from './ui'

function downloadReceipt(report: VerificationReport) {
  const blob = new Blob([receiptText(report)], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${report.output.name.replace(/\.[^.]+$/, '')}.receipt.txt`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function Hash({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-14 shrink-0 font-mono text-[11px] tracking-wider text-faint uppercase">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={value}>
        {value}
      </code>
      <button
        type="button"
        onClick={() => navigator.clipboard?.writeText(value).then(() => setCopied(true)).catch(() => undefined)}
        onBlur={() => setCopied(false)}
        className="shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] text-faint hover:bg-raised hover:text-fg"
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  )
}

function ItemList({ items, removed }: { items: HiddenItem[]; removed: boolean }) {
  return (
    <ul className="space-y-1">
      {items.map((i) => (
        <li key={`${i.label}:${i.value}`} className="flex min-w-0 items-baseline gap-2 text-xs">
          <span className={cx('shrink-0 font-mono', removed ? 'text-ok' : 'text-warn')} aria-hidden>
            {removed ? '−' : '•'}
          </span>
          <span className="shrink-0 text-muted">{i.label}</span>
          <span className={cx('min-w-0 truncate font-mono', removed ? 'text-faint line-through' : 'text-fg')} title={i.value}>
            {i.value}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The evidence behind "Verified output": what was checked, what changed, and fingerprints. */
export function VerificationReceipt({ report }: { report: VerificationReport }) {
  const [open, setOpen] = useState(false)
  const { hidden, destination } = report
  const remaining = hidden.remaining ?? []
  const saved = report.input.sizeBytes - report.output.sizeBytes

  const highlights: string[] = [`${report.checks.length} checks passed`]
  if (hidden.removed.length > 0) highlights.push(`${hidden.removed.length} hidden item${hidden.removed.length === 1 ? '' : 's'} removed`)
  if (destination?.maxBytes) highlights.push(`fits ${destination.label} (≤ ${formatTarget(destination.maxBytes)})`)
  else if (saved > 0 && report.input.sizeBytes > 0) highlights.push(`${Math.round((saved / report.input.sizeBytes) * 100)}% smaller`)

  return (
    <section className="rounded-xl border border-ok/25 bg-ok/[0.03]" aria-label="Verification report">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium text-fg">How this file was verified</span>
          <span className="block truncate font-mono text-[11px] text-muted">{highlights.join(' · ')}</span>
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden className={cx('shrink-0 text-muted transition-transform', open && 'rotate-180')}>
          <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="space-y-5 border-t border-ok/15 px-4 py-4 animate-fade-in">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-center">
            <div className="min-w-0 rounded-lg border border-line bg-ink px-3 py-2">
              <p className="font-mono text-sm font-semibold tracking-wider">{FORMATS[report.input.format].label}</p>
              <p className="font-mono text-[11px] text-muted">{formatBytes(report.input.sizeBytes)}</p>
            </div>
            <span aria-hidden className="text-faint">
              →
            </span>
            <div className="min-w-0 rounded-lg border border-ok/30 bg-ink px-3 py-2">
              <p className="font-mono text-sm font-semibold tracking-wider text-ok">{FORMATS[report.output.format].label}</p>
              <p className="font-mono text-[11px] text-muted">{formatBytes(report.output.sizeBytes)}</p>
            </div>
          </div>

          <div>
            <p className="mb-2 font-mono text-[11px] tracking-wider text-faint uppercase">Checked after conversion</p>
            <ol className="space-y-1.5">
              {report.checks.map((c) => (
                <li key={`${c.label}:${c.detail}`} className="flex gap-2.5 text-xs">
                  <span className="mt-px font-mono text-ok" aria-hidden>
                    ✓
                  </span>
                  <span>
                    <span className="text-fg">{c.label}</span>
                    <span className="text-muted"> — {c.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>

          {(hidden.removed.length > 0 || remaining.length > 0) && (
            <div className="space-y-3">
              {hidden.removed.length > 0 && (
                <div>
                  <p className="mb-1.5 font-mono text-[11px] tracking-wider text-faint uppercase">Removed hidden data</p>
                  <ItemList items={hidden.removed} removed />
                </div>
              )}
              {remaining.length > 0 && (
                <div>
                  <p className="mb-1.5 font-mono text-[11px] tracking-wider text-faint uppercase">Still in the output</p>
                  <ItemList items={remaining} removed={false} />
                </div>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <p className="font-mono text-[11px] tracking-wider text-faint uppercase">SHA-256 fingerprints</p>
            <Hash label="Source" value={report.input.sha256} />
            <Hash label="Output" value={report.output.sha256} />
          </div>

          <Button size="sm" variant="secondary" onClick={() => downloadReceipt(report)}>
            Download receipt
          </Button>
        </div>
      )}
    </section>
  )
}

import type { HiddenCategory, HiddenItem, Upload } from '@/lib/api'
import { Button, cx, Spinner, Tag } from './ui'

const CATEGORY_LABELS: Record<HiddenCategory, string> = {
  location: 'Location',
  device: 'Device',
  people: 'People',
  time: 'Dates',
  software: 'Software',
  history: 'Editing history',
  description: 'Descriptions',
  content: 'Inside the document',
}

const CATEGORY_ORDER: HiddenCategory[] = ['location', 'people', 'device', 'history', 'time', 'software', 'description', 'content']

const RISK_DOT: Record<HiddenItem['risk'], string> = { high: 'bg-danger', medium: 'bg-warn', low: 'bg-faint' }

function summary(items: HiddenItem[]): string {
  const high = items.filter((i) => i.risk === 'high')
  if (high.some((i) => i.category === 'location')) return 'This file records where it was made.'
  if (high.length > 0) return `This file carries ${high.map((i) => i.label.toLowerCase()).join(', ')}.`
  if (items.some((i) => i.category === 'people' || i.category === 'device')) return 'This file names people or devices.'
  return 'Small details, but they travel with the file.'
}

/** What the file reveals that its viewer does not see, and a one-click way to remove it. */
export function HiddenData({
  upload,
  canClean,
  cleaning,
  cleanHint,
  onClean,
}: {
  upload: Upload
  canClean: boolean
  cleaning: boolean
  cleanHint: string | null
  onClean: () => void
}) {
  const items = upload.info?.hidden
  if (!items || upload.info?.kind === 'archive') return null

  if (items.length === 0) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface px-5 py-4 animate-fade-in">
        <span className="grid size-7 shrink-0 place-items-center rounded-full border border-ok/40 text-ok" aria-hidden>
          ✓
        </span>
        <p className="text-sm text-muted">
          <span className="text-fg">No hidden metadata found.</span> No location, device or author data travels with this file.
        </p>
      </div>
    )
  }

  const removable = items.filter((i) => i.removable)
  const groups = CATEGORY_ORDER.map((category) => ({ category, items: items.filter((i) => i.category === category) })).filter((g) => g.items.length > 0)
  const highCount = items.filter((i) => i.risk === 'high').length

  return (
    <section aria-labelledby="hidden-title" className="rounded-2xl border border-line bg-surface animate-fade-in">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h2 id="hidden-title" className="font-mono text-xs tracking-[0.14em] text-muted uppercase">
            Hidden in this file
          </h2>
          <p className="mt-1 text-sm text-fg">{summary(items)}</p>
        </div>
        <div className="flex items-center gap-2">
          {highCount > 0 && <Tag tone="danger">{highCount} sensitive</Tag>}
          <Tag>{items.length} found</Tag>
        </div>
      </header>

      <div className="max-h-80 space-y-4 overflow-y-auto px-5 py-4">
        {groups.map((g) => (
          <div key={g.category}>
            <p className="mb-1.5 font-mono text-[11px] tracking-wider text-faint uppercase">{CATEGORY_LABELS[g.category]}</p>
            <dl className="space-y-1.5">
              {g.items.map((item) => (
                <div
                  key={`${item.label}:${item.value}`}
                  className={cx('grid grid-cols-[auto_minmax(7rem,auto)_1fr] items-baseline gap-x-3 rounded-lg px-2 py-1', item.risk === 'high' && 'bg-danger/5')}
                >
                  <span aria-hidden className={cx('size-1.5 translate-y-[-1px] rounded-full', RISK_DOT[item.risk])} />
                  <dt className="text-xs text-muted">
                    {item.label}
                    <span className="sr-only"> ({item.risk} sensitivity)</span>
                  </dt>
                  <dd className="min-w-0 font-mono text-xs break-words text-fg">
                    {item.value}
                    {!item.removable && <span className="ml-2 text-faint">kept</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4">
        <p className="max-w-sm text-xs text-muted">
          {canClean && removable.length > 0
            ? cleanHint
            : removable.length === 0
              ? 'These are part of the document itself, so a clean copy keeps them.'
              : 'Converting re-checks the result and lists exactly which of these were removed.'}
        </p>
        {canClean && removable.length > 0 && (
          <Button variant="primary" onClick={onClean} disabled={cleaning}>
            {cleaning ? (
              <>
                <Spinner /> Cleaning…
              </>
            ) : (
              `Remove ${removable.length === items.length ? 'all' : removable.length} hidden item${removable.length === 1 ? '' : 's'}`
            )}
          </Button>
        )}
      </footer>
    </section>
  )
}

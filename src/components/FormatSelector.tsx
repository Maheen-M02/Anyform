import type { OutputChoice } from '@/lib/api'
import { FORMAT_KIND_LABELS, FORMATS, type FormatId, type FormatKind } from '@/lib/formats'
import { cx, Tag } from './ui'

const KIND_ORDER: FormatKind[] = ['video', 'audio', 'image', 'document', 'archive']

/** Only formats the registry can actually produce for this input are listed, grouped by kind. */
export function FormatSelector({
  choices,
  value,
  disabled,
  onChange,
}: {
  choices: OutputChoice[]
  value: FormatId | null
  disabled?: boolean
  onChange: (format: FormatId) => void
}) {
  const groups = KIND_ORDER.map((kind) => ({ kind, items: choices.filter((c) => c.kind === kind) })).filter((g) => g.items.length > 0)

  return (
    <fieldset disabled={disabled} className="space-y-4">
      <legend className="font-mono text-[11px] tracking-wider text-faint uppercase">Convert to</legend>
      {groups.map((g) => (
        <div key={g.kind}>
          {groups.length > 1 && <p className="mb-1.5 text-xs text-muted">{FORMAT_KIND_LABELS[g.kind]}</p>}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {g.items.map((c) => {
              const selected = c.format === value
              return (
                <label
                  key={c.format}
                  title={FORMATS[c.format].description}
                  className={cx(
                    'flex cursor-pointer items-center justify-between gap-2 rounded-xl border px-3 py-2.5 transition-colors',
                    selected ? 'border-accent bg-accent/5' : 'border-line-strong hover:border-faint',
                    disabled && 'cursor-not-allowed opacity-60',
                  )}
                >
                  <input type="radio" name="output-format" className="sr-only" checked={selected} onChange={() => onChange(c.format)} />
                  <span className="min-w-0">
                    <span className="block font-mono text-sm font-semibold tracking-wider">{c.label}</span>
                    <span className="block truncate text-[11px] text-muted">
                      {!c.sameFormat ? FORMATS[c.format].description : c.kind === 'image' ? 'Resize / re-encode' : 'Clean copy, no hidden data'}
                    </span>
                  </span>
                  {c.lossy && <Tag tone="warn">Lossy</Tag>}
                </label>
              )
            })}
          </div>
        </div>
      ))}
    </fieldset>
  )
}

import type { OutputChoice, Upload } from '@/lib/api'
import { cx } from './ui'

const COLS: Record<number, string> = { 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-3' }

function Label({ id, text, help }: { id: string; text: string; help?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span id={id} className="font-mono text-[11px] tracking-wider text-faint uppercase">
        {text}
      </span>
      {help && <span className="hidden text-right text-xs text-faint sm:block">{help}</span>}
    </div>
  )
}

/** Renders the option fields declared by the selected conversion adapter. */
export function ConversionOptions({
  choice,
  upload,
  values,
  disabled,
  onChange,
}: {
  choice: OutputChoice
  upload: Upload
  values: Record<string, number | string>
  disabled?: boolean
  onChange: (key: string, value: number | string) => void
}) {
  const numberFields = choice.options.filter((f) => f.type === 'number')
  const otherFields = choice.options.filter((f) => f.type !== 'number')

  return (
    <fieldset disabled={disabled} className="space-y-5">
      {numberFields.length > 0 && (
        <div>
          <Label id="opt-dimensions" text="Resize" help={numberFields[0]!.help} />
          <div className="mt-2 grid grid-cols-2 gap-2">
            {numberFields.map((field) =>
              field.type !== 'number' ? null : (
                <label key={field.key} className="relative block">
                  <span className="sr-only">{field.label}</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={field.min}
                    max={field.max}
                    step={1}
                    value={values[field.key] ?? ''}
                    placeholder={field.placeholder}
                    aria-label={field.label}
                    onChange={(e) => onChange(field.key, e.target.value === '' ? '' : Number(e.target.value))}
                    className="h-10 w-full rounded-xl border border-line-strong bg-ink pr-16 pl-3 font-mono text-sm text-fg placeholder:text-faint disabled:opacity-60"
                  />
                  <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center font-mono text-[11px] text-faint">
                    {field.label.replace(/^Max /, '').toLowerCase()} {field.unit}
                  </span>
                </label>
              ),
            )}
          </div>
        </div>
      )}

      {otherFields.map((field) => {
        const id = `opt-${field.key}`
        if (field.type === 'select') {
          const cols = COLS[field.choices.length] ?? 'grid-cols-2 sm:grid-cols-4'
          return (
            <div key={field.key}>
              <Label id={id} text={field.label} help={field.help} />
              <div role="radiogroup" aria-labelledby={id} className={cx('mt-2 grid gap-1 rounded-xl border border-line-strong bg-ink p-1', cols)}>
                {field.choices.map((c) => {
                  const selected = values[field.key] === c.value
                  return (
                    <button
                      key={String(c.value)}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => onChange(field.key, c.value)}
                      className={cx(
                        'min-h-9 rounded-lg px-2 py-1.5 font-mono text-xs transition-colors disabled:cursor-not-allowed sm:text-sm',
                        selected ? 'bg-fg text-ink' : 'text-muted hover:bg-raised hover:text-fg',
                      )}
                    >
                      {c.label}
                      {c.value === field.default && <span className="sr-only"> (default)</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        }
        if (field.type !== 'audioStream') return null
        const streams = upload.info?.kind === 'av' ? upload.info.media.audioStreams : []
        return (
          <div key={field.key}>
            <label htmlFor={id} className="font-mono text-[11px] tracking-wider text-faint uppercase">
              {field.label}
            </label>
            <select
              id={id}
              value={String(values[field.key] ?? '')}
              onChange={(e) => onChange(field.key, Number(e.target.value))}
              className="mt-2 h-10 w-full rounded-xl border border-line-strong bg-ink px-3 text-sm text-fg disabled:opacity-60"
            >
              {streams.map((s) => (
                <option key={s.index} value={s.index} disabled={s.decodable === false}>
                  Track {s.ordinal + 1} · {s.codec} · {s.channels === 1 ? 'mono' : s.channels === 2 ? 'stereo' : `${s.channels} ch`}
                  {s.language ? ` · ${s.language}` : ''}
                  {s.title ? ` · ${s.title}` : ''}
                  {s.isDefault ? ' · default' : ''}
                  {s.decodable === false ? ' · cannot decode' : ''}
                </option>
              ))}
            </select>
            {field.help && <p className="mt-1.5 text-xs text-faint">{field.help}</p>}
          </div>
        )
      })}

      {choice.notes.length > 0 && (
        <ul className="space-y-1 border-t border-line pt-4 text-xs text-muted">
          {choice.notes.map((n) => (
            <li key={n} className="flex gap-2">
              <span aria-hidden className="text-faint">
                —
              </span>
              {n}
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  )
}

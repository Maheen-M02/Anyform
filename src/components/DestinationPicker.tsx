import type { ReactNode } from 'react'
import type { Upload } from '@/lib/api'
import { DESTINATIONS, planDestination, type Destination, type DestinationPlan } from '@/lib/destinations'
import { FORMATS } from '@/lib/formats'
import { formatTarget } from '@/lib/size-targets'
import { destinationInput } from '@/lib/workflow'
import { cx } from './ui'

const ICONS: Record<Destination['icon'], ReactNode> = {
  chat: <path d="M4 5h16v10H9l-5 4V5Z" />,
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M11 18h2" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
    </>
  ),
  camera: (
    <>
      <rect x="3" y="6" width="18" height="14" rx="3" />
      <circle cx="12" cy="13" r="3.5" />
      <path d="M8 6l1.5-2h5L16 6" />
    </>
  ),
  print: (
    <>
      <path d="M7 9V3h10v6" />
      <rect x="3" y="9" width="18" height="8" rx="2" />
      <path d="M7 14h10v7H7z" />
    </>
  ),
  feather: <path d="M20 4c-8 0-14 6-14 14v2M6 18 16 8M10 14h6" />,
}

/** Destinations that apply to this upload, with the target each one picks (or why it cannot). */
export function destinationPlans(upload: Upload): DestinationPlan[] {
  const input = destinationInput(upload)
  if (!input) return []
  const available = upload.outputs.map((o) => o.format)
  return DESTINATIONS.map((d) => planDestination(d, input, available)).filter((p): p is DestinationPlan => p !== null)
}

function targetLabel(plan: DestinationPlan): string {
  if (!plan.ok) return plan.reason
  const { format, options } = plan.target
  const limit = typeof options.maxBytes === 'number' ? ` · ≤ ${formatTarget(options.maxBytes)}` : ''
  return `${FORMATS[format].label}${limit}`
}

/** "Where is it going?": one tap picks the format, settings and size limit for that place. */
export function DestinationPicker({
  plans,
  value,
  disabled,
  onPick,
}: {
  plans: DestinationPlan[]
  value: string | null
  disabled?: boolean
  onPick: (plan: Extract<DestinationPlan, { ok: true }>) => void
}) {
  if (plans.length === 0) return null
  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="flex w-full items-baseline justify-between gap-4">
        <span className="font-mono text-[11px] tracking-wider text-faint uppercase">Where is it going?</span>
        <span className="hidden text-xs text-faint sm:block">Picks format, settings and size for you</span>
      </legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {plans.map((plan) => {
          const selected = plan.ok && plan.destination.id === value
          return (
            <button
              key={plan.destination.id}
              type="button"
              aria-pressed={selected}
              disabled={!plan.ok || disabled}
              title={plan.destination.blurb}
              onClick={() => plan.ok && onPick(plan)}
              className={cx(
                'group flex min-w-0 items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed',
                selected ? 'border-accent bg-accent/5' : 'border-line-strong hover:border-faint',
                !plan.ok && 'opacity-50',
              )}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
                className={cx('mt-0.5 shrink-0', selected ? 'text-accent' : 'text-muted group-hover:text-fg')}
              >
                {ICONS[plan.destination.icon]}
              </svg>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-fg">{plan.destination.label}</span>
                <span className="block truncate font-mono text-[11px] text-muted">{targetLabel(plan)}</span>
              </span>
            </button>
          )
        })}
      </div>
      {value && <p className="text-xs text-muted">{plans.find((p) => p.destination.id === value)?.destination.blurb}</p>}
    </fieldset>
  )
}

import type { ApiErrorBody } from '@/lib/api'
import { Button } from './ui'

export interface RecoveryAction {
  label: string
  onClick: () => void
}

/** A concise failure explanation plus the most useful next step. */
export function ErrorState({ title, error, actions }: { title: string; error: ApiErrorBody; actions: RecoveryAction[] }) {
  return (
    <div role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-4 animate-fade-in">
      <p className="font-medium text-danger">{title}</p>
      <p className="mt-1 text-sm text-fg/90">{error.message}</p>
      {error.requestId && <p className="mt-2 font-mono text-[11px] text-faint">Reference: {error.requestId}</p>}
      {actions.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {actions.map((a, i) => (
            <Button key={a.label} size="sm" variant={i === 0 ? 'secondary' : 'ghost'} onClick={a.onClick}>
              {a.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

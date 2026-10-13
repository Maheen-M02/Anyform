import type { ButtonHTMLAttributes, ReactNode } from 'react'

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:brightness-110 disabled:bg-raised disabled:text-faint',
  secondary: 'border border-line-strong bg-raised text-fg hover:border-faint disabled:text-faint',
  ghost: 'text-muted hover:text-fg hover:bg-raised disabled:text-faint',
  danger: 'border border-danger/40 text-danger hover:bg-danger/10',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-[background,color,border,filter] duration-150 disabled:cursor-not-allowed',
        size === 'sm' && 'h-8 px-3 text-sm',
        size === 'md' && 'h-10 px-4 text-sm',
        size === 'lg' && 'h-12 px-6 text-base',
        VARIANTS[variant],
        className,
      )}
    />
  )
}

export function Panel({ title, aside, children, className }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-2xl border border-line bg-surface', className)}>
      {title && (
        <header className="flex items-center justify-between gap-4 border-b border-line px-5 py-3">
          <h2 className="font-mono text-xs tracking-[0.14em] text-muted uppercase">{title}</h2>
          {aside}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  )
}

export function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[11px] tracking-wide uppercase',
        tone === 'neutral' && 'border-line-strong text-muted',
        tone === 'accent' && 'border-accent/40 text-accent',
        tone === 'ok' && 'border-ok/40 text-ok',
        tone === 'warn' && 'border-warn/40 text-warn',
        tone === 'danger' && 'border-danger/40 text-danger',
      )}
    >
      {children}
    </span>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx('inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent', className)}
    />
  )
}

export function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[11px] tracking-wider text-faint uppercase">{label}</dt>
      <dd className="mt-0.5 truncate text-sm text-fg">{value}</dd>
    </div>
  )
}

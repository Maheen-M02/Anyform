export function Logo() {
  return (
    <span className="inline-flex items-center gap-2.5" aria-label="ANYFORM">
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden fill="none">
        <rect x="1.5" y="1.5" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="2" />
        <circle cx="18" cy="18" r="4.5" fill="var(--color-accent)" />
        <path d="M13 6h5.5v5.5M18.5 6 10 14.5" stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="font-mono text-sm font-semibold tracking-[0.22em]">ANYFORM</span>
    </span>
  )
}

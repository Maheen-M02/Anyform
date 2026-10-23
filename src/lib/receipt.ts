import type { VerificationReport } from './api'
import { FORMATS } from './formats'
import { formatTarget } from './size-targets'

/**
 * Plain-text verification receipt. It is self-contained so it still makes
 * sense on its own; the fingerprints let anyone confirm a file matches it
 * (`sha256sum` / `Get-FileHash`).
 */
export function receiptText(r: VerificationReport): string {
  const lines: string[] = []
  const rule = '-'.repeat(64)
  lines.push('ANYFORM verification receipt', rule)
  lines.push(`Verified:      ${new Date(r.verifiedAt).toISOString()}`)
  if (r.destination) {
    lines.push(`Made for:      ${r.destination.label}${r.destination.maxBytes ? ` (limit ${formatTarget(r.destination.maxBytes)})` : ''}`)
  }
  lines.push('')
  lines.push(`Source:        ${r.input.name}`)
  lines.push(`               ${FORMATS[r.input.format].label}, ${r.input.sizeBytes.toLocaleString('en-US')} bytes`)
  lines.push(`               SHA-256 ${r.input.sha256}`)
  lines.push(`Output:        ${r.output.name}`)
  lines.push(`               ${FORMATS[r.output.format].label}, ${r.output.sizeBytes.toLocaleString('en-US')} bytes`)
  lines.push(`               SHA-256 ${r.output.sha256}`)
  lines.push('', 'Checks passed', rule)
  for (const c of r.checks) lines.push(`[ok] ${c.label}: ${c.detail}`)
  lines.push('', 'Hidden data', rule)
  if (r.hidden.before.length === 0) lines.push('None found in the source.')
  for (const item of r.hidden.removed) lines.push(`removed  ${item.label}: ${item.value}`)
  if (r.hidden.remaining === null) lines.push('The output format cannot be scanned for metadata.')
  else for (const item of r.hidden.remaining) lines.push(`remains  ${item.label}: ${item.value}`)
  lines.push('')
  return lines.join('\n')
}

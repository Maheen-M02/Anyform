import { findDestination } from '@/lib/destinations'
import { formatTarget } from '@/lib/size-targets'
import type { VerifiedOutput } from '../conversions/types'
import { sha256File } from '../hash'
import { inspectFile } from '../inspect'
import { removedHidden } from '../inspect/hidden'
import type { HiddenItem } from '../inspect/types'
import { ToolError } from '../media/process'
import type { JobRecord, UploadRecord, VerificationReport } from '../store/types'

/**
 * Builds the verification report for a finished output: the adapter's own
 * checks, plus fingerprints of both files and an independent re-scan of the
 * output for hidden metadata.
 */
export async function buildReport(a: {
  job: JobRecord
  upload: UploadRecord
  verified: VerifiedOutput
  sourcePath: string
  outputPath: string
  outputName: string
  signal: AbortSignal
}): Promise<VerificationReport> {
  const [inputHash, outputHash] = await Promise.all([sha256File(a.sourcePath, a.signal), sha256File(a.outputPath, a.signal)])
  const before = a.upload.info?.hidden ?? []

  let remaining: HiddenItem[] | null
  if (a.verified.format === 'txt') {
    // Plain text has no metadata container.
    remaining = []
  } else {
    try {
      remaining = (await inspectFile(a.outputPath, { signal: a.signal, decodeTest: false })).hidden ?? null
    } catch (err) {
      if (err instanceof ToolError && err.kind === 'aborted') throw err
      remaining = null
    }
  }
  const removed = remaining === null ? [] : removedHidden(before, remaining)

  const checks = [...a.verified.checks]
  if (remaining !== null) {
    checks.push({
      label: 'Hidden data',
      detail:
        remaining.length > 0
          ? `Re-scanned the output: ${remaining.length} item${remaining.length === 1 ? '' : 's'} remain${remaining.length === 1 ? 's' : ''} (listed below)`
          : before.length > 0
            ? `Re-scanned the output: none of the ${before.length} item${before.length === 1 ? '' : 's'} found in the source remain`
            : 'Re-scanned the output: no hidden metadata',
    })
  }
  checks.push({ label: 'Fingerprint', detail: `SHA-256 of the output recorded (${outputHash.slice(0, 12)}…)` })

  const destination = a.job.destination ? findDestination(a.job.destination) : undefined
  const maxBytes = typeof a.job.options.maxBytes === 'number' ? a.job.options.maxBytes : null
  if (destination && maxBytes && !checks.some((c) => c.label === 'Size limit')) {
    checks.push({ label: 'Size limit', detail: `${a.verified.sizeBytes.toLocaleString('en-US')} bytes, under the ${formatTarget(maxBytes)} limit` })
  }

  return {
    version: 1,
    verifiedAt: Date.now(),
    input: { name: a.upload.originalName, format: a.job.inputFormat, sizeBytes: a.upload.sizeBytes, sha256: inputHash },
    output: { name: a.outputName, format: a.verified.format, sizeBytes: a.verified.sizeBytes, sha256: outputHash },
    checks,
    hidden: { before, removed, remaining },
    destination: destination ? { id: destination.id, label: destination.label, maxBytes } : null,
  }
}

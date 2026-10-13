/**
 * Lifecycle states shared by the server and the UI.
 *
 * An upload moves through `uploaded → validating → validated | rejected`.
 * A conversion job moves through `queued → processing → verifying → completed`,
 * may end as `failed` or `cancelled`, and every terminal job eventually becomes
 * `expired` once its artifacts are deleted.
 */
export const UPLOAD_STATUSES = ['uploaded', 'validating', 'validated', 'rejected', 'expired'] as const
export type UploadStatus = (typeof UPLOAD_STATUSES)[number]

export const JOB_STATUSES = ['queued', 'processing', 'verifying', 'completed', 'failed', 'cancelled', 'expired'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

const UPLOAD_TRANSITIONS: Record<UploadStatus, readonly UploadStatus[]> = {
  uploaded: ['validating', 'expired'],
  // A validation interrupted by a crash may be retried, hence validating → validating.
  validating: ['validating', 'validated', 'rejected', 'uploaded', 'expired'],
  validated: ['expired'],
  rejected: ['expired'],
  expired: [],
}

const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ['processing', 'failed', 'cancelled'],
  // processing → processing happens when a crashed attempt is picked up again.
  processing: ['processing', 'verifying', 'queued', 'failed', 'cancelled'],
  verifying: ['processing', 'completed', 'queued', 'failed', 'cancelled'],
  completed: ['expired'],
  failed: ['expired'],
  cancelled: ['expired'],
  expired: [],
}

export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ['queued', 'processing', 'verifying']
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['completed', 'failed', 'cancelled', 'expired']

export function canTransitionUpload(from: UploadStatus, to: UploadStatus): boolean {
  return UPLOAD_TRANSITIONS[from].includes(to)
}

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to)
}

export function isActiveJob(status: JobStatus): boolean {
  return ACTIVE_JOB_STATUSES.includes(status)
}

export class InvalidTransitionError extends Error {
  constructor(entity: string, from: string, to: string) {
    super(`Invalid ${entity} transition ${from} → ${to}`)
    this.name = 'InvalidTransitionError'
  }
}

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransitionJob(from, to)) throw new InvalidTransitionError('job', from, to)
}

export function assertUploadTransition(from: UploadStatus, to: UploadStatus): void {
  if (!canTransitionUpload(from, to)) throw new InvalidTransitionError('upload', from, to)
}

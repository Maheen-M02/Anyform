import type { FormatId } from '@/lib/formats'
import type { JobStatus, UploadStatus } from '@/lib/states'
import type { ErrorCode } from '../errors'
import type { VerificationCheck } from '../conversions/types'
import type { FileInfo, HiddenItem } from '../inspect/types'

export interface StoredError {
  code: ErrorCode
  message: string
}

export interface UploadRecord {
  id: string
  sessionId: string
  originalName: string
  sizeBytes: number
  storageKey: string
  /** Absent on records created before URL import existed. */
  origin?: { kind: 'file' } | { kind: 'url'; host: string; /** Host of the page the media was found on. */ page?: string }
  status: UploadStatus
  info: FileInfo | null
  error: StoredError | null
  createdAt: number
  updatedAt: number
  expiresAt: number
}

/**
 * Evidence that an output was checked, shown to the user and downloadable as
 * a receipt. Everything here was established by re-reading the produced file.
 */
export interface VerificationReport {
  version: 1
  verifiedAt: number
  input: { name: string; format: FormatId; sizeBytes: number; sha256: string }
  output: { name: string; format: FormatId; sizeBytes: number; sha256: string }
  checks: VerificationCheck[]
  hidden: {
    /** Hidden data found in the source when it was uploaded. */
    before: HiddenItem[]
    /** Items of `before` that the output no longer contains. */
    removed: HiddenItem[]
    /** Hidden data found in the output (null when the output format cannot be scanned). */
    remaining: HiddenItem[] | null
  }
  destination: { id: string; label: string; maxBytes: number | null } | null
}

export interface JobOutput {
  storageKey: string
  filename: string
  format: FormatId
  sizeBytes: number
  durationSec: number | null
  details: Record<string, string | number>
  /** Absent on jobs completed before reports existed. */
  report?: VerificationReport
}

export interface JobRecord {
  id: string
  sessionId: string
  uploadId: string
  inputName: string
  inputFormat: FormatId
  outputFormat: FormatId
  adapterIds: string[]
  options: Record<string, unknown>
  /** Destination preset the settings came from (e.g. "discord"), if any. */
  destination?: string | null
  /** Identifies equivalent requests so duplicate submissions return the same job. */
  dedupeKey: string
  status: JobStatus
  /** Fraction in [0, 1] when backed by real encoder progress, otherwise null. */
  progress: number | null
  attempts: number
  cancelRequested: boolean
  error: StoredError | null
  output: JobOutput | null
  createdAt: number
  updatedAt: number
  startedAt: number | null
  finishedAt: number | null
  /** When artifacts expire (outputs for completed jobs). */
  expiresAt: number | null
}

export type Updater<T> = (current: T) => T

/**
 * Persistence for upload and job metadata. Media binaries never go here.
 * `update*` applies the updater atomically with respect to other updates of the
 * same record and returns null when the record does not exist.
 */
export interface MetaStore {
  getUpload(id: string): Promise<UploadRecord | null>
  createUpload(rec: UploadRecord): Promise<void>
  updateUpload(id: string, fn: Updater<UploadRecord>): Promise<UploadRecord | null>
  deleteUpload(id: string): Promise<void>
  listUploads(): Promise<UploadRecord[]>

  getJob(id: string): Promise<JobRecord | null>
  /**
   * Creates the job unless the same session already has a reusable (active or
   * completed) job with the same dedupeKey, in which case that job is returned.
   */
  createJobDeduped(rec: JobRecord): Promise<{ job: JobRecord; created: boolean }>
  updateJob(id: string, fn: Updater<JobRecord>): Promise<JobRecord | null>
  deleteJob(id: string): Promise<void>
  listJobs(): Promise<JobRecord[]>
  listJobsForSession(sessionId: string): Promise<JobRecord[]>

  ping(): Promise<void>
  close(): Promise<void>
}

import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { contentDisposition } from '@/lib/filename'
import { FORMATS, isFormatId, type FormatId } from '@/lib/formats'
import { assertJobTransition, isActiveJob, type JobStatus } from '@/lib/states'
import { getConfig } from '../config'
import { AppError } from '../errors'
import { isId, newId } from '../ids'
import { logger } from '../logger'
import type { Runtime } from '../runtime'
import type { JobRecord } from '../store/types'
import { getOwnedUpload, releaseUpload, sessionUsageBytes } from './uploads'

export interface JobView {
  id: string
  uploadId: string
  status: JobStatus
  progress: number | null
  inputName: string
  inputFormat: FormatId
  outputFormat: FormatId
  options: Record<string, unknown>
  error: { code: string; message: string } | null
  output: {
    filename: string
    format: FormatId
    sizeBytes: number
    durationSec: number | null
    details: Record<string, string | number>
  } | null
  downloadUrl: string | null
  previewUrl: string | null
  createdAt: number
  updatedAt: number
  finishedAt: number | null
  expiresAt: number | null
}

/** Treats completed jobs past their expiry as expired even before cleanup runs. */
function effectiveStatus(job: JobRecord, now = Date.now()): JobStatus {
  if (job.status === 'completed' && job.expiresAt !== null && job.expiresAt <= now) return 'expired'
  return job.status
}

export function jobView(job: JobRecord): JobView {
  const status = effectiveStatus(job)
  const available = status === 'completed' && job.output !== null
  const base = `/api/v1/conversions/${job.id}/download`
  return {
    id: job.id,
    uploadId: job.uploadId,
    status,
    progress: job.progress,
    inputName: job.inputName,
    inputFormat: job.inputFormat,
    outputFormat: job.outputFormat,
    options: job.options,
    error: job.error,
    output: available && job.output
      ? {
          filename: job.output.filename,
          format: job.output.format,
          sizeBytes: job.output.sizeBytes,
          durationSec: job.output.durationSec,
          details: job.output.details,
        }
      : null,
    downloadUrl: available ? base : null,
    previewUrl: available ? `${base}?inline=1` : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    expiresAt: job.expiresAt,
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export interface CreateConversionInput {
  uploadId: string
  outputFormat: string
  options?: Record<string, unknown>
}

export async function createConversion(rt: Runtime, sessionId: string, input: CreateConversionInput): Promise<{ job: JobView; created: boolean }> {
  const cfg = getConfig()
  const upload = await getOwnedUpload(rt, sessionId, input.uploadId)
  if (upload.status !== 'validated' || !upload.info?.format) {
    throw new AppError('UPLOAD_NOT_VALIDATED', 'This file has not passed validation, so it cannot be converted.')
  }
  const info = upload.info
  const inputFormat = info.format!
  if (!isFormatId(input.outputFormat)) throw new AppError('UNSUPPORTED_CONVERSION', 'Unknown output format.')
  const outputFormat = input.outputFormat
  const plan = rt.registry.plan(inputFormat, outputFormat)
  if (!plan) {
    throw new AppError('UNSUPPORTED_CONVERSION', `${FORMATS[inputFormat].label} to ${FORMATS[outputFormat].label} is not supported.`)
  }
  const first = plan.steps[0]!
  const last = plan.steps[plan.steps.length - 1]!
  first.validateInput(info)
  // For single-step plans the final adapter sees the real input; for chains we
  // can only fully validate options once the intermediate file exists.
  const options = plan.steps.length === 1 ? last.validateOptions(input.options ?? {}, info) : (input.options ?? {})

  const sessionJobs = await rt.store.listJobsForSession(sessionId)
  const dedupeKey = createHash('sha256').update(stableJson({ u: upload.id, f: outputFormat, o: options })).digest('hex').slice(0, 32)
  const duplicate = sessionJobs.find((j) => j.dedupeKey === dedupeKey && (isActiveJob(j.status) || effectiveStatus(j) === 'completed'))
  if (duplicate) return { job: jobView(duplicate), created: false }

  if (sessionJobs.filter((j) => isActiveJob(j.status)).length >= cfg.sessionMaxActiveJobs) {
    throw new AppError('QUOTA_EXCEEDED', `You can run at most ${cfg.sessionMaxActiveJobs} conversions at once. Wait for one to finish.`)
  }
  if (plan.steps.length === 1) {
    const estimate = last.estimate(info, options)
    if ((await sessionUsageBytes(rt, sessionId)) + estimate.outputBytes > cfg.sessionQuotaBytes) {
      throw new AppError('QUOTA_EXCEEDED', 'This conversion would exceed your storage limit. Delete earlier conversions first.')
    }
  }

  const now = Date.now()
  const rec: JobRecord = {
    id: newId('job'),
    sessionId,
    uploadId: upload.id,
    inputName: upload.originalName,
    inputFormat,
    outputFormat,
    adapterIds: plan.steps.map((s) => s.id),
    options,
    dedupeKey,
    status: 'queued',
    progress: null,
    attempts: 0,
    cancelRequested: false,
    error: null,
    output: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    expiresAt: null,
  }
  const { job, created } = await rt.store.createJobDeduped(rec)
  if (created) {
    try {
      await rt.queue.enqueue(job.id)
    } catch (err) {
      logger.error('enqueue failed', { jobId: job.id, error: err })
      await rt.store.updateJob(job.id, (j) => ({
        ...j,
        status: 'failed',
        finishedAt: Date.now(),
        error: { code: 'SERVICE_UNAVAILABLE', message: 'The conversion service is temporarily unavailable.' },
      }))
      throw new AppError('SERVICE_UNAVAILABLE', 'The conversion service is temporarily unavailable. Please try again.')
    }
    logger.info('conversion queued', { jobId: job.id, adapters: job.adapterIds, uploadId: upload.id })
  }
  return { job: jobView(job), created }
}

export async function getOwnedJob(rt: Pick<Runtime, 'store'>, sessionId: string, jobId: unknown): Promise<JobRecord> {
  if (!isId(jobId, 'job')) throw new AppError('NOT_FOUND', 'Conversion not found.')
  const job = await rt.store.getJob(jobId)
  if (!job || job.sessionId !== sessionId) throw new AppError('NOT_FOUND', 'Conversion not found.')
  return job
}

export async function listConversions(rt: Pick<Runtime, 'store'>, sessionId: string): Promise<JobView[]> {
  const jobs = await rt.store.listJobsForSession(sessionId)
  return jobs.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(jobView)
}

export async function cancelConversion(rt: Pick<Runtime, 'store'>, sessionId: string, jobId: unknown): Promise<JobView> {
  const job = await getOwnedJob(rt, sessionId, jobId)
  if (!isActiveJob(job.status)) throw new AppError('JOB_NOT_ACTIVE', 'This conversion has already finished.')
  const updated = await rt.store.updateJob(job.id, (j) => {
    if (!isActiveJob(j.status)) return j
    // Queued jobs are cancelled immediately; running ones are stopped by the worker.
    if (j.status === 'queued') {
      assertJobTransition(j.status, 'cancelled')
      return { ...j, status: 'cancelled', cancelRequested: true, finishedAt: Date.now(), updatedAt: Date.now() }
    }
    return { ...j, cancelRequested: true, updatedAt: Date.now() }
  })
  return jobView(updated ?? job)
}

export async function deleteConversion(rt: Pick<Runtime, 'store' | 'storage'>, sessionId: string, jobId: unknown): Promise<void> {
  const job = await getOwnedJob(rt, sessionId, jobId)
  if (isActiveJob(job.status)) throw new AppError('JOB_ACTIVE', 'Cancel this conversion before deleting it.')
  if (job.output) await rt.storage.delete(job.output.storageKey)
  await rt.store.deleteJob(job.id)
  await releaseUpload(rt, job.uploadId)
}

export function parseRange(header: string | null, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid'
  let start: number
  let end: number
  if (m[1] === '') {
    const suffix = Number(m[2])
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start > end || start >= size) return 'invalid'
  return { start, end }
}

/** Serves an owned, completed, unexpired output with HTTP range support. */
export async function downloadConversion(rt: Pick<Runtime, 'store' | 'storage'>, sessionId: string, jobId: unknown, req: Request): Promise<Response> {
  const job = await getOwnedJob(rt, sessionId, jobId)
  const status = effectiveStatus(job)
  if (status === 'expired') throw new AppError('RESULT_EXPIRED', 'This file has expired and was deleted. Convert the original again.')
  if (status !== 'completed' || !job.output) throw new AppError('RESULT_NOT_READY', 'This conversion has not finished.')
  const obj = await rt.storage.stat(job.output.storageKey)
  if (!obj) throw new AppError('RESULT_EXPIRED', 'This file is no longer available.')

  const inline = new URL(req.url).searchParams.get('inline') === '1'
  const headers = new Headers({
    'content-type': FORMATS[job.output.format].mime,
    'content-disposition': contentDisposition(job.output.filename, inline ? 'inline' : 'attachment'),
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  })
  const range = parseRange(req.headers.get('range'), obj.sizeBytes)
  if (range === 'invalid') {
    headers.set('content-range', `bytes */${obj.sizeBytes}`)
    return new Response(null, { status: 416, headers })
  }
  const stream = rt.storage.read(job.output.storageKey, range ?? undefined)
  const body = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
  if (range) {
    headers.set('content-range', `bytes ${range.start}-${range.end}/${obj.sizeBytes}`)
    headers.set('content-length', String(range.end - range.start + 1))
    return new Response(body, { status: 206, headers })
  }
  headers.set('content-length', String(obj.sizeBytes))
  return new Response(body, { status: 200, headers })
}

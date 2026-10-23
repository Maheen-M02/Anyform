import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { FORMATS } from '@/lib/formats'
import { assertJobTransition, isActiveJob, type JobStatus } from '@/lib/states'
import { outputFilename } from '@/lib/filename'
import type { ConversionRegistry } from '../conversions/registry'
import { getConfig } from '../config'
import { AppError, toAppError } from '../errors'
import { newId } from '../ids'
import { logger } from '../logger'
import { inspectFile, type FileInfo } from '../inspect'
import { ToolError } from '../media/process'
import { metrics } from '../metrics'
import { storageKey, type StorageDriver } from '../storage'
import type { JobRecord, MetaStore } from '../store/types'
import type { JobQueue } from './queue'
import { buildReport } from './report'

export interface ProcessorDeps {
  store: MetaStore
  storage: StorageDriver
  registry: ConversionRegistry
  queue: JobQueue
}

const CANCEL_POLL_MS = 750
const PROGRESS_WRITE_MS = 500

/** Moves a job to a new status, enforcing the state machine. */
function transition(job: JobRecord, to: JobStatus, patch: Partial<JobRecord> = {}): JobRecord {
  assertJobTransition(job.status, to)
  return { ...job, ...patch, status: to, updatedAt: Date.now() }
}

class CancelledError extends Error {}

/**
 * Executes one attempt of a conversion job. Safe to call more than once for the
 * same job: terminal jobs are ignored and crashed attempts are counted.
 */
export async function processJob(deps: ProcessorDeps, jobId: string): Promise<void> {
  const cfg = getConfig()
  const { store, storage, registry, queue } = deps
  const log = logger.child({ jobId })

  const initial = await store.getJob(jobId)
  if (!initial || !isActiveJob(initial.status)) return
  if (initial.cancelRequested) {
    await store.updateJob(jobId, (j) => (isActiveJob(j.status) ? transition(j, 'cancelled', { finishedAt: Date.now(), progress: null }) : j))
    return
  }

  // Claim the job. A job found in processing/verifying is a crashed attempt being resumed.
  const claimed = await store.updateJob(jobId, (j) => {
    if (!isActiveJob(j.status)) return j
    return transition(j, 'processing', { attempts: j.attempts + 1, startedAt: Date.now(), progress: null, error: null })
  })
  if (!claimed || claimed.status !== 'processing') return
  if (claimed.attempts > cfg.jobMaxAttempts) {
    await failJob(store, jobId, new AppError('CONVERSION_FAILED', 'Processing was interrupted repeatedly and has been stopped.'))
    metrics.inc('worker_failures_total', { reason: 'attempts_exhausted' })
    return
  }
  if (claimed.attempts === 1) metrics.observe('queue_wait_seconds', (Date.now() - claimed.createdAt) / 1000)

  const started = Date.now()
  const scratch = path.join(cfg.scratchDir, `${jobId}-${claimed.attempts}`)
  const controller = new AbortController()
  let timedOut = false
  let cancelled = false
  const deadline = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, cfg.jobTimeoutMs)
  const poller = setInterval(() => {
    store
      .getJob(jobId)
      .then((j) => {
        if (j?.cancelRequested) {
          cancelled = true
          controller.abort()
        }
      })
      .catch(() => undefined)
  }, CANCEL_POLL_MS)
  let outputKey: string | null = null

  try {
    const upload = await store.getUpload(claimed.uploadId)
    if (!upload || upload.status !== 'validated' || !upload.info) {
      throw new AppError('UPLOAD_EXPIRED', 'The original file is no longer available. Please upload it again.')
    }
    const steps = claimed.adapterIds.map((id) => {
      const adapter = registry.get(id)
      if (!adapter) throw new AppError('UNSUPPORTED_CONVERSION', 'This conversion is no longer available.')
      return adapter
    })

    await mkdir(scratch, { recursive: true, mode: 0o700 })
    const sourcePath = await storage.localPath(upload.storageKey)
    let inputPath = sourcePath
    let info: FileInfo = upload.info
    let lastProgressWrite = 0

    for (let i = 0; i < steps.length; i++) {
      const adapter = steps[i]!
      const isLast = i === steps.length - 1
      adapter.validateInput(info)
      // User options apply to the final step; intermediate steps use defaults.
      const options = adapter.validateOptions(isLast ? claimed.options : {}, info)

      const estimate = adapter.estimate(info, options)
      const free = await storage.freeBytes()
      if (free - estimate.outputBytes < cfg.minFreeDiskBytes) {
        throw new AppError('INSUFFICIENT_STORAGE', 'The server is temporarily low on storage. Please try again shortly.', { retryable: true })
      }

      // Fixed scratch names (never user input); the extension is cosmetic.
      const outPath = path.join(scratch, `step-${i}.${FORMATS[adapter.outputFormat].extension}`)
      const remaining = cfg.jobTimeoutMs - (Date.now() - started)
      await adapter.convert({
        inputPath,
        outputPath: outPath,
        info,
        options,
        signal: controller.signal,
        timeoutMs: Math.max(1000, remaining),
        onProgress: (fraction) => {
          const now = Date.now()
          if (now - lastProgressWrite < PROGRESS_WRITE_MS) return
          lastProgressWrite = now
          const overall = (i + fraction) / steps.length
          void store.updateJob(jobId, (j) => (j.status === 'processing' ? { ...j, progress: overall, updatedAt: now } : j)).catch(() => undefined)
        },
      })
      if (controller.signal.aborted) throw new CancelledError()

      if (isLast) {
        await store.updateJob(jobId, (j) => transition(j, 'verifying', { progress: 1 }))
        const verified = await adapter.verifyOutput({
          outputPath: outPath,
          info,
          options,
          signal: controller.signal,
          timeoutMs: Math.max(1000, cfg.jobTimeoutMs - (Date.now() - started)),
        })
        if (controller.signal.aborted) throw new CancelledError()
        const filename = outputFilename(claimed.inputName, FORMATS[verified.format].extension)
        const report = await buildReport({ job: claimed, upload, verified, sourcePath, outputPath: outPath, outputName: filename, signal: controller.signal })
        if (controller.signal.aborted) throw new CancelledError()

        outputKey = storageKey('outputs', newId('out'))
        const { sizeBytes } = await storage.importFile(outputKey, outPath)
        const finishedAt = Date.now()
        const done = await store.updateJob(jobId, (j) =>
          transition(j, 'completed', {
            progress: 1,
            finishedAt,
            expiresAt: finishedAt + cfg.resultTtlMs,
            output: {
              storageKey: outputKey!,
              filename,
              format: verified.format,
              sizeBytes,
              durationSec: verified.durationSec,
              details: verified.details,
              report,
            },
          }),
        )
        if (!done) throw new CancelledError() // deleted while running
        metrics.inc('conversions_total', { result: 'completed', adapter: claimed.adapterIds.join('+') })
        metrics.observe('conversion_seconds', (finishedAt - started) / 1000)
        metrics.observe('output_bytes', sizeBytes)
        log.info('conversion completed', { durationMs: finishedAt - started, outputBytes: sizeBytes, attempt: claimed.attempts })
        outputKey = null // ownership passed to the job record
      } else {
        // Re-inspect the intermediate output so the next adapter sees real media facts.
        info = await inspectFile(outPath, { signal: controller.signal })
        inputPath = outPath
      }
    }
  } catch (err) {
    if (outputKey) await storage.delete(outputKey).catch(() => undefined)
    const aborted = err instanceof CancelledError || (err instanceof ToolError && err.kind === 'aborted') || controller.signal.aborted

    if (aborted && cancelled) {
      await store.updateJob(jobId, (j) => (isActiveJob(j.status) ? transition(j, 'cancelled', { finishedAt: Date.now(), progress: null }) : j))
      metrics.inc('conversions_total', { result: 'cancelled' })
      log.info('conversion cancelled')
      return
    }
    const appErr = aborted && timedOut ? new AppError('CONVERSION_TIMEOUT', 'The conversion took too long and was stopped.') : toAppError(err)
    if (appErr.code === 'INTERNAL_ERROR' || appErr.code === 'SERVICE_UNAVAILABLE') {
      log.error('conversion attempt crashed', { error: err, attempt: claimed.attempts })
    }

    if (appErr.retryable && claimed.attempts < cfg.jobMaxAttempts) {
      const requeued = await store.updateJob(jobId, (j) =>
        isActiveJob(j.status) && !j.cancelRequested ? transition(j, 'queued', { progress: null }) : j,
      )
      if (requeued?.status === 'queued') {
        await queue.enqueue(jobId, { delayMs: 2000 * claimed.attempts, attempt: claimed.attempts })
        log.warn('conversion attempt failed, retrying', { code: appErr.code, attempt: claimed.attempts })
        return
      }
    }
    await failJob(store, jobId, appErr)
    metrics.inc('conversions_total', { result: 'failed', code: appErr.code })
    log.warn('conversion failed', { code: appErr.code, attempt: claimed.attempts })
  } finally {
    clearTimeout(deadline)
    clearInterval(poller)
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function failJob(store: MetaStore, jobId: string, err: AppError) {
  const now = Date.now()
  await store.updateJob(jobId, (j) =>
    isActiveJob(j.status)
      ? transition(j, 'failed', {
          finishedAt: now,
          progress: null,
          error: { code: err.code, message: err.message },
        })
      : j,
  )
}

/**
 * Re-enqueues jobs left active by a previous process (local mode). Jobs that
 * were mid-flight are resumed as a new attempt by processJob.
 */
export async function recoverJobs(deps: ProcessorDeps): Promise<number> {
  const jobs = (await deps.store.listJobs()).filter((j) => isActiveJob(j.status))
  for (const job of jobs.sort((a, b) => a.createdAt - b.createdAt)) await deps.queue.enqueue(job.id, { attempt: job.attempts })
  if (jobs.length) logger.info('recovered unfinished jobs', { count: jobs.length })
  return jobs.length
}

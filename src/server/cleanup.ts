import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { isActiveJob } from '@/lib/states'
import { getConfig } from './config'
import { logger } from './logger'
import { metrics } from './metrics'
import type { StorageDriver } from './storage'
import type { MetaStore } from './store/types'

export interface CleanupDeps {
  store: MetaStore
  storage: StorageDriver
}

export interface CleanupReport {
  uploadsExpired: number
  outputsExpired: number
  recordsDeleted: number
  orphansDeleted: number
  scratchDeleted: number
}

/**
 * Deletes expired uploads and outputs, prunes old metadata, removes orphaned
 * objects (e.g. abandoned partial uploads) and stale scratch directories.
 * Idempotent and safe to run concurrently with request handling.
 */
export async function runCleanup(deps: CleanupDeps, now = Date.now()): Promise<CleanupReport> {
  const cfg = getConfig()
  const { store, storage } = deps
  const report: CleanupReport = { uploadsExpired: 0, outputsExpired: 0, recordsDeleted: 0, orphansDeleted: 0, scratchDeleted: 0 }

  const jobs = await store.listJobs()
  const uploadsInUse = new Set(jobs.filter((j) => isActiveJob(j.status)).map((j) => j.uploadId))

  for (const job of jobs) {
    const expiresAt = job.expiresAt ?? (job.finishedAt !== null ? job.finishedAt + cfg.resultTtlMs : null)
    if (!isActiveJob(job.status) && job.status !== 'expired' && expiresAt !== null && expiresAt <= now) {
      if (job.output) await storage.delete(job.output.storageKey)
      await store.updateJob(job.id, (j) => (j.status === 'expired' || isActiveJob(j.status) ? j : { ...j, status: 'expired', updatedAt: now }))
      if (job.output) report.outputsExpired++
    }
    const retainUntil = (expiresAt ?? job.createdAt) + cfg.metadataRetentionMs
    if (job.status === 'expired' && retainUntil <= now) {
      await store.deleteJob(job.id)
      report.recordsDeleted++
    }
  }

  for (const upload of await store.listUploads()) {
    if (upload.status !== 'expired' && upload.expiresAt <= now && !uploadsInUse.has(upload.id)) {
      await storage.delete(upload.storageKey)
      await store.updateUpload(upload.id, (u) => ({ ...u, status: 'expired', updatedAt: now }))
      report.uploadsExpired++
    } else if (upload.status === 'expired' && upload.expiresAt + cfg.metadataRetentionMs <= now) {
      await store.deleteUpload(upload.id)
      report.recordsDeleted++
    }
  }

  // Objects not referenced by any live record and older than the upload TTL are orphans.
  const referenced = new Set<string>()
  for (const u of await store.listUploads()) if (u.status !== 'expired') referenced.add(u.storageKey)
  for (const j of await store.listJobs()) if (j.output && j.status !== 'expired') referenced.add(j.output.storageKey)
  for (const obj of await storage.list()) {
    if (!referenced.has(obj.key) && now - obj.modifiedAt > cfg.uploadTtlMs) {
      await storage.delete(obj.key)
      report.orphansDeleted++
    }
  }

  // Scratch directories outlive their job only if a worker crashed.
  const scratchMaxAge = cfg.jobTimeoutMs + 10 * 60_000
  for (const name of await readdir(cfg.scratchDir).catch(() => [] as string[])) {
    const dir = path.join(cfg.scratchDir, name)
    const s = await stat(dir).catch(() => null)
    if (s && now - s.mtimeMs > scratchMaxAge) {
      await rm(dir, { recursive: true, force: true })
      report.scratchDeleted++
    }
  }

  metrics.inc('cleanup_uploads_expired_total', undefined, report.uploadsExpired)
  metrics.inc('cleanup_outputs_expired_total', undefined, report.outputsExpired)
  metrics.inc('cleanup_orphans_deleted_total', undefined, report.orphansDeleted)
  if (Object.values(report).some((v) => v > 0)) logger.info('cleanup completed', { ...report })
  return report
}

export function startCleanupTimer(deps: CleanupDeps): NodeJS.Timeout {
  const cfg = getConfig()
  let running = false
  const t = setInterval(() => {
    if (running) return
    running = true
    runCleanup(deps)
      .catch((err) => logger.error('cleanup failed', { error: err }))
      .finally(() => (running = false))
  }, cfg.cleanupIntervalMs)
  t.unref?.()
  return t
}

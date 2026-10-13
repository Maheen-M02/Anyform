import { Redis } from 'ioredis'
import { registry } from './conversions'
import type { ConversionRegistry } from './conversions/registry'
import { getConfig } from './config'
import { processJob, recoverJobs } from './jobs/processor'
import { BullJobQueue, LocalJobQueue, type JobQueue } from './jobs/queue'
import { logger } from './logger'
import { LocalStorageDriver, type StorageDriver } from './storage'
import { FileMetaStore } from './store/file-store'
import { RedisMetaStore } from './store/redis-store'
import type { MetaStore } from './store/types'
import { startCleanupTimer } from './cleanup'

export interface Runtime {
  /** `local`: single process, file metadata, in-process queue. `redis`: BullMQ + Redis metadata + separate workers. */
  mode: 'local' | 'redis'
  store: MetaStore
  storage: StorageDriver
  queue: JobQueue
  registry: ConversionRegistry
  close(): Promise<void>
}

export function createRuntime(opts: { role: 'web' | 'worker' }): Runtime {
  const cfg = getConfig()
  const storage = new LocalStorageDriver(cfg.storageDir)
  const maxRecordAgeMs = Math.max(cfg.uploadTtlMs, cfg.resultTtlMs) + cfg.metadataRetentionMs + 3_600_000

  if (cfg.redisUrl) {
    const redis = new Redis(cfg.redisUrl, { maxRetriesPerRequest: 3, lazyConnect: false })
    redis.on('error', (err) => logger.error('redis error', { error: err }))
    const store = new RedisMetaStore(redis, maxRecordAgeMs)
    const queue = new BullJobQueue(cfg.redisUrl)
    return {
      mode: 'redis',
      store,
      storage,
      queue,
      registry,
      async close() {
        await queue.close()
        await store.close()
      },
    }
  }

  const store = new FileMetaStore(cfg.metaDir)
  const rt: Runtime = {
    mode: 'local',
    store,
    storage,
    registry,
    queue: new LocalJobQueue((id) => processJob(rt, id), cfg.workerConcurrency),
    async close() {
      await rt.queue.close()
    },
  }
  if (opts.role === 'web') logger.info('running in local mode: in-process queue, file metadata store', { concurrency: cfg.workerConcurrency })
  return rt
}

const globalKey = Symbol.for('anyform.runtime')
type GlobalWithRuntime = typeof globalThis & { [globalKey]?: Runtime }

/**
 * Process-wide runtime for the web server. Cached on globalThis so that
 * development hot reloads do not spawn duplicate queues.
 */
export function getRuntime(): Runtime {
  const g = globalThis as GlobalWithRuntime
  if (!g[globalKey]) {
    const rt = createRuntime({ role: 'web' })
    g[globalKey] = rt
    if (rt.mode === 'local') {
      // The web process is also the worker in local mode.
      void recoverJobs(rt).catch((err) => logger.error('job recovery failed', { error: err }))
      startCleanupTimer(rt)
    }
  }
  return g[globalKey]!
}

/** Test hook. */
export async function resetRuntime(): Promise<void> {
  const g = globalThis as GlobalWithRuntime
  await g[globalKey]?.close()
  delete g[globalKey]
}

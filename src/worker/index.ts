/**
 * Dedicated conversion worker for Redis/BullMQ deployments.
 * Run one or more of these alongside the web server: `npm run worker`.
 */
import { startCleanupTimer } from '@/server/cleanup'
import { getConfig } from '@/server/config'
import { processJob } from '@/server/jobs/processor'
import { startBullWorker } from '@/server/jobs/queue'
import { logger } from '@/server/logger'
import { createRuntime } from '@/server/runtime'

async function main() {
  const cfg = getConfig()
  if (!cfg.redisUrl) {
    logger.error('REDIS_URL is not set. In local mode the web server processes jobs itself; no worker is needed.')
    process.exit(1)
  }
  const rt = createRuntime({ role: 'worker' })
  await rt.store.ping()
  const worker = startBullWorker(cfg.redisUrl, (id) => processJob(rt, id), cfg.workerConcurrency)
  const cleanup = startCleanupTimer(rt)
  logger.info('worker started', { concurrency: cfg.workerConcurrency })

  const shutdown = async (signal: string) => {
    logger.info('worker shutting down', { signal })
    clearInterval(cleanup)
    // Waits for running conversions to finish; unfinished ones are retried by another worker.
    await worker.close()
    await rt.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  logger.error('worker failed to start', { error: err })
  process.exit(1)
})

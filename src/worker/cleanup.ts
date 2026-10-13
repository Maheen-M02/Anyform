/**
 * One-off cleanup run (e.g. from cron): `npm run cleanup`.
 * Removes expired uploads/outputs, old metadata, orphaned objects and stale scratch files.
 */
import { runCleanup } from '@/server/cleanup'
import { logger } from '@/server/logger'
import { createRuntime } from '@/server/runtime'

async function main() {
  const rt = createRuntime({ role: 'worker' })
  try {
    const report = await runCleanup(rt)
    logger.info('cleanup finished', { ...report })
  } finally {
    await rt.close()
  }
}

main().catch((err) => {
  logger.error('cleanup failed', { error: err })
  process.exit(1)
})

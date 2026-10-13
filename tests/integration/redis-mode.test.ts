/**
 * Redis/BullMQ deployment mode: the web runtime only enqueues, and a separately
 * constructed worker runtime (own connections, as in `npm run worker`) processes.
 *
 * Requires a disposable Redis instance; the database is flushed.
 *   TEST_REDIS_URL=redis://localhost:6390/15 npm test
 */
import { Redis } from 'ioredis'
import type { Worker } from 'bullmq'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetConfig } from '@/server/config'
import { processJob } from '@/server/jobs/processor'
import { startBullWorker } from '@/server/jobs/queue'
import { createRuntime, resetRuntime, type Runtime } from '@/server/runtime'
import { ensureFixtures, fixture } from '../helpers/fixtures'
import { TestClient } from '../helpers/client'

const url = process.env.TEST_REDIS_URL

describe.skipIf(!url)('redis mode (BullMQ + Redis metadata)', () => {
  let worker: Worker
  let workerRt: Runtime

  beforeAll(async () => {
    ensureFixtures()
    const admin = new Redis(url!)
    await admin.flushdb()
    await admin.quit()
    process.env.REDIS_URL = url
    resetConfig()
    await resetRuntime()
    workerRt = createRuntime({ role: 'worker' })
    worker = startBullWorker(url!, (id) => processJob(workerRt, id), 2)
  })

  afterAll(async () => {
    await worker?.close()
    await workerRt?.close()
    await resetRuntime()
    delete process.env.REDIS_URL
    resetConfig()
  })

  it('converts through the durable queue and a separate worker', async () => {
    const client = new TestClient()
    const { upload } = await client.prepare(fixture('video-audio.mp4'))
    expect(upload!.status).toBe('validated')
    const { body } = await client.convert({ uploadId: upload!.id, outputFormat: 'mp3', options: { bitrate: 128 } })
    const job = await client.waitFor(body.job.id)
    expect(job.status).toBe('completed')
    expect(job.output?.details.bitrateKbps).toBe(128)
    const dl = await client.download(job.id)
    expect(dl.status).toBe(200)
    expect(Buffer.from(await dl.arrayBuffer()).subarray(0, 3).toString()).toBe('ID3')
  })

  it('deduplicates concurrent identical submissions atomically', async () => {
    const client = new TestClient()
    const { upload } = await client.prepare(fixture('audio-only.mp4'))
    const results = await Promise.all(Array.from({ length: 5 }, () => client.convert({ uploadId: upload!.id, outputFormat: 'mp3' })))
    const ids = new Set(results.map((r) => r.body.job.id))
    expect(ids.size).toBe(1)
    expect(results.filter((r) => r.body.created)).toHaveLength(1)
    await client.waitFor([...ids][0]!)
  })

  it('keeps sessions isolated', async () => {
    const owner = new TestClient()
    const { upload } = await owner.prepare(fixture('audio-only.mp4'))
    const { body } = await owner.convert({ uploadId: upload!.id, outputFormat: 'mp3', options: { bitrate: 320 } })
    await owner.waitFor(body.job.id)
    expect((await new TestClient().job(body.job.id)).res.status).toBe(404)
  })

  it('cancels a job across processes', async () => {
    const client = new TestClient()
    const { upload } = await client.prepare(fixture('long.wav'))
    const { body } = await client.convert({ uploadId: upload!.id, outputFormat: 'mp3' })
    await client.cancel(body.job.id)
    const job = await client.waitFor(body.job.id)
    expect(job.status).toBe('cancelled')
  })
})

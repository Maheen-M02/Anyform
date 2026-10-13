import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getConfig, resetConfig } from '@/server/config'
import { ConversionRegistry } from '@/server/conversions/registry'
import type { ConversionAdapter } from '@/server/conversions/types'
import { AppError } from '@/server/errors'
import { newId } from '@/server/ids'
import { processJob, recoverJobs, type ProcessorDeps } from '@/server/jobs/processor'
import { LocalJobQueue } from '@/server/jobs/queue'
import type { FileInfo } from '@/server/inspect/types'
import { runTool, ToolError } from '@/server/media/process'
import { LocalStorageDriver, storageKey } from '@/server/storage'
import { FileMetaStore } from '@/server/store/file-store'
import type { JobRecord } from '@/server/store/types'

const info: FileInfo = {
  kind: 'av',
  family: 'wav',
  format: 'wav',
  sizeBytes: 10,
  media: {
    family: 'wav',
    format: 'wav',
    formatName: 'wav',
    majorBrand: null,
    durationSec: 1,
    bitRate: null,
    sizeBytes: 10,
    videoStreams: [],
    audioStreams: [
      { index: 0, ordinal: 0, codec: 'pcm_s16le', codecLongName: null, channels: 1, channelLayout: 'mono', sampleRate: 44100, bitRate: null, durationSec: 1, startTimeSec: 0, language: null, title: null, isDefault: true, decodable: true },
    ],
  },
}

type Behaviour = (ctx: { signal: AbortSignal; outputPath: string; attempt: number }) => Promise<void>

function fakeAdapter(behaviour: Behaviour): ConversionAdapter<Record<string, never>> {
  let attempt = 0
  return {
    id: 'fake-wav-to-mp3',
    label: 'Fake',
    inputFormats: ['wav'],
    outputFormat: 'mp3',
    requiredTools: [],
    lossy: true,
    notes: [],
    optionFields: () => [],
    validateInput: () => undefined,
    validateOptions: () => ({}),
    estimate: () => ({ outputBytes: 100, cpuSeconds: 0 }),
    convert: (ctx) => behaviour({ signal: ctx.signal, outputPath: ctx.outputPath, attempt: ++attempt }),
    verifyOutput: async (ctx) => ({ format: 'mp3', sizeBytes: statSync(ctx.outputPath).size, durationSec: 1, details: {} }),
  }
}

function waitForAbort(signal: AbortSignal) {
  return new Promise<void>((_, reject) => {
    signal.addEventListener('abort', () => reject(new ToolError('aborted', 'aborted')), { once: true })
  })
}

async function setup(behaviour: Behaviour, opts: { freeBytes?: number } = {}) {
  const cfg = getConfig()
  const store = new FileMetaStore(path.join(cfg.dataDir, 'proc-meta'))
  const storage = new LocalStorageDriver(path.join(cfg.dataDir, 'proc-objects'))
  if (opts.freeBytes !== undefined) storage.freeBytes = async () => opts.freeBytes!
  const registry = new ConversionRegistry().register(fakeAdapter(behaviour))
  const deps: ProcessorDeps = { store, storage, registry, queue: null as unknown as LocalJobQueue }
  const queue = new LocalJobQueue((id) => processJob(deps, id), 2)
  deps.queue = queue

  const uploadId = newId('upl')
  const key = storageKey('uploads', uploadId)
  await storage.write(key, Readable.from([Buffer.from('RIFF....WAVE')]), { maxBytes: 100 })
  const now = Date.now()
  await store.createUpload({ id: uploadId, sessionId: 's', originalName: 'a.wav', sizeBytes: 12, storageKey: key, status: 'validated', info, error: null, createdAt: now, updatedAt: now, expiresAt: now + 60_000 })
  const id = newId('job')
  const job: JobRecord = {
    id, sessionId: 's', uploadId, inputName: 'a.wav', inputFormat: 'wav', outputFormat: 'mp3', adapterIds: ['fake-wav-to-mp3'],
    options: {}, dedupeKey: id, status: 'queued', progress: null, attempts: 0, cancelRequested: false, error: null, output: null,
    createdAt: now, updatedAt: now, startedAt: null, finishedAt: null, expiresAt: null,
  }
  await store.createJobDeduped(job)
  return { deps, store, storage, queue, jobId: job.id }
}

function scratchEntries(jobId: string) {
  const dir = getConfig().scratchDir
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(jobId)) : []
}

afterEach(() => {
  delete process.env.JOB_TIMEOUT_SECONDS
  resetConfig()
})

describe('job processor', () => {
  it('cancels a running conversion and removes partial output', async () => {
    let started!: () => void
    const running = new Promise<void>((r) => (started = r))
    const { deps, store, jobId } = await setup(async ({ signal, outputPath }) => {
      writeFileSync(outputPath, 'partial')
      started()
      await waitForAbort(signal)
    })
    const done = processJob(deps, jobId)
    await running
    await store.updateJob(jobId, (j) => ({ ...j, cancelRequested: true }))
    await done
    const job = await store.getJob(jobId)
    expect(job!.status).toBe('cancelled')
    expect(job!.output).toBeNull()
    expect(scratchEntries(jobId)).toEqual([])
  })

  it('times out a conversion that runs too long', async () => {
    process.env.JOB_TIMEOUT_SECONDS = '1'
    resetConfig()
    const { deps, store, jobId } = await setup(({ signal }) => waitForAbort(signal))
    await processJob(deps, jobId)
    const job = await store.getJob(jobId)
    expect(job!.status).toBe('failed')
    expect(job!.error?.code).toBe('CONVERSION_TIMEOUT')
  })

  it('retries transient failures and then succeeds', async () => {
    const { store, queue, jobId } = await setup(async ({ attempt, outputPath }) => {
      if (attempt === 1) throw new AppError('SERVICE_UNAVAILABLE', 'flaky', { retryable: true })
      writeFileSync(outputPath, 'mp3')
    })
    await queue.enqueue(jobId)
    for (let i = 0; i < 100 && (await store.getJob(jobId))!.status !== 'completed'; i++) await new Promise((r) => setTimeout(r, 100))
    const job = await store.getJob(jobId)
    expect(job!.status).toBe('completed')
    expect(job!.attempts).toBe(2)
    await queue.close()
  })

  it('does not retry failures caused by the file itself', async () => {
    let calls = 0
    const { deps, store, jobId } = await setup(async () => {
      calls++
      throw new AppError('CONVERSION_FAILED', 'bad file')
    })
    await processJob(deps, jobId)
    expect(calls).toBe(1)
    expect((await store.getJob(jobId))!.status).toBe('failed')
  })

  it('fails with a retryable error when disk space is insufficient', async () => {
    const { deps, store, jobId } = await setup(async () => undefined, { freeBytes: 0 })
    process.env.MIN_FREE_DISK_MB = '1'
    resetConfig()
    try {
      await processJob(deps, jobId)
      let job = await store.getJob(jobId)
      expect(job!.status).toBe('queued') // first attempt: scheduled for retry
      await processJob(deps, jobId)
      job = await store.getJob(jobId)
      expect(job!.status).toBe('failed')
      expect(job!.error?.code).toBe('INSUFFICIENT_STORAGE')
    } finally {
      process.env.MIN_FREE_DISK_MB = '0'
      await deps.queue.close()
    }
  })

  it('recovers a job orphaned by a worker crash and bounds repeated crashes', async () => {
    const { deps, store, jobId } = await setup(async ({ outputPath }) => writeFileSync(outputPath, 'ok'))
    // Simulate a crash: job stuck in processing after attempts are exhausted.
    await store.updateJob(jobId, (j) => ({ ...j, status: 'processing', attempts: getConfig().jobMaxAttempts }))
    await processJob(deps, jobId)
    expect((await store.getJob(jobId))!.status).toBe('failed')

    const second = await setup(async ({ outputPath }) => writeFileSync(outputPath, 'ok'))
    await second.store.updateJob(second.jobId, (j) => ({ ...j, status: 'processing', attempts: 1 }))
    expect(await recoverJobs(second.deps)).toBeGreaterThanOrEqual(1)
    await (second.queue as LocalJobQueue).onIdle()
    expect((await second.store.getJob(second.jobId))!.status).toBe('completed')
  })

  it('skips jobs cancelled while queued', async () => {
    let calls = 0
    const { deps, store, jobId } = await setup(async () => void calls++)
    await store.updateJob(jobId, (j) => ({ ...j, status: 'cancelled', cancelRequested: true }))
    await processJob(deps, jobId)
    expect(calls).toBe(0)
  })
})

describe('FFmpeg process control', () => {
  const infinite = ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-f', 'null', '-']

  it('kills FFmpeg when cancelled', async () => {
    const ac = new AbortController()
    const started = Date.now()
    setTimeout(() => ac.abort(), 2500)
    await expect(runTool(getConfig().ffmpegPath, infinite, { timeoutMs: 60_000, signal: ac.signal })).rejects.toMatchObject({ kind: 'aborted' })
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('kills FFmpeg on timeout', async () => {
    await expect(runTool(getConfig().ffmpegPath, infinite, { timeoutMs: 2500 })).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('reports a missing binary as a spawn error', async () => {
    await expect(runTool('anyform-no-such-binary', [], { timeoutMs: 1000 })).rejects.toMatchObject({ kind: 'spawn' })
  })
})

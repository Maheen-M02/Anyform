import { Queue, Worker } from 'bullmq'
import { logger } from '../logger'

export const QUEUE_NAME = 'anyform-conversions'

export interface JobQueue {
  /** Whether queued work survives a process restart. */
  readonly durable: boolean
  enqueue(jobId: string, opts?: { delayMs?: number; attempt?: number }): Promise<void>
  /** Number of jobs waiting plus running in this queue (best effort). */
  depth(): Promise<number>
  close(): Promise<void>
}

export type JobProcessor = (jobId: string) => Promise<void>

/**
 * In-process queue with bounded concurrency for local development and
 * single-node deployments. It is NOT durable on its own: pending work is
 * reconstructed from the metadata store on startup (see recoverJobs).
 */
export class LocalJobQueue implements JobQueue {
  readonly durable = false
  private readonly pending: string[] = []
  private readonly queued = new Set<string>()
  private readonly timers = new Set<NodeJS.Timeout>()
  private running = 0
  private closed = false
  private idleWaiters: (() => void)[] = []

  constructor(
    private readonly processor: JobProcessor,
    private readonly concurrency: number,
  ) {}

  async enqueue(jobId: string, opts: { delayMs?: number } = {}) {
    if (this.closed) return
    if (opts.delayMs && opts.delayMs > 0) {
      const t = setTimeout(() => {
        this.timers.delete(t)
        void this.enqueue(jobId)
      }, opts.delayMs)
      t.unref?.()
      this.timers.add(t)
      return
    }
    if (this.queued.has(jobId)) return
    this.queued.add(jobId)
    this.pending.push(jobId)
    this.pump()
  }

  private pump() {
    while (!this.closed && this.running < this.concurrency && this.pending.length > 0) {
      const id = this.pending.shift()!
      this.queued.delete(id)
      this.running++
      this.processor(id)
        .catch((err) => logger.error('job processor crashed', { jobId: id, error: err }))
        .finally(() => {
          this.running--
          this.pump()
          if (this.running === 0 && this.pending.length === 0) {
            this.idleWaiters.splice(0).forEach((w) => w())
          }
        })
    }
  }

  async depth() {
    return this.pending.length + this.running + this.timers.size
  }

  /** Resolves once nothing is queued or running (used by tests). */
  onIdle(): Promise<void> {
    if (this.running === 0 && this.pending.length === 0) return Promise.resolve()
    return new Promise((r) => this.idleWaiters.push(r))
  }

  async close() {
    this.closed = true
    this.timers.forEach(clearTimeout)
    this.timers.clear()
    this.pending.length = 0
  }
}

function redisConnection(url: string) {
  const u = new URL(url)
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  }
}

/** Producer side of the durable BullMQ queue (used by the web process). */
export class BullJobQueue implements JobQueue {
  readonly durable = true
  private readonly queue: Queue

  constructor(redisUrl: string) {
    this.queue = new Queue(QUEUE_NAME, { connection: redisConnection(redisUrl) })
  }

  async enqueue(jobId: string, opts: { delayMs?: number; attempt?: number } = {}) {
    await this.queue.add(
      'convert',
      { jobId },
      {
        // BullMQ ignores duplicate ids, which makes enqueueing idempotent per attempt.
        jobId: `${jobId}-${opts.attempt ?? 0}`,
        delay: opts.delayMs,
        // Retries are decided by the processor, which knows which errors are transient.
        attempts: 1,
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 24 * 3600 },
      },
    )
  }

  async depth() {
    const c = await this.queue.getJobCounts('waiting', 'active', 'delayed')
    return (c.waiting ?? 0) + (c.active ?? 0) + (c.delayed ?? 0)
  }

  async close() {
    await this.queue.close()
  }
}

/** Consumer side: runs in dedicated worker processes. */
export function startBullWorker(redisUrl: string, processor: JobProcessor, concurrency: number): Worker {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      await processor(String(job.data.jobId))
    },
    {
      connection: redisConnection(redisUrl),
      concurrency,
      // A worker that dies mid-job leaves it stalled; it is handed to another
      // worker once, and the processor counts that as an attempt.
      maxStalledCount: 1,
      lockDuration: 60_000,
    },
  )
  worker.on('failed', (job, err) => logger.error('queue job failed', { queueJobId: job?.id, error: err }))
  return worker
}

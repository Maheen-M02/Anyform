import type { Redis } from 'ioredis'
import { isActiveJob } from '@/lib/states'
import type { JobRecord, MetaStore, Updater, UploadRecord } from './types'

const P = 'anyform:'
const k = {
  upload: (id: string) => `${P}upload:${id}`,
  job: (id: string) => `${P}job:${id}`,
  uploads: `${P}uploads`,
  jobs: `${P}jobs`,
  sessionJobs: (sid: string) => `${P}session:${sid}:jobs`,
  dedupe: (sid: string, key: string) => `${P}dedupe:${sid}:${key}`,
}

/**
 * Metadata store for multi-process deployments (web + workers).
 * Updates use optimistic locking (WATCH/MULTI) so concurrent writers never lose updates.
 */
export class RedisMetaStore implements MetaStore {
  /**
   * WATCH state is per connection, so optimistic updates run on a dedicated
   * connection and are serialised within this process.
   */
  private readonly txConn: Redis
  private txQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly redis: Redis,
    /** Records are evicted by Redis after this long as a safety net for cleanup. */
    private readonly maxRecordAgeMs: number,
  ) {
    this.txConn = redis.duplicate()
  }

  private serialised<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.txQueue.then(fn, fn)
    this.txQueue = run.catch(() => undefined)
    return run
  }

  private async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key)
    return raw ? (JSON.parse(raw) as T) : null
  }

  private update<T>(key: string, fn: Updater<T>): Promise<T | null> {
    const c = this.txConn
    return this.serialised(async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        await c.watch(key)
        const raw = await c.get(key)
        if (!raw) {
          await c.unwatch()
          return null
        }
        let next: T
        try {
          next = fn(JSON.parse(raw) as T)
        } catch (err) {
          await c.unwatch()
          throw err
        }
        const res = await c.multi().set(key, JSON.stringify(next), 'KEEPTTL').exec()
        if (res) return next
      }
      throw new Error('Metadata update contention')
    })
  }

  private async listAll<T>(setKey: string, keyFn: (id: string) => string): Promise<T[]> {
    const ids = await this.redis.smembers(setKey)
    if (ids.length === 0) return []
    const raws = await this.redis.mget(ids.map(keyFn))
    const out: T[] = []
    const missing: string[] = []
    raws.forEach((raw, i) => (raw ? out.push(JSON.parse(raw) as T) : missing.push(ids[i]!)))
    if (missing.length) await this.redis.srem(setKey, ...missing)
    return out
  }

  getUpload(id: string) {
    return this.get<UploadRecord>(k.upload(id))
  }

  async createUpload(rec: UploadRecord) {
    await this.redis.multi().set(k.upload(rec.id), JSON.stringify(rec), 'PX', this.maxRecordAgeMs).sadd(k.uploads, rec.id).exec()
  }

  updateUpload(id: string, fn: Updater<UploadRecord>) {
    return this.update(k.upload(id), fn)
  }

  async deleteUpload(id: string) {
    await this.redis.multi().del(k.upload(id)).srem(k.uploads, id).exec()
  }

  listUploads() {
    return this.listAll<UploadRecord>(k.uploads, k.upload)
  }

  getJob(id: string) {
    return this.get<JobRecord>(k.job(id))
  }

  async createJobDeduped(rec: JobRecord) {
    const dedupeKey = k.dedupe(rec.sessionId, rec.dedupeKey)
    for (let attempt = 0; attempt < 3; attempt++) {
      const claimed = await this.redis.set(dedupeKey, rec.id, 'PX', this.maxRecordAgeMs, 'NX')
      if (claimed === 'OK') {
        await this.redis
          .multi()
          .set(k.job(rec.id), JSON.stringify(rec), 'PX', this.maxRecordAgeMs)
          .sadd(k.jobs, rec.id)
          .sadd(k.sessionJobs(rec.sessionId), rec.id)
          .pexpire(k.sessionJobs(rec.sessionId), this.maxRecordAgeMs)
          .exec()
        return { job: rec, created: true }
      }
      const existingId = await this.redis.get(dedupeKey)
      const existing = existingId ? await this.getJob(existingId) : null
      if (existing && (isActiveJob(existing.status) || existing.status === 'completed')) {
        return { job: existing, created: false }
      }
      // The previous job is no longer reusable: release the claim and try again.
      if (existingId) await this.redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0", 1, dedupeKey, existingId)
    }
    throw new Error('Could not create job')
  }

  updateJob(id: string, fn: Updater<JobRecord>) {
    return this.update(k.job(id), fn)
  }

  async deleteJob(id: string) {
    const job = await this.getJob(id)
    const m = this.redis.multi().del(k.job(id)).srem(k.jobs, id)
    if (job) m.srem(k.sessionJobs(job.sessionId), id)
    await m.exec()
  }

  listJobs() {
    return this.listAll<JobRecord>(k.jobs, k.job)
  }

  listJobsForSession(sessionId: string) {
    return this.listAll<JobRecord>(k.sessionJobs(sessionId), k.job)
  }

  async ping() {
    await this.redis.ping()
  }

  async close() {
    await Promise.all([this.redis.quit(), this.txConn.quit()])
  }
}

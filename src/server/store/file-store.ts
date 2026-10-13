import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isActiveJob } from '@/lib/states'
import { isId } from '../ids'
import type { JobRecord, MetaStore, Updater, UploadRecord } from './types'

/**
 * Metadata store backed by one JSON file per record, written atomically.
 * Safe for a single Node.js process (local development and single-node
 * deployments). Multi-process deployments must use the Redis store.
 */
export class FileMetaStore implements MetaStore {
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(private readonly root: string) {}

  /** Serialises async critical sections per key within this process. */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => undefined)
    this.locks.set(key, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
  }

  private file(kind: 'uploads' | 'jobs', id: string): string {
    if (!isId(id)) throw new Error('Invalid record id')
    return path.join(this.root, kind, `${id}.json`)
  }

  private async read<T>(kind: 'uploads' | 'jobs', id: string): Promise<T | null> {
    if (!isId(id)) return null
    try {
      return JSON.parse(await readFile(this.file(kind, id), 'utf8')) as T
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  private async write(kind: 'uploads' | 'jobs', id: string, value: unknown): Promise<void> {
    const dest = this.file(kind, id)
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 })
    const tmp = `${dest}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
    // Windows may briefly refuse to replace a file that is being read.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, dest)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
          await rm(tmp, { force: true })
          throw err
        }
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)))
      }
    }
  }

  private async list<T>(kind: 'uploads' | 'jobs'): Promise<T[]> {
    const names = await readdir(path.join(this.root, kind)).catch(() => [] as string[])
    const records = await Promise.all(
      names.filter((n) => n.endsWith('.json')).map((n) => this.read<T>(kind, n.slice(0, -'.json'.length)).catch(() => null)),
    )
    return records.filter((r): r is Awaited<T> => r !== null) as T[]
  }

  getUpload(id: string) {
    return this.read<UploadRecord>('uploads', id)
  }

  createUpload(rec: UploadRecord) {
    return this.withLock(rec.id, () => this.write('uploads', rec.id, rec))
  }

  updateUpload(id: string, fn: Updater<UploadRecord>) {
    return this.withLock(id, async () => {
      const cur = await this.read<UploadRecord>('uploads', id)
      if (!cur) return null
      const next = fn(cur)
      await this.write('uploads', id, next)
      return next
    })
  }

  deleteUpload(id: string) {
    return this.withLock(id, () => rm(this.file('uploads', id), { force: true }))
  }

  listUploads() {
    return this.list<UploadRecord>('uploads')
  }

  getJob(id: string) {
    return this.read<JobRecord>('jobs', id)
  }

  createJobDeduped(rec: JobRecord) {
    return this.withLock(`dedupe:${rec.sessionId}`, async () => {
      const existing = (await this.listJobsForSession(rec.sessionId)).find(
        (j) => j.dedupeKey === rec.dedupeKey && (isActiveJob(j.status) || j.status === 'completed'),
      )
      if (existing) return { job: existing, created: false }
      await this.withLock(rec.id, () => this.write('jobs', rec.id, rec))
      return { job: rec, created: true }
    })
  }

  updateJob(id: string, fn: Updater<JobRecord>) {
    return this.withLock(id, async () => {
      const cur = await this.read<JobRecord>('jobs', id)
      if (!cur) return null
      const next = fn(cur)
      await this.write('jobs', id, next)
      return next
    })
  }

  deleteJob(id: string) {
    return this.withLock(id, () => rm(this.file('jobs', id), { force: true }))
  }

  listJobs() {
    return this.list<JobRecord>('jobs')
  }

  async listJobsForSession(sessionId: string) {
    return (await this.listJobs()).filter((j) => j.sessionId === sessionId)
  }

  async ping() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
  }

  async close() {}
}

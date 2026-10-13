import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as uploads from '@/app/api/v1/uploads/route'
import * as validate from '@/app/api/v1/validate/route'
import * as conversions from '@/app/api/v1/conversions/route'
import * as conversion from '@/app/api/v1/conversions/[id]/route'
import * as cancel from '@/app/api/v1/conversions/[id]/cancel/route'
import * as download from '@/app/api/v1/conversions/[id]/download/route'
import * as formats from '@/app/api/v1/formats/route'
import type { JobView } from '@/server/services/conversions'
import type { UploadView } from '@/server/services/uploads'

const ORIGIN = 'http://localhost:3000'

/**
 * Calls the real route handlers in-process with a cookie jar, the same way the
 * browser client does (CSRF header, raw-body uploads).
 */
export class TestClient {
  cookie = ''

  private request(method: string, url: string, init: { body?: BodyInit; headers?: Record<string, string>; csrf?: boolean } = {}) {
    const headers: Record<string, string> = { host: 'localhost:3000', ...init.headers }
    if (this.cookie) headers.cookie = this.cookie
    if (init.csrf !== false && method !== 'GET') headers['x-anyform-request'] = '1'
    return new Request(`${ORIGIN}${url}`, { method, headers, body: init.body, duplex: 'half' } as RequestInit)
  }

  private remember(res: Response) {
    const set = res.headers.get('set-cookie')
    if (set) this.cookie = set.split(';')[0]!
    return res
  }

  async uploadBuffer(buf: Buffer, name: string, extra: { headers?: Record<string, string>; csrf?: boolean } = {}) {
    const req = this.request('POST', '/api/v1/uploads', {
      body: new Uint8Array(buf),
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(buf.length), 'x-file-name': encodeURIComponent(name), ...extra.headers },
      csrf: extra.csrf,
    })
    const res = this.remember(await uploads.POST(req))
    return { res, body: (await res.json()) as { upload: UploadView; error?: { code: string; message: string } } & { error?: { code: string } } }
  }

  uploadFile(filePath: string, name = path.basename(filePath)) {
    return this.uploadBuffer(readFileSync(filePath), name)
  }

  async validate(uploadId: string) {
    const req = this.request('POST', '/api/v1/validate', { body: JSON.stringify({ uploadId }), headers: { 'content-type': 'application/json' } })
    const res = this.remember(await validate.POST(req))
    return { res, body: (await res.json()) as { upload: UploadView; error?: { code: string; message: string } } }
  }

  async convert(payload: Record<string, unknown>) {
    const req = this.request('POST', '/api/v1/conversions', { body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } })
    const res = this.remember(await conversions.POST(req))
    return { res, body: (await res.json()) as { job: JobView; created: boolean; error?: { code: string; message: string } } }
  }

  async history() {
    const res = this.remember(await conversions.GET(this.request('GET', '/api/v1/conversions')))
    return (await res.json()) as { jobs: JobView[] }
  }

  async job(id: string) {
    const res = this.remember(await conversion.GET(this.request('GET', `/api/v1/conversions/${id}`), { params: Promise.resolve({ id }) }))
    return { res, body: (await res.json()) as { job: JobView; error?: { code: string } } }
  }

  async cancel(id: string) {
    const res = await cancel.POST(this.request('POST', `/api/v1/conversions/${id}/cancel`), { params: Promise.resolve({ id }) })
    return { res, body: (await res.json()) as { job: JobView; error?: { code: string } } }
  }

  async remove(id: string) {
    return conversion.DELETE(this.request('DELETE', `/api/v1/conversions/${id}`), { params: Promise.resolve({ id }) })
  }

  async download(id: string, headers: Record<string, string> = {}) {
    return download.GET(this.request('GET', `/api/v1/conversions/${id}/download`, { headers }), { params: Promise.resolve({ id }) })
  }

  async formats() {
    return (await formats.GET(this.request('GET', '/api/v1/formats'))).json()
  }

  /** Polls until the job reaches a terminal state. */
  async waitFor(id: string, timeoutMs = 60_000): Promise<JobView> {
    const end = Date.now() + timeoutMs
    for (;;) {
      const { body } = await this.job(id)
      if (['completed', 'failed', 'cancelled', 'expired'].includes(body.job.status)) return body.job
      if (Date.now() > end) throw new Error(`Job ${id} did not finish: ${body.job.status}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  /** Upload + validate in one go. */
  async prepare(filePath: string, name?: string) {
    const up = await this.uploadFile(filePath, name)
    if (up.res.status !== 201) return { upload: null, error: up.body.error, status: up.res.status }
    const v = await this.validate(up.body.upload.id)
    return { upload: v.body.upload, error: v.body.error, status: v.res.status }
  }
}

/** The audio/video facts of an inspected upload (fails the test otherwise). */
export function av(u: UploadView) {
  if (u.info?.kind !== 'av') throw new Error(`expected an audio/video upload, got ${u.info?.kind}`)
  return u.info.media
}

/**
 * Upload → validate → convert → wait → download, asserting success at every
 * step. Returns the verified job and the downloaded bytes.
 */
export async function convertOk(client: TestClient, file: string, outputFormat: string, options: Record<string, unknown> = {}) {
  const { upload, error } = await client.prepare(file)
  if (error || !upload) throw new Error(`validation failed: ${JSON.stringify(error)}`)
  if (upload.status !== 'validated') throw new Error(`upload ${upload.status}: ${JSON.stringify(upload.error)}`)
  const { body } = await client.convert({ uploadId: upload.id, outputFormat, options })
  if (body.error) throw new Error(`convert rejected: ${JSON.stringify(body.error)}`)
  const job = await client.waitFor(body.job.id, 120_000)
  if (job.status !== 'completed') throw new Error(`job ${job.status}: ${JSON.stringify(job.error)}`)
  const res = await client.download(job.id)
  return { upload, job, data: Buffer.from(await res.arrayBuffer()), headers: res.headers }
}

/** Upload → validate → convert, expecting the job itself to fail. */
export async function convertFails(client: TestClient, file: string, outputFormat: string, options: Record<string, unknown> = {}) {
  const { upload } = await client.prepare(file)
  const { body } = await client.convert({ uploadId: upload!.id, outputFormat, options })
  if (body.error) return { stage: 'request' as const, code: body.error.code, message: body.error.message }
  const job = await client.waitFor(body.job.id, 120_000)
  return { stage: 'job' as const, code: job.error?.code, message: job.error?.message, status: job.status }
}

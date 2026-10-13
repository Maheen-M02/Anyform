import { readFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as imports from '@/app/api/v1/imports/route'
import { resetConfig } from '@/server/config'
import type { UploadView } from '@/server/services/uploads'
import { convertOk, TestClient } from '../helpers/client'
import { ensureFixtures, fixture } from '../helpers/fixtures'

/** A local web server standing in for "the internet". */
let server: http.Server
let base = ''

beforeAll(async () => {
  await ensureFixtures()
  const video = readFileSync(fixture('clip.mov'))
  const pdf = readFileSync(fixture('text.pdf'))
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x')
    switch (url.pathname) {
      case '/media/Holiday%20clip.mov':
        res.writeHead(200, { 'content-type': 'video/quicktime', 'content-length': video.length })
        return res.end(video)
      case '/download':
        res.writeHead(200, { 'content-disposition': `attachment; filename*=UTF-8''Quarterly%20report.pdf`, 'content-length': pdf.length })
        return res.end(pdf)
      case '/redirect':
        res.writeHead(302, { location: '/r2' })
        return res.end()
      case '/r2':
        res.writeHead(301, { location: '/download' })
        return res.end()
      case '/loop':
        res.writeHead(302, { location: '/loop' })
        return res.end()
      case '/to-localhost':
        res.writeHead(302, { location: `http://localhost:${(server.address() as AddressInfo).port}/download` })
        return res.end()
      case '/to-file':
        res.writeHead(302, { location: 'file:///etc/passwd' })
        return res.end()
      case '/page.html':
        res.writeHead(200, { 'content-type': 'text/html' })
        return res.end('<!doctype html><html><body>Not a file</body></html>')
      case '/huge':
        res.writeHead(200, { 'content-length': String(10 * 1024 * 1024 * 1024) })
        return res.end()
      case '/short':
        // Declares more bytes than it sends, then hangs up.
        res.writeHead(200, { 'content-length': String(video.length * 2) })
        res.write(video)
        return res.destroy()
      case '/stall':
        res.writeHead(200, { 'content-length': '1000000' })
        res.write(Buffer.alloc(10))
        return // never finishes
      default:
        res.writeHead(404)
        return res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.closeAllConnections()
  server.close()
})

function setEnv(vars: Record<string, string>) {
  Object.assign(process.env, vars)
  resetConfig()
}

afterEach(() => {
  for (const k of ['IMPORT_ALLOW_PRIVATE_NETWORKS', 'IMPORT_ALLOWED_HOSTS', 'IMPORT_TIMEOUT_SECONDS', 'MAX_UPLOAD_MB', 'IMPORT_ENABLED']) delete process.env[k]
  resetConfig()
})

async function importUrl(client: TestClient, url: string) {
  const req = new Request('http://localhost:3000/api/v1/imports', {
    method: 'POST',
    headers: { host: 'localhost:3000', 'content-type': 'application/json', 'x-anyform-request': '1', ...(client.cookie ? { cookie: client.cookie } : {}) },
    body: JSON.stringify({ url }),
  })
  const res = await imports.POST(req)
  const set = res.headers.get('set-cookie')
  if (set) client.cookie = set.split(';')[0]!
  return { status: res.status, body: (await res.json()) as { upload: UploadView; error?: { code: string; message: string } } }
}

describe('URL import (local test server, private networks allowed for the test)', () => {
  it('imports a video by link, validates it and converts it', async () => {
    setEnv({ IMPORT_ALLOW_PRIVATE_NETWORKS: 'true' })
    const client = new TestClient()
    const { status, body } = await importUrl(client, `${base}/media/Holiday%20clip.mov?token=secret`)
    expect(status).toBe(201)
    expect(body.upload.filename).toBe('Holiday clip.mov')
    expect(body.upload.origin).toEqual({ kind: 'url', host: '127.0.0.1' })
    // The token-bearing URL is never stored or echoed.
    expect(JSON.stringify(body)).not.toContain('secret')

    const v = await client.validate(body.upload.id)
    expect(v.body.upload.info?.format).toBe('mov')
    const { body: conv } = await client.convert({ uploadId: body.upload.id, outputFormat: 'mp4' })
    const job = await client.waitFor(conv.job.id)
    expect(job.status).toBe('completed')
    expect(job.output?.filename).toBe('Holiday clip.mp4')
  })

  it('follows redirects and uses the Content-Disposition filename', async () => {
    setEnv({ IMPORT_ALLOW_PRIVATE_NETWORKS: 'true' })
    const { status, body } = await importUrl(new TestClient(), `${base}/redirect`)
    expect(status).toBe(201)
    expect(body.upload.filename).toBe('Quarterly report.pdf')
  })

  it.each([
    ['/missing', 'REMOTE_FETCH_FAILED', /404/],
    ['/loop', 'REMOTE_FETCH_FAILED', /redirected too many times/],
    ['/to-file', 'INVALID_URL', /http/],
    ['/page.html', 'UNSUPPORTED_FORMAT', /web page/],
    ['/huge', 'UPLOAD_TOO_LARGE', /limit/],
    ['/short', 'REMOTE_FETCH_FAILED', /interrupted|closed the connection/],
  ])('%s → %s', async (path, code, message) => {
    setEnv({ IMPORT_ALLOW_PRIVATE_NETWORKS: 'true' })
    const { body } = await importUrl(new TestClient(), `${base}${path}`)
    expect(body.error?.code).toBe(code)
    expect(body.error?.message).toMatch(message)
  })

  it('stops downloads that exceed the time limit', async () => {
    setEnv({ IMPORT_ALLOW_PRIVATE_NETWORKS: 'true', IMPORT_TIMEOUT_SECONDS: '1' })
    const started = Date.now()
    const { body } = await importUrl(new TestClient(), `${base}/stall`)
    expect(body.error?.code).toBe('IMPORT_TIMEOUT')
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('re-checks the host policy on every redirect hop', async () => {
    setEnv({ IMPORT_ALLOW_PRIVATE_NETWORKS: 'true', IMPORT_ALLOWED_HOSTS: '127.0.0.1' })
    const { body } = await importUrl(new TestClient(), `${base}/to-localhost`)
    expect(body.error?.code).toBe('URL_NOT_ALLOWED')
  })

  it('converts an imported PDF end to end', async () => {
    setEnv({ IMPORT_ALLOW_PRIVATE_NETWORKS: 'true' })
    const client = new TestClient()
    const { body } = await importUrl(client, `${base}/download`)
    await client.validate(body.upload.id)
    const { body: conv } = await client.convert({ uploadId: body.upload.id, outputFormat: 'txt' })
    const job = await client.waitFor(conv.job.id)
    expect(job.status).toBe('completed')
    // sanity: the regular flow still works alongside imports
    await convertOk(client, fixture('alpha.png'), 'jpg')
  })
})

describe('URL import with default (production) policy', () => {
  it.each(['/media/Holiday%20clip.mov', '/download'])('refuses the loopback server for %s', async (path) => {
    const { body } = await importUrl(new TestClient(), `${base}${path}`)
    expect(body.error?.code).toBe('URL_NOT_ALLOWED')
  })

  it('refuses localhost by name and cloud metadata addresses', async () => {
    for (const url of ['http://localhost/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/']) {
      const { body } = await importUrl(new TestClient(), url)
      expect(body.error?.code).toBe('URL_NOT_ALLOWED')
    }
  })

  it('explains that streaming services are not supported', async () => {
    const { status, body } = await importUrl(new TestClient(), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(status).toBe(422)
    expect(body.error?.code).toBe('UNSUPPORTED_SOURCE')
    expect(body.error?.message).toMatch(/streaming services/)
  })

  it('can be disabled', async () => {
    setEnv({ IMPORT_ENABLED: 'false' })
    const { status, body } = await importUrl(new TestClient(), 'https://example.com/a.mp4')
    expect(status).toBe(403)
    expect(body.error?.code).toBe('IMPORT_DISABLED')
  })

  it('requires the CSRF header', async () => {
    const res = await imports.POST(
      new Request('http://localhost:3000/api/v1/imports', {
        method: 'POST',
        headers: { host: 'localhost:3000', 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/a.mp4' }),
      }),
    )
    expect(res.status).toBe(403)
  })
})

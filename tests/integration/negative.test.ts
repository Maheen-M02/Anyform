import { existsSync, readFileSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runCleanup } from '@/server/cleanup'
import { resetConfig } from '@/server/config'
import { getRuntime } from '@/server/runtime'
import { ensureFixtures, fixture } from '../helpers/fixtures'
import { TestClient } from '../helpers/client'

beforeAll(() => ensureFixtures())

async function completedJob(client: TestClient) {
  const { upload } = await client.prepare(fixture('audio-only.mp4'))
  const { body } = await client.convert({ uploadId: upload!.id, outputFormat: 'mp3' })
  return client.waitFor(body.job.id)
}

describe('upload validation', () => {
  afterEach(() => {
    delete process.env.MAX_UPLOAD_MB
    resetConfig()
  })

  it('rejects a non-media file that has an .mp4 extension', async () => {
    const { res, body } = await new TestClient().uploadFile(fixture('not-media.mp4'))
    expect(res.status).toBe(422)
    expect(body.error?.code).toBe('UNSUPPORTED_FORMAT')
  })

  it('rejects an empty upload', async () => {
    const { res, body } = await new TestClient().uploadBuffer(Buffer.alloc(0), 'empty.mp4')
    expect(res.status).toBe(400)
    expect(body.error?.code).toBe('UPLOAD_EMPTY')
  })

  it('rejects an oversized upload from its declared length', async () => {
    process.env.MAX_UPLOAD_MB = '0.01'
    resetConfig()
    const { res, body } = await new TestClient().uploadFile(fixture('video-audio.mp4'))
    expect(res.status).toBe(413)
    expect(body.error?.code).toBe('UPLOAD_TOO_LARGE')
  })

  it('stops reading an oversized upload that lies about its length', async () => {
    process.env.MAX_UPLOAD_MB = '0.01'
    resetConfig()
    const data = readFileSync(fixture('video-audio.mp4'))
    // Declared length is small, real body is large: the stream limiter must cut it off.
    const { res, body } = await new TestClient().uploadBuffer(data, 'liar.mp4', { headers: { 'content-length': '100' } })
    expect(res.status).toBe(413)
    expect(body.error?.code).toBe('UPLOAD_TOO_LARGE')
  })

  it('rejects a corrupted MP4 during validation and deletes it', async () => {
    const client = new TestClient()
    const { upload } = await client.prepare(fixture('corrupt.mp4'))
    expect(upload!.status).toBe('rejected')
    expect(upload!.error?.code).toBe('CORRUPT_MEDIA')
    expect(upload!.outputs).toEqual([])
    const rec = await getRuntime().store.getUpload(upload!.id)
    expect(existsSync(await getRuntime().storage.localPath(rec!.storageKey))).toBe(false)
  })

  it('offers only video outputs for video without audio, and explains why audio is refused', async () => {
    const client = new TestClient()
    const { upload } = await client.prepare(fixture('video-only.mp4'))
    expect(upload!.status).toBe('validated')
    expect(upload!.outputs.map((o) => o.format)).toEqual(['webm'])
    const { res, body } = await client.convert({ uploadId: upload!.id, outputFormat: 'mp3' })
    expect(res.status).toBe(422)
    expect(body.error?.code).toBe('NO_AUDIO_STREAM')
    expect(body.error?.message).toMatch(/no audio track/i)
  })

  it('fails a truncated upload instead of returning partial audio', async () => {
    const client = new TestClient()
    const { upload } = await client.prepare(fixture('truncated.mp4'))
    if (upload!.status === 'rejected') {
      expect(['CORRUPT_MEDIA', 'UNSUPPORTED_CODEC']).toContain(upload!.error?.code)
      return
    }
    const { body } = await client.convert({ uploadId: upload!.id, outputFormat: 'mp3' })
    const job = await client.waitFor(body.job.id)
    expect(job.status).toBe('failed')
    expect(['CORRUPT_MEDIA', 'CONVERSION_FAILED']).toContain(job.error?.code)
    expect(job.downloadUrl).toBeNull()
  })

  it('never echoes filesystem paths in errors', async () => {
    const { upload } = await new TestClient().prepare(fixture('corrupt.mp4'))
    expect(JSON.stringify(upload)).not.toMatch(/anyform-test-|[A-Za-z]:\\|\/tmp\//)
  })

  it('sanitises path-like filenames', async () => {
    const client = new TestClient()
    const { body } = await client.uploadBuffer(readFileSync(fixture('audio-only.mp4')), '../../etc/pass<wd>.mp4')
    expect(body.upload.filename).toBe('pass<wd>.mp4')
    await client.validate(body.upload.id)
    const conv = await client.convert({ uploadId: body.upload.id, outputFormat: 'mp3' })
    const job = await client.waitFor(conv.body.job.id)
    expect(job.output?.filename).toBe('pass wd.mp3')
  })
})

describe('conversion requests', () => {
  it('rejects an invalid bitrate', async () => {
    const client = new TestClient()
    const { upload } = await client.prepare(fixture('audio-only.mp4'))
    const { res, body } = await client.convert({ uploadId: upload!.id, outputFormat: 'mp3', options: { bitrate: 999 } })
    expect(res.status).toBe(422)
    expect(body.error?.code).toBe('INVALID_OPTIONS')
  })

  it('rejects a non-existent audio track', async () => {
    const client = new TestClient()
    const { upload } = await client.prepare(fixture('audio-only.mp4'))
    const { body } = await client.convert({ uploadId: upload!.id, outputFormat: 'mp3', options: { streamIndex: 7 } })
    expect(body.error?.code).toBe('INVALID_OPTIONS')
  })

  it('rejects unknown option keys', async () => {
    const client = new TestClient()
    const { upload } = await client.prepare(fixture('audio-only.mp4'))
    const { body } = await client.convert({ uploadId: upload!.id, outputFormat: 'mp3', options: { codec: 'pcm' } })
    expect(body.error?.code).toBe('INVALID_OPTIONS')
  })

  it('rejects a missing upload identifier', async () => {
    const { res, body } = await new TestClient().convert({ outputFormat: 'mp3' })
    expect(res.status).toBe(400)
    expect(body.error?.code).toBe('INVALID_REQUEST')
  })

  it('rejects conversions that are not registered', async () => {
    const client = new TestClient()
    const { upload } = await client.prepare(fixture('audio-only.mp4'))
    const { body } = await client.convert({ uploadId: upload!.id, outputFormat: 'png' })
    expect(body.error?.code).toBe('UNSUPPORTED_CONVERSION')
  })

  it('refuses to convert an upload that failed validation', async () => {
    const client = new TestClient()
    const { upload } = await client.prepare(fixture('corrupt.mp4'))
    expect(upload!.status).toBe('rejected')
    const { body } = await client.convert({ uploadId: upload!.id, outputFormat: 'mp3' })
    expect(body.error?.code).toBe('UPLOAD_NOT_VALIDATED')
  })
})

describe('authorization and request integrity', () => {
  it("prevents another session from seeing, cancelling, deleting or downloading a job", async () => {
    const owner = new TestClient()
    const job = await completedJob(owner)
    const other = new TestClient()

    expect((await other.job(job.id)).res.status).toBe(404)
    expect((await other.download(job.id)).status).toBe(404)
    expect((await other.cancel(job.id)).res.status).toBe(404)
    expect((await other.remove(job.id)).status).toBe(404)
    expect((await other.validate(job.uploadId)).res.status).toBe(404)
    expect((await other.convert({ uploadId: job.uploadId, outputFormat: 'mp3' })).res.status).toBe(404)
    // The owner still has access.
    expect((await owner.download(job.id)).status).toBe(200)
  })

  it('ignores forged session cookies', async () => {
    const owner = new TestClient()
    const job = await completedJob(owner)
    const forger = new TestClient()
    forger.cookie = `anyform_sid=${owner.cookie.split('=')[1]!.split('.')[0]}.forgedsignature`
    expect((await forger.job(job.id)).res.status).toBe(404)
  })

  it('treats path traversal ids as not found', async () => {
    const client = new TestClient()
    for (const id of ['../../etc/passwd', '..%2F..%2Fsecret', 'job_../../../x', 'job_' + 'a'.repeat(200)]) {
      expect((await client.job(id)).res.status).toBe(404)
      expect((await client.download(id)).status).toBe(404)
    }
    expect((await client.validate('../uploads/upl_x')).res.status).toBe(404)
  })

  it('requires the CSRF header on state-changing requests', async () => {
    const { res, body } = await new TestClient().uploadBuffer(readFileSync(fixture('audio-only.mp4')), 'a.mp4', { csrf: false })
    expect(res.status).toBe(403)
    expect(body.error?.code).toBe('CSRF_REJECTED')
  })

  it('rejects cross-origin state-changing requests', async () => {
    const { res } = await new TestClient().uploadBuffer(readFileSync(fixture('audio-only.mp4')), 'a.mp4', {
      headers: { origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
  })
})

describe('lifecycle', () => {
  it('makes expired results unavailable and cleans them up', async () => {
    const client = new TestClient()
    const job = await completedJob(client)
    const rt = getRuntime()
    const rec = await rt.store.getJob(job.id)
    const outPath = await rt.storage.localPath(rec!.output!.storageKey)
    expect(existsSync(outPath)).toBe(true)

    await rt.store.updateJob(job.id, (j) => ({ ...j, expiresAt: Date.now() - 1000 }))
    expect((await client.job(job.id)).body.job.status).toBe('expired')
    const dl = await client.download(job.id)
    expect(dl.status).toBe(410)

    const report = await runCleanup(rt)
    expect(report.outputsExpired).toBeGreaterThanOrEqual(1)
    expect(existsSync(outPath)).toBe(false)
    expect((await rt.store.getJob(job.id))!.status).toBe('expired')
  })

  it('expires abandoned uploads', async () => {
    const client = new TestClient()
    const { body } = await client.uploadFile(fixture('audio-only.mp4'))
    const rt = getRuntime()
    await rt.store.updateUpload(body.upload.id, (u) => ({ ...u, expiresAt: Date.now() - 1 }))
    const rec = await rt.store.getUpload(body.upload.id)
    await runCleanup(rt)
    expect(existsSync(await rt.storage.localPath(rec!.storageKey))).toBe(false)
    expect((await client.validate(body.upload.id)).body.error?.code).toBe('UPLOAD_EXPIRED')
  })

  it('deletes a job and its artifacts on request', async () => {
    const client = new TestClient()
    const job = await completedJob(client)
    const rt = getRuntime()
    const rec = await rt.store.getJob(job.id)
    const outPath = await rt.storage.localPath(rec!.output!.storageKey)
    const upload = await rt.store.getUpload(job.uploadId)
    expect((await client.remove(job.id)).status).toBe(204)
    expect(existsSync(outPath)).toBe(false)
    expect(existsSync(await rt.storage.localPath(upload!.storageKey))).toBe(false)
    expect((await client.job(job.id)).res.status).toBe(404)
  })

  it('cancels a queued or running job', async () => {
    const client = new TestClient()
    const { upload } = await client.prepare(fixture('long.wav'))
    const { body } = await client.convert({ uploadId: upload!.id, outputFormat: 'mp3' })
    const cancelled = await client.cancel(body.job.id)
    expect(cancelled.res.status).toBe(200)
    const job = await client.waitFor(body.job.id)
    expect(job.status).toBe('cancelled')
    expect(job.downloadUrl).toBeNull()
    expect((await client.cancel(body.job.id)).body.error?.code).toBe('JOB_NOT_ACTIVE')
  })

  it('lists formats from the registry only', async () => {
    const formats = (await new TestClient().formats()) as { conversions: { id: string }[] }
    const { registry } = await import('@/server/conversions')
    expect(formats.conversions.map((c) => c.id).sort()).toEqual(registry.list().map((a) => a.id).sort())
  })
})

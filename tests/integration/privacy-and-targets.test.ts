import { createHash } from 'node:crypto'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import { beforeAll, describe, expect, it } from 'vitest'
import { MB } from '@/lib/size-targets'
import { av, convertOk, TestClient } from '../helpers/client'
import { ensureFixtures, fixture } from '../helpers/fixtures'
import { ffprobe } from '../helpers/inspect'

beforeAll(() => ensureFixtures())

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')
const labels = (items: { label: string }[] | null | undefined) => (items ?? []).map((i) => i.label)

describe('hidden data scan', () => {
  it('finds the location in a phone-style video and offers a clean copy last', async () => {
    const { upload } = await new TestClient().prepare(fixture('located.mp4'))
    expect(upload!.status).toBe('validated')
    expect(upload!.info?.hidden).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: 'location', value: '48.85840, 2.29450', risk: 'high', removable: true })]),
    )
    const formats = upload!.outputs.map((o) => o.format)
    expect(formats.at(-1)).toBe('mp4')
    expect(formats[0]).not.toBe('mp4')
  })

  it('finds GPS, camera and owner data in a photo', async () => {
    const { upload } = await new TestClient().prepare(fixture('gps.jpg'))
    expect(labels(upload!.info?.hidden)).toEqual(expect.arrayContaining(['GPS location', 'Camera serial number', 'Camera maker', 'Artist']))
  })

  it('finds authors, software and earlier revisions in a PDF', async () => {
    const { upload } = await new TestClient().prepare(fixture('authored.pdf'))
    expect(labels(upload!.info?.hidden)).toEqual(expect.arrayContaining(['Author', 'Created with', 'Produced by', 'Keywords', 'Earlier revisions']))
  })

  it('reports nothing for a file without metadata', async () => {
    const { upload } = await new TestClient().prepare(fixture('alpha.png'))
    expect(upload!.info?.hidden).toEqual([])
  })
})

describe('clean copies', () => {
  it('MP4: streams copied bit-for-bit, location and title gone', async () => {
    const { job, data, upload } = await convertOk(new TestClient(), fixture('located.mp4'), 'mp4')
    expect(job.output?.details.encoding).toBe('copied (lossless)')
    const probe = ffprobe(data, 'mp4')
    expect(probe.format.tags?.location).toBeUndefined()
    expect(probe.format.tags?.title).toBeUndefined()
    expect(probe.streams.map((s) => s.codec_name)).toEqual(av(upload).videoStreams.map((v) => v.codec).concat(av(upload).audioStreams.map((a) => a.codec)))
    const report = job.output!.report!
    expect(labels(report.hidden.removed)).toEqual(expect.arrayContaining(['GPS location', 'Title']))
    expect(report.hidden.remaining).toEqual([])
    expect(labels(report.checks)).toEqual(expect.arrayContaining(['Streams', 'Location', 'Hidden data', 'Fingerprint']))
  })

  it('JPG: re-saved without EXIF; the report lists what was removed', async () => {
    const { job, data } = await convertOk(new TestClient(), fixture('gps.jpg'), 'jpg', { quality: 'high' })
    expect((await sharp(data).metadata()).exif).toBeUndefined()
    expect(labels(job.output!.report!.hidden.removed)).toEqual(expect.arrayContaining(['GPS location', 'Camera serial number']))
    expect(job.output!.report!.hidden.remaining).toEqual([])
  })

  it('PDF: pages kept, info dictionary, XMP and old revisions dropped', async () => {
    const { job, data } = await convertOk(new TestClient(), fixture('authored.pdf'), 'pdf')
    const doc = await PDFDocument.load(data, { updateMetadata: false })
    expect(doc.getPageCount()).toBe(2)
    expect(doc.getAuthor()).toBeUndefined()
    expect(doc.getProducer()).toBeUndefined()
    expect(data.toString('latin1').match(/%%EOF/g)).toHaveLength(1)
    expect(labels(job.output!.report!.hidden.removed)).toEqual(expect.arrayContaining(['Author', 'Earlier revisions']))
  })
})

describe('verification report', () => {
  it('fingerprints match the source and the downloaded bytes', async () => {
    const { readFileSync } = await import('node:fs')
    const { job, data } = await convertOk(new TestClient(), fixture('tone.flac'), 'mp3', { bitrate: 128 })
    const report = job.output!.report!
    expect(report.output.sha256).toBe(sha256(data))
    expect(report.input.sha256).toBe(sha256(readFileSync(fixture('tone.flac'))))
    expect(report.output.sizeBytes).toBe(data.length)
    expect(labels(report.checks)).toEqual(['Container', 'Playback', 'Duration', 'Bitrate', 'Hidden data', 'Fingerprint'])
    expect(report.destination).toBeNull()
  })

  it('image → PDF output carries no producer or dates', async () => {
    const { job } = await convertOk(new TestClient(), fixture('gps.jpg'), 'pdf')
    expect(job.output!.report!.hidden.remaining).toEqual([])
  })
})

describe('size targets and destinations', () => {
  it('re-encodes a video under the limit and records the destination', async () => {
    const client = new TestClient()
    const { upload } = await client.prepare(fixture('faststart.mp4'))
    const { body } = await client.convert({
      uploadId: upload!.id,
      outputFormat: 'webm',
      options: { mode: 'reencode', quality: 'balanced', maxHeight: 'original', maxBytes: MB },
      destination: 'discord',
    })
    expect(body.error).toBeUndefined()
    const job = await client.waitFor(body.job.id, 120_000)
    expect(job.status).toBe('completed')
    expect(job.destination).toBe('discord')
    expect(job.output!.sizeBytes).toBeLessThanOrEqual(MB)
    const report = job.output!.report!
    expect(report.destination).toEqual({ id: 'discord', label: 'Discord', maxBytes: MB })
    expect(labels(report.checks)).toContain('Size limit')
  })

  it('shrinks a hard-to-compress image until it fits', async () => {
    const { job, data } = await convertOk(new TestClient(), fixture('noise.png'), 'jpg', { maxBytes: 60_000 })
    expect(data.length).toBeLessThanOrEqual(60_000)
    const m = await sharp(data).metadata()
    expect(m.width! / m.height!).toBeCloseTo(800 / 600, 1)
    expect(job.output?.details.quality).toBe('fitted to size')
  })

  it('refuses unreachable targets and unknown destinations up front', async () => {
    const client = new TestClient()
    const { upload } = await client.prepare(fixture('long.wav'))
    const tooSmall = await client.convert({ uploadId: upload!.id, outputFormat: 'mp3', options: { bitrate: 320, maxBytes: 100_000 } })
    expect(tooSmall.res.status).toBe(422)
    expect(tooSmall.body.error?.code).toBe('SIZE_TARGET_UNREACHABLE')
    const unknown = await client.convert({ uploadId: upload!.id, outputFormat: 'mp3', options: {}, destination: 'myspace' })
    expect(unknown.body.error?.code).toBe('INVALID_OPTIONS')
  })

  it('lowers the MP3 bitrate just enough', async () => {
    // 20 s at 320 kbps is 800 KB; 520 KB allows 192 kbps (about 501 KB with headers).
    const { job, data } = await convertOk(new TestClient(), fixture('long.wav'), 'mp3', { bitrate: 320, maxBytes: 520_000 })
    expect(data.length).toBeLessThanOrEqual(520_000)
    expect(job.output?.details.bitrateKbps).toBe(192)
  })
})

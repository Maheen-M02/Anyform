import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { getConfig } from '@/server/config'
import { ensureFixtures, fixture } from '../helpers/fixtures'
import { av, TestClient } from '../helpers/client'

/** ffprobe facts about a downloaded file, used to verify outputs independently of the app. */
function probe(buf: Buffer) {
  const file = path.join(getConfig().dataDir, `probe-${Date.now()}.mp3`)
  writeFileSync(file, buf)
  const out = execFileSync(process.env.FFPROBE_PATH ?? 'ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {
    encoding: 'utf8',
  })
  return JSON.parse(out) as {
    format: { format_name: string; duration: string }
    streams: { codec_type: string; codec_name: string; bit_rate: string; channels: number; sample_rate: string }[]
  }
}

async function convertAndDownload(client: TestClient, file: string, options: Record<string, unknown> = {}) {
  const { upload, error } = await client.prepare(file)
  expect(error).toBeUndefined()
  expect(upload!.status).toBe('validated')
  const { res, body } = await client.convert({ uploadId: upload!.id, outputFormat: 'mp3', options })
  expect(res.status).toBe(202)
  const job = await client.waitFor(body.job.id)
  expect(job.error).toBeNull()
  expect(job.status).toBe('completed')
  const dl = await client.download(job.id)
  expect(dl.status).toBe(200)
  return { upload: upload!, job, data: Buffer.from(await dl.arrayBuffer()), headers: dl.headers }
}

beforeAll(() => ensureFixtures())

describe('MP4 → MP3 end to end', () => {
  it('uploads, validates, converts, verifies and downloads', async () => {
    const client = new TestClient()
    const { upload, job, data, headers } = await convertAndDownload(client, fixture('video-audio.mp4'), { bitrate: 256 })

    expect(upload.info?.format).toBe('mp4')
    expect(av(upload).audioStreams).toHaveLength(1)
    expect(upload.outputs.map((o) => o.format).sort()).toEqual(['flac', 'm4a', 'mp3', 'ogg', 'wav', 'webm'])
    expect(upload.outputs.find((o) => o.format === 'mp3')!.lossy).toBe(true)

    expect(job.output?.filename).toBe('video-audio.mp3')
    expect(job.output?.details.bitrateKbps).toBe(256)
    expect(job.progress).toBe(1)
    expect(headers.get('content-type')).toBe('audio/mpeg')
    expect(headers.get('content-disposition')).toContain('attachment; filename="video-audio.mp3"')

    const p = probe(data)
    expect(p.format.format_name).toBe('mp3')
    expect(p.streams).toHaveLength(1)
    expect(p.streams[0]!.codec_name).toBe('mp3')
    expect(Number(p.streams[0]!.bit_rate)).toBe(256000)
    expect(Math.abs(Number(p.format.duration) - 3)).toBeLessThan(0.5)
    expect(p.streams[0]!.channels).toBe(2)
  })

  it('defaults to 192 kbps', async () => {
    const { job, data } = await convertAndDownload(new TestClient(), fixture('audio-only.mp4'))
    expect(job.options.bitrate).toBe(192)
    expect(Number(probe(data).streams[0]!.bit_rate)).toBe(192000)
  })

  it.each([128, 320])('encodes at %i kbps', async (bitrate) => {
    const { data } = await convertAndDownload(new TestClient(), fixture('audio-only.mp4'), { bitrate })
    expect(Number(probe(data).streams[0]!.bit_rate)).toBe(bitrate * 1000)
  })

  it('accepts audio-only M4A containers', async () => {
    const { upload, data } = await convertAndDownload(new TestClient(), fixture('audio.m4a'))
    expect(upload.info?.format).toBe('m4a')
    expect(Math.abs(Number(probe(data).format.duration) - 2)).toBeLessThan(0.5)
  })

  it('extracts the selected track from a multi-track file', async () => {
    const client = new TestClient()
    const { upload } = await client.prepare(fixture('multi-audio.mp4'))
    expect(av(upload!).audioStreams).toHaveLength(2)
    expect(upload!.outputs.find((o) => o.format === 'mp3')!.options.some((o) => o.type === 'audioStream')).toBe(true)
    const second = av(upload!).audioStreams[1]!
    expect(second.language).toBe('fra')
    const { body } = await client.convert({ uploadId: upload!.id, outputFormat: 'mp3', options: { streamIndex: second.index } })
    const job = await client.waitFor(body.job.id)
    expect(job.status).toBe('completed')
    expect(job.options.streamIndex).toBe(second.index)
  })

  it('preserves duration when audio starts at a non-zero timestamp', async () => {
    const { upload, data } = await convertAndDownload(new TestClient(), fixture('offset-audio.mp4'))
    const stream = av(upload).audioStreams[0]!
    expect(stream.startTimeSec).toBeGreaterThan(0.9)
    // The MP3 contains the audio track itself (≈2 s), not the leading gap before it.
    expect(Math.abs(Number(probe(data).format.duration) - stream.durationSec!)).toBeLessThan(0.5)
  })

  it('downmixes surround audio to stereo', async () => {
    const { upload, data } = await convertAndDownload(new TestClient(), fixture('surround.mp4'))
    expect(av(upload).audioStreams[0]!.channels).toBe(6)
    expect(probe(data).streams[0]!.channels).toBe(2)
  })

  it('supports byte-range requests for preview seeking', async () => {
    const client = new TestClient()
    const { job, data } = await convertAndDownload(client, fixture('audio-only.mp4'))
    const res = await client.download(job.id, { range: 'bytes=10-19' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 10-19/${data.length}`)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(data.subarray(10, 20))
    expect((await client.download(job.id, { range: `bytes=${data.length + 5}-` })).status).toBe(416)
  })

  it('returns the existing job for a duplicate submission', async () => {
    const client = new TestClient()
    const { upload } = await client.prepare(fixture('audio-only.mp4'))
    const a = await client.convert({ uploadId: upload!.id, outputFormat: 'mp3', options: { bitrate: 192 } })
    const b = await client.convert({ uploadId: upload!.id, outputFormat: 'mp3', options: {} })
    expect(b.res.status).toBe(200)
    expect(b.body.created).toBe(false)
    expect(b.body.job.id).toBe(a.body.job.id)
    await client.waitFor(a.body.job.id)
    expect((await client.history()).jobs).toHaveLength(1)
  })
})

describe('WAV → MP3 (second adapter)', () => {
  it('resamples low sample rates so every bitrate is valid', async () => {
    const { upload, job, data } = await convertAndDownload(new TestClient(), fixture('mono-22k.wav'), { bitrate: 320 })
    expect(upload.info?.format).toBe('wav')
    expect(job.output?.details.sampleRate).toBe(44100)
    const s = probe(data).streams[0]!
    expect(s.channels).toBe(1)
    expect(Number(s.bit_rate)).toBe(320000)
  })

  it('resamples high-resolution audio to 48 kHz', async () => {
    const { data } = await convertAndDownload(new TestClient(), fixture('stereo-96k.wav'))
    expect(probe(data).streams[0]!.sample_rate).toBe('48000')
  })
})

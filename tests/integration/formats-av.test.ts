import { beforeAll, describe, expect, it } from 'vitest'
import { av, convertOk, TestClient } from '../helpers/client'
import { ensureFixtures, fixture } from '../helpers/fixtures'
import { ffprobe } from '../helpers/inspect'

beforeAll(() => ensureFixtures())

const streamsOf = (p: ReturnType<typeof ffprobe>, type: string) => p.streams.filter((s) => s.codec_type === type)

describe('container detection', () => {
  it.each([
    ['clip.mov', 'mov'],
    ['clip.mkv', 'mkv'],
    ['clip.webm', 'webm'],
    ['clip.avi', 'avi'],
    ['tone.flac', 'flac'],
    ['tone.ogg', 'ogg'],
    ['tone.mp3', 'mp3'],
  ])('%s is detected as %s from its contents', async (file, format) => {
    const { upload } = await new TestClient().prepare(fixture(file))
    expect(upload!.status).toBe('validated')
    expect(upload!.info?.format).toBe(format)
  })
})

describe('video → video', () => {
  it('MOV → MP4 copies compatible streams losslessly', async () => {
    const { job, data } = await convertOk(new TestClient(), fixture('clip.mov'), 'mp4')
    expect(job.output?.details.encoding).toBe('copied (lossless)')
    const p = ffprobe(data, 'mp4')
    expect(p.format.format_name).toContain('mp4')
    expect(streamsOf(p, 'video')[0]!.codec_name).toBe('h264')
    expect(streamsOf(p, 'audio')[0]!.codec_name).toBe('aac')
    expect(Math.abs(Number(p.format.duration) - 2)).toBeLessThan(0.5)
  })

  it('MOV → MP4 re-encodes when asked', async () => {
    const { job } = await convertOk(new TestClient(), fixture('clip.mov'), 'mp4', { mode: 'reencode', quality: 'small' })
    expect(job.output?.details.encoding).toBe('re-encoded')
  })

  it('MKV (Vorbis audio) → MP4 transcodes the incompatible audio', async () => {
    const { job, data } = await convertOk(new TestClient(), fixture('clip.mkv'), 'mp4')
    expect(job.output?.details.encoding).toBe('re-encoded')
    expect(streamsOf(ffprobe(data, 'mp4'), 'audio')[0]!.codec_name).toBe('aac')
  })

  it('AVI (MPEG-4 Part 2) → MP4 as H.264', async () => {
    const { data } = await convertOk(new TestClient(), fixture('clip.avi'), 'mp4')
    expect(streamsOf(ffprobe(data, 'mp4'), 'video')[0]!.codec_name).toBe('h264')
  })

  it('MP4 → WebM as VP9/Opus', async () => {
    const { data } = await convertOk(new TestClient(), fixture('video-audio.mp4'), 'webm', { quality: 'small' })
    const p = ffprobe(data, 'webm')
    expect(p.format.format_name).toContain('webm')
    expect(streamsOf(p, 'video')[0]!.codec_name).toBe('vp9')
    expect(streamsOf(p, 'audio')[0]!.codec_name).toBe('opus')
  })

  it('WebM → MP4 downscales to the requested height', async () => {
    const client = new TestClient()
    const { upload } = await client.prepare(fixture('clip.webm'))
    // 120 px source: no smaller presets are offered, and larger ones never upscale.
    const field = upload!.outputs.find((o) => o.format === 'mp4')!.options.find((f) => f.key === 'maxHeight')
    expect(field && field.type === 'select' && field.choices.map((c) => c.value)).toEqual(['original'])
    const { data } = await convertOk(client, fixture('clip.webm'), 'mp4', { maxHeight: 480 })
    expect(streamsOf(ffprobe(data, 'mp4'), 'video')[0]!.height).toBe(120)
  })

  it('offers no video outputs for audio-only files', async () => {
    const { upload } = await new TestClient().prepare(fixture('tone.flac'))
    expect(upload!.outputs.map((o) => o.format).sort()).toEqual(['m4a', 'mp3', 'ogg', 'wav'])
  })
})

describe('audio ↔ audio and extraction from video', () => {
  it('FLAC → MP3', async () => {
    const { data } = await convertOk(new TestClient(), fixture('tone.flac'), 'mp3', { bitrate: 256 })
    expect(Number(ffprobe(data, 'mp3').streams[0]!.bit_rate)).toBe(256000)
  })

  it('MP3 → WAV at 24-bit', async () => {
    const { job, data } = await convertOk(new TestClient(), fixture('tone.mp3'), 'wav', { bitDepth: 24 })
    expect(job.output?.details.bitDepth).toBe(24)
    expect(ffprobe(data, 'wav').streams[0]!.codec_name).toBe('pcm_s24le')
  })

  it('WAV → FLAC is lossless and keeps the sample rate', async () => {
    const { job, data } = await convertOk(new TestClient(), fixture('stereo-96k.wav'), 'flac', { bitDepth: 24 })
    const s = ffprobe(data, 'flac').streams[0]!
    expect(s.codec_name).toBe('flac')
    expect(s.sample_rate).toBe('96000')
    expect(job.output?.details.sampleRate).toBe(96000)
  })

  it('OGG → M4A (AAC)', async () => {
    const { data } = await convertOk(new TestClient(), fixture('tone.ogg'), 'm4a')
    const p = ffprobe(data, 'm4a')
    expect(p.streams[0]!.codec_name).toBe('aac')
    expect(p.format.tags?.major_brand?.trim()).toBe('M4A')
  })

  it('WAV → OGG (Vorbis)', async () => {
    const { data } = await convertOk(new TestClient(), fixture('mono-22k.wav'), 'ogg')
    expect(ffprobe(data, 'ogg').streams[0]!.codec_name).toBe('vorbis')
  })

  it('extracts audio from MKV video to MP3', async () => {
    const { upload, data } = await convertOk(new TestClient(), fixture('clip.mkv'), 'mp3')
    expect(av(upload).videoStreams.length).toBe(1)
    const p = ffprobe(data, 'mp3')
    expect(streamsOf(p, 'video')).toHaveLength(0)
    expect(p.streams[0]!.codec_name).toBe('mp3')
  })

  it('extracts audio from MP4 video to FLAC, keeping surround channels', async () => {
    const { data } = await convertOk(new TestClient(), fixture('surround.mp4'), 'flac')
    expect(ffprobe(data, 'flac').streams[0]!.channels).toBe(6)
  })

  it('rejects options that belong to another output', async () => {
    const client = new TestClient()
    const { upload } = await client.prepare(fixture('tone.flac'))
    const { body } = await client.convert({ uploadId: upload!.id, outputFormat: 'wav', options: { bitrate: 192 } })
    expect(body.error?.code).toBe('INVALID_OPTIONS')
  })
})

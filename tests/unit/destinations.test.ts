import { describe, expect, it } from 'vitest'
import type { VerificationReport } from '@/lib/api'
import { DESTINATIONS, findDestination, planDestination, type DestinationInput } from '@/lib/destinations'
import { receiptText } from '@/lib/receipt'
import { formatTarget, heightForVideoKbps, MB, mp3BitrateFor, MIN_VIDEO_KBPS, videoBudget } from '@/lib/size-targets'
import { registry } from '@/server/conversions'
import { effectiveBitrate } from '@/server/conversions/adapters/audio'
import { buildVideoArgs, sizeBudget } from '@/server/conversions/adapters/video'
import type { FileInfo } from '@/server/inspect/types'
import type { MediaInfo } from '@/server/media/probe'

const video = (over: Partial<DestinationInput> = {}): DestinationInput => ({ kind: 'video', durationSec: 60, hasAudio: true, hasAlpha: false, animated: false, ...over })

function media(durationSec: number, sizeBytes = 200 * MB): MediaInfo {
  return {
    family: 'isobmff', format: 'mov', formatName: 'mov,mp4', majorBrand: 'qt', durationSec, bitRate: null, sizeBytes,
    audioStreams: [{ index: 1, ordinal: 0, codec: 'aac', codecLongName: null, channels: 2, channelLayout: 'stereo', sampleRate: 48000, bitRate: null, durationSec, startTimeSec: 0, language: null, title: null, isDefault: true, decodable: true }],
    videoStreams: [{ index: 0, codec: 'h264', width: 1920, height: 1080, frameRate: 30, pixFmt: 'yuv420p', durationSec, isAttachedPicture: false, decodable: true }],
  }
}

describe('size budgets', () => {
  it('splits a budget into video and audio bitrates with headroom', () => {
    const b = videoBudget(60, 10 * MB, true)!
    // 10 MB over 60 s is ~1333 kbps in total, 94 % of which goes to streams.
    expect(b.audioKbps).toBe(96)
    expect(b.videoKbps).toBe(Math.floor((10 * MB * 8 * 0.94) / 60 / 1000) - 96)
    expect((b.videoKbps + b.audioKbps) * 1000 * 60 / 8).toBeLessThan(10 * MB)
    expect(b.maxHeight).toBe(720)
  })

  it('refuses targets below watchable quality', () => {
    expect(videoBudget(3600, 10 * MB, true)).toBeNull()
    expect(videoBudget(0, 10 * MB, true)).toBeNull()
    expect(videoBudget(10, 10 * MB, false)!.audioKbps).toBe(0)
  })

  it('maps bitrates to sensible resolutions', () => {
    expect(heightForVideoKbps(MIN_VIDEO_KBPS)).toBe(360)
    expect(heightForVideoKbps(1500)).toBe(720)
    expect(heightForVideoKbps(8000)).toBeNull()
  })

  it('picks the largest MP3 bitrate that fits, never above the chosen one', () => {
    expect(mp3BitrateFor(180, 10 * MB, 320)).toBe(320)
    // 10 minutes in 5 MB: 64 kbps fits (4.85 MB), 80 kbps does not.
    expect(mp3BitrateFor(600, 5 * MB, 320)).toBe(64)
    expect(mp3BitrateFor(180, 10 * MB, 192)).toBe(192)
    expect(mp3BitrateFor(3600, 5 * MB, 320)).toBeNull()
  })

  it('formats limits in decimal units', () => {
    expect(formatTarget(10 * MB)).toBe('10 MB')
    expect(formatTarget(300_000)).toBe('300 KB')
  })
})

describe('adapters with size targets', () => {
  const info = (m: MediaInfo): FileInfo => ({ kind: 'av', family: 'isobmff', format: 'mov', sizeBytes: m.sizeBytes, media: m })

  it('validates a reachable target and re-encodes at the budgeted bitrate and height', () => {
    const adapter = registry.get('video-to-mp4')!
    const m = media(60)
    const options = adapter.validateOptions({ maxBytes: 10 * MB }, info(m))
    expect(options.maxBytes).toBe(10 * MB)
    const budget = sizeBudget('mp4', m, options)!
    const { args, copied } = buildVideoArgs({ output: 'mp4', inputPath: 'in', outputPath: 'out', media: m, options, threads: 2, budget })
    expect(copied).toBe(false)
    expect(args).toEqual(expect.arrayContaining(['-b:v', `${budget.videoKbps}k`, '-vf', 'scale=-2:720', '-b:a', '96k']))
  })

  it('refuses an unreachable target before queuing', () => {
    const adapter = registry.get('video-to-mp4')!
    expect(() => adapter.validateOptions({ maxBytes: 8 * MB }, info(media(3600)))).toThrow(/can't fit in 8 MB/)
  })

  it('copies instead of re-encoding when the source already fits', () => {
    const m = media(60, 4 * MB)
    const options = registry.get('video-to-mp4')!.validateOptions({ maxBytes: 10 * MB }, info(m))
    expect(sizeBudget('mp4', m, options)).toBeNull()
  })

  it('lowers the MP3 bitrate to fit and rejects the option for other audio formats', () => {
    const m = media(600)
    const mp3 = registry.get('audio-to-mp3')!.validateOptions({ bitrate: 320, maxBytes: 5 * MB }, info(m))
    expect(effectiveBitrate(mp3, 600)).toBe(64)
    expect(() => registry.get('audio-to-m4a')!.validateOptions({ maxBytes: 5 * MB }, info(m))).toThrow()
  })
})

describe('destinations', () => {
  const available = ['mp4', 'webm', 'mp3', 'wav', 'flac', 'm4a', 'ogg'] as const

  it('have unique ids and only use formats and options the adapters accept', () => {
    expect(new Set(DESTINATIONS.map((d) => d.id)).size).toBe(DESTINATIONS.length)
    for (const d of DESTINATIONS) {
      for (const [kind, pick] of Object.entries(d.targets)) {
        const target = pick!({ ...video(), kind: kind as DestinationInput['kind'] })
        const adapter = registry.list().find((a) => a.outputFormat === target.format && !a.id.startsWith('clean-'))
        expect(adapter, `${d.id}/${kind}`).toBeDefined()
        const keys = new Set(adapter!.optionFields(null).map((f) => f.key))
        for (const key of Object.keys(target.options)) expect(keys.has(key), `${d.id}/${kind}: ${key}`).toBe(true)
      }
    }
  })

  it('plans a target, or explains why not', () => {
    const discord = findDestination('discord')!
    expect(planDestination(discord, video(), [...available])).toMatchObject({ ok: true, target: { format: 'mp4' } })
    expect(planDestination(discord, video({ durationSec: 3 * 3600 }), [...available])).toMatchObject({ ok: false, reason: /Too long/ })
    expect(planDestination(discord, video(), ['webm'])).toMatchObject({ ok: false, reason: /Not available/ })
    expect(planDestination(findDestination('print')!, video(), [...available])).toBeNull()
  })

  it('keeps transparency and animation for Discord images', () => {
    const discord = findDestination('discord')!
    const image = (over: Partial<DestinationInput>) => planDestination(discord, { ...video(), kind: 'image', ...over }, ['png', 'jpg', 'gif'])
    expect(image({})).toMatchObject({ target: { format: 'jpg' } })
    expect(image({ hasAlpha: true })).toMatchObject({ target: { format: 'png' } })
    expect(image({ animated: true })).toMatchObject({ target: { format: 'gif' } })
  })
})

describe('receipt', () => {
  it('is self-contained text with both fingerprints', () => {
    const report: VerificationReport = {
      version: 1,
      verifiedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
      input: { name: 'clip.mov', format: 'mov', sizeBytes: 1234, sha256: 'a'.repeat(64) },
      output: { name: 'clip.mp4', format: 'mp4', sizeBytes: 999, sha256: 'b'.repeat(64) },
      checks: [{ label: 'Duration', detail: '3.00 s against 3.00 s in the source' }],
      hidden: { before: [], removed: [], remaining: [] },
      destination: { id: 'discord', label: 'Discord', maxBytes: 10 * MB },
    }
    const text = receiptText(report)
    expect(text).toContain('Verified:      2026-01-02T03:04:05.000Z')
    expect(text).toContain('Made for:      Discord (limit 10 MB)')
    expect(text).toContain(`SHA-256 ${'a'.repeat(64)}`)
    expect(text).toContain(`SHA-256 ${'b'.repeat(64)}`)
    expect(text).toContain('[ok] Duration: 3.00 s against 3.00 s in the source')
  })
})

import { describe, expect, it } from 'vitest'
import { FORMATS, type FormatId } from '@/lib/formats'
import { registry } from '@/server/conversions'
import { buildAudioArgs, createAudioAdapter, mp3SampleRate } from '@/server/conversions/adapters/audio'
import { durationTolerance } from '@/server/conversions/adapters/ffmpeg-common'
import { createImageAdapter, fitInside, keepsAnimation } from '@/server/conversions/adapters/image'
import { buildVideoArgs, canCopy, createVideoAdapter } from '@/server/conversions/adapters/video'
import { ConversionRegistry, describePlan } from '@/server/conversions/registry'
import type { ConversionAdapter } from '@/server/conversions/types'
import type { FileInfo, ImageInfo } from '@/server/inspect/types'
import type { AudioStreamInfo, MediaInfo, VideoStreamInfo } from '@/server/media/probe'
import { safeEntryName } from '@/sandbox/archives'

function stream(over: Partial<AudioStreamInfo> = {}): AudioStreamInfo {
  return {
    index: 1, ordinal: 0, codec: 'aac', codecLongName: null, channels: 2, channelLayout: 'stereo', sampleRate: 48000,
    bitRate: null, durationSec: 10, startTimeSec: 0, language: null, title: null, isDefault: true, decodable: true, ...over,
  }
}

function vstream(over: Partial<VideoStreamInfo> = {}): VideoStreamInfo {
  return { index: 0, codec: 'h264', width: 1920, height: 1080, frameRate: 30, pixFmt: 'yuv420p', durationSec: 10, isAttachedPicture: false, decodable: true, ...over }
}

function media(over: Partial<MediaInfo> = {}): MediaInfo {
  return {
    family: 'isobmff', format: 'mp4', formatName: 'mov,mp4,m4a,3gp,3g2,mj2', majorBrand: 'isom', durationSec: 10,
    bitRate: null, sizeBytes: 1000, audioStreams: [stream()], videoStreams: [vstream()], ...over,
  }
}

function av(over: Partial<MediaInfo> = {}): FileInfo {
  const m = media(over)
  return { kind: 'av', family: m.family, format: m.format, sizeBytes: 1000, media: m }
}

function img(over: Partial<ImageInfo> = {}): FileInfo {
  const image: ImageInfo = { format: 'png', width: 4000, height: 3000, frames: 1, hasAlpha: false, colorSpace: 'srgb', ...over }
  return { kind: 'image', family: 'png', format: image.format, sizeBytes: 1000, image }
}

function fake(id: string, inputs: FormatId[], output: FormatId, extra: Partial<ConversionAdapter> = {}): ConversionAdapter {
  return {
    id, label: id, inputFormats: inputs, outputFormat: output, requiredTools: [], lossy: false, notes: [],
    optionFields: () => [], validateInput: () => undefined, validateOptions: () => ({}),
    estimate: () => ({ outputBytes: 0, cpuSeconds: 0 }), convert: async () => undefined,
    verifyOutput: async () => ({ format: output, sizeBytes: 0, durationSec: null, details: {}, checks: [] }),
    ...extra,
  }
}

describe('registry planning', () => {
  it('returns null for unregistered conversions and plain identity', () => {
    expect(registry.plan('mp3', 'png')).toBeNull()
    expect(registry.plan('mp4', 'mp4')!.steps.map((s) => s.id)).toEqual(['clean-mp4'])
    expect(registry.plan('zip', 'zip')).toBeNull()
  })

  it('allows same-format transforms only for adapters that opt in', () => {
    expect(registry.plan('png', 'png')!.steps.map((s) => s.id)).toEqual(['image-to-png'])
    expect(() => new ConversionRegistry().register(fake('b', ['wav'], 'wav'))).toThrow(/itself/)
    expect(() => new ConversionRegistry().register(fake('c', ['wav'], 'wav', { allowSameFormat: true }))).not.toThrow()
  })

  it('rejects duplicate adapters', () => {
    expect(() => new ConversionRegistry().register(fake('a', ['wav'], 'mp3')).register(fake('a', ['wav'], 'mp3'))).toThrow(/Duplicate/)
  })

  it('plans multi-step chains only through registered adapters, shortest first', () => {
    const r = new ConversionRegistry()
      .register(fake('mov-mp4', ['mov'], 'mp4'))
      .register(fake('mp4-wav', ['mp4'], 'wav'))
      .register(fake('wav-mp3', ['wav'], 'mp3'))
      .register(fake('mov-wav', ['mov'], 'wav'))
    expect(r.plan('mov', 'mp4')!.steps.map((s) => s.id)).toEqual(['mov-mp4'])
    expect(r.plan('mov', 'mp3')!.steps.map((s) => s.id)).toEqual(['mov-wav', 'wav-mp3'])
    expect(r.plan('mp4', 'mp3')!.steps).toHaveLength(2)
    expect(r.plan('mp4', 'mp3', 1)).toBeNull()
  })

  it('never chains through adapters marked non-chainable', () => {
    const r = new ConversionRegistry().register(fake('png-pdf', ['png'], 'pdf', { chainable: false })).register(fake('pdf-txt', ['pdf'], 'txt'))
    expect(r.plan('png', 'pdf')).not.toBeNull()
    expect(r.plan('png', 'txt')).toBeNull()
  })

  it('cannot loop through cycles', () => {
    const r = new ConversionRegistry().register(fake('wav-mp3', ['wav'], 'mp3')).register(fake('mp3-wav', ['mp3'], 'wav'))
    expect(r.plan('wav', 'mov', 10)).toBeNull()
    expect(r.reachable('wav', 10).map((p) => p.to)).toEqual(['mp3'])
  })

  it('describes plans with kind, lossiness, notes and options', () => {
    const choice = describePlan(registry.plan('mp4', 'mp3')!, av())
    expect(choice).toMatchObject({ kind: 'audio', lossy: true, sameFormat: false })
    expect(choice.options.map((o) => o.key)).toEqual(['bitrate', 'maxBytes'])
    const multi = describePlan(registry.plan('mp4', 'mp3')!, av({ audioStreams: [stream(), stream({ index: 2, ordinal: 1, isDefault: false })] }))
    expect(multi.options.map((o) => o.key)).toEqual(['bitrate', 'maxBytes', 'streamIndex'])
    expect(describePlan(registry.plan('png', 'png')!, img()).sameFormat).toBe(true)
  })
})

describe('audio adapters', () => {
  const mp3 = createAudioAdapter('mp3')
  const wav = createAudioAdapter('wav')
  const flac = createAudioAdapter('flac')

  it('validates options and fills defaults', () => {
    expect(mp3.validateOptions({}, av())).toEqual({ bitrate: 192, streamIndex: 1, maxBytes: null })
    expect(mp3.validateOptions({ bitrate: '320' }, av())).toEqual({ bitrate: 320, streamIndex: 1, maxBytes: null })
    expect(wav.validateOptions({ bitDepth: 24 }, av())).toEqual({ bitDepth: 24, streamIndex: 1 })
    for (const bad of [{ bitrate: 999 }, { bitrate: 'abc' }, { streamIndex: 5 }, { extra: 1 }]) {
      expect(() => mp3.validateOptions(bad, av())).toThrow(expect.objectContaining({ code: 'INVALID_OPTIONS' }))
    }
    // Options belong to their output: WAV has no bitrate, MP3 has no bit depth.
    expect(() => wav.validateOptions({ bitrate: 192 }, av())).toThrow(expect.objectContaining({ code: 'INVALID_OPTIONS' }))
    expect(() => mp3.validateOptions({ bitDepth: 24 }, av())).toThrow(expect.objectContaining({ code: 'INVALID_OPTIONS' }))
  })

  it('prefers the default track and skips undecodable ones', () => {
    const m = av({ audioStreams: [stream({ index: 1, isDefault: false }), stream({ index: 2, ordinal: 1, isDefault: true })] })
    expect(mp3.validateOptions({}, m).streamIndex).toBe(2)
    const broken = av({ audioStreams: [stream({ index: 1, decodable: false }), stream({ index: 2, ordinal: 1, isDefault: false })] })
    expect(mp3.validateOptions({}, broken).streamIndex).toBe(2)
    expect(() => mp3.validateOptions({ streamIndex: 1 }, broken)).toThrow(/cannot be decoded/)
  })

  it('rejects inputs it cannot handle', () => {
    expect(() => mp3.validateInput(av({ audioStreams: [] }))).toThrow(expect.objectContaining({ code: 'NO_AUDIO_STREAM' }))
    expect(() => mp3.validateInput(av({ audioStreams: [stream({ decodable: false, codec: 'opus' })] }))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CODEC' }))
    expect(() => mp3.validateInput(av({ durationSec: 10 * 3600 }))).toThrow(expect.objectContaining({ code: 'DURATION_LIMIT' }))
    expect(() => mp3.validateInput(img())).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONVERSION' }))
    expect(() => flac.validateInput(av({ format: 'flac' }))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONVERSION' }))
  })

  it('chooses MP3-compatible sample rates', () => {
    expect([44100, 48000, 32000, 22050, 8000, 96000].map(mp3SampleRate)).toEqual([44100, 48000, 32000, 44100, 44100, 48000])
  })

  it('builds an argument array that only maps the chosen audio track', () => {
    const m = media()
    const args = buildAudioArgs({ output: 'mp3', inputPath: '/data/in; rm -rf /', outputPath: '/data/out.mp3', media: m, stream: stream({ index: 3, channels: 6 }), options: { streamIndex: 3, bitrate: 256 }, threads: 2 })
    expect(args).toContain('file:/data/in; rm -rf /')
    expect(args.slice(args.indexOf('-map'), args.indexOf('-map') + 2)).toEqual(['-map', '0:3'])
    expect(args).toEqual(expect.arrayContaining(['-vn', '-sn', '-dn', '-c:a', 'libmp3lame', '-b:a', '256k', '-ac', '2']))
    expect(args.slice(args.indexOf('-protocol_whitelist'), args.indexOf('-protocol_whitelist') + 2)).toEqual(['-protocol_whitelist', 'file'])
    const flacArgs = buildAudioArgs({ output: 'flac', inputPath: 'i', outputPath: 'o', media: m, stream: stream({ channels: 6 }), options: { streamIndex: 1, bitDepth: 24 }, threads: 1 })
    expect(flacArgs).not.toContain('-ac') // lossless outputs keep surround channels
    expect(flacArgs).toEqual(expect.arrayContaining(['-sample_fmt', 's32', '-bits_per_raw_sample', '24']))
  })

  it('allows small encoder padding in duration checks', () => {
    expect(durationTolerance(3)).toBe(0.5)
    expect(durationTolerance(600)).toBe(12)
  })
})

describe('video adapters', () => {
  const mp4 = createVideoAdapter('mp4')
  const opts = (o: Partial<Parameters<typeof canCopy>[2]> = {}) => ({ mode: 'auto' as const, quality: 'balanced' as const, maxHeight: null, streamIndex: 1, ...o })

  it('copies compatible streams and re-encodes otherwise', () => {
    expect(canCopy('mp4', media({ format: 'mov' }), opts())).toBe(true)
    expect(canCopy('mp4', media(), opts({ mode: 'reencode' }))).toBe(false)
    expect(canCopy('mp4', media(), opts({ maxHeight: 720 }))).toBe(false)
    expect(canCopy('mp4', media({ videoStreams: [vstream({ codec: 'mpeg4' })] }), opts())).toBe(false)
    expect(canCopy('mp4', media({ audioStreams: [stream({ codec: 'vorbis' })] }), opts())).toBe(false)
    expect(canCopy('webm', media({ videoStreams: [vstream({ codec: 'vp9' })], audioStreams: [stream({ codec: 'opus' })] }), opts())).toBe(true)
  })

  it('builds copy and encode arguments', () => {
    const copy = buildVideoArgs({ output: 'mp4', inputPath: 'i', outputPath: 'o', media: media({ videoStreams: [vstream({ codec: 'hevc' })] }), options: opts(), threads: 2 })
    expect(copy.copied).toBe(true)
    expect(copy.args).toEqual(expect.arrayContaining(['-c', 'copy', '-tag:v', 'hvc1', '-movflags', '+faststart']))
    const enc = buildVideoArgs({ output: 'mp4', inputPath: 'i', outputPath: 'o', media: media(), options: opts({ maxHeight: 720, quality: 'high' }), threads: 2 })
    expect(enc.copied).toBe(false)
    expect(enc.args).toEqual(expect.arrayContaining(['-vf', 'scale=-2:720', '-c:v', 'libx264', '-crf', '18', '-c:a', 'aac']))
    expect(enc.args).toEqual(expect.arrayContaining(['-map_metadata', '-1', '-sn']))
  })

  it('never upscales and validates options', () => {
    expect(mp4.validateOptions({ maxHeight: 1080 }, av({ videoStreams: [vstream({ height: 720 })] })).maxHeight).toBeNull()
    expect(mp4.validateOptions({ maxHeight: 480 }, av()).maxHeight).toBe(480)
    expect(() => mp4.validateOptions({ maxHeight: 999 }, av())).toThrow(expect.objectContaining({ code: 'INVALID_OPTIONS' }))
    expect(mp4.validateOptions({}, av({ audioStreams: [] })).streamIndex).toBeNull()
  })

  it('requires a real video stream', () => {
    expect(() => mp4.validateInput(av({ format: 'mov', videoStreams: [] }))).toThrow(expect.objectContaining({ code: 'NO_VIDEO_STREAM' }))
    expect(() => mp4.validateInput(av({ format: 'mov', videoStreams: [vstream({ isAttachedPicture: true })] }))).toThrow(expect.objectContaining({ code: 'NO_VIDEO_STREAM' }))
    expect(() => mp4.validateInput(av({ format: 'mov', durationSec: 5 * 3600, videoStreams: [vstream({ durationSec: 5 * 3600 })] }))).toThrow(
      expect.objectContaining({ code: 'DURATION_LIMIT' }),
    )
  })
})

describe('image adapters', () => {
  it('fits inside a box without enlarging', () => {
    expect(fitInside(4000, 3000, 1000, null)).toEqual({ width: 1000, height: 750 })
    expect(fitInside(4000, 3000, 1000, 500)).toEqual({ width: 667, height: 500 })
    expect(fitInside(400, 300, 1000, 1000)).toEqual({ width: 400, height: 300 })
    expect(fitInside(400, 300, null, null)).toEqual({ width: 400, height: 300 })
  })

  it('keeps animation only between animated formats', () => {
    const gif = { format: 'gif', width: 1, height: 1, frames: 10, hasAlpha: false, colorSpace: null } as const
    expect(keepsAnimation(gif, 'webp')).toBe(true)
    expect(keepsAnimation(gif, 'png')).toBe(false)
    expect(keepsAnimation({ ...gif, format: 'tiff' }, 'gif')).toBe(false)
    expect(keepsAnimation({ ...gif, frames: 1 }, 'gif')).toBe(false)
  })

  it('validates dimensions against encoder limits', () => {
    const webp = createImageAdapter('webp')
    expect(webp.validateOptions({ width: '', height: null }, img())).toEqual({ width: null, height: null, quality: 'balanced', maxBytes: null })
    expect(() => webp.validateOptions({}, img({ width: 20000, height: 100 }))).toThrow(/at most 16383/)
    expect(webp.validateOptions({ width: 16000 }, img({ width: 20000, height: 100 })).width).toBe(16000)
    for (const bad of [{ width: 0 }, { width: 1.5 }, { width: -4 }, { width: 50000 }, { quality: 'max' }]) {
      expect(() => webp.validateOptions(bad, img())).toThrow(expect.objectContaining({ code: 'INVALID_OPTIONS' }))
    }
  })
})

describe('archive entry names', () => {
  it('normalises safe paths', () => {
    expect(safeEntryName('docs/readme.txt')).toBe('docs/readme.txt')
    expect(safeEntryName('./docs//a.txt')).toBe('docs/a.txt')
    expect(safeEntryName('docs\\win.txt')).toBe('docs/win.txt')
    expect(safeEntryName('dir/')).toBe('dir/')
  })
  it('rejects paths that escape the archive root', () => {
    for (const bad of ['../evil', 'a/../../evil', '/etc/passwd', 'C:/Windows/x', 'C:\\x', '..']) expect(safeEntryName(bad)).toBeNull()
  })
})

describe('every adapter', () => {
  const infoFor = (adapter: ConversionAdapter): FileInfo => {
    const kind = FORMATS[adapter.inputFormats[0]!].kind
    if (kind === 'image') return img()
    if (kind === 'document') return { kind: 'pdf', family: 'pdf', format: 'pdf', sizeBytes: 1, pdf: { pages: 3, title: null, permissions: { copy: true, print: true } } }
    if (kind === 'archive') {
      return { kind: 'archive', family: 'zip', format: 'zip', sizeBytes: 1, archive: { format: 'zip', documentType: null, files: 1, directories: 0, skipped: 0, unpackedBytes: 1, encrypted: false, unsafePaths: false } }
    }
    return av()
  }

  it.each(registry.list().map((a) => [a.id, a] as const))('%s: normalised options re-validate to themselves', (_id, adapter) => {
    // Jobs store normalised options and the worker validates them again.
    const info = infoFor(adapter)
    const once = adapter.validateOptions({}, info)
    expect(adapter.validateOptions(JSON.parse(JSON.stringify(once)), info)).toEqual(once)
  })
})

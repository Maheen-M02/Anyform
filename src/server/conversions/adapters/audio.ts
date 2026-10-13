import { stat } from 'node:fs/promises'
import { z } from 'zod'
import { AUDIO_FORMATS, FORMATS, VIDEO_FORMATS } from '@/lib/formats'
import { getConfig } from '../../config'
import { AppError } from '../../errors'
import { canDecodeStream, inputGuardArgs, probeMedia, type AudioStreamInfo, type MediaInfo } from '../../media/probe'
import { ToolError } from '../../media/process'
import type { ContainerFamily } from '../../media/sniff'
import type { ConversionAdapter, OptionField } from '../types'
import {
  audioStreamOrThrow,
  defaultAudioStream,
  durationTolerance,
  expectedDuration,
  mediaOf,
  PROGRESS_ARGS,
  requireAudio,
  runFfmpeg,
  verificationError,
} from './ffmpeg-common'

export type AudioOutput = (typeof AUDIO_FORMATS)[number]

export const MP3_BITRATES = [128, 192, 256, 320] as const
const AAC_VORBIS_BITRATES = [128, 192, 256] as const
const BIT_DEPTHS = [16, 24] as const
/** Vorbis quality levels that land near the offered bitrates for stereo 44.1 kHz. */
const VORBIS_QUALITY: Record<number, number> = { 128: 4, 192: 6, 256: 8 }

export interface AudioOptions {
  streamIndex: number
  bitrate?: number
  bitDepth?: 16 | 24
}

interface OutputSpec {
  family: ContainerFamily
  codec: (o: AudioOptions) => string
  lossy: boolean
  bitrates?: readonly number[]
  bitDepths?: readonly (16 | 24)[]
  maxChannels: number
  sampleRate: (input: number) => number | null
  encoder: (o: AudioOptions) => string[]
  muxer: string[]
  /** CBR outputs can have their bitrate verified exactly. */
  verifyBitrate: boolean
}

/** MPEG-1 Layer III rates support every offered bitrate; others are resampled. */
export function mp3SampleRate(input: number): number {
  if (input === 32000 || input === 44100 || input === 48000) return input
  return input > 48000 ? 48000 : 44100
}

export const AUDIO_OUTPUTS: Record<AudioOutput, OutputSpec> = {
  mp3: {
    family: 'mp3',
    codec: () => 'mp3',
    lossy: true,
    bitrates: MP3_BITRATES,
    maxChannels: 2,
    sampleRate: mp3SampleRate,
    encoder: (o) => ['-c:a', 'libmp3lame', '-b:a', `${o.bitrate}k`],
    muxer: ['-id3v2_version', '3', '-write_xing', '1', '-f', 'mp3'],
    verifyBitrate: true,
  },
  m4a: {
    family: 'isobmff',
    codec: () => 'aac',
    lossy: true,
    bitrates: AAC_VORBIS_BITRATES,
    maxChannels: 6,
    // Below 44.1 kHz the AAC encoder silently caps the bitrate; resample so the target is honoured.
    sampleRate: (sr) => (sr > 96000 ? 48000 : sr < 44100 ? 44100 : null),
    encoder: (o) => ['-c:a', 'aac', '-b:a', `${o.bitrate}k`],
    muxer: ['-movflags', '+faststart', '-f', 'ipod'],
    verifyBitrate: false,
  },
  ogg: {
    family: 'ogg',
    codec: () => 'vorbis',
    lossy: true,
    bitrates: AAC_VORBIS_BITRATES,
    maxChannels: 2,
    sampleRate: (sr) => (sr > 192000 ? 48000 : null),
    // Vorbis quality mode works for every rate/channel layout (fixed bitrates do not).
    encoder: (o) => ['-c:a', 'libvorbis', '-q:a', String(VORBIS_QUALITY[o.bitrate ?? 192] ?? 6)],
    muxer: ['-f', 'ogg'],
    verifyBitrate: false,
  },
  wav: {
    family: 'wav',
    codec: (o) => (o.bitDepth === 24 ? 'pcm_s24le' : 'pcm_s16le'),
    lossy: false,
    bitDepths: BIT_DEPTHS,
    maxChannels: 8,
    sampleRate: () => null,
    encoder: (o) => ['-c:a', o.bitDepth === 24 ? 'pcm_s24le' : 'pcm_s16le'],
    // RF64 above 4 GB, plain RIFF otherwise.
    muxer: ['-rf64', 'auto', '-f', 'wav'],
    verifyBitrate: false,
  },
  flac: {
    family: 'flac',
    codec: () => 'flac',
    lossy: false,
    bitDepths: BIT_DEPTHS,
    maxChannels: 8,
    sampleRate: () => null,
    encoder: (o) =>
      o.bitDepth === 24
        ? ['-c:a', 'flac', '-compression_level', '5', '-sample_fmt', 's32', '-bits_per_raw_sample', '24']
        : ['-c:a', 'flac', '-compression_level', '5', '-sample_fmt', 's16'],
    muxer: ['-f', 'flac'],
    verifyBitrate: false,
  },
}

export function buildAudioArgs(a: {
  output: AudioOutput
  inputPath: string
  outputPath: string
  media: MediaInfo
  stream: AudioStreamInfo
  options: AudioOptions
  threads: number
}): string[] {
  const spec = AUDIO_OUTPUTS[a.output]
  const args = [
    ...PROGRESS_ARGS,
    ...inputGuardArgs(a.media.family),
    '-i', `file:${a.inputPath}`,
    '-map', `0:${a.stream.index}`,
    // Audio only: video, subtitles, data, metadata and chapters are never touched.
    '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    // Fill timestamp gaps / drop overlaps so output duration matches the source timeline.
    '-af', 'aresample=async=1',
    ...spec.encoder(a.options),
  ]
  const rate = spec.sampleRate(a.stream.sampleRate)
  if (rate !== null && rate !== a.stream.sampleRate) args.push('-ar', String(rate))
  if (a.stream.channels > spec.maxChannels) args.push('-ac', '2')
  args.push('-threads', String(a.threads), ...spec.muxer, `file:${a.outputPath}`)
  return args
}

export function createAudioAdapter(output: AudioOutput): ConversionAdapter<AudioOptions> {
  const spec = AUDIO_OUTPUTS[output]
  const label = FORMATS[output].label
  const id = `audio-to-${output}`
  const optionsSchema = z
    .object({
      bitrate: spec.bitrates
        ? z.coerce
            .number()
            .refine((v) => spec.bitrates!.includes(v), { message: `Bitrate must be one of ${spec.bitrates.join(', ')} kbps` })
            .default(192)
        : // Present only for outputs that have it; supplying it elsewhere is an error.
          z.never().optional(),
      bitDepth: spec.bitDepths
        ? z.coerce
            .number()
            .refine((v): v is 16 | 24 => v === 16 || v === 24, { message: 'Bit depth must be 16 or 24' })
            .default(16)
        : z.never().optional(),
      streamIndex: z.coerce.number().int().nonnegative().optional(),
    })
    .strict()

  const inputFormats = [...AUDIO_FORMATS, ...VIDEO_FORMATS].filter((f) => f !== output)

  return {
    id,
    label: `Audio to ${label}`,
    inputFormats,
    outputFormat: output,
    requiredTools: ['ffmpeg', 'ffprobe'],
    lossy: spec.lossy,
    notes: [
      spec.lossy
        ? `${label} is lossy: audio is re-encoded and some detail is discarded.`
        : `${label} is lossless: no further quality is lost, but quality already lost in the source cannot be restored.`,
      'Only one audio track is exported. Video, subtitles and metadata are not included.',
      ...(spec.maxChannels === 2 ? ['Surround audio is downmixed to stereo.'] : []),
    ],

    optionFields(info) {
      const fields: OptionField[] = []
      if (spec.bitrates) {
        fields.push({
          key: 'bitrate',
          label: 'Bitrate',
          type: 'select',
          choices: spec.bitrates.map((b) => ({ value: b, label: spec.verifyBitrate ? `${b} kbps` : `~${b} kbps` })),
          default: 192,
          help: spec.verifyBitrate
            ? 'Higher bitrates sound closer to the source and produce larger files.'
            : 'Variable bitrate: the encoder targets this rate and adapts to the audio.',
        })
      }
      if (spec.bitDepths) {
        fields.push({
          key: 'bitDepth',
          label: 'Bit depth',
          type: 'select',
          choices: spec.bitDepths.map((d) => ({ value: d, label: `${d}-bit` })),
          default: 16,
          help: '16-bit is CD quality; 24-bit preserves high-resolution sources.',
        })
      }
      if (!info || (info.kind === 'av' && info.media.audioStreams.length > 1)) {
        fields.push({ key: 'streamIndex', label: 'Audio track', type: 'audioStream', help: 'This file has several audio tracks.' })
      }
      return fields
    },

    validateInput(info) {
      if (!info.format || !(inputFormats as readonly string[]).includes(info.format)) {
        throw new AppError('UNSUPPORTED_CONVERSION', `${label} conversion does not accept this file type.`)
      }
      requireAudio(mediaOf(info), getConfig().maxDurationSeconds)
    },

    validateOptions(raw, info) {
      const media = mediaOf(info)
      const parsed = optionsSchema.safeParse(raw ?? {})
      if (!parsed.success) throw new AppError('INVALID_OPTIONS', parsed.error.issues[0]?.message ?? 'Invalid conversion options.')
      const streamIndex = parsed.data.streamIndex ?? defaultAudioStream(media)?.index
      if (streamIndex === undefined) throw new AppError('NO_AUDIO_STREAM', 'This file has no usable audio track.')
      audioStreamOrThrow(media, streamIndex)
      const options: AudioOptions = { streamIndex }
      if (parsed.data.bitrate !== undefined) options.bitrate = parsed.data.bitrate
      if (parsed.data.bitDepth !== undefined) options.bitDepth = parsed.data.bitDepth as 16 | 24
      return options
    },

    estimate(info, options) {
      const media = mediaOf(info)
      const stream = audioStreamOrThrow(media, options.streamIndex)
      const seconds = expectedDuration(media, stream) ?? 0
      const channels = Math.min(stream.channels, spec.maxChannels)
      const pcmBytes = seconds * (spec.sampleRate(stream.sampleRate) ?? stream.sampleRate) * channels * ((options.bitDepth ?? 16) / 8)
      const outputBytes = options.bitrate ? (seconds * options.bitrate * 1000) / 8 : output === 'flac' ? pcmBytes * 0.8 : pcmBytes
      return { outputBytes: Math.ceil(outputBytes * 1.05) + 64 * 1024, cpuSeconds: seconds / 40 }
    },

    async convert(ctx) {
      const media = mediaOf(ctx.info)
      const stream = audioStreamOrThrow(media, ctx.options.streamIndex)
      const args = buildAudioArgs({
        output,
        inputPath: ctx.inputPath,
        outputPath: ctx.outputPath,
        media,
        stream,
        options: ctx.options,
        threads: getConfig().ffmpegThreads,
      })
      await runFfmpeg(args, { ...ctx, totalSec: expectedDuration(media, stream), adapterId: id })
    },

    async verifyOutput(ctx) {
      const size = (await stat(ctx.outputPath).catch(() => null))?.size ?? 0
      if (size === 0) throw verificationError(id, 'empty output')
      let out: MediaInfo
      try {
        out = await probeMedia(ctx.outputPath, { expect: spec.family, signal: ctx.signal })
      } catch (err) {
        if (err instanceof ToolError && err.kind === 'aborted') throw err
        throw verificationError(id, 'output not readable')
      }
      const audio = out.audioStreams
      if (out.format !== output || audio.length !== 1 || audio[0]!.codec !== spec.codec(ctx.options) || out.videoStreams.length > 0) {
        throw verificationError(id, `unexpected output structure: ${out.formatName}/${audio[0]?.codec}`)
      }
      const outStream = audio[0]!
      if (!(await canDecodeStream(ctx.outputPath, spec.family, outStream.index, ctx.signal))) throw verificationError(id, 'output not decodable')

      const media = mediaOf(ctx.info)
      const expected = expectedDuration(media, audioStreamOrThrow(media, ctx.options.streamIndex))
      const actual = out.durationSec ?? outStream.durationSec
      if (actual === null || actual <= 0) throw verificationError(id, 'output has no duration')
      if (expected !== null && Math.abs(actual - expected) > durationTolerance(expected)) {
        throw new AppError('CORRUPT_MEDIA', 'Only part of the audio could be converted. The source file appears to be truncated or damaged.')
      }
      if (spec.verifyBitrate && ctx.options.bitrate) {
        const bitRate = outStream.bitRate ?? out.bitRate
        const target = ctx.options.bitrate * 1000
        if (bitRate !== null && Math.abs(bitRate - target) / target > 0.03) throw verificationError(id, `bitrate ${bitRate} != ${target}`)
      }
      const details: Record<string, string | number> = { sampleRate: outStream.sampleRate, channels: outStream.channels }
      if (ctx.options.bitrate) details[spec.verifyBitrate ? 'bitrateKbps' : 'targetKbps'] = ctx.options.bitrate
      if (ctx.options.bitDepth) details.bitDepth = ctx.options.bitDepth
      return { format: output, sizeBytes: size, durationSec: actual, details }
    },
  }
}

export const audioAdapters = AUDIO_FORMATS.map(createAudioAdapter)

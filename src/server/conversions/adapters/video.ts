import { stat } from 'node:fs/promises'
import { z } from 'zod'
import { FORMATS, VIDEO_FORMATS } from '@/lib/formats'
import { getConfig } from '../../config'
import { AppError } from '../../errors'
import { canDecodeStream, inputGuardArgs, probeMedia, type MediaInfo } from '../../media/probe'
import { ToolError } from '../../media/process'
import type { ConversionAdapter, OptionField } from '../types'
import {
  audioStreamOrThrow,
  defaultAudioStream,
  mediaOf,
  primaryVideo,
  PROGRESS_ARGS,
  runFfmpeg,
  verificationError,
} from './ffmpeg-common'

export type VideoOutput = 'mp4' | 'webm'

const QUALITIES = ['high', 'balanced', 'small'] as const
const HEIGHTS = [2160, 1440, 1080, 720, 480] as const

export interface VideoOptions {
  mode: 'auto' | 'reencode'
  quality: (typeof QUALITIES)[number]
  /** Maximum output height in pixels, or null to keep the source size. */
  maxHeight: number | null
  /** Absolute index of the audio track, or null when the video has no audio. */
  streamIndex: number | null
}

interface VideoSpec {
  family: 'isobmff' | 'matroska'
  videoCodec: string
  audioCodec: string
  /** Codecs that may be copied into this container without re-encoding. */
  copyVideo: readonly string[]
  copyAudio: readonly string[]
  crf: Record<VideoOptions['quality'], number>
  encode: (crf: number, threads: number) => string[]
  audio: (channels: number) => string[]
  muxer: string[]
}

const SPECS: Record<VideoOutput, VideoSpec> = {
  mp4: {
    family: 'isobmff',
    videoCodec: 'h264',
    audioCodec: 'aac',
    copyVideo: ['h264', 'hevc'],
    copyAudio: ['aac', 'mp3'],
    crf: { high: 18, balanced: 23, small: 28 },
    encode: (crf) => ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p'],
    audio: (ch) => ['-c:a', 'aac', '-b:a', '160k', ...(ch > 6 ? ['-ac', '2'] : [])],
    muxer: ['-movflags', '+faststart', '-f', 'mp4'],
  },
  webm: {
    family: 'matroska',
    videoCodec: 'vp9',
    audioCodec: 'opus',
    copyVideo: ['vp8', 'vp9', 'av1'],
    copyAudio: ['opus', 'vorbis'],
    crf: { high: 28, balanced: 33, small: 40 },
    encode: (crf) => ['-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-deadline', 'good', '-cpu-used', '5', '-row-mt', '1', '-pix_fmt', 'yuv420p'],
    audio: (ch) => ['-c:a', 'libopus', '-b:a', '128k', ...(ch > 2 ? ['-ac', '2'] : [])],
    muxer: ['-f', 'webm'],
  },
}

/** Whether the streams can be remuxed into the target container unchanged. */
export function canCopy(output: VideoOutput, media: MediaInfo, options: VideoOptions): boolean {
  const spec = SPECS[output]
  const video = primaryVideo(media)
  if (!video || options.mode !== 'auto' || options.maxHeight !== null) return false
  if (!spec.copyVideo.includes(video.codec)) return false
  if (options.streamIndex === null) return true
  const audio = media.audioStreams.find((s) => s.index === options.streamIndex)
  return !!audio && spec.copyAudio.includes(audio.codec)
}

export function buildVideoArgs(a: {
  output: VideoOutput
  inputPath: string
  outputPath: string
  media: MediaInfo
  options: VideoOptions
  threads: number
}): { args: string[]; copied: boolean } {
  const spec = SPECS[a.output]
  const video = primaryVideo(a.media)!
  const audio = a.options.streamIndex === null ? null : a.media.audioStreams.find((s) => s.index === a.options.streamIndex) ?? null
  const copied = canCopy(a.output, a.media, a.options)
  const args = [
    ...PROGRESS_ARGS,
    ...inputGuardArgs(a.media.family),
    '-i', `file:${a.inputPath}`,
    '-map', `0:${video.index}`,
    ...(audio ? ['-map', `0:${audio.index}`] : []),
    // Subtitles, data and metadata (including location tags from phones) are dropped.
    '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
  ]
  if (copied) {
    args.push('-c', 'copy')
    if (a.output === 'mp4' && video.codec === 'hevc') args.push('-tag:v', 'hvc1')
  } else {
    // Even dimensions are required by 4:2:0 encoders.
    const scale = a.options.maxHeight ? `scale=-2:${a.options.maxHeight}` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
    args.push('-vf', scale, ...spec.encode(spec.crf[a.options.quality], a.threads))
    if (audio) args.push(...spec.audio(audio.channels))
  }
  args.push('-max_muxing_queue_size', '1024', '-threads', String(a.threads), ...spec.muxer, `file:${a.outputPath}`)
  return { args, copied }
}

function videoDuration(media: MediaInfo): number | null {
  return primaryVideo(media)?.durationSec ?? media.durationSec
}

export function createVideoAdapter(output: VideoOutput): ConversionAdapter<VideoOptions> {
  const spec = SPECS[output]
  const label = FORMATS[output].label
  const id = `video-to-${output}`
  const inputFormats = VIDEO_FORMATS.filter((f) => f !== output)
  const schema = z
    .object({
      mode: z.enum(['auto', 'reencode']).default('auto'),
      quality: z.enum(QUALITIES).default('balanced'),
      // null is the normalised form of 'original' / 'no audio', so normalised options re-validate.
      maxHeight: z.union([z.literal('original'), z.null(), z.coerce.number().int()]).default('original'),
      streamIndex: z.union([z.null(), z.coerce.number().int().nonnegative()]).optional(),
    })
    .strict()

  return {
    id,
    label: `Video to ${label}`,
    inputFormats,
    outputFormat: output,
    requiredTools: ['ffmpeg', 'ffprobe'],
    lossy: true,
    notes: [
      `Streams are copied unchanged when they already suit ${label} (fast and lossless); otherwise video is re-encoded as ${spec.videoCodec.toUpperCase()}, which is lossy.`,
      'One audio track is kept. Subtitles, chapters and metadata (including location) are removed.',
    ],

    optionFields(info) {
      const media = info?.kind === 'av' ? info.media : null
      const sourceHeight = media ? primaryVideo(media)?.height ?? null : null
      const heights = HEIGHTS.filter((h) => sourceHeight === null || h < sourceHeight)
      const fields: OptionField[] = [
        {
          key: 'mode',
          label: 'Encoding',
          type: 'select',
          choices: [
            { value: 'auto', label: 'Fastest (copy if possible)' },
            { value: 'reencode', label: 'Always re-encode' },
          ],
          default: 'auto',
          help: 'Copying keeps the original quality and is near-instant, but only works for compatible codecs.',
        },
        {
          key: 'quality',
          label: 'Quality',
          type: 'select',
          choices: [
            { value: 'high', label: 'High' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'small', label: 'Small file' },
          ],
          default: 'balanced',
          help: 'Applies when the video is re-encoded.',
        },
        {
          key: 'maxHeight',
          label: 'Resolution',
          type: 'select',
          choices: [{ value: 'original', label: 'Original' }, ...heights.map((h) => ({ value: h, label: `${h}p` }))],
          default: 'original',
          help: 'Downscaling always re-encodes the video.',
        },
      ]
      if (!media || media.audioStreams.length > 1) {
        fields.push({ key: 'streamIndex', label: 'Audio track', type: 'audioStream', help: 'This file has several audio tracks.' })
      }
      return fields
    },

    validateInput(info) {
      if (!info.format || !inputFormats.includes(info.format as (typeof inputFormats)[number])) {
        throw new AppError('UNSUPPORTED_CONVERSION', `${label} conversion does not accept this file type.`)
      }
      const media = mediaOf(info)
      const video = primaryVideo(media)
      if (!video) throw new AppError('NO_VIDEO_STREAM', 'This file has no video track.')
      if (video.decodable === false) throw new AppError('UNSUPPORTED_CODEC', `The video uses a codec that cannot be decoded (${video.codec}).`)
      const duration = videoDuration(media)
      if (duration === null || duration <= 0) throw new AppError('CORRUPT_MEDIA', 'This video reports no playable duration.')
      const limit = getConfig().maxVideoDurationSeconds
      if (duration > limit) throw new AppError('DURATION_LIMIT', `Videos can be at most ${Math.round(limit / 60)} minutes long.`)
    },

    validateOptions(raw, info) {
      const media = mediaOf(info)
      const parsed = schema.safeParse(raw ?? {})
      if (!parsed.success) throw new AppError('INVALID_OPTIONS', parsed.error.issues[0]?.message ?? 'Invalid conversion options.')
      const { mode, quality, maxHeight, streamIndex } = parsed.data
      if (maxHeight !== 'original' && maxHeight !== null && !(HEIGHTS as readonly number[]).includes(maxHeight)) {
        throw new AppError('INVALID_OPTIONS', `Resolution must be one of ${HEIGHTS.join(', ')} or original.`)
      }
      const sourceHeight = primaryVideo(media)?.height ?? Infinity
      if (streamIndex !== undefined && streamIndex !== null) audioStreamOrThrow(media, streamIndex)
      return {
        mode,
        quality,
        // Never upscale: a target at or above the source height keeps the original size.
        maxHeight: maxHeight === 'original' || maxHeight === null || maxHeight >= sourceHeight ? null : maxHeight,
        // Explicit null means "no audio"; absent means "the default track".
        streamIndex: streamIndex === undefined ? defaultAudioStream(media)?.index ?? null : streamIndex,
      }
    },

    estimate(info, options) {
      const media = mediaOf(info)
      const seconds = videoDuration(media) ?? 0
      const copied = canCopy(output, media, options)
      return { outputBytes: Math.ceil(info.sizeBytes * (copied ? 1.1 : 2)) + 1024 * 1024, cpuSeconds: copied ? seconds / 200 : seconds }
    },

    async convert(ctx) {
      const media = mediaOf(ctx.info)
      const { args } = buildVideoArgs({ output, inputPath: ctx.inputPath, outputPath: ctx.outputPath, media, options: ctx.options, threads: getConfig().ffmpegThreads })
      await runFfmpeg(args, { ...ctx, totalSec: videoDuration(media), adapterId: id })
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
      const media = mediaOf(ctx.info)
      const copied = canCopy(output, media, ctx.options)
      const v = primaryVideo(out)
      const expectedCodec = copied ? primaryVideo(media)!.codec : spec.videoCodec
      if (out.format !== output || !v || v.codec !== expectedCodec) throw verificationError(id, `unexpected output: ${out.formatName}/${v?.codec}`)
      if (ctx.options.streamIndex !== null && out.audioStreams.length !== 1) throw verificationError(id, 'audio track missing')
      if (!(await canDecodeStream(ctx.outputPath, spec.family, v.index, ctx.signal, 2))) throw verificationError(id, 'output not decodable')
      // The output holds video and audio, so compare against the container duration.
      const expected = media.durationSec ?? videoDuration(media)
      const actual = out.durationSec ?? v.durationSec
      if (!actual || actual <= 0) throw verificationError(id, 'output has no duration')
      if (expected !== null && Math.abs(actual - expected) > Math.max(1, expected * 0.02)) {
        throw new AppError('CORRUPT_MEDIA', 'Only part of the video could be converted. The source file appears to be truncated or damaged.')
      }
      const details: Record<string, string | number> = {
        resolution: `${v.width}×${v.height}`,
        videoCodec: v.codec,
        encoding: copied ? 'copied (lossless)' : 're-encoded',
      }
      if (out.audioStreams[0]) details.audioCodec = out.audioStreams[0].codec
      return { format: output, sizeBytes: size, durationSec: actual, details }
    },
  }
}

export const videoAdapters = (['mp4', 'webm'] as const).map(createVideoAdapter)

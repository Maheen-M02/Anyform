import { stat } from 'node:fs/promises'
import { z } from 'zod'
import { FORMATS, formatDuration, VIDEO_FORMATS } from '@/lib/formats'
import { formatTarget, maxVideoSeconds, MB, MIN_VIDEO_KBPS, videoBudget, type VideoBudget } from '@/lib/size-targets'
import { getConfig } from '../../config'
import { AppError } from '../../errors'
import { logger } from '../../logger'
import { canDecodeStream, inputGuardArgs, probeMedia, type MediaInfo } from '../../media/probe'
import { ToolError } from '../../media/process'
import type { ConversionAdapter, OptionField, VerificationCheck } from '../types'
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

/** Size targets offered in the UI (the API accepts any value in range). */
export const VIDEO_SIZE_TARGETS = [8, 10, 16, 25, 50, 100].map((n) => n * MB)
const MAX_SIZE_ATTEMPTS = 3

export interface VideoOptions {
  mode: 'auto' | 'reencode'
  quality: (typeof QUALITIES)[number]
  /** Maximum output height in pixels, or null to keep the source size. */
  maxHeight: number | null
  /** Absolute index of the audio track, or null when the video has no audio. */
  streamIndex: number | null
  /** Upper bound for the output file size in bytes, or null for none. */
  maxBytes?: number | null
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
  /** Bitrate-targeted encode, used when the output must fit a size. */
  encodeBitrate: (kbps: number) => string[]
  audio: (channels: number) => string[]
  audioBitrate: (kbps: number) => string[]
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
    encodeBitrate: (kbps) => ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${kbps * 2}k`, '-pix_fmt', 'yuv420p'],
    audio: (ch) => ['-c:a', 'aac', '-b:a', '160k', ...(ch > 6 ? ['-ac', '2'] : [])],
    audioBitrate: (kbps) => ['-c:a', 'aac', '-b:a', `${kbps}k`, '-ac', '2'],
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
    encodeBitrate: (kbps) => ['-c:v', 'libvpx-vp9', '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-deadline', 'good', '-cpu-used', '5', '-row-mt', '1', '-pix_fmt', 'yuv420p'],
    audio: (ch) => ['-c:a', 'libopus', '-b:a', '128k', ...(ch > 2 ? ['-ac', '2'] : [])],
    audioBitrate: (kbps) => ['-c:a', 'libopus', '-b:a', `${kbps}k`, '-ac', '2'],
    muxer: ['-f', 'webm'],
  },
}

/** Whether the streams can be remuxed into the target container unchanged. */
export function canCopy(output: VideoOutput, media: MediaInfo, options: VideoOptions): boolean {
  const spec = SPECS[output]
  const video = primaryVideo(media)
  if (!video || options.mode !== 'auto' || options.maxHeight !== null) return false
  // A size target can still be met by copying when the source is already comfortably small.
  if (options.maxBytes && !(media.sizeBytes > 0 && media.sizeBytes <= options.maxBytes * 0.97)) return false
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
  /** Bitrates for a size target (re-encodes even when copying would be possible). */
  budget?: VideoBudget | null
}): { args: string[]; copied: boolean } {
  const spec = SPECS[a.output]
  const video = primaryVideo(a.media)!
  const audio = a.options.streamIndex === null ? null : a.media.audioStreams.find((s) => s.index === a.options.streamIndex) ?? null
  const copied = !a.budget && canCopy(a.output, a.media, a.options)
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
  } else if (a.budget) {
    const height = targetHeight(a.options.maxHeight, a.budget.maxHeight, video.height)
    args.push('-vf', height ? `scale=-2:${height}` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2', ...spec.encodeBitrate(a.budget.videoKbps))
    if (audio) args.push(...spec.audioBitrate(a.budget.audioKbps))
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

/** The smallest of the requested and bitrate-appropriate heights, never above the source. */
function targetHeight(requested: number | null, forBitrate: number | null, source: number | null): number | null {
  const height = Math.min(requested ?? Infinity, forBitrate ?? Infinity)
  return Number.isFinite(height) && (source === null || height < source) ? height : null
}

/** Bitrate plan for a size target, or null when the options set none (or copying already fits). */
export function sizeBudget(output: VideoOutput, media: MediaInfo, options: VideoOptions): VideoBudget | null {
  if (!options.maxBytes || canCopy(output, media, options)) return null
  const duration = media.durationSec ?? videoDuration(media) ?? 0
  const budget = videoBudget(duration, options.maxBytes, options.streamIndex !== null)
  if (!budget) {
    const limit = maxVideoSeconds(options.maxBytes, options.streamIndex !== null)
    throw new AppError(
      'SIZE_TARGET_UNREACHABLE',
      `A ${formatDuration(duration)} video can't fit in ${formatTarget(options.maxBytes)} at watchable quality (about ${formatDuration(limit)} fits). Choose a larger size or a shorter clip.`,
    )
  }
  return budget
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
      maxBytes: z.union([z.literal('none'), z.null(), z.coerce.number().int().min(MB).max(10_000 * MB)]).default('none'),
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
        {
          key: 'maxBytes',
          label: 'Max file size',
          type: 'select',
          choices: [{ value: 'none', label: 'No limit' }, ...VIDEO_SIZE_TARGETS.map((b) => ({ value: b, label: formatTarget(b) }))],
          default: 'none',
          help: 'Bitrate and resolution are chosen to fit, and the result is checked against the limit.',
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
      const { mode, quality, maxHeight, streamIndex, maxBytes } = parsed.data
      if (maxHeight !== 'original' && maxHeight !== null && !(HEIGHTS as readonly number[]).includes(maxHeight)) {
        throw new AppError('INVALID_OPTIONS', `Resolution must be one of ${HEIGHTS.join(', ')} or original.`)
      }
      const sourceHeight = primaryVideo(media)?.height ?? Infinity
      if (streamIndex !== undefined && streamIndex !== null) audioStreamOrThrow(media, streamIndex)
      const options: VideoOptions = {
        mode,
        quality,
        // Never upscale: a target at or above the source height keeps the original size.
        maxHeight: maxHeight === 'original' || maxHeight === null || maxHeight >= sourceHeight ? null : maxHeight,
        // Explicit null means "no audio"; absent means "the default track".
        streamIndex: streamIndex === undefined ? defaultAudioStream(media)?.index ?? null : streamIndex,
        maxBytes: maxBytes === 'none' ? null : maxBytes,
      }
      // Refuse unreachable size targets before any work is queued.
      sizeBudget(output, media, options)
      return options
    },

    estimate(info, options) {
      const media = mediaOf(info)
      const seconds = videoDuration(media) ?? 0
      const copied = canCopy(output, media, options)
      const bound = Math.ceil(info.sizeBytes * (copied ? 1.1 : 2)) + 1024 * 1024
      return { outputBytes: options.maxBytes ? Math.min(bound, options.maxBytes * 2) : bound, cpuSeconds: copied ? seconds / 200 : seconds }
    },

    async convert(ctx) {
      const media = mediaOf(ctx.info)
      const budget = sizeBudget(output, media, ctx.options)
      const run = (b: VideoBudget | null, onProgress: (f: number) => void) => {
        const { args } = buildVideoArgs({ output, inputPath: ctx.inputPath, outputPath: ctx.outputPath, media, options: ctx.options, threads: getConfig().ffmpegThreads, budget: b })
        return runFfmpeg(args, { ...ctx, onProgress, totalSec: videoDuration(media), adapterId: id })
      }
      await run(budget, ctx.onProgress)
      if (!budget || !ctx.options.maxBytes) return
      // Rate control can overshoot on short or very detailed clips: lower the bitrate by the overshoot and try again.
      let current = budget
      for (let attempt = 1; attempt < MAX_SIZE_ATTEMPTS; attempt++) {
        const size = (await stat(ctx.outputPath)).size
        if (size <= ctx.options.maxBytes) return
        const videoKbps = Math.floor(current.videoKbps * (ctx.options.maxBytes / size) * 0.93)
        if (videoKbps < MIN_VIDEO_KBPS) break
        current = { ...current, videoKbps }
        logger.info('size target overshot, re-encoding', { adapter: id, attempt, size, target: ctx.options.maxBytes, videoKbps })
        await run(current, () => undefined)
      }
      if ((await stat(ctx.outputPath)).size > ctx.options.maxBytes) {
        throw new AppError('SIZE_TARGET_UNREACHABLE', `This video could not be made smaller than ${formatTarget(ctx.options.maxBytes)} at watchable quality. Choose a larger size or a shorter clip.`)
      }
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
      if (ctx.options.maxBytes && size > ctx.options.maxBytes) throw verificationError(id, `size ${size} > ${ctx.options.maxBytes}`)
      const details: Record<string, string | number> = {
        resolution: `${v.width}×${v.height}`,
        videoCodec: v.codec,
        encoding: copied ? 'copied (lossless)' : 're-encoded',
      }
      if (out.audioStreams[0]) details.audioCodec = out.audioStreams[0].codec
      const checks: VerificationCheck[] = [
        { label: 'Container', detail: `Re-read with ffprobe: ${FORMATS[output].label} (${out.formatName.split(',')[0]})` },
        { label: 'Video stream', detail: `${v.codec.toUpperCase()}, ${v.width}×${v.height}${copied ? ', copied bit-for-bit from the source' : ''}` },
        out.audioStreams[0]
          ? { label: 'Audio stream', detail: `${out.audioStreams[0].codec}, ${out.audioStreams[0].channels === 1 ? 'mono' : `${out.audioStreams[0].channels} channels`}` }
          : { label: 'Audio stream', detail: 'none, as requested' },
        { label: 'Playback', detail: 'The first 2 seconds of video decoded without errors' },
        { label: 'Duration', detail: `${actual.toFixed(2)} s against ${expected?.toFixed(2) ?? '?'} s in the source` },
      ]
      if (ctx.options.maxBytes) checks.push({ label: 'Size limit', detail: `${size.toLocaleString('en-US')} bytes, under the ${formatTarget(ctx.options.maxBytes)} limit` })
      return { format: output, sizeBytes: size, durationSec: actual, details, checks }
    },
  }
}

export const videoAdapters = (['mp4', 'webm'] as const).map(createVideoAdapter)

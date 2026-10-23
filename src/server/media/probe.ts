import { z } from 'zod'
import type { FormatId } from '@/lib/formats'
import { getConfig } from '../config'
import { AppError } from '../errors'
import { logger } from '../logger'
import { runTool, sanitizeDiagnostics, ToolError } from './process'
import { DEMUXER_WHITELIST, matroskaDocType, readHead, sniffBytes, type ContainerFamily } from './sniff'
import type { MediaTag } from '../inspect/hidden'

/** Tags kept per file for the hidden-data scan (keys and values are bounded too). */
const MAX_TAGS = 200

export interface AudioStreamInfo {
  /** Absolute stream index inside the container (used with `-map 0:<index>`). */
  index: number
  /** Position among audio streams, 0-based. */
  ordinal: number
  codec: string
  codecLongName: string | null
  channels: number
  channelLayout: string | null
  sampleRate: number
  bitRate: number | null
  durationSec: number | null
  startTimeSec: number | null
  language: string | null
  title: string | null
  isDefault: boolean
  /** Result of a real decode test; null until tested. */
  decodable: boolean | null
}

export interface VideoStreamInfo {
  index: number
  codec: string
  width: number | null
  height: number | null
  frameRate: number | null
  pixFmt: string | null
  durationSec: number | null
  /** Cover art embedded in audio files, not real video. */
  isAttachedPicture: boolean
  decodable: boolean | null
}

export interface MediaInfo {
  family: ContainerFamily
  /** Identified format, or null when the container is readable but not one we recognise. */
  format: FormatId | null
  formatName: string
  majorBrand: string | null
  durationSec: number | null
  bitRate: number | null
  sizeBytes: number
  audioStreams: AudioStreamInfo[]
  videoStreams: VideoStreamInfo[]
  /** Container and stream tags (titles, devices, locations…). Absent on older records. */
  tags?: MediaTag[]
}

const num = z.union([z.string(), z.number()]).optional().transform((v) => {
  if (v === undefined || v === 'N/A') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
})

const probeSchema = z.object({
  format: z.object({
    format_name: z.string(),
    duration: num,
    bit_rate: num,
    size: num,
    tags: z.record(z.string(), z.string()).optional(),
  }),
  streams: z
    .array(
      z.object({
        index: z.number().int(),
        codec_type: z.string().optional(),
        codec_name: z.string().optional(),
        codec_long_name: z.string().optional(),
        channels: z.number().int().optional(),
        channel_layout: z.string().optional(),
        sample_rate: num,
        bit_rate: num,
        duration: num,
        start_time: num,
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        avg_frame_rate: z.string().optional(),
        pix_fmt: z.string().optional(),
        disposition: z.record(z.string(), z.number()).optional(),
        tags: z.record(z.string(), z.string()).optional(),
      }),
    )
    .default([]),
})

type ProbeJson = z.infer<typeof probeSchema>

function frameRate(value: string | undefined): number | null {
  const [n, d] = (value ?? '').split('/').map(Number)
  return n && d ? n / d : null
}

/** Maps ffprobe's demuxer name, ISO-BMFF brand and Matroska DocType to a concrete format. */
export function detectFormat(formatName: string, majorBrand: string | null, docType: 'webm' | 'matroska' | null = null): FormatId | null {
  const names = formatName.split(',')
  for (const simple of ['wav', 'mp3', 'flac', 'ogg', 'avi'] as const) if (names.includes(simple)) return simple
  if (names.includes('matroska') || names.includes('webm')) return docType === 'webm' ? 'webm' : 'mkv'
  if (names.includes('mp4') || names.includes('mov')) {
    const brand = (majorBrand ?? '').trim().toLowerCase()
    if (brand === 'qt') return 'mov'
    if (brand === 'm4a' || brand === 'm4b') return 'm4a'
    if (/^(isom|iso[2-9]|mp41|mp42|avc1|dash|mmp4|msnv|ndas|f4v)$/.test(brand)) return 'mp4'
    // 3GP and other ISO-BMFF brands are deliberately not claimed.
    return null
  }
  return null
}

export function parseProbeJson(raw: ProbeJson, family: ContainerFamily, docType: 'webm' | 'matroska' | null = null): MediaInfo {
  const tags = raw.format.tags ?? {}
  const majorBrand = tags.major_brand ?? null
  const audio = raw.streams.filter((s) => s.codec_type === 'audio')
  const video = raw.streams.filter((s) => s.codec_type === 'video')
  const mediaTags: MediaTag[] = []
  const tagSources = [{ stream: null, record: raw.format.tags }, ...raw.streams.map((s) => ({ stream: s.index, record: s.tags }))]
  for (const { stream, record } of tagSources) {
    for (const [key, value] of Object.entries(record ?? {})) {
      if (mediaTags.length < MAX_TAGS) mediaTags.push({ key: key.slice(0, 80), value: value.slice(0, 500), stream })
    }
  }
  return {
    family,
    format: detectFormat(raw.format.format_name, majorBrand, docType),
    formatName: raw.format.format_name,
    majorBrand,
    durationSec: raw.format.duration,
    bitRate: raw.format.bit_rate,
    sizeBytes: raw.format.size ?? 0,
    audioStreams: audio.map((s, ordinal) => ({
      index: s.index,
      ordinal,
      codec: s.codec_name ?? 'unknown',
      codecLongName: s.codec_long_name ?? null,
      channels: s.channels ?? 0,
      channelLayout: s.channel_layout ?? null,
      sampleRate: s.sample_rate ?? 0,
      bitRate: s.bit_rate,
      durationSec: s.duration,
      startTimeSec: s.start_time,
      language: s.tags?.language && s.tags.language !== 'und' ? s.tags.language : null,
      title: s.tags?.title ?? null,
      isDefault: s.disposition?.default === 1,
      decodable: null,
    })),
    videoStreams: video.map((s) => ({
      index: s.index,
      codec: s.codec_name ?? 'unknown',
      width: s.width ?? null,
      height: s.height ?? null,
      frameRate: frameRate(s.avg_frame_rate),
      pixFmt: s.pix_fmt ?? null,
      durationSec: s.duration,
      isAttachedPicture: s.disposition?.attached_pic === 1,
      decodable: null,
    })),
    tags: mediaTags,
  }
}

/** Arguments that restrict FFmpeg tools to local files and the expected demuxers. */
export function inputGuardArgs(family: ContainerFamily): string[] {
  const demuxers = DEMUXER_WHITELIST[family]
  if (!demuxers) throw new Error(`No FFmpeg demuxers are allowed for ${family}`)
  return ['-protocol_whitelist', 'file', '-format_whitelist', demuxers]
}

/**
 * Inspects a stored file. The container family is established from magic bytes
 * first, and ffprobe is only allowed to use the matching demuxers.
 */
export async function probeMedia(filePath: string, opts: { signal?: AbortSignal; expect?: ContainerFamily } = {}): Promise<MediaInfo> {
  const cfg = getConfig()
  const head = await readHead(filePath)
  const family = sniffBytes(head)
  if (!family || !DEMUXER_WHITELIST[family] || (opts.expect && family !== opts.expect)) {
    throw new AppError('UNSUPPORTED_FORMAT', 'This file type is not supported. Its contents do not match any format ANYFORM can read.')
  }
  let stdout: string
  try {
    ;({ stdout } = await runTool(
      cfg.ffprobePath,
      ['-v', 'error', ...inputGuardArgs(family), '-print_format', 'json', '-show_format', '-show_streams', `file:${filePath}`],
      { timeoutMs: cfg.probeTimeoutMs, signal: opts.signal, maxStdoutBytes: 4 * 1024 * 1024 },
    ))
  } catch (err) {
    if (err instanceof ToolError) {
      if (err.kind === 'spawn') {
        logger.error('ffprobe unavailable', { error: err.message })
        throw new AppError('SERVICE_UNAVAILABLE', 'Media inspection is temporarily unavailable.', { retryable: true })
      }
      if (err.kind === 'aborted') throw err
      logger.info('ffprobe rejected input', { kind: err.kind, diagnostics: sanitizeDiagnostics(err.stderr) })
      throw new AppError('CORRUPT_MEDIA', 'This file could not be read. It may be corrupted or incomplete.')
    }
    throw err
  }
  let parsed: ProbeJson
  try {
    parsed = probeSchema.parse(JSON.parse(stdout))
  } catch {
    throw new AppError('CORRUPT_MEDIA', 'This file could not be read. It may be corrupted or incomplete.')
  }
  return parseProbeJson(parsed, family, family === 'matroska' ? matroskaDocType(head) : null)
}

/**
 * Decodes the first seconds of a stream to prove it is decodable, rather than
 * trusting the codec name reported by the container.
 */
export async function canDecodeStream(filePath: string, family: ContainerFamily, streamIndex: number, signal?: AbortSignal, seconds = 10): Promise<boolean> {
  const cfg = getConfig()
  try {
    await runTool(
      cfg.ffmpegPath,
      [
        '-hide_banner', '-nostdin', '-v', 'error',
        ...inputGuardArgs(family),
        '-t', String(seconds),
        '-i', `file:${filePath}`,
        '-map', `0:${streamIndex}`,
        '-threads', '1',
        '-f', 'null', '-',
      ],
      { timeoutMs: cfg.probeTimeoutMs, signal },
    )
    return true
  } catch (err) {
    if (err instanceof ToolError && err.kind === 'spawn') {
      throw new AppError('SERVICE_UNAVAILABLE', 'Media inspection is temporarily unavailable.', { retryable: true })
    }
    if (err instanceof ToolError && err.kind === 'aborted') throw err
    logger.info('decode test failed', { diagnostics: err instanceof ToolError ? sanitizeDiagnostics(err.stderr) : undefined })
    return false
  }
}

import { getConfig } from '../../config'
import { AppError } from '../../errors'
import type { FileInfo } from '../../inspect/types'
import { logger } from '../../logger'
import type { AudioStreamInfo, MediaInfo, VideoStreamInfo } from '../../media/probe'
import { runTool, sanitizeDiagnostics, ToolError } from '../../media/process'

/** The audio/video facts of an input, or an error for non-media files. */
export function mediaOf(info: FileInfo): MediaInfo {
  if (info.kind !== 'av') throw new AppError('UNSUPPORTED_CONVERSION', 'This conversion needs an audio or video file.')
  return info.media
}

export function usableAudio(media: MediaInfo): AudioStreamInfo[] {
  return media.audioStreams.filter((s) => s.codec !== 'unknown' && s.channels > 0 && s.sampleRate > 0 && s.decodable !== false)
}

export function defaultAudioStream(media: MediaInfo): AudioStreamInfo | undefined {
  const usable = usableAudio(media)
  return usable.find((s) => s.isDefault) ?? usable[0]
}

export function audioStreamOrThrow(media: MediaInfo, index: number): AudioStreamInfo {
  const stream = media.audioStreams.find((s) => s.index === index)
  if (!stream) throw new AppError('INVALID_OPTIONS', 'The selected audio track does not exist in this file.')
  if (stream.decodable === false) throw new AppError('INVALID_OPTIONS', 'The selected audio track cannot be decoded.')
  return stream
}

/** The main picture stream (cover art in audio files does not count). */
export function primaryVideo(media: MediaInfo): VideoStreamInfo | undefined {
  return media.videoStreams.find((v) => !v.isAttachedPicture)
}

export function expectedDuration(media: MediaInfo, stream?: { durationSec: number | null }): number | null {
  return stream?.durationSec ?? media.durationSec
}

/** Allowed difference between input and output duration (encoder padding, rounding). */
export function durationTolerance(expected: number): number {
  return Math.max(0.5, expected * 0.02)
}

/** Shared check: the input has usable audio and is within the duration limit. */
export function requireAudio(media: MediaInfo, maxDurationSeconds: number): void {
  if (media.audioStreams.length === 0) {
    throw new AppError(
      'NO_AUDIO_STREAM',
      primaryVideo(media) ? 'This video has no audio track, so there is no audio to extract.' : 'This file has no audio track.',
    )
  }
  const usable = usableAudio(media)
  if (usable.length === 0) {
    const codecs = [...new Set(media.audioStreams.map((s) => s.codec))].join(', ')
    throw new AppError('UNSUPPORTED_CODEC', `The audio in this file uses a codec that cannot be decoded (${codecs}).`)
  }
  const duration = media.durationSec ?? Math.max(0, ...usable.map((s) => s.durationSec ?? 0))
  if (duration > maxDurationSeconds) {
    throw new AppError('DURATION_LIMIT', `This file is longer than the ${Math.round(maxDurationSeconds / 60)}-minute limit.`)
  }
  if (duration <= 0) throw new AppError('CORRUPT_MEDIA', 'This file reports no playable duration. It may be truncated or corrupted.')
}

/**
 * Runs FFmpeg with real progress from `-progress pipe:1` (which must be in
 * `args`) and maps failures onto user-safe errors.
 */
export async function runFfmpeg(
  args: string[],
  ctx: { timeoutMs: number; signal: AbortSignal; totalSec: number | null; onProgress: (f: number) => void; adapterId: string },
): Promise<void> {
  const cfg = getConfig()
  try {
    await runTool(cfg.ffmpegPath, args, {
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      onStdoutLine: (line) => {
        if (!ctx.totalSec || !line.startsWith('out_time_us=')) return
        const us = Number(line.slice('out_time_us='.length))
        if (Number.isFinite(us) && us >= 0) ctx.onProgress(Math.min(1, us / 1e6 / ctx.totalSec))
      },
    })
  } catch (err) {
    if (err instanceof ToolError) {
      if (err.kind === 'aborted') throw err
      if (err.kind === 'timeout') throw new AppError('CONVERSION_TIMEOUT', 'The conversion took too long and was stopped.')
      if (err.kind === 'spawn') throw new AppError('SERVICE_UNAVAILABLE', 'The conversion engine is temporarily unavailable.', { retryable: true })
      logger.warn('ffmpeg failed', { adapter: ctx.adapterId, exitCode: err.exitCode, diagnostics: sanitizeDiagnostics(err.stderr) })
      throw new AppError('CONVERSION_FAILED', 'The file could not be converted. It may be damaged or use an unusual encoding.')
    }
    throw err
  }
}

export function verificationError(adapterId: string, why: string): AppError {
  logger.warn('output verification failed', { adapter: adapterId, why })
  return new AppError('VERIFICATION_FAILED', 'The converted file did not pass verification, so it was discarded.')
}

export const PROGRESS_ARGS = ['-hide_banner', '-nostdin', '-v', 'error', '-nostats', '-progress', 'pipe:1'] as const

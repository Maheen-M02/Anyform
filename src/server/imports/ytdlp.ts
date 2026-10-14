import path from 'node:path'
import { getConfig } from '../config'
import { AppError } from '../errors'
import { logger } from '../logger'
import { minimalEnv, runTool, sanitizeDiagnostics, ToolError } from '../media/process'

export interface YtDlpRequest {
  /** A canonical YouTube video URL, or a `ytsearch1:` query. Never user-supplied text verbatim. */
  target: string
  mode: 'video' | 'audio'
  outDir: string
  maxBytes: number
  maxDurationSec: number
  signal?: AbortSignal
}

export interface YtDlpResult {
  filePath: string
  title: string
  uploader: string | null
}

/** Builds the yt-dlp command line. Extractors are restricted to YouTube so it can never fetch arbitrary URLs. */
export function ytDlpArgs(req: YtDlpRequest): string[] {
  const cfg = getConfig()
  const h = cfg.mediaMaxHeight
  const extractors = req.target.startsWith('ytsearch') ? 'youtube,youtube:search' : 'youtube'
  const args = [
    '--ignore-config',
    '--no-cache-dir',
    '--no-playlist',
    '--use-extractors', extractors,
    // YouTube's player needs a JavaScript runtime; use this very Node binary.
    '--js-runtimes', `node:${process.execPath}`,
    '--socket-timeout', '20',
    '--retries', '3',
    '--max-filesize', String(req.maxBytes),
    '--match-filter', `duration <= ${Math.floor(req.maxDurationSec)}`,
    '--no-part',
    '--no-progress',
    '--no-simulate',
    '-o', path.join(req.outDir, 'media.%(ext)s'),
    '--print', 'after_move:%(title)s',
    '--print', 'after_move:%(uploader)s',
    '--print', 'after_move:filepath',
  ]
  if (cfg.ffmpegPath.includes('/') || cfg.ffmpegPath.includes('\\')) args.push('--ffmpeg-location', path.dirname(cfg.ffmpegPath))
  if (req.mode === 'audio') {
    args.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '192K')
  } else {
    args.push('-f', `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/b[height<=${h}][ext=mp4]/bv*[height<=${h}]+ba/b`, '--merge-output-format', 'mp4')
  }
  args.push('--', req.target)
  return args
}

/** Turns yt-dlp's diagnostics into a message the user can act on. */
export function ytDlpError(stderr: string): AppError {
  const s = stderr.toLowerCase()
  if (s.includes('private video')) return new AppError('PROTECTED_FILE', 'This video is private.')
  if (s.includes('sign in to confirm your age') || s.includes('age-restricted')) return new AppError('PROTECTED_FILE', 'This video is age-restricted and needs a signed-in account.')
  if (s.includes('members-only') || s.includes('join this channel')) return new AppError('PROTECTED_FILE', 'This video is for channel members only.')
  if (s.includes('drm')) return new AppError('PROTECTED_FILE', 'This video is DRM-protected and can’t be downloaded.')
  if (s.includes('video unavailable') || s.includes('not available') || s.includes('removed')) return new AppError('REMOTE_FETCH_FAILED', 'This video is unavailable.')
  if (s.includes('live event') || s.includes('is live')) return new AppError('UNSUPPORTED_SOURCE', 'Live streams can’t be downloaded until they have ended.')
  if (s.includes('no video results') || s.includes('no results')) return new AppError('REMOTE_FETCH_FAILED', 'No matching recording was found.')
  return new AppError('REMOTE_FETCH_FAILED', 'The video could not be downloaded. Try again later.')
}

/** Runs yt-dlp with a minimal environment, a deadline and size/duration limits. */
export async function downloadWithYtDlp(req: YtDlpRequest): Promise<YtDlpResult> {
  const cfg = getConfig()
  const lines: string[] = []
  try {
    await runTool(cfg.ytdlpPath, ytDlpArgs(req), {
      timeoutMs: cfg.mediaSiteTimeoutMs,
      signal: req.signal,
      env: minimalEnv(),
      onStdoutLine: (l) => l.trim() && lines.push(l.trim()),
    })
  } catch (err) {
    if (err instanceof ToolError) {
      if (err.kind === 'spawn') throw new AppError('SERVICE_UNAVAILABLE', 'YouTube downloads aren’t available on this server (yt-dlp is not installed).')
      if (err.kind === 'timeout') throw new AppError('IMPORT_TIMEOUT', 'The download took too long and was stopped.')
      if (err.kind === 'aborted') throw err
      logger.info('yt-dlp failed', { diagnostics: sanitizeDiagnostics(err.stderr) })
      throw ytDlpError(err.stderr)
    }
    throw err
  }
  // Skipped downloads (too long / too large) exit 0 without printing a file path.
  const [title, uploader, filePath] = lines.slice(-3)
  if (lines.length < 3 || !filePath || !path.isAbsolute(filePath)) {
    throw new AppError('DURATION_LIMIT', `This is longer than ${Math.round(req.maxDurationSec / 60)} minutes or larger than the upload limit, so it wasn’t downloaded.`)
  }
  if (path.dirname(path.resolve(filePath)) !== path.resolve(req.outDir)) throw new AppError('INTERNAL_ERROR', 'Unexpected download location.')
  return { filePath, title: title || 'download', uploader: uploader && uploader !== 'NA' ? uploader : null }
}

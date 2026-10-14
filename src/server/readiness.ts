import { getConfig } from './config'
import { runTool } from './media/process'
import { getRuntime } from './runtime'
import { sandboxAvailable } from './sandbox'

interface Check {
  ok: boolean
  detail?: string
}

let toolCache: { at: number; ffmpeg: Check; ffprobe: Check; ytdlp: Check } | null = null

async function toolCheck(cmd: string): Promise<Check> {
  try {
    const { stdout } = await runTool(cmd, ['-hide_banner', '-version'], { timeoutMs: 5000 })
    return { ok: true, detail: stdout.split('\n')[0]?.split(' ').slice(0, 3).join(' ') }
  } catch {
    return { ok: false, detail: 'not executable' }
  }
}

async function ytdlpCheck(cmd: string): Promise<Check> {
  try {
    const { stdout } = await runTool(cmd, ['--version'], { timeoutMs: 10_000 })
    return { ok: true, detail: `yt-dlp ${stdout.trim()}` }
  } catch {
    return { ok: false, detail: 'not installed (YouTube and Spotify links unavailable)' }
  }
}

export async function checkReadiness() {
  const cfg = getConfig()
  if (!toolCache || Date.now() - toolCache.at > 60_000) {
    const [ffmpeg, ffprobe, ytdlp] = await Promise.all([toolCheck(cfg.ffmpegPath), toolCheck(cfg.ffprobePath), ytdlpCheck(cfg.ytdlpPath)])
    toolCache = { at: Date.now(), ffmpeg, ffprobe, ytdlp }
  }
  const rt = getRuntime()
  const storage: Check = await rt.storage
    .freeBytes()
    .then((free) => ({ ok: free > cfg.minFreeDiskBytes, detail: free > cfg.minFreeDiskBytes ? 'writable' : 'low disk space' }))
    .catch(() => ({ ok: false, detail: 'unavailable' }))
  const metadata: Check = await rt.store
    .ping()
    .then(() => ({ ok: true }))
    .catch(() => ({ ok: false, detail: 'unreachable' }))
  const sandbox: Check = sandboxAvailable() ? { ok: true } : { ok: false, detail: 'entry point missing (run npm run build)' }
  const checks = { ffmpeg: toolCache.ffmpeg, ffprobe: toolCache.ffprobe, sandbox, storage, metadata }
  // Optional features: reported, but they don't make the service unready.
  const optional = { ytdlp: cfg.mediaSitesEnabled ? toolCache.ytdlp : { ok: false, detail: 'disabled' } }
  return { ready: Object.values(checks).every((c) => c.ok), mode: rt.mode, checks, optional }
}

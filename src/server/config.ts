import path from 'node:path'
import { z } from 'zod'

const MB = 1024 * 1024

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  /** Root directory for local storage, metadata and scratch space. */
  ANYFORM_DATA_DIR: z.string().default('./data'),
  /** HMAC secret for session cookies. Required in production. */
  SESSION_SECRET: z.string().min(32).optional(),
  /** When set, jobs are queued in BullMQ and metadata lives in Redis. */
  REDIS_URL: z.string().url().optional(),
  /** Public origin (e.g. https://anyform.example.com). When set, state-changing requests must come from it. */
  PUBLIC_ORIGIN: z.string().url().optional(),

  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  FFMPEG_THREADS: z.coerce.number().int().min(1).max(16).default(2),

  MAX_UPLOAD_MB: z.coerce.number().positive().default(500),
  MAX_DURATION_SECONDS: z.coerce.number().positive().default(4 * 60 * 60),
  /** Per-session limit on bytes held in storage (uploads + outputs). */
  SESSION_QUOTA_MB: z.coerce.number().positive().default(2048),
  /** Per-session limit on queued/processing jobs. */
  SESSION_MAX_ACTIVE_JOBS: z.coerce.number().int().positive().default(3),
  /** Uploads are refused when free disk would drop below this. */
  MIN_FREE_DISK_MB: z.coerce.number().nonnegative().default(1024),

  /** Video re-encoding is far more expensive than audio; it gets its own duration cap. */
  MAX_VIDEO_DURATION_SECONDS: z.coerce.number().positive().default(2 * 60 * 60),
  /** Images larger than this (width × height) are refused before decoding. */
  MAX_IMAGE_PIXELS: z.coerce.number().int().positive().default(100_000_000),
  MAX_PDF_PAGES: z.coerce.number().int().positive().default(1000),
  /** Upper bound for "all pages" PDF → image rendering. */
  MAX_RENDER_PAGES: z.coerce.number().int().positive().default(100),
  MAX_ARCHIVE_ENTRIES: z.coerce.number().int().positive().default(10_000),
  /** Total uncompressed size allowed inside an archive (zip-bomb protection). */
  MAX_ARCHIVE_UNPACKED_MB: z.coerce.number().positive().default(4096),
  /** Heap limit for the sandbox process that parses images, PDFs and archives. */
  SANDBOX_MEMORY_MB: z.coerce.number().int().min(128).default(1024),

  /** URL import: the server downloads a file from a link the user provides. */
  IMPORT_ENABLED: bool.default(true),
  IMPORT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
  IMPORT_MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(5),
  /** Comma-separated host allowlist (exact host or parent domain). Empty = any public host. */
  IMPORT_ALLOWED_HOSTS: z.string().default(''),
  /** Test/development only: allow imports from private and loopback addresses. Refused in production. */
  IMPORT_ALLOW_PRIVATE_NETWORKS: bool.default(false),
  /** YouTube and Spotify links (downloaded through yt-dlp). */
  MEDIA_SITES_ENABLED: bool.default(true),
  YTDLP_PATH: z.string().default('yt-dlp'),
  /** Media-site downloads can be large; they get a longer deadline than plain imports. */
  MEDIA_SITE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
  /** Highest video resolution fetched from YouTube. */
  MEDIA_MAX_HEIGHT: z.coerce.number().int().positive().default(1080),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  JOB_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(2 * 60 * 60),
  PROBE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),

  UPLOAD_TTL_MINUTES: z.coerce.number().positive().default(60),
  RESULT_TTL_MINUTES: z.coerce.number().positive().default(60),
  /** How long job metadata (history) is kept after artifacts expire. */
  METADATA_RETENTION_HOURS: z.coerce.number().positive().default(24),
  CLEANUP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),

  RATE_LIMIT_UPLOADS_PER_HOUR: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(240),

  /** Bearer token required to read /api/v1/metrics. Metrics are disabled when unset. */
  METRICS_TOKEN: z.string().min(16).optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  /** Trust X-Forwarded-For for client IPs (only behind a trusted reverse proxy). */
  TRUST_PROXY: bool.default(false),
})

export type AppConfig = ReturnType<typeof buildConfig>

function buildConfig(env: NodeJS.ProcessEnv) {
  // Blank values (e.g. `SESSION_SECRET=` copied from .env.example) mean "unset".
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''))
  const parsed = schema.safeParse(present)
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ')
    throw new Error(`Invalid ANYFORM configuration: ${fields}`)
  }
  const e = parsed.data
  if (e.NODE_ENV === 'production' && !e.SESSION_SECRET) {
    throw new Error('SESSION_SECRET (32+ characters) is required in production')
  }
  if (e.NODE_ENV === 'production' && e.IMPORT_ALLOW_PRIVATE_NETWORKS) {
    throw new Error('IMPORT_ALLOW_PRIVATE_NETWORKS must not be enabled in production')
  }
  const dataDir = path.resolve(e.ANYFORM_DATA_DIR)
  return {
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    dataDir,
    storageDir: path.join(dataDir, 'objects'),
    scratchDir: path.join(dataDir, 'scratch'),
    metaDir: path.join(dataDir, 'meta'),
    // A development-only fallback secret; production refuses to start without one.
    sessionSecret: e.SESSION_SECRET ?? 'anyform-development-only-session-secret-change-me',
    redisUrl: e.REDIS_URL,
    publicOrigin: e.PUBLIC_ORIGIN ? new URL(e.PUBLIC_ORIGIN).origin : undefined,
    ffmpegPath: e.FFMPEG_PATH,
    ffprobePath: e.FFPROBE_PATH,
    ffmpegThreads: e.FFMPEG_THREADS,
    maxUploadBytes: Math.floor(e.MAX_UPLOAD_MB * MB),
    maxDurationSeconds: e.MAX_DURATION_SECONDS,
    sessionQuotaBytes: Math.floor(e.SESSION_QUOTA_MB * MB),
    sessionMaxActiveJobs: e.SESSION_MAX_ACTIVE_JOBS,
    minFreeDiskBytes: Math.floor(e.MIN_FREE_DISK_MB * MB),
    maxVideoDurationSeconds: e.MAX_VIDEO_DURATION_SECONDS,
    maxImagePixels: e.MAX_IMAGE_PIXELS,
    maxPdfPages: e.MAX_PDF_PAGES,
    maxRenderPages: e.MAX_RENDER_PAGES,
    maxArchiveEntries: e.MAX_ARCHIVE_ENTRIES,
    maxArchiveUnpackedBytes: Math.floor(e.MAX_ARCHIVE_UNPACKED_MB * MB),
    sandboxMemoryMb: e.SANDBOX_MEMORY_MB,
    importEnabled: e.IMPORT_ENABLED,
    importTimeoutMs: e.IMPORT_TIMEOUT_SECONDS * 1000,
    importMaxRedirects: e.IMPORT_MAX_REDIRECTS,
    importAllowedHosts: e.IMPORT_ALLOWED_HOSTS.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
    importAllowPrivateNetworks: e.IMPORT_ALLOW_PRIVATE_NETWORKS,
    mediaSitesEnabled: e.MEDIA_SITES_ENABLED,
    ytdlpPath: e.YTDLP_PATH,
    mediaSiteTimeoutMs: e.MEDIA_SITE_TIMEOUT_SECONDS * 1000,
    mediaMaxHeight: e.MEDIA_MAX_HEIGHT,
    workerConcurrency: e.WORKER_CONCURRENCY,
    jobTimeoutMs: e.JOB_TIMEOUT_SECONDS * 1000,
    probeTimeoutMs: e.PROBE_TIMEOUT_SECONDS * 1000,
    jobMaxAttempts: e.JOB_MAX_ATTEMPTS,
    uploadTtlMs: e.UPLOAD_TTL_MINUTES * 60_000,
    resultTtlMs: e.RESULT_TTL_MINUTES * 60_000,
    metadataRetentionMs: e.METADATA_RETENTION_HOURS * 3_600_000,
    cleanupIntervalMs: e.CLEANUP_INTERVAL_SECONDS * 1000,
    rateLimitUploadsPerHour: e.RATE_LIMIT_UPLOADS_PER_HOUR,
    rateLimitRequestsPerMinute: e.RATE_LIMIT_REQUESTS_PER_MINUTE,
    metricsToken: e.METRICS_TOKEN,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
  }
}

let cached: AppConfig | undefined

export function getConfig(): AppConfig {
  cached ??= buildConfig(process.env)
  return cached
}

/** Test hook: rebuild configuration from the current environment. */
export function resetConfig(): void {
  cached = undefined
}

/**
 * Stable, client-facing error codes. Messages attached to these are safe to show
 * to end users: they never contain filesystem paths, stack traces or tool output.
 */
export const ERROR_CODES = {
  INVALID_REQUEST: 400,
  CSRF_REJECTED: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  UPLOAD_EMPTY: 400,
  UPLOAD_TOO_LARGE: 413,
  UPLOAD_INCOMPLETE: 400,
  UPLOAD_EXPIRED: 410,
  UPLOAD_NOT_VALIDATED: 409,
  QUOTA_EXCEEDED: 429,
  INSUFFICIENT_STORAGE: 507,
  UNSUPPORTED_FORMAT: 422,
  CORRUPT_MEDIA: 422,
  NO_AUDIO_STREAM: 422,
  NO_VIDEO_STREAM: 422,
  NO_TEXT_CONTENT: 422,
  PROTECTED_FILE: 422,
  IMAGE_TOO_LARGE: 422,
  ARCHIVE_LIMIT: 422,
  UNSAFE_ARCHIVE: 422,
  INVALID_URL: 400,
  URL_NOT_ALLOWED: 422,
  UNSUPPORTED_SOURCE: 422,
  REMOTE_FETCH_FAILED: 502,
  IMPORT_TIMEOUT: 504,
  IMPORT_DISABLED: 403,
  UNSUPPORTED_CODEC: 422,
  DURATION_LIMIT: 422,
  INVALID_OPTIONS: 422,
  SIZE_TARGET_UNREACHABLE: 422,
  UNSUPPORTED_CONVERSION: 422,
  JOB_NOT_ACTIVE: 409,
  JOB_ACTIVE: 409,
  RESULT_NOT_READY: 409,
  RESULT_EXPIRED: 410,
  CONVERSION_FAILED: 500,
  CONVERSION_TIMEOUT: 500,
  VERIFICATION_FAILED: 500,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
} as const

export type ErrorCode = keyof typeof ERROR_CODES

/**
 * Brand used instead of `instanceof`: Next.js may load server modules into more
 * than one module graph (e.g. instrumentation vs. route handlers), so the same
 * error can come from a different copy of this class.
 */
const APP_ERROR_BRAND = Symbol.for('anyform.AppError')

export class AppError extends Error {
  readonly [APP_ERROR_BRAND] = true
  readonly code: ErrorCode
  readonly status: number
  readonly details?: Record<string, unknown>
  /** Whether a background job failing with this error may be retried. */
  readonly retryable: boolean

  constructor(
    code: ErrorCode,
    message: string,
    opts: { details?: Record<string, unknown>; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause })
    this.name = 'AppError'
    this.code = code
    this.status = ERROR_CODES[code]
    this.details = opts.details
    this.retryable = opts.retryable ?? false
  }
}

export function isAppError(err: unknown): err is AppError {
  return typeof err === 'object' && err !== null && (err as Record<symbol, unknown>)[APP_ERROR_BRAND] === true
}

/** Maps any thrown value to a safe AppError. Unknown errors become INTERNAL_ERROR. */
export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOSPC') {
    return new AppError('INSUFFICIENT_STORAGE', 'The server is temporarily out of storage space. Please try again later.', {
      cause: err,
      retryable: true,
    })
  }
  return new AppError('INTERNAL_ERROR', 'Something went wrong on our side. Please try again.', {
    cause: err,
    retryable: true,
  })
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown>; requestId?: string }
}

export function errorBody(err: AppError, requestId?: string): ErrorBody {
  return { error: { code: err.code, message: err.message, details: err.details, requestId } }
}

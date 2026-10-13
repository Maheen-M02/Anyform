import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import { getConfig } from './config'
import { AppError, errorBody, toAppError } from './errors'
import { logger, type Logger } from './logger'
import { metrics } from './metrics'
import { RateLimiter } from './rate-limit'
import { getSession, type Session } from './session'

/** Header that every state-changing API request must carry (blocks cross-site form posts). */
export const CSRF_HEADER = 'x-anyform-request'

export interface HandlerContext {
  req: Request
  session: Session
  requestId: string
  log: Logger
  clientIp: string
}

interface HandlerOptions {
  /** Requires the CSRF header and a same-origin Origin header. */
  mutating?: boolean
  /** Extra limiter applied in addition to the global request limit. */
  limiter?: 'uploads'
}

const g = globalThis as typeof globalThis & { __anyformLimiters?: { requests: RateLimiter; uploads: RateLimiter } }

export function limiters() {
  if (!g.__anyformLimiters) {
    const cfg = getConfig()
    g.__anyformLimiters = {
      requests: new RateLimiter(cfg.rateLimitRequestsPerMinute, 60_000),
      uploads: new RateLimiter(cfg.rateLimitUploadsPerHour, 3_600_000),
    }
  }
  return g.__anyformLimiters
}

function clientIp(req: Request): string {
  if (getConfig().trustProxy) {
    const fwd = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    if (fwd) return fwd
  }
  return req.headers.get('x-real-ip') ?? 'unknown'
}

function expectedOrigin(req: Request): string | null {
  const cfg = getConfig()
  if (cfg.publicOrigin) return cfg.publicOrigin
  const host = (cfg.trustProxy && req.headers.get('x-forwarded-host')) || req.headers.get('host')
  if (!host) return null
  const proto = (cfg.trustProxy && req.headers.get('x-forwarded-proto')) || new URL(req.url).protocol.replace(':', '')
  return `${proto}://${host}`
}

function checkCsrf(req: Request) {
  if (req.headers.get(CSRF_HEADER) !== '1') {
    throw new AppError('CSRF_REJECTED', 'This request was blocked for security reasons. Reload the page and try again.')
  }
  const origin = req.headers.get('origin')
  if (origin && origin !== expectedOrigin(req)) {
    throw new AppError('CSRF_REJECTED', 'Cross-origin requests are not allowed.')
  }
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  headers.set('cache-control', 'no-store')
  return new Response(JSON.stringify(body), { ...init, headers })
}

/**
 * Wraps a route handler with request ids, session handling, CSRF checks, rate
 * limiting, structured logging and uniform error responses.
 */
export function handle<P = Record<string, never>>(
  fn: (ctx: HandlerContext, params: P) => Promise<Response>,
  opts: HandlerOptions = {},
) {
  return async (req: Request, routeCtx?: { params: Promise<P> }): Promise<Response> => {
    const requestId = randomUUID()
    const started = Date.now()
    const session = getSession(req)
    const ip = clientIp(req)
    const log = logger.child({ requestId, method: req.method, route: new URL(req.url).pathname })
    let res: Response
    try {
      const retryAfter = limiters().requests.hit(`${session.id}|${ip}`)
      if (retryAfter) throw new AppError('RATE_LIMITED', 'Too many requests. Please slow down.', { details: { retryAfter } })
      if (opts.mutating) checkCsrf(req)
      if (opts.limiter) {
        const wait = limiters()[opts.limiter].hit(`${session.id}|${ip}`)
        if (wait) throw new AppError('RATE_LIMITED', 'Upload limit reached. Please try again later.', { details: { retryAfter: wait } })
      }
      const params = routeCtx ? await routeCtx.params : ({} as P)
      res = await fn({ req, session, requestId, log, clientIp: ip }, params)
    } catch (err) {
      const appErr = toAppError(err)
      if (appErr.status >= 500) log.error('request failed', { code: appErr.code, error: err })
      else log.info('request rejected', { code: appErr.code })
      metrics.inc('http_errors_total', { code: appErr.code })
      res = json(errorBody(appErr, requestId), { status: appErr.status })
      if (appErr.code === 'RATE_LIMITED' && appErr.details?.retryAfter) {
        res.headers.set('retry-after', String(appErr.details.retryAfter))
      }
    }
    res.headers.set('x-request-id', requestId)
    if (session.setCookie) res.headers.append('set-cookie', session.setCookie)
    log.info('request completed', { status: res.status, durationMs: Date.now() - started })
    return res
  }
}

/** Parses a JSON body against a schema, mapping failures to INVALID_REQUEST. */
export async function parseJson<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  const type = req.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) throw new AppError('INVALID_REQUEST', 'Expected a JSON request body.')
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    throw new AppError('INVALID_REQUEST', 'The request body is not valid JSON.')
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new AppError('INVALID_REQUEST', issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid request.')
  }
  return parsed.data
}

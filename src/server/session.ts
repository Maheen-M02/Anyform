import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { getConfig } from './config'

export const SESSION_COOKIE = 'anyform_sid'
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 3600
const SID_PATTERN = /^[A-Za-z0-9_-]{32}$/

export interface Session {
  id: string
  /** Set-Cookie header value when a new session was issued. */
  setCookie: string | null
}

function sign(id: string): string {
  return createHmac('sha256', getConfig().sessionSecret).update(id).digest('base64url')
}

export function encodeSessionCookie(id: string): string {
  return `${id}.${sign(id)}`
}

/** Returns the session id if the cookie value carries a valid signature. */
export function verifySessionCookie(value: string | undefined): string | null {
  if (!value) return null
  const dot = value.indexOf('.')
  if (dot === -1) return null
  const id = value.slice(0, dot)
  const mac = value.slice(dot + 1)
  if (!SID_PATTERN.test(id)) return null
  const expected = Buffer.from(sign(id))
  const actual = Buffer.from(mac)
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? id : null
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

/**
 * Anonymous, signed session used to scope ownership of uploads and jobs.
 * A session is issued on first contact; no account is required.
 */
export function getSession(req: Request): Session {
  const existing = verifySessionCookie(readCookie(req.headers.get('cookie'), SESSION_COOKIE))
  if (existing) return { id: existing, setCookie: null }
  const id = randomBytes(24).toString('base64url')
  const secure = getConfig().isProduction ? '; Secure' : ''
  return {
    id,
    setCookie: `${SESSION_COOKIE}=${encodeSessionCookie(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`,
  }
}

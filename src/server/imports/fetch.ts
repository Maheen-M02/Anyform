import { lookup as dnsLookup } from 'node:dns/promises'
import http, { type IncomingMessage } from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { AppError } from '../errors'
import { hostMatches, isPublicAddress, isStreamingHost } from './network'

export interface FetchOptions {
  maxBytes: number
  timeoutMs: number
  maxRedirects: number
  /** Test/development only. */
  allowPrivate: boolean
  /** Exact hosts or parent domains; empty allows any public host. */
  allowedHosts: readonly string[]
  /** DNS resolver (injectable for tests). Returns every address for the host. */
  resolve?: (host: string) => Promise<string[]>
}

export interface RemoteFile {
  body: IncomingMessage
  filename: string
  declaredLength: number | null
  host: string
  /** Final URL after redirects (used to resolve relative links on pages). */
  url: URL
  contentType: string | undefined
  /** Must be called once the body has been consumed (clears the deadline). */
  finish: () => void
  /** True when the overall deadline stopped the transfer. */
  timedOut: () => boolean
}

const MAX_URL_LENGTH = 2048
const ALLOWED_PORTS = new Set(['', '80', '443'])
const IDLE_TIMEOUT_MS = 20_000

const defaultResolve = async (host: string) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address)

/** Syntax and policy checks that need no network access. */
export function parseImportUrl(raw: string, opts: Pick<FetchOptions, 'allowPrivate' | 'allowedHosts'>): URL {
  if (typeof raw !== 'string' || raw.length > MAX_URL_LENGTH) throw new AppError('INVALID_URL', 'Enter a valid web address (http:// or https://).')
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new AppError('INVALID_URL', 'Enter a valid web address (http:// or https://).')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new AppError('INVALID_URL', 'Only http:// and https:// links can be imported.')
  if (url.username || url.password) throw new AppError('URL_NOT_ALLOWED', 'Links containing a username or password are not accepted.')
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host) throw new AppError('INVALID_URL', 'This link has no host name.')
  if (!opts.allowPrivate && !ALLOWED_PORTS.has(url.port)) {
    throw new AppError('URL_NOT_ALLOWED', 'Only links on the standard web ports (80 and 443) can be imported.')
  }
  if (isStreamingHost(host)) {
    throw new AppError(
      'UNSUPPORTED_SOURCE',
      "ANYFORM can't download from streaming services such as YouTube or Spotify. Use a direct link to a file you have the right to convert.",
    )
  }
  if (opts.allowedHosts.length > 0 && !opts.allowedHosts.some((d) => hostMatches(host, d))) {
    throw new AppError('URL_NOT_ALLOWED', 'Imports from this site are not enabled on this server.')
  }
  return url
}

/** Resolves a host and returns an address only if every answer is public. */
async function resolvePublic(host: string, opts: FetchOptions): Promise<{ address: string; family: 4 | 6 }> {
  let addresses: string[]
  if (isIP(host)) addresses = [host]
  else {
    try {
      addresses = await (opts.resolve ?? defaultResolve)(host)
    } catch {
      throw new AppError('REMOTE_FETCH_FAILED', `The host "${host}" could not be found.`)
    }
  }
  if (addresses.length === 0) throw new AppError('REMOTE_FETCH_FAILED', `The host "${host}" could not be found.`)
  // All answers must be public: a mix could be used to reach internal services.
  if (!opts.allowPrivate && !addresses.every(isPublicAddress)) {
    throw new AppError('URL_NOT_ALLOWED', 'This link points to a private or internal network address and cannot be imported.')
  }
  const address = addresses[0]!
  return { address, family: isIP(address) === 6 ? 6 : 4 }
}

export function filenameFrom(url: URL, contentDisposition: string | undefined): string {
  if (contentDisposition) {
    const star = contentDisposition.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/)
    if (star) {
      try {
        return decodeURIComponent(star[1]!.trim())
      } catch {
        // fall through
      }
    }
    const plain = contentDisposition.match(/filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/)
    const name = (plain?.[1] ?? plain?.[2])?.trim()
    if (name) return name
  }
  const last = url.pathname.split('/').filter(Boolean).pop()
  if (last) {
    try {
      return decodeURIComponent(last)
    } catch {
      return last
    }
  }
  return url.hostname
}

function networkError(err: NodeJS.ErrnoException): AppError {
  if (err instanceof AppError) return err
  if (err.code === 'ETIMEDOUT' || err.code === 'IMPORT_TIMEOUT') return new AppError('IMPORT_TIMEOUT', 'The remote server took too long to respond.')
  if (err.code === 'ECONNRESET' || /socket hang up|aborted/i.test(err.message)) {
    return new AppError('REMOTE_FETCH_FAILED', 'The remote server closed the connection unexpectedly.')
  }
  if (err.code?.startsWith('ERR_TLS') || /certificate|SSL|TLS/i.test(err.message)) {
    return new AppError('REMOTE_FETCH_FAILED', 'A secure connection to the remote server could not be established.')
  }
  return new AppError('REMOTE_FETCH_FAILED', 'The remote server could not be reached.')
}

function requestOnce(url: URL, pinned: { address: string; family: 4 | 6 }, track: (destroy: (e: Error) => void) => void): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    // Connect only to the address that was validated (defeats DNS rebinding).
    // TLS still verifies the certificate against the original host name.
    const lookup: LookupFunction = (_host, options, cb) => {
      if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [pinned])
      else cb(null, pinned.address, pinned.family)
    }
    const lib = url.protocol === 'https:' ? https : http
    // A private keep-alive agent per hop: `agent: false` sends "Connection: close",
    // which some CDNs and middleboxes answer with a reset. Sockets are never
    // pooled across requests; the agent is destroyed when this hop ends.
    const agent = new lib.Agent({ keepAlive: true, maxSockets: 1 })
    const req = lib.request(url, {
      method: 'GET',
      agent,
      lookup,
      headers: {
        'user-agent': 'ANYFORM-Importer/1.0',
        accept: '*/*',
        // Never let a server send us a compressed stream that expands unexpectedly.
        'accept-encoding': 'identity',
      },
    })
    // Registered before connecting so the overall deadline also covers DNS-free connect and header waits.
    track((e) => req.destroy(e))
    req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(Object.assign(new Error('idle timeout'), { code: 'ETIMEDOUT' })))
    req.on('response', (res) => {
      res.once('close', () => agent.destroy())
      resolve(res)
    })
    req.on('error', (err) => {
      agent.destroy()
      reject(networkError(err))
    })
    req.end()
  })
}

/**
 * Downloads a user-supplied URL under SSRF protections. Every hop (including
 * redirects) is re-validated: scheme, port, host policy and resolved addresses.
 */
export async function fetchRemote(raw: string, opts: FetchOptions): Promise<RemoteFile> {
  let url = parseImportUrl(raw, opts)
  let destroyCurrent: ((e: Error) => void) | null = null
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    destroyCurrent?.(Object.assign(new Error('import timeout'), { code: 'IMPORT_TIMEOUT' }))
  }, opts.timeoutMs)
  try {
    for (let hop = 0; ; hop++) {
      const pinned = await resolvePublic(url.hostname.replace(/^\[|\]$/g, ''), opts)
      if (timedOut) throw new AppError('IMPORT_TIMEOUT', 'The remote server took too long to respond.')
      const res = await requestOnce(url, pinned, (d) => (destroyCurrent = d))
      const status = res.statusCode ?? 0

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        if (hop >= opts.maxRedirects) throw new AppError('REMOTE_FETCH_FAILED', 'The link redirected too many times.')
        let next: URL
        try {
          next = new URL(res.headers.location, url)
        } catch {
          throw new AppError('REMOTE_FETCH_FAILED', 'The link redirected to an invalid address.')
        }
        url = parseImportUrl(next.href, opts)
        continue
      }
      if (status < 200 || status >= 300) {
        res.resume()
        throw new AppError('REMOTE_FETCH_FAILED', status === 404 ? 'Nothing was found at this link (404).' : `The remote server answered with status ${status}.`)
      }
      const lengthHeader = res.headers['content-length']
      const declaredLength = lengthHeader !== undefined && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null
      if (declaredLength !== null && declaredLength > opts.maxBytes) {
        res.destroy()
        throw new AppError('UPLOAD_TOO_LARGE', `This file is larger than the ${Math.round(opts.maxBytes / 1024 / 1024)} MB limit.`)
      }
      if (declaredLength === 0) {
        res.resume()
        throw new AppError('UPLOAD_EMPTY', 'The file at this link is empty.')
      }
      res.on('error', () => undefined)
      return {
        body: res,
        filename: filenameFrom(url, res.headers['content-disposition']),
        declaredLength,
        host: url.hostname,
        url,
        contentType: res.headers['content-type'],
        finish: () => clearTimeout(deadline),
        timedOut: () => timedOut,
      }
    }
  } catch (err) {
    clearTimeout(deadline)
    if (timedOut) throw new AppError('IMPORT_TIMEOUT', 'The remote server took too long to respond.')
    throw err instanceof AppError ? err : networkError(err as NodeJS.ErrnoException)
  }
}

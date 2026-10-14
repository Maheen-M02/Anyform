import { Readable } from 'node:stream'
import { contentDisposition } from '@/lib/filename'
import type { Runtime } from '../runtime'

export function parseRange(header: string | null, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid'
  let start: number
  let end: number
  if (m[1] === '') {
    const suffix = Number(m[2])
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start > end || start >= size) return 'invalid'
  return { start, end }
}

/**
 * Streams a private object with HTTP range support and locked-down headers
 * (no sniffing, sandboxed if opened directly). Returns null if it is gone.
 * `?inline=1` serves it for in-page preview instead of as an attachment.
 */
export async function serveObject(
  storage: Runtime['storage'],
  key: string,
  file: { mime: string; filename: string },
  req: Request,
): Promise<Response | null> {
  const obj = await storage.stat(key)
  if (!obj) return null
  const inline = new URL(req.url).searchParams.get('inline') === '1'
  const headers = new Headers({
    'content-type': file.mime,
    'content-disposition': contentDisposition(file.filename, inline ? 'inline' : 'attachment'),
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  })
  const range = parseRange(req.headers.get('range'), obj.sizeBytes)
  if (range === 'invalid') {
    headers.set('content-range', `bytes */${obj.sizeBytes}`)
    return new Response(null, { status: 416, headers })
  }
  const stream = storage.read(key, range ?? undefined)
  const body = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
  if (range) {
    headers.set('content-range', `bytes ${range.start}-${range.end}/${obj.sizeBytes}`)
    headers.set('content-length', String(range.end - range.start + 1))
    return new Response(body, { status: 206, headers })
  }
  headers.set('content-length', String(obj.sizeBytes))
  return new Response(body, { status: 200, headers })
}

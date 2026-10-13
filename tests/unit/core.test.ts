import { describe, expect, it } from 'vitest'
import { contentDisposition, displayFilename, outputFilename, safeBaseName } from '@/lib/filename'
import { formatBytes, formatDuration } from '@/lib/formats'
import { assertJobTransition, canTransitionJob, canTransitionUpload, JOB_STATUSES } from '@/lib/states'
import { AppError, ERROR_CODES, errorBody, toAppError } from '@/server/errors'
import { isId, newId } from '@/server/ids'
import { RateLimiter } from '@/server/rate-limit'
import { parseRange } from '@/server/services/conversions'
import { encodeSessionCookie, readCookie, verifySessionCookie } from '@/server/session'
import { storageKey } from '@/server/storage'

describe('output filenames', () => {
  it('keeps the original base name', () => {
    expect(outputFilename('Holiday Video.mp4', 'mp3')).toBe('Holiday Video.mp3')
    expect(outputFilename('my.song.final.wav', 'mp3')).toBe('my.song.final.mp3')
    expect(outputFilename('naïve café.mp4', 'mp3')).toBe('naïve café.mp3')
  })
  it('strips paths, reserved and control characters', () => {
    expect(safeBaseName('../../etc/passwd.mp4')).toBe('passwd')
    expect(safeBaseName('C:\\Users\\x\\clip.mp4')).toBe('clip')
    expect(safeBaseName('a<b>c:d"e|f?g*h\u0000.mp4')).toBe('a b c d e f g h')
    expect(safeBaseName('...')).toBe('anyform-output')
    expect(safeBaseName('CON.mp4')).toBe('anyform-output')
    expect(safeBaseName('x'.repeat(500) + '.mp4')).toHaveLength(120)
  })
  it('sanitises display names', () => {
    expect(displayFilename('/a/b/c.mp4')).toBe('c.mp4')
    expect(displayFilename('\u0007')).toBe('upload')
  })
  it('encodes Content-Disposition safely', () => {
    expect(contentDisposition('a "b".mp3')).toBe(`attachment; filename="a _b_.mp3"; filename*=UTF-8''a%20%22b%22.mp3`)
    expect(contentDisposition('café.mp3', 'inline')).toContain("filename*=UTF-8''caf%C3%A9.mp3")
  })
})

describe('state machine', () => {
  it('allows the happy path', () => {
    for (const [a, b] of [['queued', 'processing'], ['processing', 'verifying'], ['verifying', 'completed'], ['completed', 'expired']] as const) {
      expect(canTransitionJob(a, b)).toBe(true)
    }
  })
  it('forbids leaving terminal states except to expire', () => {
    for (const from of ['completed', 'failed', 'cancelled'] as const) {
      for (const to of JOB_STATUSES) expect(canTransitionJob(from, to)).toBe(to === 'expired')
    }
    expect(() => assertJobTransition('expired', 'completed')).toThrow(/Invalid job transition/)
    expect(() => assertJobTransition('queued', 'completed')).toThrow()
  })
  it('governs upload validation', () => {
    expect(canTransitionUpload('uploaded', 'validating')).toBe(true)
    expect(canTransitionUpload('validating', 'validated')).toBe(true)
    expect(canTransitionUpload('rejected', 'validated')).toBe(false)
    expect(canTransitionUpload('uploaded', 'validated')).toBe(false)
  })
})

describe('sessions', () => {
  it('round-trips a signed session id', () => {
    const id = 'A'.repeat(32)
    expect(verifySessionCookie(encodeSessionCookie(id))).toBe(id)
  })
  it('rejects tampered or malformed cookies', () => {
    const cookie = encodeSessionCookie('B'.repeat(32))
    expect(verifySessionCookie(cookie.slice(0, -2) + 'xx')).toBeNull()
    expect(verifySessionCookie('C'.repeat(32) + cookie.slice(32))).toBeNull()
    expect(verifySessionCookie('nodot')).toBeNull()
    expect(verifySessionCookie('../x.y')).toBeNull()
    expect(verifySessionCookie(undefined)).toBeNull()
  })
  it('parses cookie headers', () => {
    expect(readCookie('a=1; anyform_sid=xyz; b=2', 'anyform_sid')).toBe('xyz')
    expect(readCookie(null, 'anyform_sid')).toBeUndefined()
  })
})

describe('ids and storage keys', () => {
  it('generates prefixed random ids', () => {
    const id = newId('job')
    expect(isId(id, 'job')).toBe(true)
    expect(isId(id, 'upl')).toBe(false)
    expect(newId('job')).not.toBe(id)
    expect(isId('job_../../../etc/passwd')).toBe(false)
  })
  it('only builds keys from generated ids', () => {
    expect(storageKey('uploads', newId('upl'))).toMatch(/^uploads\/upl_/)
    expect(() => storageKey('uploads', '../../etc/passwd')).toThrow()
    expect(() => storageKey('outputs', 'out_' + 'a'.repeat(21) + '/')).toThrow()
  })
})

describe('error mapping', () => {
  it('keeps AppErrors and hides unknown errors', () => {
    const known = new AppError('NO_AUDIO_STREAM', 'No audio')
    expect(toAppError(known)).toBe(known)
    const unknown = toAppError(new Error('ENOENT: /secret/path'))
    expect(unknown.code).toBe('INTERNAL_ERROR')
    expect(unknown.message).not.toContain('/secret')
    const disk = toAppError(Object.assign(new Error('disk'), { code: 'ENOSPC' }))
    expect(disk.code).toBe('INSUFFICIENT_STORAGE')
    expect(disk.status).toBe(507)
  })
  it('produces stable response bodies', () => {
    expect(errorBody(new AppError('RATE_LIMITED', 'Slow down'), 'req-1')).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Slow down', details: undefined, requestId: 'req-1' },
    })
    expect(ERROR_CODES.UPLOAD_TOO_LARGE).toBe(413)
  })
})

describe('rate limiter', () => {
  it('blocks after the limit within a window and resets after', () => {
    const rl = new RateLimiter(2, 1000)
    expect(rl.hit('k', 0)).toBe(0)
    expect(rl.hit('k', 10)).toBe(0)
    expect(rl.hit('k', 20)).toBeGreaterThan(0)
    expect(rl.hit('other', 20)).toBe(0)
    expect(rl.hit('k', 1500)).toBe(0)
  })
})

describe('range parsing', () => {
  it('handles standard, open-ended and suffix ranges', () => {
    expect(parseRange(null, 100)).toBeNull()
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 })
  })
  it('rejects unsatisfiable or malformed ranges', () => {
    expect(parseRange('bytes=100-', 100)).toBe('invalid')
    expect(parseRange('bytes=5-1', 100)).toBe('invalid')
    expect(parseRange('bytes=0-1,5-6', 100)).toBe('invalid')
    expect(parseRange('items=0-1', 100)).toBe('invalid')
  })
})

describe('display helpers', () => {
  it('formats sizes and durations', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB')
    expect(formatDuration(65)).toBe('1:05')
    expect(formatDuration(3725)).toBe('1:02:05')
    expect(formatDuration(null)).toBe('—')
  })
})

describe('configuration', () => {
  it('treats blank environment values as unset', async () => {
    const { getConfig, resetConfig } = await import('@/server/config')
    process.env.REDIS_URL = ''
    process.env.SESSION_SECRET = '   '
    resetConfig()
    try {
      expect(getConfig().redisUrl).toBeUndefined()
    } finally {
      delete process.env.REDIS_URL
      delete process.env.SESSION_SECRET
      resetConfig()
    }
  })
})

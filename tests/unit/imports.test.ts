import { describe, expect, it } from 'vitest'
import { fetchRemote, filenameFrom, parseImportUrl } from '@/server/imports/fetch'
import { isPublicAddress, isStreamingHost } from '@/server/imports/network'

const policy = { allowPrivate: false, allowedHosts: [] as string[] }

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1', '127.255.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.10',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1',
    '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', 'not-an-ip',
  ])('blocks %s', (address) => expect(isPublicAddress(address)).toBe(false))

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (address) =>
    expect(isPublicAddress(address)).toBe(true),
  )
})

describe('parseImportUrl', () => {
  it('accepts plain http(s) links', () => {
    expect(parseImportUrl('https://example.com/a.mp4', policy).hostname).toBe('example.com')
    expect(parseImportUrl('  http://example.com:80/x  ', policy).pathname).toBe('/x')
  })
  it.each([
    ['ftp://example.com/a.mp4', 'INVALID_URL'],
    ['file:///etc/passwd', 'INVALID_URL'],
    ['javascript:alert(1)', 'INVALID_URL'],
    ['not a url', 'INVALID_URL'],
    ['https://user:pass@example.com/a.mp4', 'URL_NOT_ALLOWED'],
    ['https://example.com:8443/a.mp4', 'URL_NOT_ALLOWED'],
    ['http://example.com:6379/', 'URL_NOT_ALLOWED'],
    ['https://soundcloud.com/artist/track', 'UNSUPPORTED_SOURCE'],
    ['https://www.netflix.com/watch/123', 'UNSUPPORTED_SOURCE'],
    ['https://music.apple.com/us/album/x/1', 'UNSUPPORTED_SOURCE'],
    [`https://example.com/${'a'.repeat(3000)}`, 'INVALID_URL'],
  ])('rejects %s (%s)', (url, code) => {
    expect(() => parseImportUrl(url, policy)).toThrow(expect.objectContaining({ code }))
  })
  it('enforces the host allowlist, including subdomains', () => {
    const allow = { allowPrivate: false, allowedHosts: ['archive.org'] }
    expect(parseImportUrl('https://ia800.us.archive.org/f.mp3', allow).hostname).toBe('ia800.us.archive.org')
    expect(() => parseImportUrl('https://notarchive.org/f.mp3', allow)).toThrow(expect.objectContaining({ code: 'URL_NOT_ALLOWED' }))
  })
  it('recognises streaming hosts only on their domains', () => {
    expect(isStreamingHost('m.soundcloud.com')).toBe(true)
    expect(isStreamingHost('notsoundcloud.com')).toBe(false)
    // YouTube and Spotify go through the media-site path instead of being refused.
    expect(isStreamingHost('www.youtube.com')).toBe(false)
    expect(isStreamingHost('open.spotify.com')).toBe(false)
  })
})

describe('fetchRemote address policy (no network needed)', () => {
  const opts = { maxBytes: 1e6, timeoutMs: 5000, maxRedirects: 3, allowPrivate: false, allowedHosts: [] }

  it('refuses hosts that resolve to private addresses before connecting', async () => {
    await expect(fetchRemote('https://intranet.example/x.png', { ...opts, resolve: async () => ['10.0.0.5'] })).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' })
    await expect(fetchRemote('http://metadata.example/latest', { ...opts, resolve: async () => ['169.254.169.254'] })).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' })
  })
  it('refuses hosts with any private answer among public ones', async () => {
    await expect(fetchRemote('https://mixed.example/x', { ...opts, resolve: async () => ['93.184.216.34', '127.0.0.1'] })).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' })
  })
  it('refuses literal private and IPv6-mapped addresses', async () => {
    for (const url of ['http://127.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data']) {
      await expect(fetchRemote(url, opts)).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' })
    }
  })
  it('reports unknown hosts', async () => {
    await expect(fetchRemote('https://nope.example/x', { ...opts, resolve: async () => Promise.reject(new Error('ENOTFOUND')) })).rejects.toMatchObject({
      code: 'REMOTE_FETCH_FAILED',
    })
  })
})

describe('filenameFrom', () => {
  const u = new URL('https://cdn.example.com/media/Holiday%20clip.mov?token=secret')
  it('prefers Content-Disposition, then the URL path, then the host', () => {
    expect(filenameFrom(u, `attachment; filename*=UTF-8''caf%C3%A9.mp3`)).toBe('café.mp3')
    expect(filenameFrom(u, 'attachment; filename="report.pdf"')).toBe('report.pdf')
    expect(filenameFrom(u, undefined)).toBe('Holiday clip.mov')
    expect(filenameFrom(new URL('https://cdn.example.com/'), undefined)).toBe('cdn.example.com')
  })
})

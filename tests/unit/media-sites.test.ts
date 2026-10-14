import { describe, expect, it } from 'vitest'
import { classifyMediaSite, parseSpotifyTrackPage, spotifySearchQuery, unwrapImageSearchLink } from '@/server/imports/media-sites'
import { ytDlpArgs, ytDlpError } from '@/server/imports/ytdlp'

const u = (s: string) => new URL(s)

describe('classifyMediaSite', () => {
  it.each([
    ['https://www.youtube.com/watch?v=jNQXAC9IVRw', false],
    ['https://youtube.com/watch?v=jNQXAC9IVRw&list=PL123&t=10s', false],
    ['https://m.youtube.com/watch?v=jNQXAC9IVRw', false],
    ['https://youtu.be/jNQXAC9IVRw?si=abc', false],
    ['https://www.youtube.com/shorts/jNQXAC9IVRw', false],
    ['https://www.youtube-nocookie.com/embed/jNQXAC9IVRw', false],
    ['https://music.youtube.com/watch?v=jNQXAC9IVRw', true],
  ])('%s → canonical YouTube video (audio only: %s)', (link, audioOnly) => {
    expect(classifyMediaSite(u(link))).toEqual({
      kind: 'youtube',
      videoId: 'jNQXAC9IVRw',
      audioOnly,
      canonical: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    })
  })

  it('refuses playlists and links without a valid video id', () => {
    expect(() => classifyMediaSite(u('https://www.youtube.com/playlist?list=PL123'))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_SOURCE' }))
    expect(() => classifyMediaSite(u('https://www.youtube.com/watch?v=short'))).toThrow(expect.objectContaining({ code: 'INVALID_URL' }))
    expect(() => classifyMediaSite(u('https://www.youtube.com/@channel'))).toThrow(expect.objectContaining({ code: 'INVALID_URL' }))
    // The id can never smuggle in options or another URL.
    expect(() => classifyMediaSite(u('https://youtu.be/--exec=calc'))).toThrow()
  })

  it('recognises Spotify tracks and refuses albums, playlists and podcasts', () => {
    expect(classifyMediaSite(u('https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8?si=x'))).toEqual({
      kind: 'spotify-track',
      trackId: '4PTG3Z6ehGkBFwjybzWkR8',
      pageUrl: 'https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8',
    })
    expect(classifyMediaSite(u('https://open.spotify.com/intl-de/track/4PTG3Z6ehGkBFwjybzWkR8'))?.kind).toBe('spotify-track')
    for (const kind of ['album', 'playlist', 'episode']) {
      expect(() => classifyMediaSite(u(`https://open.spotify.com/${kind}/4PTG3Z6ehGkBFwjybzWkR8`))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_SOURCE' }))
    }
  })

  it('ignores every other site', () => {
    expect(classifyMediaSite(u('https://example.com/watch?v=jNQXAC9IVRw'))).toBeNull()
    expect(classifyMediaSite(u('https://notyoutube.com/watch?v=jNQXAC9IVRw'))).toBeNull()
  })
})

describe('unwrapImageSearchLink', () => {
  it('extracts the real image from Google and Bing result links', () => {
    expect(unwrapImageSearchLink(u('https://www.google.com/imgres?imgurl=https%3A%2F%2Fcdn.example%2Fa.png&imgrefurl=x'))).toBe('https://cdn.example/a.png')
    expect(unwrapImageSearchLink(u('https://www.google.co.uk/imgres?imgurl=https://cdn.example/b.jpg'))).toBe('https://cdn.example/b.jpg')
    expect(unwrapImageSearchLink(u('https://www.bing.com/images/search?q=x&mediaurl=https%3A%2F%2Fcdn.example%2Fc.webp'))).toBe('https://cdn.example/c.webp')
    expect(unwrapImageSearchLink(u('https://www.google.com/search?q=cats'))).toBeNull()
    expect(unwrapImageSearchLink(u('https://evil.example/imgres?imgurl=http://127.0.0.1/'))).toBeNull()
  })
})

describe('Spotify track metadata', () => {
  const page = `<html><head>
    <meta property="og:title" content="Never Gonna Give You Up"/>
    <meta property="og:description" content="Rick Astley · Whenever You Need Somebody · Song · 1987"/>
    <meta property="og:type" content="music.song"/>
  </head></html>`
  it('reads title and artist from the public page', () => {
    expect(parseSpotifyTrackPage(page)).toEqual({ title: 'Never Gonna Give You Up', artist: 'Rick Astley' })
    expect(parseSpotifyTrackPage('<html></html>')).toBeNull()
  })
  it('builds a single-argument YouTube search query', () => {
    expect(spotifySearchQuery({ title: 'Never Gonna Give You Up', artist: 'Rick Astley' })).toBe('ytsearch1:Rick Astley Never Gonna Give You Up audio')
    expect(spotifySearchQuery({ title: 'A\nB\u0000C', artist: null })).toBe('ytsearch1:A B C audio')
  })
})

describe('yt-dlp invocation', () => {
  const base = { outDir: 'C:/scratch/import-x', maxBytes: 1000, maxDurationSec: 600 }
  it('restricts extractors, ignores user config and keeps the target as one final argument', () => {
    const args = ytDlpArgs({ ...base, target: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', mode: 'video' })
    expect(args.slice(args.indexOf('--use-extractors'), args.indexOf('--use-extractors') + 2)).toEqual(['--use-extractors', 'youtube'])
    expect(args).toContain('--ignore-config')
    expect(args).toContain('--no-playlist')
    expect(args.slice(-2)).toEqual(['--', 'https://www.youtube.com/watch?v=jNQXAC9IVRw'])
    expect(args).toEqual(expect.arrayContaining(['--max-filesize', '1000', '--match-filter', 'duration <= 600', '--merge-output-format', 'mp4']))
  })
  it('allows YouTube search only for search targets and extracts MP3 for audio', () => {
    const args = ytDlpArgs({ ...base, target: 'ytsearch1:Rick Astley audio', mode: 'audio' })
    expect(args.slice(args.indexOf('--use-extractors'), args.indexOf('--use-extractors') + 2)).toEqual(['--use-extractors', 'youtube,youtube:search'])
    expect(args).toEqual(expect.arrayContaining(['-x', '--audio-format', 'mp3', '--audio-quality', '192K']))
  })
  it('maps yt-dlp failures to clear messages', () => {
    expect(ytDlpError('ERROR: [youtube] x: Private video. Sign in').code).toBe('PROTECTED_FILE')
    expect(ytDlpError('ERROR: Sign in to confirm your age').message).toMatch(/age-restricted/)
    expect(ytDlpError('ERROR: [youtube] x: Video unavailable').message).toMatch(/unavailable/)
    expect(ytDlpError('something odd').code).toBe('REMOTE_FETCH_FAILED')
  })
})

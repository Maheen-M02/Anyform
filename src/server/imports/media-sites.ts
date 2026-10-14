import { AppError } from '../errors'
import { hostMatches } from './network'
import { metaTags } from './page'

/**
 * Links that are not files but media pages ANYFORM can still turn into a
 * downloadable file:
 * - YouTube videos → MP4 (YouTube Music → MP3), fetched with yt-dlp.
 * - Spotify tracks → MP3. Spotify's own audio is DRM-protected and is never
 *   touched: the track's title and artist are read from its public page and the
 *   same recording is fetched from YouTube instead.
 */
export type MediaSite =
  | { kind: 'youtube'; videoId: string; audioOnly: boolean; canonical: string }
  | { kind: 'spotify-track'; trackId: string; pageUrl: string }

const YOUTUBE_HOSTS = ['youtube.com', 'youtube-nocookie.com', 'youtu.be']
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

function youtubeId(url: URL): string | null {
  const host = url.hostname.toLowerCase()
  if (hostMatches(host, 'youtu.be')) return url.pathname.split('/')[1] ?? null
  const v = url.searchParams.get('v')
  if (v) return v
  const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/)
  return m?.[1] ?? null
}

/** Recognises YouTube and Spotify links. Returns null for everything else. */
export function classifyMediaSite(url: URL): MediaSite | null {
  const host = url.hostname.toLowerCase()
  if (YOUTUBE_HOSTS.some((d) => hostMatches(host, d))) {
    const id = youtubeId(url)
    if (!id || !VIDEO_ID.test(id)) {
      if (url.searchParams.get('list') || url.pathname.startsWith('/playlist')) {
        throw new AppError('UNSUPPORTED_SOURCE', 'YouTube playlists aren’t supported. Open a single video and paste its link.')
      }
      throw new AppError('INVALID_URL', 'This YouTube link doesn’t point to a video. Paste the link of a single video.')
    }
    // Only a URL we construct ever reaches yt-dlp.
    return { kind: 'youtube', videoId: id, audioOnly: hostMatches(host, 'music.youtube.com'), canonical: `https://www.youtube.com/watch?v=${id}` }
  }
  if (hostMatches(host, 'spotify.com')) {
    const m = url.pathname.match(/^\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]{22})/)
    if (!m) throw new AppError('INVALID_URL', 'This Spotify link doesn’t point to a track. Use “Share → Copy song link”.')
    if (m[1] !== 'track') {
      throw new AppError('UNSUPPORTED_SOURCE', `Spotify ${m[1]}s aren’t supported, only single tracks. Copy the link of one song.`)
    }
    return { kind: 'spotify-track', trackId: m[2]!, pageUrl: `https://open.spotify.com/track/${m[2]}` }
  }
  return null
}

/**
 * Image-search result links wrap the real image URL in a query parameter
 * (Google Images `imgurl`, Bing `mediaurl`). Returns the wrapped URL, if any.
 */
export function unwrapImageSearchLink(url: URL): string | null {
  const host = url.hostname.toLowerCase()
  const isGoogle = /(^|\.)google\.[a-z.]+$/.test(host)
  if (isGoogle && (url.pathname === '/imgres' || url.searchParams.has('imgurl'))) return url.searchParams.get('imgurl')
  if (hostMatches(host, 'bing.com') && url.searchParams.has('mediaurl')) return url.searchParams.get('mediaurl')
  return null
}

/** Title and artist from a Spotify track page's Open Graph tags. */
export function parseSpotifyTrackPage(html: string): { title: string; artist: string | null } | null {
  const meta = metaTags(html)
  const title = meta['og:title']?.trim()
  if (!title) return null
  // og:description looks like "Artist · Album · Song · 1987".
  const fromDescription = meta['og:description']?.split('·')[0]?.trim()
  const artist = meta['music:musician_description']?.trim() || fromDescription || null
  return { title: title.slice(0, 200), artist: artist ? artist.slice(0, 200) : null }
}

/** A YouTube search for the recording, safe to hand to yt-dlp as a single argument. */
export function spotifySearchQuery(track: { title: string; artist: string | null }): string {
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  const terms = [track.artist && clean(track.artist), clean(track.title), 'audio'].filter(Boolean).join(' ')
  return `ytsearch1:${terms}`
}

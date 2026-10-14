/**
 * Finds the main media file referenced by an HTML page, so that pasting a link
 * to a page (an article, a photo page) downloads its video, audio or image.
 * Uses the page's own declarations (Open Graph / Twitter tags, <video>,
 * <audio>, <link rel="image_src">). Scripts are never executed.
 */

export type MediaKind = 'video' | 'audio' | 'image'

export interface PageMedia {
  url: URL
  kind: MediaKind
}

/** Largest HTML document read while looking for media. */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x2F': '/', '#47': '/' }

function decodeEntities(value: string): string {
  return value
    .replace(/&(amp|lt|gt|quot|apos|#39|#x2F|#47);/gi, (m, e: string) => ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
}

/** Attributes of every occurrence of `tag` (attribute names lower-cased). */
function tags(html: string, tag: string): Record<string, string>[] {
  const out: Record<string, string>[] = []
  const re = new RegExp(`<${tag}\\b([^>]*)>`, 'gi')
  for (const m of html.matchAll(re)) {
    const attrs: Record<string, string> = {}
    for (const a of m[1]!.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[a[1]!.toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '')
    }
    out.push(attrs)
  }
  return out
}

/** First value of each <meta property|name> on a page (names lower-cased). */
export function metaTags(html: string): Record<string, string> {
  const out: Record<string, string> = {}
  const doc = html.slice(0, MAX_PAGE_BYTES).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
  for (const m of tags(doc, 'meta')) {
    const key = (m.property ?? m.name ?? '').toLowerCase()
    if (key && m.content !== undefined && !(key in out)) out[key] = m.content
  }
  return out
}

function resolve(raw: string | undefined, base: URL): URL | null {
  if (!raw || !raw.trim()) return null
  try {
    const url = new URL(raw.trim(), base)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null
  } catch {
    return null
  }
}

/** Streaming manifests are playlists of fragments, not downloadable files. */
function isManifest(url: URL): boolean {
  return /\.(m3u8|mpd)$/i.test(url.pathname)
}

/**
 * Candidate media URLs in priority order: video, then audio, then image
 * (a page with a video usually also has a thumbnail image).
 */
export function findPageMedia(html: string, base: URL): PageMedia[] {
  // Ignore script/style bodies, which may contain HTML-looking strings.
  const doc = html.slice(0, MAX_PAGE_BYTES).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
  const meta = tags(doc, 'meta')
  const metaValue = (...names: string[]) =>
    names.flatMap((n) => meta.filter((m) => (m.property ?? m.name ?? '').toLowerCase() === n).map((m) => m.content))

  const found: PageMedia[] = []
  const add = (kind: MediaKind, raws: (string | undefined)[]) => {
    for (const raw of raws) {
      const url = resolve(raw, base)
      if (url && !isManifest(url) && !found.some((f) => f.url.href === url.href)) found.push({ url, kind })
    }
  }

  add('video', metaValue('og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player:stream'))
  add('video', tags(doc, 'video').map((v) => v.src))
  add('video', tags(doc, 'source').filter((s) => !s.type || s.type.startsWith('video/')).map((s) => s.src))
  add('audio', metaValue('og:audio:secure_url', 'og:audio:url', 'og:audio'))
  add('audio', tags(doc, 'audio').map((a) => a.src))
  add('audio', tags(doc, 'source').filter((s) => s.type?.startsWith('audio/')).map((s) => s.src))
  add('image', metaValue('og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src'))
  add('image', tags(doc, 'link').filter((l) => (l.rel ?? '').toLowerCase() === 'image_src').map((l) => l.href))
  // A video's own poster frame is a last-resort image.
  add('image', tags(doc, 'video').map((v) => v.poster))
  return found
}

/** Whether a response is a web page (rather than a file) according to its Content-Type. */
export function isHtmlContentType(contentType: string | undefined): boolean {
  return !!contentType && /^\s*(text\/html|application\/xhtml\+xml)\b/i.test(contentType)
}

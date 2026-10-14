import { describe, expect, it } from 'vitest'
import { findPageMedia, isHtmlContentType } from '@/server/imports/page'

const base = new URL('https://news.example/articles/42')

describe('findPageMedia', () => {
  it('prefers video, then audio, then image, resolving relative URLs and entities', () => {
    const html = `<html><head>
      <meta property="og:image" content="/img/cover.jpg">
      <meta content="https://cdn.example/v.mp4?a=1&amp;b=2" property="og:video:secure_url" />
      <meta name="twitter:image" content='https://cdn.example/t.png'>
      <script>var x = '<meta property="og:video" content="https://evil.example/x.mp4">'</script>
    </head><body><audio src="clip.mp3"></audio></body></html>`
    expect(findPageMedia(html, base).map((m) => `${m.kind}:${m.url.href}`)).toEqual([
      'video:https://cdn.example/v.mp4?a=1&b=2',
      'audio:https://news.example/articles/clip.mp3',
      'image:https://news.example/img/cover.jpg',
      'image:https://cdn.example/t.png',
    ])
  })

  it('reads <video><source> and posters, and skips streaming manifests and non-http links', () => {
    const html = `<video poster="/p.jpg"><source src="/live.m3u8" type="application/x-mpegURL"><source src="/v.webm" type="video/webm"></video>
      <meta property="og:image" content="javascript:alert(1)"><meta property="og:image" content="data:image/png;base64,AAA">`
    expect(findPageMedia(html, base).map((m) => m.url.pathname)).toEqual(['/v.webm', '/p.jpg'])
  })

  it('returns nothing for pages without media', () => {
    expect(findPageMedia('<html><body><p>Hello</p></body></html>', base)).toEqual([])
  })
})

describe('isHtmlContentType', () => {
  it('recognises pages but not files', () => {
    expect(isHtmlContentType('text/html; charset=utf-8')).toBe(true)
    expect(isHtmlContentType('application/xhtml+xml')).toBe(true)
    expect(isHtmlContentType('image/png')).toBe(false)
    expect(isHtmlContentType(undefined)).toBe(false)
  })
})

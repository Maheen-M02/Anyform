/**
 * Minimal, bounds-checked readers for the metadata blocks libvips hands back
 * (EXIF/TIFF IFDs, XMP, IPTC-IIM, PNG text chunks). Only the fields that reveal
 * something about the photographer are extracted. Runs in the sandbox: every
 * offset comes from an untrusted file.
 */
import { dedupeHidden, formatCoordinates, hiddenItem, sortHidden } from '../server/inspect/hidden'
import type { HiddenItem } from '../server/inspect/types'

const MAX_IFD_ENTRIES = 512
const MAX_STRING = 400

interface Entry {
  type: number
  count: number
  /** Offset of the value bytes (inline values point inside the entry). */
  at: number
}

// BYTE, ASCII, SHORT, LONG, RATIONAL, UNDEFINED, SLONG, SRATIONAL, IFD.
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 13: 4 }

class Tiff {
  private readonly le: boolean

  constructor(private readonly buf: Buffer) {
    const order = buf.toString('latin1', 0, 2)
    if (order !== 'II' && order !== 'MM') throw new Error('not TIFF')
    this.le = order === 'II'
    if (this.u16(2) !== 42) throw new Error('not TIFF')
  }

  inRange(offset: number, length: number): boolean {
    return Number.isInteger(offset) && offset >= 0 && length >= 0 && offset + length <= this.buf.length
  }

  u16(o: number): number {
    if (!this.inRange(o, 2)) throw new Error('out of range')
    return this.le ? this.buf.readUInt16LE(o) : this.buf.readUInt16BE(o)
  }

  u32(o: number): number {
    if (!this.inRange(o, 4)) throw new Error('out of range')
    return this.le ? this.buf.readUInt32LE(o) : this.buf.readUInt32BE(o)
  }

  firstIfd(): number {
    return this.u32(4)
  }

  /** Entries of the IFD at `offset` and the offset of the next IFD (0 when none). */
  ifd(offset: number): { entries: Map<number, Entry>; next: number } {
    const entries = new Map<number, Entry>()
    const count = Math.min(this.u16(offset), MAX_IFD_ENTRIES)
    for (let i = 0; i < count; i++) {
      const e = offset + 2 + i * 12
      if (!this.inRange(e, 12)) break
      const tag = this.u16(e)
      const type = this.u16(e + 2)
      const n = this.u32(e + 4)
      const size = (TYPE_SIZE[type] ?? 0) * n
      if (!size) continue
      const at = size <= 4 ? e + 8 : this.u32(e + 8)
      if (this.inRange(at, size)) entries.set(tag, { type, count: n, at })
    }
    const nextAt = offset + 2 + count * 12
    return { entries, next: this.inRange(nextAt, 4) ? this.u32(nextAt) : 0 }
  }

  ascii(e: Entry | undefined): string | null {
    if (!e || (e.type !== 2 && e.type !== 7 && e.type !== 1)) return null
    const raw = this.buf.subarray(e.at, e.at + Math.min(e.count, MAX_STRING))
    const text = raw.toString('utf8').replace(/\0[\s\S]*$/, '').trim()
    return text || null
  }

  /** Windows "XP" tags are UCS-2 stored as BYTE arrays. */
  ucs2(e: Entry | undefined): string | null {
    if (!e || e.type !== 1) return null
    const raw = this.buf.subarray(e.at, e.at + Math.min(e.count, MAX_STRING * 2))
    const text = raw.toString('utf16le').replace(/\0[\s\S]*$/, '').trim()
    return text || null
  }

  uint(e: Entry | undefined): number | null {
    if (!e) return null
    if (e.type === 3) return this.u16(e.at)
    if (e.type === 4 || e.type === 13) return this.u32(e.at)
    if (e.type === 1 || e.type === 7) return this.buf[e.at] ?? null
    return null
  }

  rationals(e: Entry | undefined): number[] {
    if (!e || (e.type !== 5 && e.type !== 10)) return []
    const out: number[] = []
    for (let i = 0; i < Math.min(e.count, 8); i++) {
      const num = this.u32(e.at + i * 8)
      const den = this.u32(e.at + i * 8 + 4)
      out.push(den === 0 ? NaN : num / den)
    }
    return out
  }

  /** Readable sub-IFD pointed to by a LONG/IFD entry, or null. */
  pointer(e: Entry | undefined): number | null {
    const offset = this.uint(e)
    return offset && this.inRange(offset, 2) ? offset : null
  }
}

function dms(values: number[]): number | null {
  const [d, m = 0, s = 0] = values
  if (d === undefined || ![d, m, s].every(Number.isFinite)) return null
  return d + m / 60 + s / 3600
}

/** Hidden data in an EXIF block ("Exif\0\0" + TIFF structure). */
export function exifHidden(block: Buffer): HiddenItem[] {
  const items: HiddenItem[] = []
  const buf = block.toString('latin1', 0, 6) === 'Exif\0\0' ? block.subarray(6) : block
  let tiff: Tiff
  try {
    tiff = new Tiff(buf)
  } catch {
    return items
  }
  const push = (category: HiddenItem['category'], label: string, value: string | null, risk: HiddenItem['risk']) => {
    if (value) items.push(hiddenItem(category, label, value, risk))
  }

  try {
    const ifd0 = tiff.ifd(tiff.firstIfd())
    const t = ifd0.entries
    push('device', 'Camera maker', tiff.ascii(t.get(0x010f)), 'medium')
    push('device', 'Camera model', tiff.ascii(t.get(0x0110)), 'medium')
    push('software', 'Software', tiff.ascii(t.get(0x0131)), 'low')
    push('device', 'Computer name', tiff.ascii(t.get(0x013c)), 'medium')
    push('time', 'Modified', tiff.ascii(t.get(0x0132)), 'low')
    push('people', 'Artist', tiff.ascii(t.get(0x013b)), 'medium')
    push('people', 'Copyright', tiff.ascii(t.get(0x8298)), 'low')
    push('description', 'Description', tiff.ascii(t.get(0x010e)), 'low')
    push('description', 'Title', tiff.ucs2(t.get(0x9c9b)), 'low')
    push('description', 'Comment', tiff.ucs2(t.get(0x9c9c)), 'low')
    push('people', 'Author', tiff.ucs2(t.get(0x9c9d)), 'medium')

    const exifAt = tiff.pointer(t.get(0x8769))
    if (exifAt !== null) {
      const e = tiff.ifd(exifAt).entries
      push('time', 'Taken', tiff.ascii(e.get(0x9003)), 'low')
      push('people', 'Camera owner', tiff.ascii(e.get(0xa430)), 'high')
      push('device', 'Camera serial number', tiff.ascii(e.get(0xa431)), 'high')
      push('device', 'Lens', tiff.ascii(e.get(0xa434)), 'low')
      push('device', 'Lens serial number', tiff.ascii(e.get(0xa435)), 'high')
      push('history', 'Unique image ID', tiff.ascii(e.get(0xa420)), 'medium')
      const maker = e.get(0x927c)
      if (maker && maker.count > 0) {
        push('device', 'Maker notes', `${Math.max(1, Math.round(maker.count / 1024))} KB of manufacturer-private data`, 'medium')
      }
    }

    const gpsAt = tiff.pointer(t.get(0x8825))
    if (gpsAt !== null) {
      const g = tiff.ifd(gpsAt).entries
      const lat = dms(tiff.rationals(g.get(2)))
      const lon = dms(tiff.rationals(g.get(4)))
      if (lat !== null && lon !== null && !(lat === 0 && lon === 0) && lat <= 90 && lon <= 180) {
        const signedLat = tiff.ascii(g.get(1))?.toUpperCase() === 'S' ? -lat : lat
        const signedLon = tiff.ascii(g.get(3))?.toUpperCase() === 'W' ? -lon : lon
        const alt = tiff.rationals(g.get(6))[0]
        const below = tiff.uint(g.get(5)) === 1
        const altitude = alt !== undefined && Number.isFinite(alt) ? ` (altitude ${Math.round(below ? -alt : alt)} m)` : ''
        push('location', 'GPS location', `${formatCoordinates(signedLat, signedLon)}${altitude}`, 'high')
      } else if (g.size > 0) {
        push('location', 'GPS data', 'present (no usable coordinates)', 'medium')
      }
      push('time', 'GPS date', tiff.ascii(g.get(0x1d)), 'low')
    }

    // IFD1 holds an embedded preview, which can still show the uncropped original.
    if (ifd0.next && tiff.inRange(ifd0.next, 2)) {
      const ifd1 = tiff.ifd(ifd0.next).entries
      const length = tiff.uint(ifd1.get(0x0202))
      if (ifd1.has(0x0201) && length) {
        push('history', 'Embedded thumbnail', `${Math.max(1, Math.round(length / 1024))} KB preview that may show the photo before cropping or edits`, 'medium')
      }
    }
  } catch {
    // A truncated or malformed block: report what was read so far.
  }
  return items
}

function xmpValue(xmp: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const attr = xmp.match(new RegExp(`${escaped}="([^"]{1,${MAX_STRING}})"`))
  if (attr) return attr[1]!.trim() || null
  const element = xmp.match(new RegExp(`<${escaped}>([^<]{1,${MAX_STRING}})</${escaped}>`))
  if (element) return element[1]!.trim() || null
  // Lists: <dc:creator><rdf:Seq><rdf:li>Name</rdf:li>…
  const list = xmp.match(new RegExp(`<${escaped}>[\\s\\S]{0,200}?<rdf:li[^>]*>([^<]{1,${MAX_STRING}})</rdf:li>`))
  return list ? list[1]!.trim() || null : null
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

/** Hidden data in an XMP packet (Adobe and phone editing software). */
export function xmpHidden(block: Buffer): HiddenItem[] {
  const xmp = block.subarray(0, 512 * 1024).toString('utf8')
  const items: HiddenItem[] = []
  const push = (category: HiddenItem['category'], label: string, value: string | null, risk: HiddenItem['risk']) => {
    if (value) items.push(hiddenItem(category, label, decodeXmlEntities(value), risk))
  }
  push('people', 'Creator', xmpValue(xmp, 'dc:creator'), 'medium')
  push('people', 'Rights', xmpValue(xmp, 'dc:rights'), 'low')
  push('software', 'Editing software', xmpValue(xmp, 'xmp:CreatorTool'), 'low')
  push('time', 'Created', xmpValue(xmp, 'xmp:CreateDate'), 'low')
  push('history', 'Original document ID', xmpValue(xmp, 'xmpMM:OriginalDocumentID'), 'medium')
  const lat = xmpValue(xmp, 'exif:GPSLatitude')
  const lon = xmpValue(xmp, 'exif:GPSLongitude')
  if (lat && lon) push('location', 'GPS location', `${lat}, ${lon}`, 'high')
  push('location', 'City', xmpValue(xmp, 'photoshop:City'), 'medium')
  push('location', 'Country', xmpValue(xmp, 'photoshop:Country'), 'low')
  const steps = (xmp.match(/stEvt:action/g) ?? []).length
  if (steps > 0) push('history', 'Edit history', `${steps} recorded editing step${steps === 1 ? '' : 's'}`, 'medium')
  if (items.length === 0 && xmp.includes('x:xmpmeta')) push('description', 'XMP metadata', `${Math.max(1, Math.round(block.length / 1024))} KB block`, 'low')
  return items
}

const IPTC: Record<number, { category: HiddenItem['category']; label: string; risk: HiddenItem['risk'] }> = {
  80: { category: 'people', label: 'By-line', risk: 'medium' },
  116: { category: 'people', label: 'Copyright', risk: 'low' },
  90: { category: 'location', label: 'City', risk: 'medium' },
  92: { category: 'location', label: 'Sub-location', risk: 'medium' },
  95: { category: 'location', label: 'Region', risk: 'low' },
  101: { category: 'location', label: 'Country', risk: 'low' },
  120: { category: 'description', label: 'Caption', risk: 'low' },
  25: { category: 'description', label: 'Keywords', risk: 'low' },
}

/** Hidden data in IPTC-IIM datasets (record 2), found by scanning for tag markers. */
export function iptcHidden(block: Buffer): HiddenItem[] {
  const items: HiddenItem[] = []
  let i = 0
  while (i + 5 <= block.length && items.length < 40) {
    if (block[i] !== 0x1c || block[i + 1] !== 0x02) {
      i++
      continue
    }
    const dataset = block[i + 2]!
    const length = block.readUInt16BE(i + 3)
    const start = i + 5
    if (length & 0x8000 || start + length > block.length) break
    const rule = IPTC[dataset]
    if (rule && length > 0) {
      items.push(hiddenItem(rule.category, rule.label, block.toString('utf8', start, start + Math.min(length, MAX_STRING)), rule.risk))
    }
    i = start + length
  }
  return items
}

/** Hidden data in PNG text chunks (tEXt/iTXt/zTXt). */
export function pngTextHidden(comments: readonly { keyword: string; text: string }[]): HiddenItem[] {
  return comments.slice(0, 40).flatMap((c) => {
    const key = c.keyword.toLowerCase()
    if (key.startsWith('xml:com.adobe.xmp')) return xmpHidden(Buffer.from(c.text, 'utf8'))
    if (key === 'author') return [hiddenItem('people', 'Author', c.text, 'medium')]
    if (key === 'copyright') return [hiddenItem('people', 'Copyright', c.text, 'low')]
    if (key === 'software') return [hiddenItem('software', 'Software', c.text, 'low')]
    if (key === 'creation time') return [hiddenItem('time', 'Created', c.text, 'low')]
    // Image generators store their full prompt and settings here.
    if (key === 'parameters' || key === 'prompt' || key === 'workflow') return [hiddenItem('history', 'Generation settings', c.text, 'medium')]
    return [hiddenItem('description', `Text: ${c.keyword.slice(0, 40)}`, c.text, 'low')]
  })
}

export interface ImageMetadataBlocks {
  exif?: Buffer
  xmp?: Buffer
  iptc?: Buffer
  comments?: { keyword: string; text: string }[]
}

export function imageHidden(meta: ImageMetadataBlocks): HiddenItem[] {
  const items = [
    ...(meta.exif ? exifHidden(meta.exif) : []),
    ...(meta.xmp ? xmpHidden(meta.xmp) : []),
    ...(meta.iptc ? iptcHidden(meta.iptc) : []),
    ...(meta.comments ? pngTextHidden(meta.comments) : []),
  ]
  return sortHidden(dedupeHidden(items))
}

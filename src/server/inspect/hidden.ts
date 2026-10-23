/**
 * Classification of hidden metadata. Shared by the server (audio/video tags
 * from ffprobe) and the sandbox (EXIF, XMP, PDF info), so this module must stay
 * dependency-free.
 */
import type { HiddenCategory, HiddenItem } from './types'

const MAX_VALUE = 120
/** Upper bound on reported items, so a file stuffed with tags cannot bloat the record. */
export const MAX_HIDDEN_ITEMS = 40

export function hiddenItem(category: HiddenCategory, label: string, value: string, risk: HiddenItem['risk'], removable = true): HiddenItem {
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return { category, label, value: clean.length > MAX_VALUE ? `${clean.slice(0, MAX_VALUE - 1)}…` : clean, risk, removable }
}

export function formatCoordinates(lat: number, lon: number): string {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`
}

/** "+37.7749-122.4194+010.000/" (ISO 6709, used by phones in MP4/MOV) → coordinates. */
export function parseIso6709(value: string): { lat: number; lon: number } | null {
  const m = value.trim().match(/^([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)/)
  if (!m) return null
  const lat = Number(m[1])
  const lon = Number(m[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { lat, lon }
}

/** "D:20240102153000+01'00'" (PDF date) → "2024-01-02 15:30". */
export function formatPdfDate(value: string): string {
  const m = value.match(/^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/)
  if (!m) return value
  const [, y, mo = '01', d = '01', h, mi] = m
  return `${y}-${mo}-${d}${h ? ` ${h}:${mi ?? '00'}` : ''}`
}

/** Deduplicates by category, label and value, keeping the first occurrence, and caps the list. */
export function dedupeHidden(items: HiddenItem[]): HiddenItem[] {
  const seen = new Set<string>()
  const out: HiddenItem[] = []
  for (const item of items) {
    const key = `${item.category}\u0000${item.label}\u0000${item.value}`
    if (seen.has(key) || !item.value) continue
    seen.add(key)
    out.push(item)
    if (out.length >= MAX_HIDDEN_ITEMS) break
  }
  return out
}

const RISK_ORDER = { high: 0, medium: 1, low: 2 } as const

export function sortHidden(items: HiddenItem[]): HiddenItem[] {
  return [...items].sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk])
}

/** Items of the source that are no longer present in the output (compared by category and label). */
export function removedHidden(before: HiddenItem[], after: HiddenItem[]): HiddenItem[] {
  const remaining = new Set(after.map((i) => `${i.category}\u0000${i.label}`))
  return before.filter((i) => !remaining.has(`${i.category}\u0000${i.label}`))
}

// ---------------------------------------------------------------------------
// Audio/video container tags (ffprobe format and stream tags)

export interface MediaTag {
  key: string
  value: string
  /** Absolute stream index, or null for container-level tags. */
  stream: number | null
}

type TagRule = { category: HiddenCategory; label: string; risk: HiddenItem['risk'] }

const LOCATION_KEYS = new Set(['location', 'com.apple.quicktime.location.iso6709', 'com.android.location', 'xyz'])

const TAG_RULES: Record<string, TagRule> = {
  make: { category: 'device', label: 'Device maker', risk: 'medium' },
  'com.apple.quicktime.make': { category: 'device', label: 'Device maker', risk: 'medium' },
  'com.android.manufacturer': { category: 'device', label: 'Device maker', risk: 'medium' },
  model: { category: 'device', label: 'Device model', risk: 'medium' },
  'com.apple.quicktime.model': { category: 'device', label: 'Device model', risk: 'medium' },
  'com.android.model': { category: 'device', label: 'Device model', risk: 'medium' },
  'com.apple.quicktime.camera.lens_model': { category: 'device', label: 'Lens', risk: 'low' },
  'com.apple.quicktime.software': { category: 'software', label: 'Device software', risk: 'low' },
  'com.android.version': { category: 'software', label: 'Device software', risk: 'low' },
  software: { category: 'software', label: 'Software', risk: 'low' },
  encoder: { category: 'software', label: 'Software', risk: 'low' },
  encoded_by: { category: 'software', label: 'Encoded by', risk: 'low' },
  creation_time: { category: 'time', label: 'Recorded', risk: 'low' },
  'com.apple.quicktime.creationdate': { category: 'time', label: 'Recorded', risk: 'low' },
  date: { category: 'time', label: 'Date', risk: 'low' },
  date_recorded: { category: 'time', label: 'Recorded', risk: 'low' },
  author: { category: 'people', label: 'Author', risk: 'medium' },
  'com.apple.quicktime.author': { category: 'people', label: 'Author', risk: 'medium' },
  artist: { category: 'people', label: 'Artist', risk: 'low' },
  album_artist: { category: 'people', label: 'Album artist', risk: 'low' },
  composer: { category: 'people', label: 'Composer', risk: 'low' },
  copyright: { category: 'people', label: 'Copyright', risk: 'low' },
  comment: { category: 'description', label: 'Comment', risk: 'low' },
  description: { category: 'description', label: 'Description', risk: 'low' },
  synopsis: { category: 'description', label: 'Description', risk: 'low' },
  title: { category: 'description', label: 'Title', risk: 'low' },
  album: { category: 'description', label: 'Album', risk: 'low' },
  genre: { category: 'description', label: 'Genre', risk: 'low' },
}

/** The FFmpeg/libav muxer stamps its own name; that says nothing about the user. */
const TOOLCHAIN_STAMP = /^(lav[fc]|libebml|libmatroska)/i

/** Hidden data in audio/video container tags. */
export function avHidden(tags: readonly MediaTag[]): HiddenItem[] {
  const items: HiddenItem[] = []
  for (const tag of tags) {
    // QuickTime appends a language code ("location-eng"); Matroska keys are upper case.
    const key = tag.key.toLowerCase().replace(/-[a-z]{3}$/, '').replace(/^©/, '')
    const value = tag.value.trim()
    if (!value) continue
    if (LOCATION_KEYS.has(key)) {
      const pos = parseIso6709(value)
      items.push(hiddenItem('location', 'GPS location', pos ? formatCoordinates(pos.lat, pos.lon) : value, 'high'))
      continue
    }
    const rule = TAG_RULES[key]
    if (!rule) continue
    if (rule.category === 'software' && TOOLCHAIN_STAMP.test(value)) continue
    // Stream-level titles are track names ("SoundHandler"), not the file's title.
    if (tag.stream !== null && (key === 'title' || key === 'creation_time')) continue
    items.push(hiddenItem(rule.category, rule.label, value, rule.risk))
  }
  return sortHidden(dedupeHidden(items))
}

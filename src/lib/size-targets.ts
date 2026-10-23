/**
 * Size-budget arithmetic for "make it fit under N MB". Shared by the server
 * (which enforces it) and the browser (which greys out destinations a file
 * cannot reach). Sizes are decimal megabytes, as upload limits are advertised.
 */

export const MB = 1_000_000

/** Below this the picture is not worth watching; such targets are refused rather than produced. */
export const MIN_VIDEO_KBPS = 150
/** Share of the budget given to audio/video streams; the rest absorbs container overhead and rate-control drift. */
const STREAM_SHARE = 0.94

export interface VideoBudget {
  videoKbps: number
  audioKbps: number
  /** Height cap that suits the bitrate (null: no cap needed). */
  maxHeight: number | null
}

/** Bitrates that fit `maxBytes` for a clip of `durationSec`, or null when the target is unreachable. */
export function videoBudget(durationSec: number, maxBytes: number, hasAudio: boolean): VideoBudget | null {
  if (!(durationSec > 0) || !(maxBytes > 0)) return null
  const totalKbps = (maxBytes * 8 * STREAM_SHARE) / durationSec / 1000
  const audioKbps = !hasAudio ? 0 : totalKbps >= 1500 ? 128 : totalKbps >= 500 ? 96 : 64
  const videoKbps = Math.floor(totalKbps - audioKbps)
  if (videoKbps < MIN_VIDEO_KBPS) return null
  return { videoKbps, audioKbps, maxHeight: heightForVideoKbps(videoKbps) }
}

/** Resolution that a bitrate can carry without turning into blocks (H.264-class codecs). */
export function heightForVideoKbps(kbps: number): number | null {
  if (kbps < 400) return 360
  if (kbps < 900) return 480
  if (kbps < 2000) return 720
  if (kbps < 5000) return 1080
  return null
}

/** Longest clip (seconds) that can fit `maxBytes`, for messages. */
export function maxVideoSeconds(maxBytes: number, hasAudio: boolean): number {
  return Math.floor((maxBytes * 8 * STREAM_SHARE) / ((MIN_VIDEO_KBPS + (hasAudio ? 64 : 0)) * 1000))
}

/** Valid MPEG-1 Layer III bitrates at 32/44.1/48 kHz. */
export const MP3_ALL_BITRATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] as const
/** Lowest MP3 bitrate offered for a size target (below this speech becomes hard to follow). */
export const MIN_MP3_KBPS = 48

/** Largest MP3 bitrate at or below `ceilingKbps` whose CBR stream fits `maxBytes`, or null. */
export function mp3BitrateFor(durationSec: number, maxBytes: number, ceilingKbps: number): number | null {
  if (!(durationSec > 0)) return null
  for (const kbps of [...MP3_ALL_BITRATES].reverse()) {
    if (kbps > ceilingKbps || kbps < MIN_MP3_KBPS) continue
    // CBR is exact; allow for the Xing header, ID3 tag and frame padding.
    if (durationSec * kbps * 125 * 1.01 + 16_384 <= maxBytes) return kbps
  }
  return null
}

/** Smallest image target worth attempting (a few KB is below any real photo). */
export const MIN_IMAGE_TARGET = 20_000

/** "10 MB", "500 KB": decimal units, matching how platforms state their limits. */
export function formatTarget(bytes: number): string {
  if (bytes >= MB) return `${Number((bytes / MB).toFixed(1))} MB`
  return `${Math.round(bytes / 1000)} KB`
}

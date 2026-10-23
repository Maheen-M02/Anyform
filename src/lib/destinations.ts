/**
 * "Convert for where it's going": each destination maps an input kind to an
 * output format and options the conversion adapters already understand. The
 * server validates the result like any other request; this catalogue only
 * picks sensible settings and names the limit the output is checked against.
 */
import type { FormatId } from './formats'
import { MB, mp3BitrateFor, videoBudget } from './size-targets'

export type DestinationKind = 'video' | 'audio' | 'image' | 'pdf'

export interface DestinationTarget {
  format: FormatId
  options: Record<string, number | string>
}

/** What a destination needs to know about the input to pick a target. */
export interface DestinationInput {
  kind: DestinationKind
  durationSec: number | null
  hasAudio: boolean
  hasAlpha: boolean
  animated: boolean
}

export interface Destination {
  id: string
  label: string
  /** One line explaining what the preset does. */
  blurb: string
  icon: 'chat' | 'mail' | 'phone' | 'globe' | 'camera' | 'print' | 'feather'
  targets: Partial<Record<DestinationKind, (input: DestinationInput) => DestinationTarget>>
}

const discordImage = (i: DestinationInput): DestinationTarget =>
  i.animated
    ? { format: 'gif', options: { maxBytes: 10 * MB } }
    : i.hasAlpha
      ? { format: 'png', options: { maxBytes: 10 * MB } }
      : { format: 'jpg', options: { quality: 'high', maxBytes: 10 * MB } }

export const DESTINATIONS: readonly Destination[] = [
  {
    id: 'discord',
    label: 'Discord',
    blurb: 'Under 10 MB, the upload limit without Nitro',
    icon: 'chat',
    targets: {
      video: () => ({ format: 'mp4', options: { mode: 'auto', quality: 'balanced', maxHeight: 'original', maxBytes: 10 * MB } }),
      audio: () => ({ format: 'mp3', options: { bitrate: 192, maxBytes: 10 * MB } }),
      image: discordImage,
    },
  },
  {
    id: 'email',
    label: 'Email',
    blurb: 'Under 20 MB, within Gmail and Outlook attachment limits',
    icon: 'mail',
    targets: {
      video: () => ({ format: 'mp4', options: { mode: 'auto', quality: 'balanced', maxHeight: 1080, maxBytes: 20 * MB } }),
      audio: () => ({ format: 'mp3', options: { bitrate: 192, maxBytes: 20 * MB } }),
      image: () => ({ format: 'jpg', options: { quality: 'high', width: 2560, height: 2560, maxBytes: 5 * MB } }),
    },
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    blurb: 'H.264 MP4 at 720p under 16 MB, plays inline in chats',
    icon: 'phone',
    targets: {
      video: () => ({ format: 'mp4', options: { mode: 'reencode', quality: 'balanced', maxHeight: 720, maxBytes: 16 * MB } }),
      audio: () => ({ format: 'mp3', options: { bitrate: 128, maxBytes: 16 * MB } }),
      image: () => ({ format: 'jpg', options: { quality: 'high', width: 1600, height: 1600 } }),
    },
  },
  {
    id: 'web',
    label: 'Website',
    blurb: 'Fast-loading: WebP under 300 KB, 1080p MP4',
    icon: 'globe',
    targets: {
      video: () => ({ format: 'mp4', options: { mode: 'reencode', quality: 'balanced', maxHeight: 1080 } }),
      audio: () => ({ format: 'mp3', options: { bitrate: 128 } }),
      image: () => ({ format: 'webp', options: { quality: 'balanced', width: 1920, height: 1920, maxBytes: 300_000 } }),
    },
  },
  {
    id: 'instagram',
    label: 'Instagram',
    blurb: '1080 px wide JPG, the width posts are shown at',
    icon: 'camera',
    targets: {
      image: () => ({ format: 'jpg', options: { quality: 'high', width: 1080 } }),
    },
  },
  {
    id: 'print',
    label: 'Print',
    blurb: 'A4 PDF with margins, ready for any printer',
    icon: 'print',
    targets: {
      image: () => ({ format: 'pdf', options: { pageSize: 'a4' } }),
    },
  },
  {
    id: 'smallest',
    label: 'Smallest file',
    blurb: 'Modern codecs at small-file settings',
    icon: 'feather',
    targets: {
      video: () => ({ format: 'webm', options: { mode: 'reencode', quality: 'small', maxHeight: 'original' } }),
      audio: () => ({ format: 'm4a', options: { bitrate: 128 } }),
      image: () => ({ format: 'avif', options: { quality: 'small' } }),
    },
  },
]

export function findDestination(id: string): Destination | undefined {
  return DESTINATIONS.find((d) => d.id === id)
}

export type DestinationPlan =
  | { ok: true; destination: Destination; target: DestinationTarget }
  | { ok: false; destination: Destination; reason: string }

/**
 * The target a destination picks for this input, or why it cannot be reached.
 * `available` lists the output formats the server offers for the file.
 */
export function planDestination(destination: Destination, input: DestinationInput, available: readonly FormatId[]): DestinationPlan | null {
  const pick = destination.targets[input.kind]
  if (!pick) return null
  const target = pick(input)
  if (!available.includes(target.format)) return { ok: false, destination, reason: 'Not available for this file' }
  const maxBytes = typeof target.options.maxBytes === 'number' ? target.options.maxBytes : null
  if (maxBytes && input.durationSec) {
    if (target.format === 'mp3') {
      if (mp3BitrateFor(input.durationSec, maxBytes, Number(target.options.bitrate ?? 192)) === null) {
        return { ok: false, destination, reason: 'Too long to fit the size limit' }
      }
    } else if (input.kind === 'video' && !videoBudget(input.durationSec, maxBytes, input.hasAudio)) {
      return { ok: false, destination, reason: 'Too long to fit the size limit' }
    }
  }
  return { ok: true, destination, target }
}

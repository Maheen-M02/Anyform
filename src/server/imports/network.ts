import { BlockList, isIP } from 'node:net'

/**
 * Address ranges an import must never reach: loopback, private, link-local
 * (including cloud metadata at 169.254.169.254), CGNAT, multicast, reserved
 * and documentation ranges, and IPv6 equivalents.
 */
const blocked = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4')
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001::', 32], // Teredo
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4 (can embed private IPv4)
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6')
}

/** IPv4 embedded in an IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::a.b.c.d) address. */
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase()
  const dotted = lower.match(/^(?:::ffff:|64:ff9b::)(?:0:)?(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) return dotted[1]!
  const hex = lower.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const hi = parseInt(hex[1]!, 16)
    const lo = parseInt(hex[2]!, 16)
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  }
  return null
}

/** True when the address is a public unicast address that imports may connect to. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, 'ipv4')
  if (family === 6) {
    const v4 = embeddedIpv4(address)
    if (v4) return isPublicAddress(v4)
    if (address.toLowerCase().startsWith('64:ff9b:')) return false
    return !blocked.check(address, 'ipv6')
  }
  return false
}

/**
 * Pages of streaming services that ANYFORM does not download from. They serve
 * players and HTML, not files, so they get a clear refusal.
 */
const STREAMING_HOSTS = [
  // YouTube and Spotify are handled by the media-site path (see media-sites.ts), not refused.
  'music.apple.com',
  'soundcloud.com',
  'tidal.com',
  'deezer.com',
  'pandora.com',
  'netflix.com',
  'primevideo.com',
  'disneyplus.com',
  'hulu.com',
  'twitch.tv',
  'tiktok.com',
  'instagram.com',
  'facebook.com',
  'x.com',
  'twitter.com',
  'vimeo.com',
  'dailymotion.com',
]

export function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

export function isStreamingHost(host: string): boolean {
  return STREAMING_HOSTS.some((d) => hostMatches(host, d))
}

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Independent ffprobe of downloaded bytes (not via the application). */
export function ffprobe(buf: Buffer, ext: string) {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'anyform-probe-')), `out.${ext}`)
  writeFileSync(file, buf)
  const out = execFileSync(process.env.FFPROBE_PATH ?? 'ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' })
  return JSON.parse(out) as {
    format: { format_name: string; duration: string; tags?: Record<string, string> }
    streams: { codec_type: string; codec_name: string; bit_rate?: string; channels?: number; sample_rate?: string; width?: number; height?: number; bits_per_raw_sample?: string; bits_per_sample?: number }[]
  }
}

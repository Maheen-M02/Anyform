import { describe, expect, it } from 'vitest'
import { registry } from '@/server/conversions'
import type { FormatId } from '@/lib/formats'

/** The full advertised conversion matrix. A change here is a product change. */
const EXPECTED: Record<string, string> = {
  mp4: 'mp4 webm mp3 wav flac m4a ogg',
  mov: 'mov mp4 webm mp3 wav flac m4a ogg',
  mkv: 'mkv mp4 webm mp3 wav flac m4a ogg',
  webm: 'webm mp4 mp3 wav flac m4a ogg',
  avi: 'avi mp4 webm mp3 wav flac m4a ogg',
  mp3: 'mp3 wav flac m4a ogg',
  wav: 'wav mp3 flac m4a ogg',
  flac: 'flac mp3 wav m4a ogg',
  m4a: 'm4a mp3 wav flac ogg',
  ogg: 'ogg mp3 wav flac m4a',
  png: 'png jpg webp gif avif tiff pdf',
  jpg: 'png jpg webp gif avif tiff pdf',
  webp: 'png jpg webp gif avif tiff pdf',
  gif: 'png jpg webp gif avif tiff pdf',
  avif: 'png jpg webp gif avif tiff pdf',
  tiff: 'png jpg webp gif avif tiff pdf',
  pdf: 'pdf txt png jpg',
  zip: 'tar tgz',
  tar: 'zip tgz',
  tgz: 'zip tar',
}

describe('conversion matrix', () => {
  it.each(Object.entries(EXPECTED))('%s → %s (direct, single-step)', (from, to) => {
    const plans = registry.reachable(from as FormatId)
    expect(plans.map((p) => p.to).sort()).toEqual(to.split(' ').sort())
    expect(plans.every((p) => p.steps.length === 1)).toBe(true)
  })

  it('advertises nothing else', () => {
    const inputs = new Set(registry.list().flatMap((a) => a.inputFormats))
    expect([...inputs].sort()).toEqual(Object.keys(EXPECTED).sort())
    expect(registry.reachable('txt')).toEqual([])
  })
})

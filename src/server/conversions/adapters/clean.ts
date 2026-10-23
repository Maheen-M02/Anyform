import { stat } from 'node:fs/promises'
import { z } from 'zod'
import { AUDIO_FORMATS, FORMATS, VIDEO_FORMATS } from '@/lib/formats'
import { AppError } from '../../errors'
import { avHidden } from '../../inspect/hidden'
import type { FileInfo, HiddenItem, PdfInfo } from '../../inspect/types'
import { canDecodeStream, inputGuardArgs, probeMedia, type MediaInfo } from '../../media/probe'
import { ToolError } from '../../media/process'
import type { ContainerFamily } from '../../media/sniff'
import { runSandbox } from '../../sandbox'
import type { ConversionAdapter } from '../types'
import { durationTolerance, mediaOf, PROGRESS_ARGS, runFfmpeg, verificationError } from './ffmpeg-common'

/**
 * Same-format "clean copies": hidden metadata is removed while the content is
 * kept bit-for-bit (audio/video streams are copied, PDFs are rewritten object
 * by object). Images are cleaned by the image adapters' same-format path.
 */

type AvFormat = (typeof VIDEO_FORMATS)[number] | (typeof AUDIO_FORMATS)[number]

const AV: Record<AvFormat, { family: ContainerFamily; muxer: string[] }> = {
  mp4: { family: 'isobmff', muxer: ['-movflags', '+faststart', '-f', 'mp4'] },
  mov: { family: 'isobmff', muxer: ['-movflags', '+faststart', '-f', 'mov'] },
  m4a: { family: 'isobmff', muxer: ['-movflags', '+faststart', '-f', 'ipod'] },
  mkv: { family: 'matroska', muxer: ['-f', 'matroska'] },
  webm: { family: 'matroska', muxer: ['-f', 'webm'] },
  avi: { family: 'avi', muxer: ['-f', 'avi'] },
  mp3: { family: 'mp3', muxer: ['-id3v2_version', '0', '-f', 'mp3'] },
  wav: { family: 'wav', muxer: ['-rf64', 'auto', '-f', 'wav'] },
  flac: { family: 'flac', muxer: ['-f', 'flac'] },
  ogg: { family: 'ogg', muxer: ['-f', 'ogg'] },
}

const noOptions = (raw: unknown): Record<string, never> => {
  if (!z.object({}).strict().safeParse(raw ?? {}).success) throw new AppError('INVALID_OPTIONS', 'Removing hidden data has no options.')
  return {}
}

function removable(info: FileInfo): HiddenItem[] {
  return (info.hidden ?? []).filter((i) => i.removable)
}

export function buildCleanArgs(format: AvFormat, inputPath: string, outputPath: string): string[] {
  return [
    ...PROGRESS_ARGS,
    ...inputGuardArgs(AV[format].family),
    '-i', `file:${inputPath}`,
    // Every stream except data tracks (phones keep timed location and sensor data there).
    '-map', '0', '-map', '-0:d?',
    '-c', 'copy',
    // Container, stream and chapter metadata; bitexact also omits the muxer's own version stamp.
    '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact',
    ...AV[format].muxer,
    `file:${outputPath}`,
  ]
}

function streamSummary(media: MediaInfo): string {
  return [...media.videoStreams.map((v) => v.codec), ...media.audioStreams.map((a) => a.codec)].join(',')
}

export function createAvCleanAdapter(format: AvFormat): ConversionAdapter<Record<string, never>> {
  const id = `clean-${format}`
  const label = FORMATS[format].label
  const { family } = AV[format]
  return {
    id,
    label: `Remove hidden data (${label})`,
    inputFormats: [format],
    outputFormat: format,
    allowSameFormat: true,
    chainable: false,
    requiredTools: ['ffmpeg', 'ffprobe'],
    lossy: false,
    notes: [
      'Audio and video are copied bit-for-bit: no quality is lost and nothing is re-encoded.',
      'Removed: container and track tags (GPS location, device, dates, titles, comments), chapters and data tracks.',
    ],
    optionFields: () => [],
    validateInput(info) {
      const media = mediaOf(info)
      if (info.format !== format) throw new AppError('UNSUPPORTED_CONVERSION', `This clean-up only accepts ${label} files.`)
      if (!(media.durationSec && media.durationSec > 0)) throw new AppError('CORRUPT_MEDIA', 'This file reports no playable duration.')
    },
    validateOptions: noOptions,
    estimate: (info) => ({ outputBytes: Math.ceil(info.sizeBytes * 1.05) + 1024 * 1024, cpuSeconds: (mediaOf(info).durationSec ?? 0) / 200 }),
    async convert(ctx) {
      await runFfmpeg(buildCleanArgs(format, ctx.inputPath, ctx.outputPath), { ...ctx, totalSec: mediaOf(ctx.info).durationSec, adapterId: id })
    },
    async verifyOutput(ctx) {
      const size = (await stat(ctx.outputPath).catch(() => null))?.size ?? 0
      if (size === 0) throw verificationError(id, 'empty output')
      let out: MediaInfo
      try {
        out = await probeMedia(ctx.outputPath, { expect: family, signal: ctx.signal })
      } catch (err) {
        if (err instanceof ToolError && err.kind === 'aborted') throw err
        throw verificationError(id, 'output not readable')
      }
      const media = mediaOf(ctx.info)
      if (out.format !== format) throw verificationError(id, `format ${out.format}`)
      if (streamSummary(out) !== streamSummary(media)) throw verificationError(id, `streams ${streamSummary(out)} != ${streamSummary(media)}`)
      const first = out.videoStreams.find((v) => !v.isAttachedPicture) ?? out.audioStreams[0]
      if (first && !(await canDecodeStream(ctx.outputPath, family, first.index, ctx.signal, 2))) throw verificationError(id, 'output not decodable')
      const expected = media.durationSec!
      const actual = out.durationSec ?? 0
      if (Math.abs(actual - expected) > durationTolerance(expected)) throw verificationError(id, `duration ${actual} != ${expected}`)
      // The promise of this conversion: location data must be gone.
      const left = avHidden(out.tags ?? [])
      if (left.some((i) => i.category === 'location')) throw verificationError(id, 'location tag survived')
      return {
        format,
        sizeBytes: size,
        durationSec: actual,
        details: { streams: out.videoStreams.length + out.audioStreams.length, encoding: 'copied (lossless)' },
        checks: [
          { label: 'Container', detail: `Re-read with ffprobe: ${label}` },
          { label: 'Streams', detail: `Same ${out.videoStreams.length + out.audioStreams.length} streams as the source (${streamSummary(out)}), copied without re-encoding` },
          { label: 'Playback', detail: 'The first 2 seconds decoded without errors' },
          { label: 'Duration', detail: `${actual.toFixed(2)} s against ${expected.toFixed(2)} s in the source` },
          { label: 'Location', detail: 'No GPS or location tags remain' },
        ],
      }
    },
  }
}

function pdfOf(info: FileInfo): PdfInfo {
  if (info.kind !== 'pdf') throw new AppError('UNSUPPORTED_CONVERSION', 'This conversion needs a PDF.')
  return info.pdf
}

export const cleanPdf: ConversionAdapter<Record<string, never>> = {
  id: 'clean-pdf',
  label: 'Remove hidden data (PDF)',
  inputFormats: ['pdf'],
  outputFormat: 'pdf',
  allowSameFormat: true,
  chainable: false,
  requiredTools: ['sandbox'],
  lossy: false,
  notes: [
    'Pages, text, images, links, bookmarks and forms are kept unchanged.',
    'Removed: author, software, dates, XMP metadata, document IDs, application private data and earlier saved revisions. Attachments are kept.',
  ],
  optionFields: () => [],
  validateInput(info) {
    const pdf = pdfOf(info)
    if (!pdf.permissions.copy || !pdf.permissions.print) {
      throw new AppError('PROTECTED_FILE', 'This PDF is encrypted with usage restrictions. Cleaning it would mean removing the encryption, which ANYFORM does not do.')
    }
  },
  validateOptions: noOptions,
  estimate: (info) => ({ outputBytes: info.sizeBytes * 2 + 1024 * 1024, cpuSeconds: pdfOf(info).pages / 50 }),
  async convert(ctx) {
    await runSandbox('clean-pdf', { input: ctx.inputPath, output: ctx.outputPath }, { timeoutMs: ctx.timeoutMs, signal: ctx.signal })
    ctx.onProgress(1)
  },
  async verifyOutput(ctx) {
    const size = (await stat(ctx.outputPath).catch(() => null))?.size ?? 0
    if (size === 0) throw verificationError('clean-pdf', 'empty output')
    const out = await runSandbox<PdfInfo & { hidden: HiddenItem[] }>(
      'inspect-pdf',
      { path: ctx.outputPath, maxPages: Number.MAX_SAFE_INTEGER },
      { timeoutMs: ctx.timeoutMs, signal: ctx.signal },
    ).catch(() => null)
    const pages = pdfOf(ctx.info).pages
    if (!out || out.pages !== pages) throw verificationError('clean-pdf', `pdf has ${out?.pages} pages, expected ${pages}`)
    const left = out.hidden.filter((i) => i.removable)
    if (left.length > 0) throw verificationError('clean-pdf', `hidden data survived: ${left.map((i) => i.label).join(', ')}`)
    return {
      format: 'pdf',
      sizeBytes: size,
      durationSec: null,
      details: { pages },
      checks: [
        { label: 'Document', detail: `Re-opened with pdf.js: all ${pages} page${pages === 1 ? '' : 's'} present` },
        { label: 'Metadata', detail: `Re-scanned: ${removable(ctx.info).length} removable item${removable(ctx.info).length === 1 ? '' : 's'} before, none after` },
      ],
    }
  },
}

export const cleanAdapters = [...VIDEO_FORMATS, ...AUDIO_FORMATS].map(createAvCleanAdapter as (f: AvFormat) => ConversionAdapter<Record<string, never>>).concat(cleanPdf)

import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import { IMAGE_FORMATS } from '@/lib/formats'
import { getConfig } from '../../config'
import { AppError } from '../../errors'
import { archiveLimits } from '../../inspect'
import type { ArchiveInfo, FileInfo, ImageInfo, PdfInfo } from '../../inspect/types'
import { runSandbox } from '../../sandbox'
import type { ConversionAdapter } from '../types'
import { verificationError } from './ffmpeg-common'
import { imageOf } from './image'

function pdfOf(info: FileInfo): PdfInfo {
  if (info.kind !== 'pdf') throw new AppError('UNSUPPORTED_CONVERSION', 'This conversion needs a PDF.')
  return info.pdf
}

function strict<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).strict()
}

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw ?? {})
  if (!parsed.success) throw new AppError('INVALID_OPTIONS', parsed.error.issues[0]?.message ?? 'Invalid conversion options.')
  return parsed.data
}

// ---------------------------------------------------------------------------

export const pdfToText: ConversionAdapter<Record<string, never>> = {
  id: 'pdf-to-txt',
  label: 'PDF to text',
  inputFormats: ['pdf'],
  outputFormat: 'txt',
  chainable: false,
  requiredTools: ['sandbox'],
  lossy: true,
  notes: [
    'Extracts the selectable text only: layout, images and fonts are not kept.',
    'Scanned PDFs (pictures of text) contain no text to extract. ANYFORM does not perform OCR.',
  ],
  optionFields: () => [],
  validateInput(info) {
    const pdf = pdfOf(info)
    if (!pdf.permissions.copy) {
      throw new AppError('PROTECTED_FILE', "The author of this PDF has disabled copying its text, and ANYFORM respects that restriction.")
    }
  },
  validateOptions: (raw) => parse(strict({}), raw) as Record<string, never>,
  estimate: (info) => ({ outputBytes: info.sizeBytes + 1024 * 1024, cpuSeconds: pdfOf(info).pages / 20 }),
  async convert(ctx) {
    await runSandbox('pdf-to-text', { input: ctx.inputPath, output: ctx.outputPath }, { timeoutMs: ctx.timeoutMs, signal: ctx.signal, onProgress: ctx.onProgress })
  },
  async verifyOutput(ctx) {
    const buf = await readFile(ctx.outputPath).catch(() => null)
    if (!buf || buf.length === 0) throw verificationError('pdf-to-txt', 'empty output')
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    } catch {
      throw verificationError('pdf-to-txt', 'output is not valid UTF-8')
    }
    const characters = text.replace(/\s+/g, '').length
    return {
      format: 'txt',
      sizeBytes: buf.length,
      durationSec: null,
      details: { pages: pdfOf(ctx.info).pages, characters },
      checks: [
        { label: 'Encoding', detail: 'Decoded as strict UTF-8 without errors' },
        { label: 'Content', detail: `${characters.toLocaleString('en-US')} non-blank characters from ${pdfOf(ctx.info).pages} pages` },
      ],
    }
  },
}

// ---------------------------------------------------------------------------

export interface PdfRenderOptions {
  pages: 'first' | 'all'
  dpi: 72 | 150 | 300
}

function createPdfToImage(output: 'png' | 'jpg'): ConversionAdapter<PdfRenderOptions> {
  const id = `pdf-to-${output}`
  return {
    id,
    label: `PDF to ${output.toUpperCase()}`,
    inputFormats: ['pdf'],
    outputFormat: output,
    chainable: false,
    requiredTools: ['sandbox'],
    lossy: output === 'jpg',
    notes: ['Each page is rendered as a picture; text in the image is no longer selectable.', 'Multiple pages are delivered as a ZIP of images.'],
    optionFields: (info) => [
      {
        key: 'pages',
        label: 'Pages',
        type: 'select',
        choices: [
          { value: 'first', label: 'First page' },
          {
            value: 'all',
            label: info?.kind === 'pdf' ? `All ${Math.min(info.pdf.pages, getConfig().maxRenderPages)} pages (ZIP)` : 'All pages (ZIP)',
          },
        ],
        default: 'first',
      },
      {
        key: 'dpi',
        label: 'Resolution',
        type: 'select',
        choices: [
          { value: 72, label: '72 DPI (screen)' },
          { value: 150, label: '150 DPI' },
          { value: 300, label: '300 DPI (print)' },
        ],
        default: 150,
      },
    ],
    validateInput(info) {
      const pdf = pdfOf(info)
      if (!pdf.permissions.print) {
        throw new AppError('PROTECTED_FILE', 'The author of this PDF has disabled printing and page extraction, and ANYFORM respects that restriction.')
      }
    },
    validateOptions: (raw, info) => {
      const o = parse(
        strict({
          pages: z.enum(['first', 'all']).default('first'),
          dpi: z.coerce
            .number()
            .refine((v): v is 72 | 150 | 300 => v === 72 || v === 150 || v === 300, { message: 'Resolution must be 72, 150 or 300 DPI' })
            .default(150),
        }),
        raw,
      ) as PdfRenderOptions
      const limit = getConfig().maxRenderPages
      if (o.pages === 'all' && pdfOf(info).pages > limit) {
        throw new AppError('INVALID_OPTIONS', `Rendering all pages is limited to ${limit} pages; this PDF has ${pdfOf(info).pages}.`)
      }
      return o
    },
    estimate: (info, o) => {
      const pages = o.pages === 'all' ? pdfOf(info).pages : 1
      // US Letter at the chosen DPI, RGBA upper bound.
      return { outputBytes: Math.ceil(pages * 8.5 * 11 * o.dpi * o.dpi * 4) + 1024 * 1024, cpuSeconds: pages / 2 }
    },
    async convert(ctx) {
      const cfg = getConfig()
      await runSandbox(
        'pdf-to-images',
        {
          input: ctx.inputPath,
          output: ctx.outputPath,
          format: output,
          dpi: ctx.options.dpi,
          allPages: ctx.options.pages === 'all',
          maxPages: cfg.maxRenderPages,
          maxPixels: cfg.maxImagePixels,
        },
        { timeoutMs: ctx.timeoutMs, signal: ctx.signal, onProgress: ctx.onProgress },
      )
    },
    async verifyOutput(ctx) {
      const size = (await stat(ctx.outputPath).catch(() => null))?.size ?? 0
      if (size === 0) throw verificationError(id, 'empty output')
      const expectedPages = ctx.options.pages === 'all' ? pdfOf(ctx.info).pages : 1
      const opts = { timeoutMs: ctx.timeoutMs, signal: ctx.signal }
      if (expectedPages > 1) {
        const zip = await runSandbox<ArchiveInfo>('inspect-archive', { path: ctx.outputPath, family: 'zip', limits: archiveLimits() }, opts).catch(() => null)
        if (!zip || zip.format !== 'zip' || zip.files !== expectedPages) throw verificationError(id, `zip has ${zip?.files} pages`)
        const details: Record<string, string | number> = { pages: expectedPages, dpi: ctx.options.dpi, images: output.toUpperCase() }
        const checks = [{ label: 'Archive', detail: `Re-listed the ZIP: ${expectedPages} page images, one per PDF page` }]
        return { format: 'zip', sizeBytes: size, durationSec: null, details, checks }
      }
      const image = await runSandbox<ImageInfo>('inspect-image', { path: ctx.outputPath, maxPixels: Number.MAX_SAFE_INTEGER }, opts).catch(() => null)
      if (!image || image.format !== output) throw verificationError(id, 'output not an image')
      return {
        format: output,
        sizeBytes: size,
        durationSec: null,
        details: { dimensions: `${image.width}×${image.height}`, dpi: ctx.options.dpi, page: 1 },
        checks: [{ label: 'Image', detail: `Re-opened with libvips: ${output.toUpperCase()}, ${image.width}×${image.height} at ${ctx.options.dpi} DPI` }],
      }
    },
  }
}

// ---------------------------------------------------------------------------

export interface ImageToPdfOptions {
  pageSize: 'original' | 'a4' | 'letter'
}

export const imageToPdf: ConversionAdapter<ImageToPdfOptions> = {
  id: 'image-to-pdf',
  label: 'Image to PDF',
  inputFormats: IMAGE_FORMATS,
  outputFormat: 'pdf',
  chainable: false,
  requiredTools: ['sandbox'],
  lossy: false,
  notes: ['Each frame of an animated image or page of a multi-page TIFF becomes a PDF page.', 'Image metadata (EXIF, GPS) is not carried into the PDF.'],
  optionFields: () => [
    {
      key: 'pageSize',
      label: 'Page size',
      type: 'select',
      choices: [
        { value: 'original', label: 'Same as image' },
        { value: 'a4', label: 'A4' },
        { value: 'letter', label: 'US Letter' },
      ],
      default: 'original',
    },
  ],
  validateInput(info) {
    const image = imageOf(info)
    if (image.width * image.height > getConfig().maxImagePixels) throw new AppError('IMAGE_TOO_LARGE', 'This image has too many pixels to process safely.')
  },
  validateOptions: (raw) => parse(strict({ pageSize: z.enum(['original', 'a4', 'letter']).default('original') }), raw),
  estimate: (info) => ({ outputBytes: info.sizeBytes * 3 + 1024 * 1024, cpuSeconds: 1 }),
  async convert(ctx) {
    const cfg = getConfig()
    await runSandbox(
      'images-to-pdf',
      { input: ctx.inputPath, output: ctx.outputPath, pageSize: ctx.options.pageSize, maxPixels: cfg.maxImagePixels, maxPages: cfg.maxRenderPages },
      { timeoutMs: ctx.timeoutMs, signal: ctx.signal, onProgress: ctx.onProgress },
    )
  },
  async verifyOutput(ctx) {
    const size = (await stat(ctx.outputPath).catch(() => null))?.size ?? 0
    if (size === 0) throw verificationError('image-to-pdf', 'empty output')
    const expected = Math.min(imageOf(ctx.info).frames, getConfig().maxRenderPages)
    const pages = await runSandbox<number>('pdf-pages', { path: ctx.outputPath }, { timeoutMs: ctx.timeoutMs, signal: ctx.signal }).catch(() => 0)
    if (pages !== expected) throw verificationError('image-to-pdf', `pdf has ${pages} pages, expected ${expected}`)
    return {
      format: 'pdf',
      sizeBytes: size,
      durationSec: null,
      details: { pages, pageSize: ctx.options.pageSize },
      checks: [{ label: 'Document', detail: `Re-opened with pdf.js: ${pages} page${pages === 1 ? '' : 's'}, one per image frame` }],
    }
  },
}

export const documentAdapters = [pdfToText, createPdfToImage('png'), createPdfToImage('jpg'), imageToPdf]

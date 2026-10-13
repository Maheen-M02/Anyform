import { createWriteStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import yazl from 'yazl'
import type { PdfInfo } from '../server/inspect/types'
import { SandboxError, type Progress } from './errors'
import { frameForPdf } from './images'

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
type PdfDoc = Awaited<ReturnType<PdfJs['getDocument']>['promise']>

let pdfjs: PdfJs | null = null
async function lib(): Promise<PdfJs> {
  pdfjs ??= await import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfjs
}

function assetDir(sub: string): string {
  const root = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  // pdf.js expects URL-style separators with a trailing slash, also on Windows.
  return path.join(root, sub).split(path.sep).join('/') + '/'
}

/**
 * Opens a PDF with font loading, XFA and network access disabled (pdf.js 6
 * has no eval-based code paths). `close` releases the document.
 */
async function open(file: string): Promise<{ doc: PdfDoc; close: () => Promise<void> }> {
  const { getDocument } = await lib()
  const data = new Uint8Array(await readFile(file))
  const task = getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    standardFontDataUrl: assetDir('standard_fonts'),
    cMapUrl: assetDir('cmaps'),
    cMapPacked: true,
    verbosity: 0,
  })
  try {
    return { doc: await task.promise, close: () => task.destroy() }
  } catch (err) {
    await task.destroy().catch(() => undefined)
    const name = (err as { name?: string }).name
    if (name === 'PasswordException') {
      throw new SandboxError('PROTECTED_FILE', 'This PDF is password-protected. ANYFORM does not remove passwords or encryption.')
    }
    throw new SandboxError('CORRUPT_MEDIA', 'This PDF could not be read. It may be damaged.')
  }
}

export async function inspectPdf(file: string, maxPages: number): Promise<PdfInfo> {
  const { PermissionFlag } = await lib()
  const { doc, close } = await open(file)
  try {
    if (doc.numPages < 1) throw new SandboxError('CORRUPT_MEDIA', 'This PDF has no pages.')
    if (doc.numPages > maxPages) throw new SandboxError('DURATION_LIMIT', `This PDF has ${doc.numPages} pages; the limit is ${maxPages}.`)
    // Fail early on documents whose first page cannot be parsed.
    await doc.getPage(1)
    const perms = await doc.getPermissions()
    const meta = await doc.getMetadata().catch(() => null)
    const title = (meta?.info as { Title?: unknown } | undefined)?.Title
    return {
      pages: doc.numPages,
      title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : null,
      permissions: {
        copy: perms === null || perms.has(PermissionFlag.COPY),
        print: perms === null || perms.has(PermissionFlag.PRINT) || perms.has(PermissionFlag.PRINT_HIGH_QUALITY),
      },
    }
  } finally {
    await close()
  }
}

export async function pdfToText(input: string, output: string, onProgress: Progress): Promise<{ pages: number; characters: number }> {
  const { doc, close } = await open(input)
  try {
    const pages: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      let text = ''
      for (const item of content.items) {
        if (!('str' in item)) continue
        text += item.str
        if (item.hasEOL) text += '\n'
      }
      pages.push(text.replace(/[ \t]+\n/g, '\n').trimEnd())
      page.cleanup()
      onProgress(i / doc.numPages)
    }
    const body = pages.join('\n\n\f\n\n') + '\n'
    const characters = body.replace(/\s+/g, '').length
    if (characters === 0) {
      throw new SandboxError('NO_TEXT_CONTENT', 'This PDF has no selectable text. It is probably scanned images; try PDF → PNG instead.')
    }
    await writeFile(output, body, 'utf8')
    return { pages: doc.numPages, characters }
  } finally {
    await close()
  }
}

export interface PdfToImagesArgs {
  input: string
  output: string
  format: 'png' | 'jpg'
  dpi: number
  allPages: boolean
  maxPages: number
  maxPixels: number
}

/** Renders one page (single image) or every page (ZIP of images). */
export async function pdfToImages(a: PdfToImagesArgs, onProgress: Progress): Promise<{ pages: number; zip: boolean; width: number; height: number }> {
  const { doc, close } = await open(a.input)
  try {
    const count = a.allPages ? doc.numPages : 1
    if (count > a.maxPages) throw new SandboxError('DURATION_LIMIT', `Rendering is limited to ${a.maxPages} pages; this PDF has ${doc.numPages}.`)
    const zip = count > 1 ? new yazl.ZipFile() : null
    const written = zip ? pipeline(zip.outputStream, createWriteStream(a.output)) : null
    let first = { width: 0, height: 0 }
    for (let i = 1; i <= count; i++) {
      const page = await doc.getPage(i)
      const viewport = page.getViewport({ scale: a.dpi / 72 })
      const width = Math.ceil(viewport.width)
      const height = Math.ceil(viewport.height)
      if (width * height > a.maxPixels) {
        throw new SandboxError('IMAGE_TOO_LARGE', `Page ${i} is too large at ${a.dpi} DPI. Choose a lower resolution.`)
      }
      const canvas = createCanvas(width, height)
      const ctx = canvas.getContext('2d')
      // PDF pages assume a white sheet; transparent output renders badly in dark viewers.
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise
      const bytes = a.format === 'png' ? await canvas.encode('png') : await canvas.encode('jpeg', 90)
      page.cleanup()
      if (i === 1) first = { width, height }
      if (zip) zip.addBuffer(bytes, `page-${String(i).padStart(3, '0')}.${a.format}`)
      else await writeFile(a.output, bytes)
      onProgress(i / count)
    }
    if (zip && written) {
      zip.end()
      await written
    }
    return { pages: count, zip: zip !== null, ...first }
  } finally {
    await close()
  }
}

const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] } as const

export interface ImagesToPdfArgs {
  input: string
  output: string
  pageSize: 'original' | 'a4' | 'letter'
  maxPixels: number
  maxPages: number
}

/** Places each frame/page of an image on its own PDF page. */
export async function imagesToPdf(a: ImagesToPdfArgs, onProgress: Progress): Promise<{ pages: number }> {
  const meta = await sharp(a.input, { limitInputPixels: a.maxPixels }).metadata()
  const frames = Math.min(meta.pages ?? 1, a.maxPages)
  const pdf = await PDFDocument.create()
  pdf.setProducer('ANYFORM')
  pdf.setCreator('ANYFORM')
  for (let i = 0; i < frames; i++) {
    const frame = await frameForPdf(a.input, i, a.maxPixels)
    const image = frame.kind === 'png' ? await pdf.embedPng(frame.bytes) : await pdf.embedJpg(frame.bytes)
    // 96 px per inch → points.
    const natural = [frame.width * 0.75, frame.height * 0.75] as const
    if (a.pageSize === 'original') {
      const page = pdf.addPage([natural[0], natural[1]])
      page.drawImage(image, { x: 0, y: 0, width: natural[0], height: natural[1] })
    } else {
      const [pw, ph] = PAGE_SIZES[a.pageSize]
      const landscape = frame.width > frame.height
      const [w, h] = landscape ? [ph, pw] : [pw, ph]
      const margin = 36
      const scale = Math.min((w - 2 * margin) / natural[0], (h - 2 * margin) / natural[1], 1)
      const dw = natural[0] * scale
      const dh = natural[1] * scale
      const page = pdf.addPage([w, h])
      page.drawImage(image, { x: (w - dw) / 2, y: (h - dh) / 2, width: dw, height: dh })
    }
    onProgress((i + 1) / frames)
  }
  await writeFile(a.output, await pdf.save())
  return { pages: frames }
}

export async function countPdfPages(file: string): Promise<number> {
  const { doc, close } = await open(file)
  try {
    return doc.numPages
  } finally {
    await close()
  }
}

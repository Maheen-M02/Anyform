import { createWriteStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createCanvas } from '@napi-rs/canvas'
import { EncryptedPDFError, PDFArray, PDFDict, PDFDocument, PDFName, type PDFObject, PDFRef, PDFStream } from 'pdf-lib'
import sharp from 'sharp'
import yazl from 'yazl'
import { dedupeHidden, formatPdfDate, hiddenItem, sortHidden } from '../server/inspect/hidden'
import type { HiddenItem, PdfInfo } from '../server/inspect/types'
import { SandboxError, type Progress } from './errors'
import { xmpHidden } from './exif'
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
async function open(file: string): Promise<{ doc: PdfDoc; close: () => Promise<void>; data: Buffer }> {
  const { getDocument } = await lib()
  const raw = await readFile(file)
  // pdf.js may take ownership of (detach) the array it is given, so it gets a copy.
  const data = new Uint8Array(raw)
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
    return { doc: await task.promise, close: () => task.destroy(), data: raw }
  } catch (err) {
    await task.destroy().catch(() => undefined)
    const name = (err as { name?: string }).name
    if (name === 'PasswordException') {
      throw new SandboxError('PROTECTED_FILE', 'This PDF is password-protected. ANYFORM does not remove passwords or encryption.')
    }
    throw new SandboxError('CORRUPT_MEDIA', 'This PDF could not be read. It may be damaged.')
  }
}

/** Saved revisions: each incremental save appends a new `%%EOF`; linearized files have one extra. */
function revisionCount(data: Buffer): number {
  let count = 0
  for (let i = data.indexOf('%%EOF'); i !== -1; i = data.indexOf('%%EOF', i + 5)) count++
  const linearized = data.subarray(0, 1024).includes('/Linearized')
  return Math.max(1, count - (linearized ? 1 : 0))
}

const INFO_FIELDS: [key: string, category: HiddenItem['category'], label: string, risk: HiddenItem['risk']][] = [
  ['Author', 'people', 'Author', 'medium'],
  ['Creator', 'software', 'Created with', 'low'],
  ['Producer', 'software', 'Produced by', 'low'],
  ['CreationDate', 'time', 'Created', 'low'],
  ['ModDate', 'time', 'Modified', 'low'],
  ['Title', 'description', 'Title', 'low'],
  ['Subject', 'description', 'Subject', 'low'],
  ['Keywords', 'description', 'Keywords', 'low'],
]

async function pdfHidden(doc: PdfDoc, data: Buffer): Promise<HiddenItem[]> {
  const items: HiddenItem[] = []
  const meta = await doc.getMetadata().catch(() => null)
  const info = (meta?.info ?? {}) as Record<string, unknown>
  for (const [key, category, label, risk] of INFO_FIELDS) {
    const value = info[key]
    if (typeof value !== 'string' || !value.trim()) continue
    items.push(hiddenItem(category, label, key.endsWith('Date') ? formatPdfDate(value) : value, risk))
  }
  const xmp = (meta?.metadata as { getRaw?: () => unknown } | null | undefined)?.getRaw?.()
  if (typeof xmp === 'string' && xmp) items.push(...xmpHidden(Buffer.from(xmp, 'utf8')))
  const revisions = revisionCount(data)
  if (revisions > 1) {
    items.push(hiddenItem('history', 'Earlier revisions', `${revisions - 1} earlier saved version${revisions > 2 ? 's' : ''} kept inside the file; deleted text may be recoverable`, 'high'))
  }
  // Part of the document itself: reported so nobody is surprised, but kept when cleaning.
  const attachments = await doc.getAttachments().catch(() => null)
  if (attachments && attachments.size > 0) {
    const names = [...attachments.values()].map((a) => (a as { filename?: string }).filename ?? '').filter(Boolean)
    items.push(hiddenItem('content', 'Attached files', `${attachments.size}${names.length ? `: ${names.slice(0, 5).join(', ')}` : ''}`, 'medium', false))
  }
  // Typed as a Map, but pdf.js returns a plain object.
  const scripts: unknown = await doc.getJSActions().catch(() => null)
  const scriptCount = scripts instanceof Map ? scripts.size : scripts && typeof scripts === 'object' ? Object.keys(scripts).length : 0
  if (scriptCount > 0) items.push(hiddenItem('content', 'JavaScript', 'document-level scripts (never run by ANYFORM)', 'medium', false))
  return sortHidden(dedupeHidden(items))
}

export async function inspectPdf(file: string, maxPages: number): Promise<PdfInfo & { hidden: HiddenItem[] }> {
  const { PermissionFlag } = await lib()
  const { doc, close, data } = await open(file)
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
      hidden: await pdfHidden(doc, data),
    }
  } finally {
    await close()
  }
}

/** Every indirect object reachable from `root`; anything else is a leftover of an earlier revision. */
function reachable(context: PDFDocument['context'], root: PDFObject): Set<PDFRef> {
  const seen = new Set<PDFRef>()
  const stack: PDFObject[] = [root]
  while (stack.length) {
    const obj = stack.pop()!
    if (obj instanceof PDFRef) {
      if (seen.has(obj)) continue
      seen.add(obj)
      const target = context.lookup(obj)
      if (target) stack.push(target)
    } else if (obj instanceof PDFDict) {
      for (const [, value] of obj.entries()) stack.push(value)
    } else if (obj instanceof PDFArray) {
      stack.push(...obj.asArray())
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict)
    }
  }
  return seen
}

/**
 * Rewrites a PDF without its document information, XMP packets, file
 * identifiers, application private data and earlier revisions. Pages,
 * bookmarks, forms and attachments are kept.
 */
export async function cleanPdf(a: { input: string; output: string }): Promise<{ pages: number }> {
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(await readFile(a.input), { updateMetadata: false })
  } catch (err) {
    if (err instanceof EncryptedPDFError) {
      throw new SandboxError('PROTECTED_FILE', 'This PDF is encrypted. Cleaning it would mean removing the encryption, which ANYFORM does not do.')
    }
    throw new SandboxError('CORRUPT_MEDIA', 'This PDF could not be read. It may be damaged.')
  }
  const { context, catalog } = doc
  const drop = (dict: PDFDict, key: string) => {
    const value = dict.get(PDFName.of(key))
    if (value instanceof PDFRef) context.delete(value)
    dict.delete(PDFName.of(key))
  }
  if (context.trailerInfo.Info instanceof PDFRef) context.delete(context.trailerInfo.Info)
  context.trailerInfo.Info = undefined
  context.trailerInfo.ID = undefined
  drop(catalog, 'Metadata')
  drop(catalog, 'PieceInfo')
  for (const page of doc.getPages()) {
    drop(page.node, 'Metadata')
    drop(page.node, 'PieceInfo')
  }
  const keep = reachable(context, context.trailerInfo.Root!)
  for (const [ref] of context.enumerateIndirectObjects()) if (!keep.has(ref)) context.delete(ref)
  await writeFile(a.output, await doc.save())
  return { pages: doc.getPageCount() }
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
  // No producer, creator or dates: the PDF says nothing about who made it, or when.
  const pdf = await PDFDocument.create({ updateMetadata: false })
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

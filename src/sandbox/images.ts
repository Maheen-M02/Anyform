import { writeFile } from 'node:fs/promises'
import sharp, { type Metadata, type Sharp, type SharpOptions } from 'sharp'
import type { HiddenItem, ImageInfo } from '../server/inspect/types'
import { SandboxError } from './errors'
import { imageHidden } from './exif'

sharp.cache(false)

type ImageFormat = ImageInfo['format']

function formatOf(meta: Metadata): ImageFormat {
  switch (meta.format) {
    case 'png':
      return 'png'
    case 'jpeg':
      return 'jpg'
    case 'webp':
      return 'webp'
    case 'gif':
      return 'gif'
    case 'tiff':
      return 'tiff'
    case 'heif':
      if (meta.compression === 'av1') return 'avif'
      throw new SandboxError('UNSUPPORTED_FORMAT', 'HEIC/HEIF images are not supported yet. AVIF is.')
    default:
      throw new SandboxError('UNSUPPORTED_FORMAT', 'This image format is not supported.')
  }
}

function decodeOptions(maxPixels: number, extra: SharpOptions = {}): SharpOptions {
  return { limitInputPixels: maxPixels, failOn: 'error', sequentialRead: true, ...extra }
}

function mapSharpError(err: unknown): never {
  if (err instanceof SandboxError) throw err
  const msg = err instanceof Error ? err.message : String(err)
  if (/pixel limit/i.test(msg)) throw new SandboxError('IMAGE_TOO_LARGE', 'This image has too many pixels to process safely.')
  throw new SandboxError('CORRUPT_MEDIA', 'This image could not be read. It may be corrupted or incomplete.')
}

export async function inspectImage(path: string, maxPixels: number): Promise<ImageInfo & { hidden: HiddenItem[] }> {
  let meta: Metadata
  try {
    meta = await sharp(path, { limitInputPixels: false }).metadata()
  } catch (err) {
    mapSharpError(err)
  }
  const format = formatOf(meta)
  // Dimensions as displayed: EXIF orientation applied (portrait phone photos), per frame for animations.
  const multiFrame = (meta.pages ?? 1) > 1
  const width = (multiFrame ? meta.width : meta.autoOrient?.width ?? meta.width) ?? 0
  const height = (multiFrame ? meta.pageHeight ?? meta.height : meta.autoOrient?.height ?? meta.height) ?? 0
  if (!width || !height) throw new SandboxError('CORRUPT_MEDIA', 'This image has no readable dimensions.')
  if (width * height > maxPixels) {
    throw new SandboxError('IMAGE_TOO_LARGE', `This image is ${width}×${height}, which exceeds the ${Math.round(maxPixels / 1e6)}-megapixel limit.`)
  }
  // Decode for real (downscaled) rather than trusting the header.
  try {
    await sharp(path, decodeOptions(maxPixels)).resize(32, 32, { fit: 'inside' }).toBuffer()
  } catch (err) {
    mapSharpError(err)
  }
  return {
    format,
    width,
    height,
    frames: meta.pages ?? 1,
    hasAlpha: meta.hasAlpha ?? false,
    colorSpace: meta.space ?? null,
    hidden: imageHidden({ exif: meta.exif, xmp: meta.xmp, iptc: meta.iptc, comments: meta.comments }),
  }
}

export interface ConvertImageArgs {
  input: string
  output: string
  format: ImageFormat
  width?: number
  height?: number
  quality: number
  /** Keep all frames (GIF/WebP output from an animated source). */
  animated: boolean
  maxPixels: number
  /** Upper bound for the output size: quality, then dimensions, are reduced until it fits. */
  maxBytes?: number
}

const LOSSY_QUALITY_STEPS: Partial<Record<ImageFormat, number[]>> = {
  jpg: [75, 65, 55, 45, 38],
  webp: [75, 65, 55, 45, 38],
  avif: [45, 38, 32, 26],
}
/** Re-encodes allowed while searching for a size target (each one is a full encode). */
const MAX_SIZE_ATTEMPTS = 12
const MIN_SIDE = 16

function encodeAs(img: Sharp, format: ImageFormat, quality: number): Sharp {
  switch (format) {
    case 'jpg':
      return img.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true })
    case 'png':
      return img.png({ compressionLevel: 6 })
    case 'webp':
      return img.webp({ quality, effort: 4 })
    case 'avif':
      return img.avif({ quality, effort: 4 })
    case 'gif':
      return img.gif({ effort: 7 })
    case 'tiff':
      return img.tiff({ compression: 'lzw' })
  }
}

export async function convertImage(a: ConvertImageArgs): Promise<{ width: number; height: number; quality: number }> {
  try {
    const pipeline = (box: { width?: number; height?: number }, quality: number) => {
      let img = sharp(a.input, decodeOptions(a.maxPixels, a.animated ? { animated: true } : { pages: 1 }))
        // Apply EXIF orientation, then all metadata (EXIF/GPS/XMP) is dropped by default.
        .rotate()
      if (box.width || box.height) img = img.resize({ width: box.width, height: box.height, fit: 'inside', withoutEnlargement: true })
      return encodeAs(img, a.format, quality)
    }
    let quality = a.quality
    if (!a.maxBytes) {
      await pipeline({ width: a.width, height: a.height }, quality).toFile(a.output)
    } else {
      await writeFile(a.output, await fitToSize(a, pipeline, (q) => (quality = q)))
    }
    const out = await sharp(a.output).metadata()
    return { width: out.width ?? 0, height: out.pageHeight ?? out.height ?? 0, quality }
  } catch (err) {
    mapSharpError(err)
  }
}

/** Lowers quality first (lossy formats), then scales down, until the encoded image fits `maxBytes`. */
async function fitToSize(
  a: ConvertImageArgs,
  pipeline: (box: { width?: number; height?: number }, quality: number) => Sharp,
  onQuality: (q: number) => void,
): Promise<Buffer> {
  const maxBytes = a.maxBytes!
  const steps = [a.quality, ...(LOSSY_QUALITY_STEPS[a.format] ?? []).filter((q) => q < a.quality)]
  // Displayed size after orientation and the requested box.
  const meta = await sharp(a.input, { limitInputPixels: a.maxPixels }).metadata()
  const multiFrame = (meta.pages ?? 1) > 1
  const srcWidth = (multiFrame ? meta.width : meta.autoOrient?.width ?? meta.width) ?? 1
  const srcHeight = (multiFrame ? meta.pageHeight ?? meta.height : meta.autoOrient?.height ?? meta.height) ?? 1
  const scale0 = Math.min(1, a.width ? a.width / srcWidth : 1, a.height ? a.height / srcHeight : 1)
  let width = Math.max(1, Math.round(srcWidth * scale0))
  let height = Math.max(1, Math.round(srcHeight * scale0))
  let attempts = 0
  let qualityIndex = 0
  while (attempts++ < MAX_SIZE_ATTEMPTS) {
    const quality = steps[qualityIndex]!
    const buf = await pipeline({ width, height }, quality).toBuffer()
    if (buf.length <= maxBytes) {
      onQuality(quality)
      return buf
    }
    if (qualityIndex < steps.length - 1) {
      qualityIndex++
      continue
    }
    // Lowest quality still too big: shrink by the overshoot (bytes scale roughly with area).
    const factor = Math.min(0.9, Math.sqrt(maxBytes / buf.length) * 0.95)
    width = Math.round(width * factor)
    height = Math.round(height * factor)
    if (width < MIN_SIDE || height < MIN_SIDE) break
  }
  throw new SandboxError('SIZE_TARGET_UNREACHABLE', `This image could not be made smaller than ${Math.round(maxBytes / 1000)} KB in this format. Choose a larger size or a more compact format such as WebP or AVIF.`)
}

/** Frame `index` of an image as PNG (alpha) or JPEG bytes, for embedding in a PDF. */
export async function frameForPdf(input: string, index: number, maxPixels: number): Promise<{ bytes: Buffer; kind: 'png' | 'jpg'; width: number; height: number }> {
  try {
    const base = sharp(input, decodeOptions(maxPixels, { page: index, pages: 1 })).rotate()
    const meta = await base.clone().metadata()
    const alpha = meta.hasAlpha ?? false
    const { data, info } = alpha
      ? await base.png({ compressionLevel: 6 }).toBuffer({ resolveWithObject: true })
      : await base.flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true })
    return { bytes: data, kind: alpha ? 'png' : 'jpg', width: info.width, height: info.height }
  } catch (err) {
    mapSharpError(err)
  }
}

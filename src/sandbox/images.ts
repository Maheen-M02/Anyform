import sharp, { type Metadata, type SharpOptions } from 'sharp'
import type { ImageInfo } from '../server/inspect/types'
import { SandboxError } from './errors'

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

export async function inspectImage(path: string, maxPixels: number): Promise<ImageInfo> {
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
}

export async function convertImage(a: ConvertImageArgs): Promise<{ width: number; height: number }> {
  try {
    let img = sharp(a.input, decodeOptions(a.maxPixels, a.animated ? { animated: true } : { pages: 1 }))
      // Apply EXIF orientation, then all metadata (EXIF/GPS/XMP) is dropped by default.
      .rotate()
    if (a.width || a.height) {
      img = img.resize({ width: a.width, height: a.height, fit: 'inside', withoutEnlargement: true })
    }
    switch (a.format) {
      case 'jpg':
        img = img.flatten({ background: '#ffffff' }).jpeg({ quality: a.quality, mozjpeg: true })
        break
      case 'png':
        img = img.png({ compressionLevel: 6 })
        break
      case 'webp':
        img = img.webp({ quality: a.quality, effort: 4 })
        break
      case 'avif':
        img = img.avif({ quality: a.quality, effort: 4 })
        break
      case 'gif':
        img = img.gif({ effort: 7 })
        break
      case 'tiff':
        img = img.tiff({ compression: 'lzw' })
        break
    }
    await img.toFile(a.output)
    const out = await sharp(a.output).metadata()
    return { width: out.width ?? 0, height: out.pageHeight ?? out.height ?? 0 }
  } catch (err) {
    mapSharpError(err)
  }
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

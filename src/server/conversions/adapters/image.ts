import { stat } from 'node:fs/promises'
import { z } from 'zod'
import { FORMATS, IMAGE_FORMATS } from '@/lib/formats'
import { getConfig } from '../../config'
import { AppError } from '../../errors'
import type { FileInfo, ImageInfo } from '../../inspect/types'
import { runSandbox } from '../../sandbox'
import type { ConversionAdapter, OptionField } from '../types'
import { verificationError } from './ffmpeg-common'

export type ImageOutput = (typeof IMAGE_FORMATS)[number]

const QUALITY: Record<'high' | 'balanced' | 'small', { standard: number; avif: number }> = {
  high: { standard: 90, avif: 70 },
  balanced: { standard: 80, avif: 55 },
  small: { standard: 65, avif: 40 },
}
const LOSSY: readonly ImageOutput[] = ['jpg', 'webp', 'avif', 'gif']
const ANIMATED_OUTPUTS: readonly ImageOutput[] = ['gif', 'webp']
/** Largest dimension each encoder accepts. */
const MAX_DIMENSION: Record<ImageOutput, number> = { png: 100_000, jpg: 65_500, webp: 16_383, gif: 65_535, avif: 16_384, tiff: 100_000 }
const MAX_REQUESTED = 20_000

export interface ImageOptions {
  width: number | null
  height: number | null
  quality: keyof typeof QUALITY
}

export function imageOf(info: FileInfo): ImageInfo {
  if (info.kind !== 'image') throw new AppError('UNSUPPORTED_CONVERSION', 'This conversion needs an image.')
  return info.image
}

/** Output size for "fit inside the box, never enlarge". */
export function fitInside(width: number, height: number, maxW: number | null, maxH: number | null): { width: number; height: number } {
  const scale = Math.min(maxW ? maxW / width : Infinity, maxH ? maxH / height : Infinity, 1)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** Animation survives only between animated sources and animated-capable outputs. */
export function keepsAnimation(image: ImageInfo, output: ImageOutput): boolean {
  return image.frames > 1 && (image.format === 'gif' || image.format === 'webp') && ANIMATED_OUTPUTS.includes(output)
}

const optionalDimension = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? null : v),
  z.coerce.number().int('Dimensions must be whole numbers.').min(1).max(MAX_REQUESTED).nullable(),
)

export function createImageAdapter(output: ImageOutput): ConversionAdapter<ImageOptions> {
  const label = FORMATS[output].label
  const id = `image-to-${output}`
  const lossy = LOSSY.includes(output)
  const schema = z
    .object({
      width: optionalDimension.default(null),
      height: optionalDimension.default(null),
      quality: z.enum(['high', 'balanced', 'small']).default('balanced'),
    })
    .strict()

  return {
    id,
    label: `Image to ${label}`,
    inputFormats: IMAGE_FORMATS,
    outputFormat: output,
    allowSameFormat: true,
    requiredTools: ['sandbox'],
    lossy,
    notes: [
      'Metadata such as EXIF, camera details and GPS location is removed. Orientation is applied and colours are converted to sRGB.',
      ...(output === 'jpg' ? ['JPG has no transparency: transparent areas become white.'] : []),
      ...(output === 'gif' ? ['GIF is limited to 256 colours per frame.'] : []),
      ANIMATED_OUTPUTS.includes(output)
        ? 'Animated GIF/WebP sources stay animated.'
        : 'Animated images and multi-page TIFFs keep only their first frame.',
    ],

    optionFields(info) {
      const image = info?.kind === 'image' ? info.image : null
      const fields: OptionField[] = [
        {
          key: 'width',
          label: 'Max width',
          type: 'number',
          min: 1,
          max: MAX_REQUESTED,
          unit: 'px',
          placeholder: image ? String(image.width) : 'original',
          help: 'Leave blank to keep the original size. Aspect ratio is kept and images are never enlarged.',
        },
        { key: 'height', label: 'Max height', type: 'number', min: 1, max: MAX_REQUESTED, unit: 'px', placeholder: image ? String(image.height) : 'original' },
      ]
      if (output === 'jpg' || output === 'webp' || output === 'avif') {
        fields.push({
          key: 'quality',
          label: 'Quality',
          type: 'select',
          choices: [
            { value: 'high', label: 'High' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'small', label: 'Small file' },
          ],
          default: 'balanced',
        })
      }
      return fields
    },

    validateInput(info) {
      const image = imageOf(info)
      if (!IMAGE_FORMATS.includes(image.format)) throw new AppError('UNSUPPORTED_CONVERSION', 'This image format is not supported.')
      if (image.width * image.height > getConfig().maxImagePixels) {
        throw new AppError('IMAGE_TOO_LARGE', 'This image has too many pixels to process safely.')
      }
    },

    validateOptions(raw, info) {
      const image = imageOf(info)
      const parsed = schema.safeParse(raw ?? {})
      if (!parsed.success) throw new AppError('INVALID_OPTIONS', parsed.error.issues[0]?.message ?? 'Invalid conversion options.')
      const target = fitInside(image.width, image.height, parsed.data.width, parsed.data.height)
      const limit = MAX_DIMENSION[output]
      if (target.width > limit || target.height > limit) {
        throw new AppError('INVALID_OPTIONS', `${label} images can be at most ${limit} pixels wide or high. Set a smaller width or height.`)
      }
      return parsed.data
    },

    estimate(info, options) {
      const image = imageOf(info)
      const t = fitInside(image.width, image.height, options.width, options.height)
      const frames = keepsAnimation(image, output) ? image.frames : 1
      return { outputBytes: t.width * t.height * 4 * frames + 1024 * 1024, cpuSeconds: (t.width * t.height * frames) / 20e6 }
    },

    async convert(ctx) {
      const image = imageOf(ctx.info)
      const q = QUALITY[ctx.options.quality]
      await runSandbox(
        'convert-image',
        {
          input: ctx.inputPath,
          output: ctx.outputPath,
          format: output,
          width: ctx.options.width ?? undefined,
          height: ctx.options.height ?? undefined,
          quality: output === 'avif' ? q.avif : q.standard,
          animated: keepsAnimation(image, output),
          maxPixels: getConfig().maxImagePixels,
        },
        { timeoutMs: ctx.timeoutMs, signal: ctx.signal },
      )
      ctx.onProgress(1)
    },

    async verifyOutput(ctx) {
      const size = (await stat(ctx.outputPath).catch(() => null))?.size ?? 0
      if (size === 0) throw verificationError(id, 'empty output')
      const image = imageOf(ctx.info)
      let out: ImageInfo
      try {
        out = await runSandbox<ImageInfo>('inspect-image', { path: ctx.outputPath, maxPixels: Number.MAX_SAFE_INTEGER }, { timeoutMs: ctx.timeoutMs, signal: ctx.signal })
      } catch {
        throw verificationError(id, 'output not readable')
      }
      const expected = fitInside(image.width, image.height, ctx.options.width, ctx.options.height)
      if (out.format !== output) throw verificationError(id, `format ${out.format}`)
      if (Math.abs(out.width - expected.width) > 1 || Math.abs(out.height - expected.height) > 1) {
        throw verificationError(id, `size ${out.width}x${out.height} != ${expected.width}x${expected.height}`)
      }
      const details: Record<string, string | number> = { dimensions: `${out.width}×${out.height}` }
      if (out.frames > 1) details.frames = out.frames
      if (lossy && output !== 'gif') details.quality = ctx.options.quality
      return { format: output, sizeBytes: size, durationSec: null, details }
    },
  }
}

export const imageAdapters = IMAGE_FORMATS.map(createImageAdapter)

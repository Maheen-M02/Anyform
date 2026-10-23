import { stat } from 'node:fs/promises'
import { getConfig } from '../config'
import { AppError } from '../errors'
import { canDecodeStream, probeMedia } from '../media/probe'
import { FAMILY_KIND, readHead, sniffBytes, type ContainerFamily } from '../media/sniff'
import { runSandbox } from '../sandbox'
import { avHidden } from './hidden'
import type { ArchiveInfo, FileInfo, HiddenItem, ImageInfo, PdfInfo } from './types'

export type { FileInfo } from './types'

/** Audio streams beyond this count are listed but not offered (decode-testing is bounded). */
const MAX_TESTED_AUDIO_STREAMS = 8

/**
 * Establishes what a stored file really is. The magic-byte family decides
 * which parser may touch it: FFprobe for audio/video, and the sandbox process
 * for images, PDFs and archives.
 */
export async function inspectFile(filePath: string, opts: { signal?: AbortSignal; decodeTest?: boolean } = {}): Promise<FileInfo> {
  const cfg = getConfig()
  const family = sniffBytes(await readHead(filePath))
  if (!family) {
    throw new AppError('UNSUPPORTED_FORMAT', 'This file type is not supported. Its contents do not match any format ANYFORM can read.')
  }
  const sizeBytes = (await stat(filePath)).size
  const sandbox = { timeoutMs: cfg.probeTimeoutMs * 2, signal: opts.signal }

  switch (FAMILY_KIND[family]) {
    case 'av': {
      const media = await probeMedia(filePath, { signal: opts.signal, expect: family })
      if (opts.decodeTest !== false) {
        for (const s of media.audioStreams) {
          s.decodable = s.ordinal < MAX_TESTED_AUDIO_STREAMS ? await canDecodeStream(filePath, family, s.index, opts.signal) : false
        }
        const video = media.videoStreams.find((v) => !v.isAttachedPicture)
        if (video) video.decodable = await canDecodeStream(filePath, family, video.index, opts.signal, 2)
      }
      return { kind: 'av', family, format: media.format, sizeBytes, media, hidden: avHidden(media.tags ?? []) }
    }
    case 'image': {
      const { hidden, ...image } = await runSandbox<ImageInfo & { hidden: HiddenItem[] }>('inspect-image', { path: filePath, maxPixels: cfg.maxImagePixels }, sandbox)
      return { kind: 'image', family, format: image.format, sizeBytes, image, hidden }
    }
    case 'pdf': {
      const { hidden, ...pdf } = await runSandbox<PdfInfo & { hidden: HiddenItem[] }>('inspect-pdf', { path: filePath, maxPages: cfg.maxPdfPages }, sandbox)
      return { kind: 'pdf', family, format: 'pdf', sizeBytes, pdf, hidden }
    }
    case 'archive': {
      const archive = await runSandbox<ArchiveInfo>(
        'inspect-archive',
        { path: filePath, family: family as Extract<ContainerFamily, 'zip' | 'gzip' | 'tar'>, limits: archiveLimits() },
        sandbox,
      )
      return { kind: 'archive', family, format: archive.format, sizeBytes, archive, hidden: [] }
    }
  }
}

export function archiveLimits() {
  const cfg = getConfig()
  return { maxEntries: cfg.maxArchiveEntries, maxUnpackedBytes: cfg.maxArchiveUnpackedBytes }
}

/** A human-readable reason why a readable file still has no supported format. */
export function unsupportedReason(info: FileInfo): string {
  if (info.kind === 'archive' && info.archive.documentType === 'office') {
    return 'This is an Office document (DOCX/XLSX/PPTX). Office formats are not supported yet.'
  }
  if (info.kind === 'archive' && info.archive.documentType === 'epub') return 'EPUB e-books are not supported yet.'
  if (info.kind === 'archive' && info.family === 'gzip') return 'Only .tar.gz archives are supported. This is a plain gzip file.'
  if (info.kind === 'av') return `This media container (${info.media.formatName}) is not supported yet.`
  return 'This file type is not supported yet.'
}

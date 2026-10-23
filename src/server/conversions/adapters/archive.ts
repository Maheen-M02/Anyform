import { stat } from 'node:fs/promises'
import { z } from 'zod'
import { ARCHIVE_FORMATS, FORMATS } from '@/lib/formats'
import { AppError } from '../../errors'
import { archiveLimits } from '../../inspect'
import type { ArchiveInfo, FileInfo } from '../../inspect/types'
import { runSandbox } from '../../sandbox'
import type { ConversionAdapter } from '../types'
import { verificationError } from './ffmpeg-common'

export type ArchiveOutput = (typeof ARCHIVE_FORMATS)[number]

const FAMILY: Record<ArchiveOutput, 'zip' | 'tar' | 'gzip'> = { zip: 'zip', tar: 'tar', tgz: 'gzip' }

function archiveOf(info: FileInfo): ArchiveInfo {
  if (info.kind !== 'archive') throw new AppError('UNSUPPORTED_CONVERSION', 'This conversion needs an archive.')
  return info.archive
}

export function createArchiveAdapter(output: ArchiveOutput): ConversionAdapter<Record<string, never>> {
  const id = `archive-to-${output}`
  const label = FORMATS[output].label
  const inputFormats = ARCHIVE_FORMATS.filter((f) => f !== output)
  return {
    id,
    label: `Archive to ${label}`,
    inputFormats,
    outputFormat: output,
    requiredTools: ['sandbox'],
    lossy: false,
    notes: [
      'Files and folders are repacked byte-for-byte; nothing is extracted to disk.',
      'Symbolic links, devices and other special entries are skipped. Owner/group information is not kept.',
    ],
    optionFields: () => [],
    validateInput(info) {
      const a = archiveOf(info)
      if (!a.format || !inputFormats.includes(a.format)) throw new AppError('UNSUPPORTED_CONVERSION', `${label} conversion does not accept this file.`)
      if (a.encrypted) throw new AppError('PROTECTED_FILE', 'This archive is encrypted. ANYFORM does not remove encryption.')
      if (a.unsafePaths) throw new AppError('UNSAFE_ARCHIVE', 'This archive contains entries with unsafe paths (absolute or "..") and was refused.')
      if (a.files === 0 && a.directories === 0) throw new AppError('CORRUPT_MEDIA', 'This archive is empty.')
    },
    validateOptions(raw) {
      const parsed = z.object({}).strict().safeParse(raw ?? {})
      if (!parsed.success) throw new AppError('INVALID_OPTIONS', 'This conversion has no options.')
      return {}
    },
    estimate: (info) => ({ outputBytes: archiveOf(info).unpackedBytes + 1024 * 1024 + archiveOf(info).files * 1024, cpuSeconds: archiveOf(info).unpackedBytes / 50e6 }),
    async convert(ctx) {
      const a = archiveOf(ctx.info)
      await runSandbox(
        'convert-archive',
        { input: ctx.inputPath, inputFormat: a.format, output: ctx.outputPath, outputFormat: output, limits: archiveLimits(), expectedBytes: a.unpackedBytes },
        { timeoutMs: ctx.timeoutMs, signal: ctx.signal, onProgress: ctx.onProgress },
      )
    },
    async verifyOutput(ctx) {
      const size = (await stat(ctx.outputPath).catch(() => null))?.size ?? 0
      if (size === 0) throw verificationError(id, 'empty output')
      const src = archiveOf(ctx.info)
      const out = await runSandbox<ArchiveInfo>(
        'inspect-archive',
        { path: ctx.outputPath, family: FAMILY[output], limits: archiveLimits() },
        { timeoutMs: ctx.timeoutMs, signal: ctx.signal },
      ).catch(() => null)
      if (!out || out.format !== output) throw verificationError(id, 'output not readable')
      if (out.files !== src.files || out.unpackedBytes !== src.unpackedBytes) {
        throw verificationError(id, `content mismatch: ${out.files}/${out.unpackedBytes} vs ${src.files}/${src.unpackedBytes}`)
      }
      const details: Record<string, string | number> = { files: out.files, folders: out.directories, unpackedBytes: out.unpackedBytes }
      if (src.skipped) details.skipped = src.skipped
      const checks = [
        { label: 'Archive', detail: `Re-listed the ${label} without extracting it` },
        { label: 'Contents', detail: `${out.files} files and ${out.unpackedBytes.toLocaleString('en-US')} bytes, identical to the source` },
      ]
      return { format: output, sizeBytes: size, durationSec: null, details, checks }
    },
  }
}

export const archiveAdapters = ARCHIVE_FORMATS.map(createArchiveAdapter)

/**
 * Facts established by inspecting a file's real contents. Shared by the server
 * and the sandbox process, so this module must stay dependency-free.
 */
import type { FormatId } from '@/lib/formats'
import type { MediaInfo } from '../media/probe'
import type { ContainerFamily } from '../media/sniff'

export interface ImageInfo {
  format: 'png' | 'jpg' | 'webp' | 'gif' | 'avif' | 'tiff'
  width: number
  height: number
  /** Frames (animated GIF/WebP) or pages (multi-page TIFF). */
  frames: number
  hasAlpha: boolean
  colorSpace: string | null
}

export interface PdfInfo {
  pages: number
  title: string | null
  /** Author-imposed restrictions. ANYFORM honours them rather than bypassing them. */
  permissions: { copy: boolean; print: boolean }
}

export interface ArchiveInfo {
  format: 'zip' | 'tar' | 'tgz' | null
  /** Set when a ZIP is really an Office document or EPUB (not converted as an archive). */
  documentType: 'office' | 'epub' | null
  files: number
  directories: number
  /** Symlinks, devices and other special entries, which are never copied. */
  skipped: number
  unpackedBytes: number
  encrypted: boolean
  /** Entries with absolute paths or `..` segments. */
  unsafePaths: boolean
}

/** What a piece of hidden data reveals about the person who made the file. */
export type HiddenCategory = 'location' | 'device' | 'people' | 'time' | 'software' | 'history' | 'description' | 'content'

/**
 * Data carried inside a file that its viewer does not normally see (EXIF GPS,
 * camera serial numbers, PDF authors, edit history…). Values are shown to the
 * file's owner only and are truncated.
 */
export interface HiddenItem {
  category: HiddenCategory
  label: string
  value: string
  risk: 'high' | 'medium' | 'low'
  /** False for things that are part of the content itself (e.g. PDF attachments), which cleaning keeps. */
  removable: boolean
}

interface Base {
  family: ContainerFamily
  /** Identified format, or null when readable but not a format we support. */
  format: FormatId | null
  sizeBytes: number
  /** Hidden metadata found in the file. Absent on records created before the scan existed. */
  hidden?: HiddenItem[]
}

export type FileInfo =
  | (Base & { kind: 'av'; media: MediaInfo })
  | (Base & { kind: 'image'; image: ImageInfo })
  | (Base & { kind: 'pdf'; pdf: PdfInfo })
  | (Base & { kind: 'archive'; archive: ArchiveInfo })

export type FileKind = FileInfo['kind']

/** Errors raised inside the sandbox carry a stable code back to the server. */
export interface SandboxErrorPayload {
  code: string
  message: string
}

export interface ArchiveLimits {
  maxEntries: number
  maxUnpackedBytes: number
}

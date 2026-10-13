const MAX_BASE_LENGTH = 120

/**
 * Derives a safe display/download filename from an untrusted original name.
 * The result never contains path separators, control characters or characters
 * reserved on common filesystems, and is never empty.
 */
export function safeBaseName(original: string): string {
  // Only the final path segment counts; browsers on some platforms send full paths.
  const lastSegment = original.split(/[\\/]/).pop() ?? ''
  const withoutExt = /\.tar\.gz$/i.test(lastSegment) ? lastSegment.slice(0, -'.tar.gz'.length) : lastSegment.replace(/\.[^.]{1,10}$/, '')
  const cleaned = withoutExt
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
  const truncated = Array.from(cleaned).slice(0, MAX_BASE_LENGTH).join('').trim()
  if (!truncated || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(truncated)) return 'anyform-output'
  return truncated
}

export function outputFilename(original: string, extension: string): string {
  return `${safeBaseName(original)}.${extension}`
}

/** Sanitises a client-supplied filename for display and storage in metadata. */
export function displayFilename(original: string): string {
  const lastSegment = original.split(/[\\/]/).pop() ?? ''
  const cleaned = lastSegment.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return Array.from(cleaned).slice(0, 255).join('') || 'upload'
}

/** RFC 6266 Content-Disposition value with an ASCII fallback and UTF-8 form. */
export function contentDisposition(filename: string, type: 'attachment' | 'inline' = 'attachment'): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

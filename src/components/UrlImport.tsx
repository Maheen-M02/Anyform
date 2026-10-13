'use client'

import { useState } from 'react'
import { Button, cx } from './ui'

/** Import a file from a direct link. The server downloads it under SSRF protections. */
export function UrlImport({ onSubmit, disabled, compact }: { onSubmit: (url: string) => void; disabled?: boolean; compact?: boolean }) {
  const [url, setUrl] = useState('')
  const valid = /^https?:\/\/\S+$/i.test(url.trim())

  return (
    <form
      className={cx('rounded-2xl border border-line bg-surface', compact ? 'p-3' : 'p-4')}
      onSubmit={(e) => {
        e.preventDefault()
        if (valid && !disabled) onSubmit(url.trim())
      }}
    >
      <label htmlFor={compact ? 'url-import-compact' : 'url-import'} className="font-mono text-[11px] tracking-wider text-faint uppercase">
        Or import from a link
      </label>
      <div className="mt-2 flex gap-2">
        <input
          id={compact ? 'url-import-compact' : 'url-import'}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://example.com/files/video.mov"
          value={url}
          disabled={disabled}
          onChange={(e) => setUrl(e.target.value)}
          className="h-10 min-w-0 flex-1 rounded-xl border border-line-strong bg-ink px-3 font-mono text-sm text-fg placeholder:text-faint disabled:opacity-60"
        />
        <Button type="submit" variant="secondary" disabled={disabled || !valid}>
          Import
        </Button>
      </div>
      {!compact && (
        <p className="mt-2 text-xs text-faint">
          Direct links to files only. Streaming sites such as YouTube or Spotify are not supported. Only import files you have the right to use.
        </p>
      )}
    </form>
  )
}

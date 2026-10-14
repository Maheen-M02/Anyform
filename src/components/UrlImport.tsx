'use client'

import { useState } from 'react'
import { Spotlight } from './motion/Spotlight'
import { Button, cx } from './ui'

/** Paste a link to a file (or a page with one); the server downloads it under SSRF protections. */
export function UrlImport({ onSubmit, disabled, compact }: { onSubmit: (url: string) => void; disabled?: boolean; compact?: boolean }) {
  const [url, setUrl] = useState('')
  const valid = /^https?:\/\/\S+\.\S+$/i.test(url.trim())
  const id = compact ? 'url-import-compact' : 'url-import'

  return (
    <Spotlight className={cx('rounded-2xl border border-line bg-surface transition-colors duration-300 focus-within:border-accent/40', compact ? 'p-3' : 'p-4')}>
      <form
        className="relative z-10"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid && !disabled) onSubmit(url.trim())
        }}
      >
        <label htmlFor={id} className="flex items-center gap-2 font-mono text-[11px] tracking-wider text-faint uppercase">
          <span className="h-px w-4 bg-line-strong" aria-hidden />
          Or paste a link
        </label>
        <div className="group/input mt-2 flex gap-2">
          <div className="relative min-w-0 flex-1">
            <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint transition-colors group-focus-within/input:text-accent">
              <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <input
              id={id}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="YouTube, Spotify, an image or any file link"
              value={url}
              disabled={disabled}
              onChange={(e) => setUrl(e.target.value)}
              className="h-11 w-full rounded-xl border border-line-strong bg-ink pr-3 pl-9 text-sm text-fg transition-[border-color,box-shadow] duration-200 placeholder:text-faint focus:border-accent/60 focus:shadow-[0_0_0_4px_rgba(200,245,60,0.08)] focus:outline-none disabled:opacity-60"
            />
          </div>
          <Button
            type="submit"
            variant={valid ? 'primary' : 'secondary'}
            disabled={disabled || !valid}
            className={cx('h-11 transition-all duration-300', valid && 'shadow-[0_8px_24px_-10px_rgba(200,245,60,0.7)]')}
          >
            Get file
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden className={cx('transition-transform duration-300', valid && 'translate-x-0.5')}>
              <path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
        </div>
        {!compact && (
          <p className="mt-2.5 text-xs leading-relaxed text-faint">
            YouTube videos come as MP4, Spotify tracks as MP3, and images and direct file links as they are. Pages that contain an image or
            video work too. Save the result as is or convert it.
          </p>
        )}
      </form>
    </Spotlight>
  )
}

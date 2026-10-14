'use client'

import type { HTMLAttributes, PointerEvent } from 'react'
import { cx } from '../ui'

/** A surface with a soft light that follows the pointer (pure CSS variables, no re-renders). */
export function Spotlight({ className, onPointerMove, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={cx('spotlight', className)}
      onPointerMove={(e: PointerEvent<HTMLDivElement>) => {
        const r = e.currentTarget.getBoundingClientRect()
        e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`)
        e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`)
        onPointerMove?.(e)
      }}
    />
  )
}

'use client'

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { cx } from '../ui'

/** Becomes true once the element has scrolled into view (and stays true). */
function useInView<T extends Element>(threshold = 0.15) {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setInView(true)
          io.disconnect()
        }
      },
      { threshold, rootMargin: '0px 0px -8% 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [threshold])
  return [ref, inView] as const
}

/**
 * Fades and lifts its children in when scrolled into view. Content is only
 * hidden when JavaScript runs (the `js` class), so nothing disappears without it.
 */
export function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const [ref, inView] = useInView<HTMLDivElement>()
  return (
    <div ref={ref} className={cx('reveal', inView && 'reveal-in', className)} style={{ transitionDelay: `${delay}ms` } as CSSProperties}>
      {children}
    </div>
  )
}

/** A headline whose words rise out of a mask one after another. */
export function RevealWords({ text, className, delay = 0, as: Tag = 'h2' }: { text: string; className?: string; delay?: number; as?: 'h1' | 'h2' | 'p' }) {
  const [ref, inView] = useInView<HTMLHeadingElement>()
  return (
    <Tag ref={ref} className={className} aria-label={text}>
      {text.split(' ').map((word, i) => (
        <span key={i} aria-hidden className="inline-block overflow-hidden pb-[0.08em] align-bottom">
          <span className={cx('reveal-word inline-block', inView && 'reveal-word-in')} style={{ transitionDelay: `${delay + i * 70}ms` }}>
            {word}
            {' '}
          </span>
        </span>
      ))}
    </Tag>
  )
}

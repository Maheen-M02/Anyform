'use client'

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { Logo } from '../Logo'
import { HeroArt } from './HeroArt'

const WORDMARK = 'ANYFORM'
const COUNT_MIN_MS = 1900
/** Never keep anyone behind the preloader longer than this. */
const INTRO_MAX_MS = 8000

type Phase = 'counting' | 'collapsing' | 'revealing' | 'done'
interface IntroState {
  phase: Phase
  count: number
}
interface IntroElements {
  panel: HTMLDivElement | null
  art: HTMLDivElement | null
  spark: HTMLDivElement | null
}

const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Real readiness signal: the page and its fonts have finished loading. */
function pageReady(): Promise<void> {
  const loaded = document.readyState === 'complete' ? Promise.resolve() : new Promise<void>((r) => window.addEventListener('load', () => r(), { once: true }))
  return Promise.all([loaded, document.fonts?.ready ?? Promise.resolve()]).then(() => undefined)
}

/**
 * One entrance per page load, owned by the page rather than by a component
 * instance: React may mount Hero more than once (Strict Mode in development,
 * hot reloads), and every mount must re-attach to the same run instead of
 * restarting it. A refresh is a new page load, so it plays again.
 */
const INITIAL: IntroState = { phase: 'counting', count: 0 }
const entrance = {
  state: INITIAL,
  started: false,
  listeners: new Set<() => void>(),
  /** The currently mounted elements (refs can change across remounts). */
  els: { panel: null, art: null, spark: null } as IntroElements,
}

function update(patch: Partial<IntroState>) {
  entrance.state = { ...entrance.state, ...patch }
  entrance.listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  entrance.listeners.add(listener)
  return () => entrance.listeners.delete(listener)
}

function startIntro() {
  if (entrance.started) return
  entrance.started = true
  const root = document.documentElement
  if (root.classList.contains('intro-skip')) {
    update({ phase: 'done', count: 100 })
    return
  }
  root.classList.add('intro-running')

  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    root.classList.remove('intro-running')
    for (const el of [entrance.els.panel, entrance.els.art, entrance.els.spark]) el?.getAnimations().forEach((a) => a.finish())
    update({ phase: 'done', count: 100 })
  }
  // Safety net: whatever happens (throttled timers, slow load), the page is never trapped.
  const bailout = setTimeout(finish, INTRO_MAX_MS)

  const run = async () => {
    // 1. Count to 100. Time drives the animation, but 100 is only reached once the page has really loaded.
    let ready = false
    void pageReady().then(() => (ready = true))
    const start = performance.now()
    // Timers rather than requestAnimationFrame: rAF can be paused (background tabs, some embedded browsers).
    await new Promise<void>((resolve) => {
      const tick = () => {
        if (finished) return resolve()
        const t = Math.min(1, (performance.now() - start) / COUNT_MIN_MS)
        const value = Math.round(easeOutQuart(t) * (ready ? 100 : 99))
        if (value !== entrance.state.count) update({ count: value })
        if (value >= 100) resolve()
        else setTimeout(tick, 16)
      }
      tick()
    })
    await wait(280)
    if (finished) return

    // 2. Collapse the digits.
    update({ phase: 'collapsing' })
    await wait(720)
    if (finished) return

    // 3. Open the hero out of a dot: dot → small window → full panel.
    update({ phase: 'revealing' })
    const { panel, art, spark } = entrance.els
    if (panel && art) {
      const r = 'round 28px'
      const clip = panel.animate(
        [
          { clipPath: `inset(49.6% 49.8% 49.6% 49.8% ${r})`, offset: 0 },
          { clipPath: `inset(49.6% 49.8% 49.6% 49.8% ${r})`, offset: 0.12 },
          { clipPath: `inset(38% 40% 38% 40% round 2px)`, offset: 0.42, easing: 'cubic-bezier(.22,1,.36,1)' },
          { clipPath: `inset(36% 37% 36% 37% round 2px)`, offset: 0.55, easing: 'cubic-bezier(.76,0,.24,1)' },
          { clipPath: `inset(0% 0% 0% 0% ${r})`, offset: 1 },
        ],
        { duration: 2100, easing: 'linear', fill: 'forwards' },
      )
      // The opening "dot" is a lime spark that dissolves as the window widens.
      spark?.animate([{ opacity: 1 }, { opacity: 1, offset: 0.18 }, { opacity: 0, offset: 0.4 }], { duration: 2100, fill: 'forwards' })
      art.animate([{ transform: 'scale(1.35)' }, { transform: 'scale(1.35)', offset: 0.55 }, { transform: 'scale(1)' }], {
        duration: 2100,
        easing: 'cubic-bezier(.76,0,.24,1)',
        fill: 'forwards',
      })
      await clip.finished.catch(() => undefined)
    }
    clearTimeout(bailout)
    finish()
  }
  void run()
}

/**
 * Entrance sequence: a growing 0→100 counter, digits collapsing away, then the
 * hero opening out of a single dot into a full-screen panel, and the wordmark
 * typing itself in. Plays on every page load; skipped for reduced motion (see
 * the inline script in the root layout).
 */
export function Hero({ conversions, formats }: { conversions: number; formats: number }) {
  // The server snapshot is the initial state, so hydration always matches the server markup.
  const { phase, count } = useSyncExternalStore(subscribe, () => entrance.state, () => INITIAL)
  const panel = useRef<HTMLDivElement>(null)
  const art = useRef<HTMLDivElement>(null)
  const spark = useRef<HTMLDivElement>(null)

  useEffect(() => {
    entrance.els = { panel: panel.current, art: art.current, spark: spark.current }
    startIntro()
  }, [])

  const intro = phase === 'counting' || phase === 'collapsing'
  const done = phase === 'done'
  const digits = String(count).split('')
  return (
    <section className="relative h-[100dvh] p-2 sm:p-3" aria-label="ANYFORM">
      {/* The hero panel. During the intro it is clipped down to a dot and opened up. */}
      <div ref={panel} className={`hero-panel relative h-full overflow-hidden rounded-[28px] ${intro ? 'hero-panel-hidden' : ''}`}>
        <div ref={art} className="absolute inset-0 will-change-transform">
          <HeroArt />
        </div>
        <div
          ref={spark}
          aria-hidden
          className={`pointer-events-none absolute top-1/2 left-1/2 z-20 size-4 -translate-x-1/2 -translate-y-1/2 bg-accent ${done ? 'hidden' : ''}`}
        />

        <header className={`hero-chrome absolute inset-x-0 top-0 z-10 flex items-center justify-between px-5 py-4 sm:px-8 sm:py-6 ${done ? 'hero-chrome-in' : ''}`}>
          <Logo />
          <nav className="flex items-center gap-5 font-mono text-[11px] tracking-[0.14em] text-white/80 uppercase sm:gap-8">
            <a href="#convert" className="hover:text-accent">
              Convert
            </a>
            <a href="#formats" className="hover:text-accent">
              Formats
            </a>
            <a href="#privacy" className="hover:text-accent">
              Privacy
            </a>
          </nav>
        </header>

        <div className="absolute inset-x-0 bottom-0 z-10 px-5 pb-4 sm:px-8 sm:pb-6">
          <h1 className="wordmark text-[clamp(4.5rem,19.5vw,22rem)] leading-[0.8] font-medium tracking-[-0.055em] text-white" aria-label={WORDMARK}>
            {WORDMARK.split('').map((ch, i) => (
              <span key={i} className="inline-block overflow-hidden pb-[0.04em] align-bottom" aria-hidden>
                <span className={`wordmark-letter inline-block ${done ? 'wordmark-letter-in' : ''}`} style={{ animationDelay: `${120 + i * 75}ms` }}>
                  {ch}
                </span>
              </span>
            ))}
          </h1>
          <div className={`hero-chrome mt-4 grid grid-cols-3 items-end font-mono text-[10px] tracking-[0.14em] text-white/60 uppercase sm:text-[11px] ${done ? 'hero-chrome-in' : ''}`}>
            <span>Everything in. Anything out.</span>
            <span className="text-center">
              {conversions} conversions · {formats} formats
            </span>
            <a href="#convert" className="justify-self-end text-white/80 hover:text-accent">
              Start converting ↓
            </a>
          </div>
        </div>
      </div>

      {/* The preloader. */}
      {intro && (
        <div className="intro-overlay fixed inset-0 z-50 flex items-center bg-ink px-5 sm:px-8" aria-hidden>
          <div className="counter font-medium leading-none tracking-[-0.04em] text-white tabular-nums" style={{ fontSize: `clamp(3rem, ${3 + count * 0.17}vw, 20rem)` }}>
            {digits.map((d, i) => (
              <span
                key={`${digits.length}-${i}`}
                className={`inline-block ${phase === 'collapsing' ? 'digit-collapse' : ''}`}
                style={{ animationDelay: `${i * 90}ms` }}
              >
                {d}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

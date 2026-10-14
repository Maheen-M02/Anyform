import { Converter } from '@/components/Converter'
import { Hero } from '@/components/hero/Hero'
import { Reveal, RevealWords } from '@/components/motion/Reveal'
import { getConfig } from '@/server/config'
import { registry } from '@/server/conversions'
import { FORMAT_KIND_LABELS, FORMATS, type FormatKind } from '@/lib/formats'

const KIND_ORDER: FormatKind[] = ['video', 'audio', 'image', 'document', 'archive']

export const dynamic = 'force-dynamic'

export default function Home() {
  const cfg = getConfig()
  const uploadTtl = Math.round(cfg.uploadTtlMs / 60_000)
  const resultTtl = Math.round(cfg.resultTtlMs / 60_000)
  // Every readable input format and everything it can become, straight from the registry.
  const inputs = [...new Set(registry.list().flatMap((a) => a.inputFormats))]
  const matrix = KIND_ORDER.map((kind) => ({
    kind,
    rows: inputs
      .filter((f) => FORMATS[f].kind === kind)
      .map((from) => ({ from, to: registry.reachable(from).map((p) => p.to) }))
      .filter((r) => r.to.length > 0),
  })).filter((g) => g.rows.length > 0)

  const conversionCount = matrix.reduce((n, g) => n + g.rows.reduce((m, r) => m + r.to.length, 0), 0)

  return (
    <>
      <Hero conversions={conversionCount} formats={inputs.length} />
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-5 sm:px-8">
      <main className="flex-1 pb-20">
        <section id="convert" className="scroll-mt-6 pt-16 pb-10 sm:pt-24 sm:pb-14">
          <Reveal>
            <p className="flex items-center gap-3 font-mono text-xs tracking-[0.2em] text-accent uppercase">
              <span className="inline-block size-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
              Universal file conversion
            </p>
          </Reveal>
          <RevealWords text="Everything in. Anything out." delay={120} className="mt-4 text-4xl font-semibold tracking-tight text-balance sm:text-6xl" />
          <Reveal delay={350}>
          <p className="mt-5 max-w-2xl text-base text-pretty text-muted sm:text-lg">
            Video, audio, images, PDFs and archives. Drop a file, pick a format, download the result. ANYFORM inspects what your file really
            contains, offers only the conversions that will work, and verifies every output before you get it.
          </p>
          </Reveal>
        </section>

        <Converter conversionCount={conversionCount} />

        <section id="formats" className="mt-20 grid gap-10 border-t border-line pt-12 md:grid-cols-2">
          <div>
            <h2 className="font-mono text-xs tracking-[0.14em] text-muted uppercase">Supported today</h2>
            <div className="mt-4 space-y-5">
              {matrix.map((group) => (
                <div key={group.kind}>
                  <p className="mb-2 text-xs text-muted">{FORMAT_KIND_LABELS[group.kind]}</p>
                  <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
                    {group.rows.map((row) => (
                      <li key={row.from} className="flex gap-4 px-4 py-2.5">
                        <span className="w-14 shrink-0 font-mono text-sm font-semibold">{FORMATS[row.from].label}</span>
                        <span className="font-mono text-xs leading-5 text-muted">
                          <span className="text-faint">→ </span>
                          {row.to.map((f) => FORMATS[f].label).join(' · ')}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <p className="mt-4 text-sm text-faint">
              Every format listed here is detected from the file&apos;s contents and every output is verified before download. Nothing appears
              until it actually works: Office documents, HEIC and RAR, for example, are not supported yet.
            </p>
          </div>
          <div id="privacy">
            <h2 className="font-mono text-xs tracking-[0.14em] text-muted uppercase">Privacy &amp; retention</h2>
            <ul className="mt-4 space-y-3 text-sm text-muted">
              <li>
                <span className="text-fg">Private by default.</span> Files are tied to this browser session and are never public. Nobody else can see,
                list or download them.
              </li>
              <li>
                <span className="text-fg">Deleted automatically.</span> Uploads are removed after {uploadTtl} minutes and converted files after{' '}
                {resultTtl} minutes. You can delete them sooner from your session history.
              </li>
              <li>
                <span className="text-fg">Your files only.</span> Convert files you have the right to process. ANYFORM does not bypass DRM, encryption or
                access controls.
              </li>
            </ul>
          </div>
        </section>
      </main>

      <footer className="flex h-16 items-center justify-between border-t border-line font-mono text-xs text-faint">
        <span>ANYFORM</span>
        <span>Max {Math.round(cfg.maxUploadBytes / 1024 / 1024)} MB per file</span>
      </footer>
    </div>
    </>
  )
}

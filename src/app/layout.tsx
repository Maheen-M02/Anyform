import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'ANYFORM — Everything in. Anything out.',
  description: 'Universal file conversion. Upload a file, choose a format, download the result. Files are private and deleted automatically.',
}

export const viewport: Viewport = {
  themeColor: '#0a0a0b',
}

const INTRO_SCRIPT = `document.documentElement.classList.add('js');try{if(matchMedia('(prefers-reduced-motion: reduce)').matches)document.documentElement.classList.add('intro-skip')}catch(e){}`

/** Without JavaScript the entrance never runs, so show the finished hero. */
const NOSCRIPT_CSS = '.intro-overlay{display:none!important}.hero-panel-hidden{clip-path:none!important}.wordmark-letter{transform:none!important}.hero-chrome{opacity:1!important;transform:none!important}'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Before first paint: skip the entrance for reduced-motion users. */}
        <script dangerouslySetInnerHTML={{ __html: INTRO_SCRIPT }} />
        <noscript>
          <style>{NOSCRIPT_CSS}</style>
        </noscript>
      </head>
      <body>{children}</body>
    </html>
  )
}

import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'ANYFORM — Everything in. Anything out.',
  description: 'Universal file conversion. Upload a file, choose a format, download the result. Files are private and deleted automatically.',
}

export const viewport: Viewport = {
  themeColor: '#0a0a0b',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}

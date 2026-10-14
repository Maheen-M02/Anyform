/**
 * Original generative artwork for the hero: drifting colour fields, a faint
 * stream of real conversions, and film grain. Pure markup/CSS, so the intro
 * and the final hero render pixel-identical art.
 */
const STREAM = [
  'MOV → MP4',
  'WAV → FLAC',
  'PNG → WEBP',
  'PDF → TXT',
  'MKV → MP3',
  'JPG → AVIF',
  'ZIP → TAR.GZ',
  'GIF → WEBP',
  'FLAC → MP3',
  'TIFF → PDF',
  'WEBM → MP4',
  'OGG → M4A',
]

export function HeroArt() {
  return (
    <div aria-hidden className="hero-art absolute inset-0 overflow-hidden bg-[#070908]">
      <div className="hero-blob hero-blob-a" />
      <div className="hero-blob hero-blob-b" />
      <div className="hero-blob hero-blob-c" />
      <div className="hero-blob hero-blob-d" />

      {/* A slow diagonal stream of conversions, barely there. */}
      <div className="hero-stream absolute -inset-[20%] flex rotate-[-12deg] flex-col justify-center gap-6 font-mono text-[clamp(14px,1.6vw,22px)] tracking-[0.3em] text-white/[0.07] uppercase">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
          <div key={row} className={row % 2 ? 'hero-stream-row-rev' : 'hero-stream-row'}>
            <span className="whitespace-nowrap">
              {[...STREAM.slice(row), ...STREAM.slice(0, row), ...STREAM].join('     ')}
            </span>
          </div>
        ))}
      </div>

      {/* Vignette keeps the wordmark and nav legible. */}
      <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_70%_30%,transparent_30%,rgba(5,6,6,0.75)_100%)]" />
      <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/60 to-transparent" />

      {/* Film grain. */}
      <svg className="hero-grain absolute inset-0 h-full w-full opacity-[0.16] mix-blend-overlay">
        <filter id="hero-grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#hero-grain)" />
      </svg>
    </div>
  )
}

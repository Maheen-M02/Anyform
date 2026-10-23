# ANYFORM

**Everything in. Anything out.** A universal file conversion platform built around a registry of
verified conversion adapters.

ANYFORM converts **20 input formats across 104 direct conversions**, plus metadata-free clean copies of 11 formats. Every input is identified from
its contents (never its name), and every output is independently verified before it can be downloaded.

| Category | Inputs | Outputs | Options |
| -------- | ------ | ------- | ------- |
| Video | MP4, MOV, MKV, WebM, AVI | MP4 (H.264/AAC), WebM (VP9/Opus) | Lossless fast copy when codecs allow (e.g. most MOV → MP4), quality, resolution (never upscales), audio track |
| Audio and video → audio | MP3, WAV, FLAC, M4A, OGG + all video formats | MP3, WAV, FLAC, M4A (AAC), OGG (Vorbis) | Bitrate (MP3 CBR verified; AAC/Vorbis VBR target), bit depth 16/24 (WAV/FLAC), audio track |
| Images | PNG, JPG, WebP, GIF, AVIF, TIFF | PNG, JPG, WebP, GIF, AVIF, TIFF (including same-format resize) | Max width/height (aspect kept, never enlarged), quality. EXIF orientation applied, metadata/GPS stripped, animation kept GIF ↔ WebP |
| Documents | PDF; all image formats | TXT (text extraction), PNG/JPG (rendered pages, ZIP for all pages); PDF from images | Pages, DPI, page size. PDF author restrictions (no copy/print) are honoured |
| Archives | ZIP, TAR, TAR.GZ | ZIP, TAR, TAR.GZ | Streamed byte-for-byte; zip-bomb, path-traversal and encryption guards |

**YouTube and Spotify links:** a YouTube video link becomes an MP4 (YouTube Music links become an MP3);
a Spotify track link becomes an MP3. Spotify's own stream is DRM-protected and is never touched: the
track's title and artist are read from its public page and the same recording is downloaded from
YouTube. Both use [yt-dlp](https://github.com/yt-dlp/yt-dlp), restricted to its YouTube extractors so
it can never fetch arbitrary URLs. Google/Bing image-result links are unwrapped to the real image.
Requires `yt-dlp` on PATH (or `YTDLP_PATH`); the Docker image includes it.

**Import from a link:** besides uploading, users can paste a direct link to a file. The server
downloads it with SSRF protections and runs it through the same pipeline. Streaming services
(YouTube, Spotify, …) are refused with an explanation: ANYFORM only fetches files that a link serves
directly.

**Not supported (and not advertised):** Office documents (DOCX/XLSX/PPTX) and PDF → Word, which would
need LibreOffice; OCR of scanned PDFs; HEIC/HEIF photos; RAR/7z archives; password-protected files
(ANYFORM never removes encryption or DRM). Uploading one of these gets a specific explanation.

## What sets it apart

- **Convert for a destination.** "Where is it going?" presets (Discord, Email, WhatsApp, Website,
  Instagram, Print, Smallest file) pick the format, settings and a size limit. Size targets are real:
  video bitrate and resolution are budgeted from the duration (and re-encoded lower if rate control
  overshoots), MP3 drops to the largest bitrate that fits, and images lose quality, then pixels,
  until they fit. Unreachable targets are refused before any work starts (`SIZE_TARGET_UNREACHABLE`).
  The same limits are available as a "Max file size" option (`maxBytes`) without a preset.
- **A verification report with every output.** The checks each adapter ran, an independent
  re-scan of the output for hidden data, and SHA-256 fingerprints of source and output. It can be
  downloaded as a plain-text receipt (`output.report` in the API).
- **"What's hidden in this file?"** Inspection lists GPS coordinates, camera and device details,
  serial numbers, authors, editing history, earlier PDF revisions and more (EXIF, XMP, IPTC, PNG
  text, container tags, PDF info), and one click makes a clean copy: audio/video streams are copied
  bit-for-bit, PDFs are rewritten without metadata or old revisions, and images are re-saved.

## How it works

```
upload (raw stream, size-capped) → magic-byte sniff → family-specific inspection
   (ffprobe + decode tests | sandbox: libvips / pdf.js / archive listing)
→ compatible outputs from the registry → job (queued)
→ worker: FFmpeg or sandbox (argument arrays, timeout, cancellable, killable)
→ independent verification of the output → private storage → authorised download
```

- **Frontend**: Next.js 16 (App Router), React 19, Tailwind CSS 4. An explicit state machine
  (`src/lib/workflow.ts`) drives upload → validation → settings → conversion → result.
- **API**: typed route handlers under `src/app/api/v1`, Zod-validated, uniform error codes.
- **Engine**: `src/server/conversions` holds the `ConversionAdapter` interface, the registry with
  bounded, cycle-free multi-step planning, and the video, audio, image, document and archive adapters.
- **Sandbox**: images (sharp/libvips), PDFs (pdf.js and @napi-rs/canvas, pdf-lib) and archives
  (yauzl/yazl/tar-stream) are parsed in a separate, killable Node process (`src/sandbox`) with a capped
  heap and no secrets in its environment. FFmpeg runs with the same minimal environment.
- **Jobs**: `src/server/jobs`. Local mode runs an in-process bounded queue that recovers
  unfinished jobs from disk on restart. Redis mode uses BullMQ with dedicated workers.
- **Storage**: `src/server/storage`, a private object store with server-generated keys. The local
  filesystem driver is implemented.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Requirements

- Node.js ≥ 20.11 (developed on 24)
- FFmpeg and FFprobe on `PATH`, built with `libmp3lame`, `libvorbis`, `libopus`, `libx264` and `libvpx`
  (standard in Debian/Ubuntu, Homebrew and gyan.dev builds), or set `FFMPEG_PATH` / `FFPROBE_PATH`
- Image, PDF and archive libraries install with `npm install` (prebuilt binaries for Linux, macOS and Windows)
  - Windows: `winget install Gyan.FFmpeg`; macOS: `brew install ffmpeg`; Debian/Ubuntu: `apt install ffmpeg`
- Optional: Redis 6.2+ for the multi-process deployment mode

## Quick start (local mode)

```bash
npm install
cp .env.example .env.local     # optional; defaults work for development
npm run dev                    # http://localhost:3000
```

In local mode the web process also runs conversions (bounded by `WORKER_CONCURRENCY`) and cleanup.
Data lives in `./data`. Check `GET /api/v1/ready` to confirm FFmpeg is found.

## Redis mode (web + workers)

```bash
REDIS_URL=redis://localhost:6379 npm run dev       # web: enqueues only
REDIS_URL=redis://localhost:6379 npm run worker    # one or more workers
```

Web and workers must share the same `ANYFORM_DATA_DIR` (see the storage notes in DEPLOYMENT.md).

## Scripts

| Command               | Purpose                                                    |
| --------------------- | ---------------------------------------------------------- |
| `npm run dev`         | Development server                                         |
| `npm run build`       | Production build (Next.js + worker + sandbox in `dist/`)   |
| `npm start`           | Serve the production build                                 |
| `npm run worker`      | Conversion worker (Redis mode, TypeScript via tsx)         |
| `npm run worker:prod` | Bundled worker (`dist/index.js`)                           |
| `npm run cleanup`     | One-off cleanup of expired/orphaned files                  |
| `npm test`            | Unit + integration tests (needs FFmpeg)                    |
| `npm run typecheck`   | TypeScript                                                 |
| `npm run lint`        | ESLint                                                     |

## Tests

```bash
npm test
# Also exercise Redis mode against a disposable Redis (the DB is FLUSHED):
TEST_REDIS_URL=redis://localhost:6390/15 npm test
```

Fixtures are generated synthetically on first run (FFmpeg `lavfi` sources, sharp, pdf-lib, yazl,
tar-stream) and cached in the OS temp dir as `anyform-fixtures-v2`. They include hostile files:
fake extensions, corrupt/truncated media, decompression-bomb PNGs, zip bombs, path-traversal and
encrypted ZIPs, and Office documents disguised as ZIPs. No network access, copyrighted samples or
paid services are needed.

## API

All endpoints are under `/api/v1`. State-changing requests require the header
`x-anyform-request: 1` and a same-origin `Origin`. Ownership comes from an HMAC-signed
anonymous session cookie. Resources owned by other sessions return `404`.

| Method & path                       | Description                                                            |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `POST /uploads`                     | Raw file body (`application/octet-stream`), name in `X-File-Name` (URL-encoded) |
| `POST /imports` `{url}`             | Server downloads a direct file link (SSRF-protected) and stores it as an upload |
| `GET /uploads/:id`                  | Upload state, detected media, compatible outputs                       |
| `POST /validate` `{uploadId}`       | Inspect real contents; returns media info and valid outputs            |
| `POST /conversions` `{uploadId, outputFormat, options}` | Create (or return the identical existing) job |
| `GET /conversions`                  | Session history                                                        |
| `GET /conversions/:id`              | Status, real progress, output metadata                                 |
| `POST /conversions/:id/cancel`      | Cancel a queued/running job (kills FFmpeg)                             |
| `GET /conversions/:id/download`     | Output file (`?inline=1` for preview; supports `Range`)                |
| `DELETE /conversions/:id`           | Delete a finished job, its output and its source upload                |
| `GET /formats`                      | Registered conversions, options and limits                             |
| `GET /health`, `GET /ready`         | Liveness / readiness (FFmpeg, storage, metadata store)                 |
| `GET /metrics`                      | Prometheus text, only when `METRICS_TOKEN` is set                      |

Errors look like `{"error": {"code": "NO_AUDIO_STREAM", "message": "…", "requestId": "…"}}`.
Codes are listed in `src/server/errors.ts`.

## Adding a conversion

1. Implement `ConversionAdapter` (`src/server/conversions/types.ts`): input formats, output
   format, option fields, `validateInput`, `validateOptions` (normalised options must re-validate
   to themselves), `estimate`, `convert`, `verifyOutput`. Parsing of untrusted non-media files
   belongs in a sandbox operation (`src/sandbox/cli.ts`).
2. If the input is a new family, add its magic bytes to `src/server/media/sniff.ts` and an inspector
   to `src/server/inspect`.
3. Register it in `src/server/conversions/index.ts`, update the expected matrix in
   `tests/unit/matrix.test.ts`, and add integration tests with synthetic fixtures. The UI, the
   landing-page matrix and `/formats` pick it up automatically.

## Legal

ANYFORM processes files that users are authorised to convert. It does not bypass DRM,
encryption, paywalls or access controls, and it does not fetch content from streaming services.

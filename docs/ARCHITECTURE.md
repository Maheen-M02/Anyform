# ANYFORM architecture

## Layout

```
src/
  app/                       Next.js App Router
    page.tsx                 Landing page + converter
    api/v1/…                 Route handlers (thin: parse → service → JSON)
  components/                UI: UploadDropzone, FileMetadataCard, FormatSelector,
                             ConversionOptions, ValidationStatus, ConversionProgress,
                             ConversionResult (AudioPreview, DownloadButton), ErrorState,
                             ConversionHistory, Converter (orchestrates the workflow)
  lib/                       Isomorphic code: formats catalogue, state machines,
                             filename sanitising, typed API client, UI workflow reducer
  server/
    config.ts                Zod-validated environment configuration
    http.ts                  Handler wrapper: request ids, session, CSRF, rate limit, errors
    session.ts               HMAC-signed anonymous session cookie
    errors.ts                Stable error codes → HTTP status + safe messages
    media/                   sniff (magic bytes), probe (ffprobe + decode test), process runner
    inspect/                 FileInfo union (av | image | pdf | archive) and inspectFile()
    sandbox.ts               Runs one sandbox operation in a fresh, killable child process
    conversions/             Adapter interface, registry/planner, and adapters:
      adapters/video.ts      Video → MP4 / WebM (stream copy or H.264 / VP9 encode)
      adapters/audio.ts      Audio + video → MP3 / WAV / FLAC / M4A / OGG
      adapters/image.ts      Image ↔ image (incl. same-format resize)
      adapters/document.ts   PDF → TXT / PNG / JPG, image → PDF
      adapters/archive.ts    ZIP ↔ TAR ↔ TAR.GZ
  sandbox/                   Child-process code for untrusted non-media parsing:
                             images (sharp), pdf (pdf.js, canvas, pdf-lib), archives (yauzl, yazl, tar-stream)
    jobs/                    Queue implementations (local, BullMQ) and the job processor
    storage/                 StorageDriver interface + local filesystem driver
    store/                   MetaStore interface + file and Redis implementations
    services/                uploads.ts, conversions.ts (business logic used by routes)
    cleanup.ts               Expiry, orphan and scratch cleanup
    runtime.ts               Wires store/storage/queue/registry for local or Redis mode
  worker/                    Worker and cleanup entry points (Redis mode / cron)
```

## Request → result

1. **Upload** (`POST /uploads`): the raw body is streamed to `objects/uploads/<id>.part`
   through a byte-counting limiter, then renamed. Content-Length, the global size cap, the
   per-session quota and free disk space are checked before and during the stream. The first
   bytes are sniffed immediately, and files that are not media at all are deleted.
2. **Validation** (`POST /validate`): ffprobe runs with `-protocol_whitelist file` and a
   `-format_whitelist` derived from the sniffed family. This means an `.mp4` that is really an
   HLS playlist, an image, or anything else is never handed to an unexpected demuxer. Each audio
   track (up to 8) is decode-tested for 10 s. The registry then lists only outputs whose first
   adapter accepts the media. Rejected uploads are deleted right away.
3. **Job creation** (`POST /conversions`): the plan comes from the registry, and options are
   parsed by the adapter. A dedupe key (upload + format + normalised options) makes identical
   submissions return the existing job. This is atomic in both stores. Active-job and storage
   quotas are enforced here too.
4. **Processing** (`processJob`): the processor claims the job, checks free disk against the
   adapter's estimate, and runs each plan step in a per-attempt scratch directory. A job-wide
   deadline applies, and the job record is polled for cancellation (cancel kills FFmpeg via
   `SIGKILL`). Real progress comes from `-progress pipe:1`. The final output is verified before
   it is moved into private storage.
5. **Download**: owner-only, unexpired, streamed with `Range` support, `nosniff` and a sandbox
   CSP.

## State machines

`src/lib/states.ts` defines the server lifecycle, shared with the UI:

- Upload: `uploaded → validating → validated | rejected → expired`
- Job: `queued → processing → verifying → completed → expired`, plus `failed` and `cancelled`.
  `processing → queued` is a retry. `processing → processing` is the resumption of a crashed attempt.

`src/lib/workflow.ts` is the UI reducer. Each phase carries exactly the data it needs, so
"result without a job" or "convert before validation" cannot be represented.

## Conversion engine

```ts
interface ConversionAdapter<O> {
  id; label; inputFormats; outputFormat; requiredTools; lossy; notes
  optionFields(media)            // declarative UI/API option description
  validateInput(media)           // throws NO_AUDIO_STREAM, UNSUPPORTED_CODEC, …
  validateOptions(raw, media): O // Zod-backed; fills defaults
  estimate(media, options)       // output bytes (disk admission), cpu seconds
  convert(ctx)                   // honours ctx.signal / ctx.timeoutMs, reports progress
  verifyOutput(ctx)              // independent inspection of the produced file
}
```

`ConversionRegistry.plan(from, to)` runs a breadth-first search over formats. Formats are never
revisited (no cycles), and chains are capped at `MAX_CHAIN_LENGTH` (2). Intermediate outputs are
re-probed before the next step. User options apply only to the final step.

### Audio → MP3 adapter details

- `-map 0:<index>` for the chosen track. `-vn -sn -dn` so video is never decoded or encoded.
  Metadata and chapters are stripped.
- `aresample=async=1` keeps duration correct across timestamp gaps (VFR sources, non-zero
  starts).
- Sample rate: 32/44.1/48 kHz are kept. Other rates are resampled (to 44.1 kHz, or 48 kHz for
  higher rates) so that every offered bitrate is valid MPEG-1 Layer III. More than 2 channels are
  downmixed to stereo.
- Verification checks that the output is an MP3 container with exactly one `mp3` stream, decodes
  it, compares duration within max(0.5 s, 2 %), and checks that the CBR bitrate is within 3 %. A
  duration mismatch is reported as a truncated/damaged source.

## Deployment modes

| | Local mode (no `REDIS_URL`) | Redis mode |
|---|---|---|
| Metadata | JSON file per record, atomic rename | Redis, WATCH/MULTI optimistic updates on a dedicated connection |
| Queue | In-process, bounded concurrency, **not durable by itself**: unfinished jobs are re-enqueued from metadata at boot | BullMQ, durable, stalled-job recovery |
| Workers | Inside the web process | `npm run worker` processes |
| Cleanup | Timer in web process | Timer in each worker, or `npm run cleanup` from cron |
| Suitable for | Development, single-node | Multi-process / multi-replica |

Retries are decided by the processor, not BullMQ. Only errors marked `retryable` (tool
unavailable, low disk, unexpected internal errors) are retried, up to `JOB_MAX_ATTEMPTS`.
Malformed media, timeouts and verification failures fail immediately.

## URL import (`src/server/imports`)

`POST /api/v1/imports {url}` downloads a user-supplied link and hands the bytes to the same
`persist()` path as uploads: quota, free disk, size cap, magic-byte sniffing, then validation.
SSRF defences, all re-applied on **every redirect hop** (at most `IMPORT_MAX_REDIRECTS`):

1. Only `http`/`https`, standard ports 80/443, no embedded credentials, URLs up to 2048 characters.
2. Streaming-service pages (YouTube, Spotify, Apple Music, SoundCloud, Netflix, TikTok, …) are
   refused with `UNSUPPORTED_SOURCE`. An optional `IMPORT_ALLOWED_HOSTS` restricts sources further.
3. The host is resolved and *every* answer must be public. Loopback, RFC 1918, link-local and
   cloud metadata (169.254.169.254), CGNAT, multicast, reserved, documentation, ULA and IPv6
   link-local are all blocked, as are IPv4-mapped/NAT64/6to4/Teredo forms that embed them.
4. The socket connects to the **validated IP** through a custom `lookup`, so DNS rebinding between
   the check and the connection is impossible. TLS still verifies the certificate against the host
   name.
5. `Accept-Encoding: identity` (no transparent decompression), a 20 s idle timeout, an overall
   `IMPORT_TIMEOUT_SECONDS` deadline that also covers the body, and Content-Length checked against
   the byte budget before reading.
6. No cookies or credentials are sent. Only the host (never the full URL, which may carry tokens)
   is stored on the upload record.

Each hop uses its own keep-alive agent, which is destroyed afterwards. `agent: false` sends
`Connection: close`, and some CDNs and middleboxes answer that with a reset.
`IMPORT_ALLOW_PRIVATE_NETWORKS` exists for tests and local development only; the server refuses
to start with it in production. In the compose deployment, imports run in the web container
(which has egress). Workers still have none.

## Inspection and the sandbox

`inspectFile()` sniffs the first 512 bytes, then hands the file only to the parser for that family:

| Family | Parser | What is established |
| --- | --- | --- |
| MP4/MOV/M4A, MKV/WebM, AVI, WAV, MP3, FLAC, OGG | ffprobe (demuxer whitelist) + 2–10 s decode tests | streams, codecs, duration, decodability |
| PNG, JPEG, GIF, WebP, AVIF, TIFF | sandbox → libvips | displayed size (EXIF-aware), frames, alpha; pixel limit enforced *before* decoding |
| PDF | sandbox → pdf.js (no eval, no XFA, no system fonts, no network) | pages, title, author permissions; password-protected files are refused |
| ZIP, TAR, TAR.GZ | sandbox → listing without extraction | entry/size limits, encryption, unsafe paths, special entries, Office/EPUB detection |

The sandbox is `node --max-old-space-size=<SANDBOX_MEMORY_MB> dist/sandbox.mjs`. Its environment
holds only PATH-like variables (no `SESSION_SECRET`, `REDIS_URL` or tokens). It takes one JSON
request on stdin and reports `@@progress`/`@@result`/`@@error` lines on stdout. Library console
output is redirected to stderr. It is killed on timeout or cancellation like FFmpeg, and a crash
(for example an out-of-memory error on a hostile file) becomes a clean `CORRUPT_MEDIA` failure, so
the web or worker process is never affected.

## Conversion catalogue notes

- **Video**: in `auto` mode, compatible streams (H.264/HEVC + AAC/MP3 for MP4; VP8/VP9/AV1 +
  Opus/Vorbis for WebM) are copied, which is lossless and near-instant. Otherwise video is
  re-encoded (`libx264 -preset veryfast`, CRF 18/23/28, or `libvpx-vp9` CRF 28/33/40) with even
  dimensions and yuv420p. Downscaling never upscales. Metadata (including phone GPS tags) is
  dropped.
- **Audio**: MP3 is CBR and its bitrate is verified exactly. AAC and Vorbis are variable, so they
  report a *target*. Vorbis uses quality mode because fixed bitrates fail at low sample rates.
  Low-rate sources are resampled where an encoder would otherwise silently cap quality.
- **Images**: `.rotate()` applies EXIF orientation, metadata is stripped and output is sRGB.
  Transparency becomes white for JPG. Animation is preserved GIF/WebP → GIF/WebP; otherwise the
  first frame is used. Encoder dimension limits (WebP 16383, AVIF 16384) are checked before work
  starts.
- **PDF**: text extraction needs the "copy" permission, and rendering needs "print". "All pages"
  output is a ZIP. The verified output format (`zip`) is recorded separately from the requested
  one (`png`). Scanned PDFs produce `NO_TEXT_CONTENT` rather than an empty file.
- **Archives**: entries stream from reader to writer without touching disk. Names are normalised,
  and any absolute or `..` path rejects the whole archive. Symlinks and devices are skipped and
  reported. The output is re-listed and must match the source's file count and byte total.

Adapters can set `chainable: false` (PDF ↔ image and PDF → text) so the planner never builds
chains such as image → PDF → text. Today every advertised conversion is a single step (asserted by
`tests/unit/matrix.test.ts`).

## Security model

- Untrusted media is only parsed by FFmpeg tools restricted to the `file` protocol and a
  family-specific demuxer whitelist. Untrusted images, PDFs and archives are only parsed in the
  sandbox process. Arguments are passed as arrays (`spawn`, `shell: false`).
  Input and output are addressed as `file:<server-generated path>`.
- Storage keys match `^(uploads|outputs)/(upl|out)_[A-Za-z0-9_-]{22}$`, and resolved paths are
  checked to stay under the storage root. User filenames are only display metadata.
- Ownership: every upload/job carries the session id. Lookups for other sessions' resources
  return `NOT_FOUND`, which avoids existence oracles.
- CSRF: custom header required on all mutating endpoints, plus an Origin check. Cookies are
  `HttpOnly; SameSite=Lax` (and `Secure` in production). No CORS headers are emitted, so the API
  is same-origin only.
- Errors: unknown exceptions map to `INTERNAL_ERROR` with a generic message. FFmpeg stderr is
  path-scrubbed and only logged. Log fields matching token/secret/cookie/url are redacted.
- Resource limits: upload size (header and stream), duration, per-session storage quota and
  active jobs, free-disk admission for uploads and conversions, FFmpeg thread count, probe and
  job timeouts, and worker concurrency.

FFmpeg's whitelists are hardening, not a sandbox. Production workers should run isolated (see
DEPLOYMENT.md).

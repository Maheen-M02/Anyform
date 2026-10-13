# Deploying and operating ANYFORM

## Runtime dependencies

- Node.js ≥ 20.11
- `ffmpeg` and `ffprobe` with `libmp3lame`, `libvorbis`, `libopus`, `libx264` and `libvpx` (the Docker image installs Debian's `ffmpeg`, which has all of them)
- The sandbox bundle `dist/sandbox.mjs` (built by `npm run build`) plus `node_modules` (sharp, pdf.js, @napi-rs/canvas, pdf-lib, yauzl, yazl, tar-stream)
- Redis 6.2+ for multi-process deployments
- A persistent volume for `ANYFORM_DATA_DIR` that is shared by the web process and all workers

`GET /api/v1/ready` reports whether FFmpeg, FFprobe, the sandbox, storage and the metadata store are usable.
Point your orchestrator's readiness probe at it, and its liveness probe at `/api/v1/health`.

## Docker Compose (web + 2 workers + Redis)

```bash
cat > .env <<EOF
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
PUBLIC_ORIGIN=https://anyform.example.com
EOF
docker compose up -d --build
```

The compose file applies:

- a non-root user (`node`) and a read-only root filesystem; only `/data` and small tmpfs mounts
  are writable
- `cap_drop: ALL` and `no-new-privileges`
- workers on an `internal` network with **no internet egress**, and CPU, memory and PID limits
- Redis on the internal network only, with AOF persistence

Put a TLS-terminating reverse proxy in front of `web`. If the proxy rewrites `Host`, set
`TRUST_PROXY=true` (and preferably `PUBLIC_ORIGIN`). Configure a request-body limit at the proxy
that is slightly above `MAX_UPLOAD_MB`, and set a per-IP rate limit there too. The built-in
limiter is per process.

### URL import egress

The web container fetches user-supplied links, so it needs outbound HTTP(S). The application blocks
private and metadata addresses itself (see ARCHITECTURE.md). As defence in depth, also deny egress
from the web container to your internal networks and cloud metadata endpoints at the network or
firewall level, or route imports through an egress proxy. Use `IMPORT_ALLOWED_HOSTS` to restrict
sources, or `IMPORT_ENABLED=false` to turn the feature off.

### Worker isolation (production checklist)

Media parsers are a well-known attack surface. Treat a worker compromise as possible:

- Run workers in their own containers or VMs with no access to secrets other than `REDIS_URL`.
- Block all egress except Redis.
- Apply seccomp/AppArmor (Docker's default profile at minimum; gVisor or Firecracker for stronger
  isolation).
- Keep FFmpeg patched by rebuilding the image regularly (Debian security updates).
- Size `WORKER_CONCURRENCY × FFMPEG_THREADS` to the container CPU limit. Video re-encoding is the
  heaviest job type. A 2-hour 1080p video can take tens of minutes on 2 threads, which is why
  `JOB_TIMEOUT_SECONDS` defaults to 2 hours. Lower `MAX_VIDEO_DURATION_SECONDS` on small machines.
- Each sandbox process can use up to `SANDBOX_MEMORY_MB` of JS heap plus native image buffers, so
  budget about `WORKER_CONCURRENCY × (SANDBOX_MEMORY_MB + 512 MB)` of memory per worker.

## Storage

The implemented `StorageDriver` is the local filesystem. With several hosts, mount the same
volume (NFS/EFS/Filestore) at `ANYFORM_DATA_DIR` on web and worker nodes. Objects are private,
because downloads are only served through the authorised `/download` endpoint.

**Not yet implemented:** an S3-compatible driver. The interface
(`src/server/storage/index.ts`) is designed for one. `localPath()` would download to scratch,
and the download route would redirect to a short-lived presigned URL. Until it exists, do not
claim object-storage support.

## Configuration

See `.env.example` for every variable and its default. Production refuses to start without
`SESSION_SECRET`. Rotating the secret invalidates all sessions, so users lose access to their
in-flight results.

## Cleanup and retention

- Uploads expire after `UPLOAD_TTL_MINUTES` (unless an active job still needs them). Results
  expire after `RESULT_TTL_MINUTES`. Rejected uploads are deleted immediately.
- Metadata is kept `METADATA_RETENTION_HOURS` longer for history, then deleted. Redis keys also
  carry a TTL as a safety net.
- Orphaned objects (for example abandoned `.part` uploads) and stale scratch directories are
  removed.
- Cleanup runs every `CLEANUP_INTERVAL_SECONDS` in the local-mode web process and in every Redis
  worker. It is idempotent, so you can also run it from cron: `npm run cleanup` (or
  `node dist/cleanup.js`).

In local mode, avoid running `npm run cleanup` while the server is running. The file metadata
store only serialises writes within one process.

## Backups

- **Redis mode:** back up the Redis AOF/RDB (`redis-data` volume) if job history matters. Media
  is deliberately short-lived and does not need backups.
- **Local mode:** `data/meta/` holds the metadata as JSON files. Copy it while the server is
  stopped.

## Observability

- Structured JSON logs on stdout/stderr include `requestId`, `jobId` and `uploadId`. File
  contents, cookies, tokens and URLs are never logged.
- `GET /api/v1/metrics` (Prometheus format, requires `Authorization: Bearer $METRICS_TOKEN`)
  exposes per-process counters: uploads, upload/validation failures, conversions by result and
  code, conversion duration, queue wait, output bytes, cleanup counts and worker failures.
  Worker-process metrics are also emitted as `metric` log lines at debug level.

## Building artifacts

```bash
npm ci
npm run build        # .next/ (web) and dist/index.js, dist/cleanup.js (worker bundles)
npm start            # web
node dist/index.js   # worker (Redis mode); needs node_modules for bullmq/ioredis/zod
```

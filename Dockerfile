# syntax=docker/dockerfile:1.7
# One image runs either role:
#   web:    node_modules/.bin/next start
#   worker: node dist/index.js
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
# FFmpeg from Debian stable: receives security updates through the distribution.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini \
 && rm -rf /var/lib/apt/lists/*
# yt-dlp for YouTube/Spotify links: the standalone release (distribution packages go stale quickly).
ARG YTDLP_VERSION=2026.08.19
ADD --chmod=755 https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux /usr/local/bin/yt-dlp
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    ANYFORM_DATA_DIR=/data \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=root:root /app/package.json ./
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/.next ./.next
COPY --from=build --chown=root:root /app/dist ./dist
COPY --from=build --chown=root:root /app/next.config.ts ./
# Application files are root-owned and read-only to the service user; only /data is writable.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node_modules/.bin/next", "start"]

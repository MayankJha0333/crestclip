# CrestClip — one container with the API and the built web app.
# ffmpeg (with captions) ships via npm and yt-dlp is managed by the app itself; system packages: fonts + ffmpeg for yt-dlp.
FROM node:22-bookworm-slim

WORKDIR /app
# Fonts for captions in non-Latin scripts (Devanagari, Bengali, Tamil, Arabic…): the caption fonts in server/assets
# cover Latin letters only, and libass falls back to these for everything else.
# System ffmpeg: only for yt-dlp cutting parts straight from YouTube — the npm ffmpeg is fully static and crashes
# (segfault) on any web address. Renders keep using the npm one.
RUN apt-get update && apt-get install -y --no-install-recommends fontconfig fonts-noto-core ffmpeg && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
COPY devops/dashboard/package.json devops/dashboard/
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build -w web

ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
# Pre-download yt-dlp so the first request doesn't wait. The app keeps it updated daily after that.
RUN npm run setup-tools -w server

# yt-dlp plugin that fetches YouTube "PO tokens" from the helper in docker-compose (service `pot`, 127.0.0.1:4416).
# yt-dlp loads any plugin zip in its plugin folders (system-wide and the running user's). The helper is optional:
# without it yt-dlp just warns and carries on.
ADD https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/latest/download/bgutil-ytdlp-pot-provider.zip /etc/yt-dlp/plugins/bgutil-ytdlp-pot-provider.zip
RUN chmod 644 /etc/yt-dlp/plugins/bgutil-ytdlp-pot-provider.zip \
 && mkdir -p /root/.config/yt-dlp/plugins \
 && cp /etc/yt-dlp/plugins/bgutil-ytdlp-pot-provider.zip /root/.config/yt-dlp/plugins/

# which version this is (the git commit) — shown by /api/live so deploys can tell when the switch happened
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

EXPOSE 8787
VOLUME ["/data"]
CMD ["npm", "start"]

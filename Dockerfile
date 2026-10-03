# CrestClip — one container with the API and the built web app.
# No system packages needed: ffmpeg (with captions) ships via npm, and yt-dlp is managed by the app itself.
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build -w web

ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
# Pre-download yt-dlp so the first request doesn't wait. The app keeps it updated daily after that.
RUN npm run setup-tools -w server

# which version this is (the git commit) — shown by /api/live so deploys can tell when the switch happened
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

EXPOSE 8787
VOLUME ["/data"]
CMD ["npm", "start"]

#!/usr/bin/env bash
# Ship the code on this computer straight to crestclip.com, skipping GitHub Actions (for when its queue is slow).
#
#   ./devops/deploy/push-from-mac.sh
#
# It builds the same Docker image GitHub would, uploads it as "main", and waits until crestclip.com runs it.
# The server picks it up within a minute and goes back to the old version by itself if the new one doesn't start.
# Needs: Docker Desktop running, and gcloud logged in (gcloud auth login) with access to peakclip-510216.
# Skips GitHub's "does the image start" test — the server's own roll-back covers that.
set -euo pipefail
cd "$(dirname "$0")/../.."

REGISTRY=us-central1-docker.pkg.dev
IMAGE=$REGISTRY/peakclip-510216/crestclip/app
DOMAIN=crestclip.com

# the server shows the commit as its version, so ship only committed code
git diff --quiet HEAD || { echo "✗ You have changes that aren't committed. Commit them first, then run this again."; exit 1; }
SHA=$(git rev-parse HEAD)

command -v docker >/dev/null || { echo "✗ Docker isn't installed. Install Docker Desktop and start it."; exit 1; }
docker info >/dev/null 2>&1 || { echo "✗ Docker isn't running. Open Docker Desktop and wait until it says it's running."; exit 1; }
command -v gcloud >/dev/null || { echo "✗ gcloud isn't installed: https://cloud.google.com/sdk/docs/install"; exit 1; }
gcloud auth configure-docker "$REGISTRY" --quiet >/dev/null 2>&1

echo "▸ Building $SHA for the server (linux/amd64). The first time on an M-series Mac this takes 10–15 min; later ones reuse the cache."
docker buildx build --platform linux/amd64 \
  --build-arg APP_VERSION="$SHA" \
  -t "$IMAGE:$SHA" -t "$IMAGE:main" \
  --push .

echo "▸ Uploaded. Waiting for $DOMAIN to switch (the server checks every minute)…"
for _ in $(seq 1 90); do
  now=$(curl -fsS --max-time 10 "https://$DOMAIN/api/live" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("version", ""))' 2>/dev/null || true)
  if [ "$now" = "$SHA" ]; then echo "✓ https://$DOMAIN is running $SHA"; exit 0; fi
  echo "  live version: ${now:-no answer} — waiting…"
  sleep 10
done
echo "✗ The server didn't switch within 15 minutes. It probably didn't start and went back to the old version."
echo "  See why on the server:  sudo journalctl -u crestclip-update -n 120"
exit 1

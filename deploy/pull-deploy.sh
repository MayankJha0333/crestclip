#!/usr/bin/env bash
# CrestClip's auto-updater. It runs ON THE SERVER every minute (systemd: crestclip-update.timer), as root.
#
#   1. Ask the image store whether the app version tagged "main" changed (GitHub moves that tag after each
#      successful build).
#   2. If it did: take this version's server files out of the image, switch to it, and check it answers.
#   3. If it doesn't answer: go back to the version that was running, and never try that broken one again.
#
# Nothing logs in to this server to deploy — it fetches new versions itself with the machine's own Google account.
# Watch it:  journalctl -u crestclip-update -f
set -euo pipefail

REPO_IMAGE=us-central1-docker.pkg.dev/peakclip-510216/crestclip/app
DOMAIN=crestclip.com
APP_DIR=/opt/crestclip

cd "$APP_DIR"
COMPOSE=(docker compose -f docker-compose.prod.yml --env-file deploy.env)
say() { echo "▸ $*"; }

[ -f .env ] || { echo "✗ $APP_DIR/.env is missing — upload the settings file first."; exit 1; }

# log in to the image store with this machine's own Google account (no stored password)
TOKEN=$(curl -fsS -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["access_token"])')
echo "$TOKEN" | docker login -u oauth2accesstoken --password-stdin "https://${REPO_IMAGE%%/*}" >/dev/null 2>&1

if ! docker pull -q "$REPO_IMAGE:main" >/dev/null 2>&1; then
  [ -f deploy.env ] || { echo "Waiting for the first version from GitHub ($REPO_IMAGE:main isn't there yet)."; exit 0; }
  echo "✗ Couldn't check the image store for a new version — will try again in a minute."
  exit 0
fi
NEW=$(docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$REPO_IMAGE:main" | grep "^$REPO_IMAGE@" | head -1)
CURRENT=$(sed -n 's/^IMAGE=//p' deploy.env 2>/dev/null || true)

[ "$NEW" = "$CURRENT" ] && exit 0                       # already running it
grep -qxF "$NEW" .failed-versions 2>/dev/null && exit 0  # tried before and it didn't start

# this version's compose file, Caddyfile and updater live inside its image
take_files() {
  local cid
  cid=$(docker create "$1")
  rm -rf .incoming && mkdir .incoming
  docker cp "$cid:/app/docker-compose.prod.yml" .incoming/ >/dev/null
  docker cp "$cid:/app/deploy" .incoming/deploy >/dev/null
  docker rm "$cid" >/dev/null
  mkdir -p deploy
  cp .incoming/docker-compose.prod.yml docker-compose.prod.yml
  if ! cmp -s .incoming/deploy/Caddyfile deploy/Caddyfile; then
    cp .incoming/deploy/Caddyfile deploy/Caddyfile # cp keeps the file Caddy has mounted
    CADDY_CHANGED=1
  fi
  cp .incoming/deploy/pull-deploy.sh deploy/pull-deploy.sh.next
}
start() {
  printf 'IMAGE=%s\nDOMAIN=%s\n' "$1" "$DOMAIN" >deploy.env
  "${COMPOSE[@]}" up -d --remove-orphans
  if [ "${CADDY_CHANGED:-0}" = 1 ]; then
    "${COMPOSE[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || "${COMPOSE[@]}" restart caddy
  fi
}
answers() {
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null http://127.0.0.1:8787/api/live && return 0
    sleep 2
  done
  return 1
}

say "New version found: $NEW"
CADDY_CHANGED=0
take_files "$NEW"
say "Switching to it"
start "$NEW"
if answers; then
  # the updater itself may have changed — swap it in for the next run (rename is safe while running)
  mv deploy/pull-deploy.sh.next deploy/pull-deploy.sh
  rm -rf .incoming
  say "New version is live ✓ ($(curl -fsS http://127.0.0.1:8787/api/live))"
  docker image prune -af --filter "until=168h" >/dev/null 2>&1 || true
  exit 0
fi

echo "✗ The new version didn't start. Its last log lines:"
"${COMPOSE[@]}" logs --tail 80 app || true
echo "$NEW" >>.failed-versions
rm -f deploy/pull-deploy.sh.next
if [ -n "$CURRENT" ]; then
  say "Going back to the version that was running: $CURRENT"
  CADDY_CHANGED=0
  take_files "$CURRENT"
  rm -f deploy/pull-deploy.sh.next
  start "$CURRENT"
  if answers; then say "Previous version is back up — the site stayed on it."; else echo "✗ The previous version didn't start either."; fi
fi
rm -rf .incoming
exit 1

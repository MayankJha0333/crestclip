#!/usr/bin/env bash
# CrestClip's auto-updater. Runs ON THE SERVER every minute (systemd: crestclip-update.timer), as root.
#
#   1. Settings: is there a newer version of the secret "crestclip-env" in Google Secret Manager?
#      → write it to /opt/crestclip/.env (readable by root only).
#   2. Code: did GitHub upload a new app image tagged "main"?
#   3. If either changed: switch one piece at a time so the site never goes down —
#        web-1 → wait until it answers → web-2 → wait → workers, scheduler, admin pages, Caddy.
#      Caddy keeps sending visitors to whichever web copy is up. Workers hand unfinished jobs back to the queue.
#   4. If the new version doesn't answer: go back to the one that was running, and never try that one again.
#
# Nothing logs in to this server to deploy — it fetches everything itself with the machine's own Google account.
# Watch it:  sudo journalctl -u crestclip-update -f
set -euo pipefail

APP_DIR=/opt/crestclip
REPO_IMAGE=us-central1-docker.pkg.dev/peakclip-510216/crestclip/app
DOMAIN=crestclip.com
SECRET=crestclip-env
WEB_PORTS=(8787 8788)
WEB_SERVICES=(web-1 web-2)

cd "$APP_DIR"
DEV="$APP_DIR/devops/server"
COMPOSE=(docker compose -f "$DEV/docker-compose.prod.yml" --env-file "$APP_DIR/deploy.env" --env-file "$DEV/sizing.env")
say() { echo "▸ $*"; }

MD=http://metadata.google.internal/computeMetadata/v1
TOKEN=$(curl -fsS -H 'Metadata-Flavor: Google' "$MD/instance/service-accounts/default/token" |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["access_token"])')
PROJECT=$(curl -fsS -H 'Metadata-Flavor: Google' "$MD/project/project-id")

# ---------------- 1. settings from Secret Manager ----------------
# .env.version = the secret version that is running. .env.pending = a newer one written to .env but not running yet
# (its version number inside); .env.previous = the settings that ran before it, to go back to.
SECRETS_CHANGED=0
SM="https://secretmanager.googleapis.com/v1/projects/$PROJECT/secrets/$SECRET"
# asking which version is newest is free; reading the value only happens when it changed
LATEST=$(curl -fsS -H "Authorization: Bearer $TOKEN" "$SM/versions/latest" 2>/dev/null |
  python3 -c 'import json, sys; d = json.load(sys.stdin); print(d["name"].rsplit("/", 1)[1] if d.get("state") == "ENABLED" else "")' 2>/dev/null || true)
HAVE=$(cat .env.version 2>/dev/null || true)
PENDING=$(cat .env.pending 2>/dev/null || true)
if [ -n "$LATEST" ] && [ "$LATEST" != "$HAVE" ]; then
  if [ "$LATEST" = "$PENDING" ]; then
    SECRETS_CHANGED=1 # written last time, but the switch didn't finish — try again
  else
    umask 077
    if curl -fsS -H "Authorization: Bearer $TOKEN" "$SM/versions/$LATEST:access" |
      python3 -c 'import base64, json, sys; sys.stdout.write(base64.b64decode(json.load(sys.stdin)["payload"]["data"]).decode())' >.env.new &&
      [ -s .env.new ]; then
      # keep the settings that actually ran (not an earlier pending one) to go back to
      [ -z "$PENDING" ] && [ -f .env ] && cp -p .env .env.previous
      mv .env.new .env
      chmod 600 .env
      echo "$LATEST" >.env.pending
      SECRETS_CHANGED=1
      say "New settings from Secret Manager (version $LATEST)"
    else
      rm -f .env.new
      echo "✗ Couldn't read secret $SECRET version $LATEST — keeping the current settings."
    fi
  fi
elif [ -z "$LATEST" ] && [ ! -f .env.version ] && [ ! -f .secret-warned ]; then
  echo "! No secret \"$SECRET\" readable in Secret Manager yet — using the existing .env (run devops/gcp/setup.sh)."
  touch .secret-warned
fi
[ -f .env ] || { echo "✗ $APP_DIR/.env is missing and Secret Manager has no settings — run devops/gcp/setup.sh first."; exit 1; }
settings_done() { [ -f .env.pending ] && mv .env.pending .env.version; true; }

# ---------------- 2. a new app image? ----------------
echo "$TOKEN" | docker login -u oauth2accesstoken --password-stdin "https://${REPO_IMAGE%%/*}" >/dev/null 2>&1 || true
if ! docker pull -q "$REPO_IMAGE:main" >/dev/null 2>&1; then
  echo "✗ Couldn't check the image store for a new version — will try again in a minute."
  [ "$SECRETS_CHANGED" = 1 ] || exit 0
fi
NEW=$(docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$REPO_IMAGE:main" 2>/dev/null | grep "^$REPO_IMAGE@" | head -1 || true)
CURRENT=$(sed -n 's/^IMAGE=//p' deploy.env 2>/dev/null || true)

IMAGE_CHANGED=0
if [ -n "$NEW" ] && [ "$NEW" != "$CURRENT" ] && ! grep -qxF "$NEW" .failed-versions 2>/dev/null; then IMAGE_CHANGED=1; fi
[ "$IMAGE_CHANGED" = 1 ] || [ "$SECRETS_CHANGED" = 1 ] || exit 0

# ---------------- 3. switch, one piece at a time ----------------
# this version's server files (compose, Caddyfile, sizing, this updater) live inside its image
CADDY_CHANGED=0
take_files() {
  local cid f
  cid=$(docker create "$1") || return 1
  rm -rf .incoming && mkdir -p .incoming
  docker cp "$cid:/app/devops/server/." .incoming/ >/dev/null || { docker rm "$cid" >/dev/null; return 1; }
  docker rm "$cid" >/dev/null
  mkdir -p "$DEV"
  for f in docker-compose.prod.yml sizing.env install.sh push-from-mac.sh; do
    if [ -f ".incoming/$f" ]; then cp ".incoming/$f" "$DEV/$f"; fi
  done
  if ! cmp -s .incoming/Caddyfile "$DEV/Caddyfile"; then
    cp .incoming/Caddyfile "$DEV/Caddyfile" # cp (not mv) keeps the file Caddy has mounted
    CADDY_CHANGED=1
  fi
  cp .incoming/update.sh "$DEV/update.sh.next" || return 1
}

answers() { # $1 = port
  local _
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null "http://127.0.0.1:$1/api/live" && return 0
    sleep 2
  done
  return 1
}

# the containers that read .env (Caddy, Redis, the token helper and the log viewer don't — they're never restarted
# just for new settings, so open connections and uploads aren't cut)
APP_SERVICES=(worker scheduler dashboard)
OTHER_SERVICES=(dozzle caddy)

start() { # $1 = image, $2 = "force": recreate the app containers even if nothing in their config changed (new settings)
  local force=() i
  [ "${2:-}" = force ] && force=(--force-recreate)
  printf 'IMAGE=%s\nDOMAIN=%s\n' "$1" "$DOMAIN" >deploy.env
  "${COMPOSE[@]}" up -d --remove-orphans redis pot || return 1
  for i in "${!WEB_SERVICES[@]}"; do
    say "Switching ${WEB_SERVICES[$i]} (the other copy keeps serving)"
    "${COMPOSE[@]}" up -d --no-deps "${force[@]}" "${WEB_SERVICES[$i]}" || return 1
    answers "${WEB_PORTS[$i]}" || return 1
  done
  say "Switching workers (they hand running jobs back to the queue), scheduler and admin pages"
  "${COMPOSE[@]}" up -d --no-deps --remove-orphans "${force[@]}" "${APP_SERVICES[@]}" || return 1
  "${COMPOSE[@]}" up -d --no-deps "${OTHER_SERVICES[@]}" || return 1
  if [ "$CADDY_CHANGED" = 1 ]; then
    "${COMPOSE[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || "${COMPOSE[@]}" restart caddy
  fi
}

finish() {
  [ -f "$DEV/update.sh.next" ] && mv "$DEV/update.sh.next" "$DEV/update.sh" # the updater may have changed itself
  rm -rf .incoming
}

# --- 3a. new settings first, on the version that's running — so if they break the app, we know it was them
if [ "$SECRETS_CHANGED" = 1 ] && [ -n "$CURRENT" ]; then
  say "Applying new settings (version $(cat .env.pending 2>/dev/null))"
  take_files "$CURRENT" || { echo "✗ Couldn't read the running version's files — will try again in a minute."; exit 1; }
  rm -f "$DEV/update.sh.next"
  if start "$CURRENT" force; then
    settings_done
    say "New settings are live ✓"
  else
    echo "✗ The app didn't start with the new settings — going back to the previous ones."
    echo "  Fix them with devops/secrets/secrets.sh edit; a newer version is applied within a minute."
    "${COMPOSE[@]}" logs --tail 40 web-1 || true
    [ -f .env.previous ] && cp -p .env.previous .env
    mv .env.pending .env.failed-version 2>/dev/null || true # don't retry this version
    cp .env.failed-version .env.version 2>/dev/null || true
    start "$CURRENT" force || echo "✗ It didn't start with the previous settings either."
    rm -rf .incoming
    exit 1
  fi
fi
[ "$IMAGE_CHANGED" = 1 ] || { finish; exit 0; }

# --- 3b. the new app version
say "New version found: $NEW"
take_files "$NEW" || { echo "✗ Couldn't read the new version's files — will try again in a minute."; exit 1; }
if start "$NEW"; then
  finish
  settings_done
  say "Live ✓ ($(curl -fsS http://127.0.0.1:${WEB_PORTS[0]}/api/live))"
  docker image prune -af --filter "until=168h" >/dev/null 2>&1 || true
  exit 0
fi

echo "✗ The new version didn't start. Its last log lines:"
"${COMPOSE[@]}" logs --tail 80 web-1 web-2 || true
rm -f "$DEV/update.sh.next"
if [ -n "$CURRENT" ]; then
  say "Going back to the version that was running: $CURRENT"
  CADDY_CHANGED=0
  if take_files "$CURRENT" && rm -f "$DEV/update.sh.next" && start "$CURRENT"; then
    # the old version starts and the new one didn't: it's the new version's fault — never try it again
    echo "$NEW" >>.failed-versions
    say "Previous version is back up — the site stayed on it."
  else
    echo "✗ The previous version didn't start either — probably not the new version's fault (database down?)."
    echo "  Will try the new version again in a minute."
  fi
fi
rm -rf .incoming
exit 1

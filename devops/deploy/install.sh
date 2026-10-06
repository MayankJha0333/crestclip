#!/usr/bin/env bash
# One-time server setup (also moves an existing server from the old single-container layout to this one).
# Run it ON THE SERVER, straight from the app image — nothing to upload:
#
#   sudo docker run --rm --entrypoint cat us-central1-docker.pkg.dev/peakclip-510216/crestclip/app:main \
#     /app/devops/deploy/install.sh | sudo bash
#
# It: installs Docker if missing, puts devops/deploy in /opt/crestclip, installs the every-minute updater
# (systemd), removes the old layout's files, then runs the updater once — which fetches the settings from Secret
# Manager and starts every container (a ~30-second blip the first time, while the old single container stops).
# Safe to run again.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run it as root (… | sudo bash)"; exit 1; }

APP_DIR=/opt/crestclip
REPO_IMAGE=us-central1-docker.pkg.dev/peakclip-510216/crestclip/app
say() { printf '▸ %s\n' "$*"; }

if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
mkdir -p "$APP_DIR/devops/deploy" "$APP_DIR/data"
cd "$APP_DIR"

say "Logging in to the image store with this machine's Google account"
TOKEN=$(curl -fsS -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["access_token"])')
echo "$TOKEN" | docker login -u oauth2accesstoken --password-stdin "https://${REPO_IMAGE%%/*}" >/dev/null
docker pull -q "$REPO_IMAGE:main" >/dev/null

say "Copying the server files out of the image"
cid=$(docker create "$REPO_IMAGE:main")
docker cp "$cid:/app/devops/deploy/." "$APP_DIR/devops/deploy/" >/dev/null
docker rm "$cid" >/dev/null
chmod 755 "$APP_DIR/devops/deploy/update.sh"

say "Installing the auto-updater (checks for new code and new settings every minute)"
cat >/etc/systemd/system/crestclip-update.service <<'UNIT'
[Unit]
Description=CrestClip auto-update (new app version from GitHub, new settings from Secret Manager)
After=docker.service network-online.target
Wants=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=/bin/bash /opt/crestclip/devops/deploy/update.sh
TimeoutStartSec=1200
UNIT
cat >/etc/systemd/system/crestclip-update.timer <<'UNIT'
[Unit]
Description=Check for a new CrestClip version or new settings every minute

[Timer]
OnBootSec=30s
OnUnitInactiveSec=60s
AccuracySec=5s

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable crestclip-update.timer >/dev/null
systemctl stop crestclip-update.timer # not while we switch layouts
for _ in $(seq 1 120); do # an update that's already running (the old updater) finishes first
  systemctl is-active --quiet crestclip-update.service || break
  sleep 5
done

# ---- moving from the old layout (one "app" container, files in /opt/crestclip/deploy) ----
if docker ps -a --format '{{.Names}}' | grep -qx 'crestclip-app-1'; then
  say "Stopping the old single app container (the new layout runs web, workers and scheduler separately)"
  docker rm -f crestclip-app-1 >/dev/null
fi
rm -rf "$APP_DIR/deploy" "$APP_DIR/docker-compose.prod.yml" "$APP_DIR/.incoming"
# make the updater start everything now, even if this image is the one already recorded
sed -i '/^IMAGE=/d' deploy.env 2>/dev/null || true
rm -f .failed-versions .secret-warned

say "Starting everything"
bash "$APP_DIR/devops/deploy/update.sh" || true
systemctl start crestclip-update.timer

echo
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep crestclip || true
echo
say "Done. Watch the updater:  sudo journalctl -u crestclip-update -f"
echo "  Admin pages:  https://crestclip.com/admin/   (sign in to CrestClip as an admin first)"

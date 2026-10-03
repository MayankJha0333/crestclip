#!/usr/bin/env bash
# One-time server setup. Upload this file and pull-deploy.sh to the server (SSH window → UPLOAD FILE), then run:
#   sudo bash server-install.sh
#
# It installs Docker (if needed) and CrestClip's auto-updater, which checks for a new app version every minute
# and switches to it by itself. Safe to run again.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "Run it with sudo:  sudo bash server-install.sh"; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
APP_DIR=/opt/crestclip
say() { printf '▸ %s\n' "$*"; }

[ -f "$HERE/pull-deploy.sh" ] || { echo "✗ pull-deploy.sh must be uploaded next to this file."; exit 1; }
[ -f "$APP_DIR/.env" ] || { echo "✗ $APP_DIR/.env is missing — upload and unpack the settings file first."; exit 1; }

if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi

say "Installing the auto-updater"
mkdir -p "$APP_DIR/deploy"
install -m 755 "$HERE/pull-deploy.sh" "$APP_DIR/deploy/pull-deploy.sh"

cat >/etc/systemd/system/crestclip-update.service <<'UNIT'
[Unit]
Description=CrestClip auto-update (switches to a new app version when GitHub uploads one)
After=docker.service network-online.target
Wants=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=/bin/bash /opt/crestclip/deploy/pull-deploy.sh
TimeoutStartSec=900
UNIT

cat >/etc/systemd/system/crestclip-update.timer <<'UNIT'
[Unit]
Description=Check for a new CrestClip version every minute

[Timer]
OnBootSec=30s
OnUnitInactiveSec=60s
AccuracySec=5s

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now crestclip-update.timer >/dev/null

# the old push-style deploy user isn't needed any more
if id deploy >/dev/null 2>&1; then
  say "Removing the old 'deploy' login"
  rm -f /home/deploy/.ssh/authorized_keys
fi

rm -f "$HERE/server-install.sh" "$HERE/pull-deploy.sh"
say "Done. The server now checks for new versions every minute."
echo "  Watch it:  journalctl -u crestclip-update -f"

#!/usr/bin/env bash
# CrestClip's production settings live in ONE place: Google Secret Manager, secret "crestclip-env"
# (the whole .env file as one versioned secret). The server checks every minute and applies a new version by itself,
# restarting one piece at a time. Nobody edits settings on the server any more.
#
#   ./devops/secrets/secrets.sh edit          open the settings in an editor, then upload them (most common)
#   ./devops/secrets/secrets.sh keys          list the setting names (no values)
#   ./devops/secrets/secrets.sh pull          download to devops/secrets/production.env (never committed)
#   ./devops/secrets/secrets.sh push [file]   upload a file as the new version (shows which names changed first)
#   ./devops/secrets/secrets.sh history       list versions (newest first)
#   ./devops/secrets/secrets.sh rollback N    make version N the newest again
#
# Needs gcloud, logged in with an account that can manage secrets in peakclip-510216 (gcloud auth login).
set -euo pipefail

PROJECT=peakclip-510216 # always explicit: your gcloud default may be another project
SECRET=crestclip-env
KEEP=3 # versions kept for rollback. Google bills every version not destroyed (free up to 6), so older ones are destroyed
HERE=$(cd "$(dirname "$0")" && pwd)
LOCAL="$HERE/production.env"
G=(gcloud --project "$PROJECT" --quiet)

command -v gcloud >/dev/null || { echo "✗ gcloud isn't installed: https://cloud.google.com/sdk/docs/install"; exit 1; }
"${G[@]}" secrets describe "$SECRET" >/dev/null 2>&1 || { echo "✗ Secret $SECRET doesn't exist (or you can't see it). Run devops/gcp/setup.sh first."; exit 1; }

latest() { "${G[@]}" secrets versions access latest --secret="$SECRET" 2>/dev/null || true; }

# names added / removed / changed between two .env texts (values never shown)
diff_keys() {
  python3 - "$1" "$2" <<'PY'
import re, sys
def parse(p):
    d = {}
    for line in open(p, encoding="utf-8"):
        m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$", line)
        if m and not line.lstrip().startswith("#"):
            d[m.group(1)] = m.group(2).strip("'\"")  # last line wins, like the app
    return d
old, new = parse(sys.argv[1]), parse(sys.argv[2])
added = sorted(set(new) - set(old)); removed = sorted(set(old) - set(new))
changed = sorted(k for k in set(old) & set(new) if old[k] != new[k])
for label, keys in (("+ added", added), ("- removed", removed), ("~ changed", changed)):
    for k in keys: print(f"  {label}: {k}")
if not (added or removed or changed): print("  (no changes)")
sys.exit(0 if (added or removed or changed) else 3)
PY
}

push() {
  local file=$1 cur
  [ -s "$file" ] || { echo "✗ $file is empty or missing."; exit 1; }
  cur=$(mktemp)
  latest >"$cur"
  echo "Changes compared with the live settings:"
  if ! diff_keys "$cur" "$file"; then rm -f "$cur"; echo "Nothing to upload."; return 0; fi
  rm -f "$cur"
  read -r -p "Upload these as the new live settings? [y/N] " ok
  [ "$ok" = y ] || [ "$ok" = Y ] || { echo "Cancelled."; return 1; }
  "${G[@]}" secrets versions add "$SECRET" --data-file="$file" >/dev/null
  echo "✓ Uploaded. The server applies them within a minute (one piece at a time — the site stays up)."
  echo "  If the app won't start with them, the server goes back to the previous settings by itself."
  # keep only the newest $KEEP versions (disabled ones are billed too — destroyed ones aren't), so it stays free
  "${G[@]}" secrets versions list "$SECRET" --filter="state!=DESTROYED" --sort-by="~createTime" --format="value(name)" |
    tail -n +$((KEEP + 1)) | while read -r v; do "${G[@]}" secrets versions destroy "${v##*/}" --secret="$SECRET" >/dev/null && echo "  (deleted old version ${v##*/})"; done
}

case "${1:-}" in
  keys)
    latest | sed -n 's/^[[:space:]]*\([A-Z0-9_]*\)[[:space:]]*=.*/\1/p' | sort -u
    ;;
  pull)
    umask 077
    latest >"$LOCAL"
    echo "✓ Saved to $LOCAL (git ignores it). Edit, then: ./devops/secrets/secrets.sh push"
    ;;
  push)
    push "${2:-$LOCAL}"
    ;;
  edit)
    umask 077
    tmp=$(mktemp -t crestclip-env.XXXXXX)
    trap 'rm -f "$tmp"' EXIT
    latest >"$tmp"
    "${EDITOR:-nano}" "$tmp"
    push "$tmp"
    ;;
  history)
    "${G[@]}" secrets versions list "$SECRET" --format="table(name, state, createTime.date('%Y-%m-%d %H:%M'))"
    ;;
  rollback)
    v=${2:?Which version? See: ./devops/secrets/secrets.sh history}
    umask 077
    tmp=$(mktemp)
    trap 'rm -f "$tmp"' EXIT
    "${G[@]}" secrets versions access "$v" --secret="$SECRET" >"$tmp"
    push "$tmp"
    ;;
  *)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac

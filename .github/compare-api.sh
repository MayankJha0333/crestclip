#!/usr/bin/env bash
# "Same answers as main": runs main's app and this branch's app on the same sample data and compares what every
# API answer and access check returns. Any difference means this change altered what people see.
#
# Needs: Docker images crestclip:old (main) and crestclip:new (this branch), and an empty MongoDB on 127.0.0.1:27017.
# Run by .github/workflows/compare-api.yml on pull requests.
set -euo pipefail

URI=mongodb://127.0.0.1:27017
DB=cmp
TOKEN=compare-test-session-token
OUT=$(mktemp -d)

echo "▸ Filling the test database"
docker run --rm --network host -e MONGODB_URI=$URI -e MONGODB_DB=$DB crestclip:new npx tsx server/src/scripts/seed-compare.ts

# name | path | signed in?
CHECKS=(
  "me|/api/auth/me|yes"
  "me-signed-out|/api/auth/me|no"
  "me-expired-session|/api/auth/me|expired"
  "projects|/api/projects|yes"
  "projects-signed-out|/api/projects|no"
  "project-p1|/api/projects/p1|yes"
  "project-p2|/api/projects/p2|yes"
  "project-p3|/api/projects/p3|yes"
  "project-p4|/api/projects/p4|yes"
  "project-g1|/api/projects/g1|yes"
  "project-g2|/api/projects/g2|yes"
  "project-g3|/api/projects/g3|yes"
  "project-g4|/api/projects/g4|yes"
  "project-someone-elses|/api/projects/pb|yes"
  "posts|/api/posts|yes"
  "posts-for-clip|/api/posts?clipId=c2|yes"
  "autopilots|/api/autopilots|yes"
  "autopilot-ap1|/api/autopilots/ap1|yes"
  "autopilot-ap2|/api/autopilots/ap2|yes"
  "autopilot-someone-elses|/api/autopilots/apb|yes"
  "billing|/api/billing/account|yes"
  "site|/api/site|no"
  "auth-config|/api/auth/config|no"
  "media-own-missing-file|/media/projects/p1/c2.jpg|yes"
  "media-signed-out|/media/projects/p1/c2.jpg|no"
  "media-someone-elses|/media/projects/pb/c10.jpg|yes"
  "app-page|/app|yes"
  "favicon|/favicon.svg|no"
)

run() {
  local name=$1 image=$2
  echo "▸ Starting the $name version"
  docker run -d --name "app-$name" --network host \
    -e CRESTCLIP_FAKE_AI=1 -e PUBLIC_URL=http://localhost:8787 \
    -e MONGODB_URI=$URI -e MONGODB_DB=$DB -e REDIS_URL=off "$image" >/dev/null
  for _ in $(seq 1 60); do curl -fsS -o /dev/null http://127.0.0.1:8787/api/live && break; sleep 2; done
  mkdir -p "$OUT/$name"
  for c in "${CHECKS[@]}"; do
    IFS='|' read -r key path auth <<<"$c"
    local cookie=()
    [ "$auth" = yes ] && cookie=(-H "Cookie: cc_session=$TOKEN")
    [ "$auth" = expired ] && cookie=(-H "Cookie: cc_session=expired-token")
    local code
    code=$(curl -s -o "$OUT/$name/$key.body" -w '%{http_code}' "${cookie[@]}" "http://127.0.0.1:8787$path")
    {
      echo "HTTP $code"
      if python3 -m json.tool --sort-keys "$OUT/$name/$key.body" >/dev/null 2>&1; then
        python3 -m json.tool --sort-keys "$OUT/$name/$key.body"
      else
        echo "(not JSON, $(wc -c <"$OUT/$name/$key.body") bytes)"
      fi
    } >"$OUT/$name/$key.txt"
    rm -f "$OUT/$name/$key.body"
  done
  # the same request a few times, to see the speed difference too
  local t0 t1
  t0=$(date +%s%N)
  for _ in $(seq 1 20); do curl -s -o /dev/null -H "Cookie: cc_session=$TOKEN" http://127.0.0.1:8787/api/projects; done
  t1=$(date +%s%N)
  echo "  /api/projects ×20: $(((t1 - t0) / 1000000)) ms"
  docker logs "app-$name" >"$OUT/$name.log" 2>&1 || true
  docker rm -f "app-$name" >/dev/null
}

run old crestclip:old
run new crestclip:new

echo
echo "▸ Sample answers (new version)"
head -c 1500 "$OUT/new/projects.txt"; echo; echo "…"
echo
if diff -ru "$OUT/old" "$OUT/new"; then
  echo "✓ All ${#CHECKS[@]} checks give exactly the same answer in both versions"
else
  echo "✗ The answers above differ between main and this change"
  echo "--- new version log (last 60 lines) ---"; tail -60 "$OUT/new.log"
  exit 1
fi

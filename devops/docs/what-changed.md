# What changed (October 2026)

## Before vs after

| | Before | After |
|---|---|---|
| **App** | 1 container doing everything | website ×2, workers ×2, 1 scheduler — each its own container |
| **Job queue** | in the app's memory — lost on restart, stuck jobs blocked everything | in Redis — survives restarts, stuck jobs re-run once, then fail with a refund |
| **Videos at once** | 1 (the `5` setting was silently ignored) | 10 in progress (2 workers × 5), max 4 heavy renders at once — set in `deploy/sizing.env` |
| **Load balancing** | none — a crash or deploy took the site down | Caddy spreads visitors over 2 copies, skips one that's down |
| **Settings** | a file on the server, edited by hand over SSH | one secret in Google Secret Manager, edited with `secrets.sh`, versioned, auto-applied |
| **Deploys** | switch everything at once | one piece at a time — no downtime; goes back by itself if broken |
| **Seeing what's going on** | SSH + `docker logs` | `/admin/` pages: overview, jobs, live logs, costs |
| **Costs** | unknown | `/admin/costs` |
| **Files** | `deploy/` + `docker-compose.prod.yml` at the top | everything in `devops/` |
| **Monthly price** | ≈ $118 | ≈ $118 — same server, nothing new to pay for |

## Changes in the app code (`server/src/`)

Needed so the app can run as several copies at once without stepping on itself.

| File | Change | Why |
|---|---|---|
| `index.ts` | starts only what its `ROLE` needs (`web` / `worker` / `scheduler` / `all`) | so timers like "post at 5 pm" run in exactly one place |
| `infra/queue.ts` | job queue moved into Redis (BullMQ library) | jobs survive restarts; any worker can take any job |
| `infra/jobs.ts` (new) | what each job type does, and the clean-up if it gets stuck twice | stuck work is marked failed + refunded, not left "processing" forever |
| `infra/shared.ts` (new) | small shared store + locks in Redis | sign-in, rate limits and "one render per clip" work across copies |
| `modules/auth/*`, `modules/publishing/*` | Google sign-in and YouTube/Instagram connect use the shared store | the sign-in reply may land on the other website copy |
| `db/posts.ts`, `publishing.service.ts` | a post is "claimed" once; only posts stuck 30+ min are reset | a clip is never posted twice |
| `modules/autopilot/autopilot.engine.ts` | only the scheduler runs Autopilot; website copies just book posts | no double Autopilot runs |
| `pipeline/process.ts`, `pipeline/footage.ts` | shared lock per clip render and per video download | two workers never write the same file |
| `app.ts` | new `/admin/gate`: "is this an admin?" | Caddy uses it to lock every `/admin` page |
| `config.ts` | new settings: `ROLE`, `JOB_MAX_MINUTES`, `RENDER_MAX_MINUTES`, `SECRET_KEY_HEX` | see above |
| `lib/secrets.ts` | can read the account key from settings (`SECRET_KEY_HEX`) | a new server can read connected accounts |
| `infra/tools.ts` | only the scheduler checks for yt-dlp updates | 5 containers don't download it at once |
| `pipeline/transcribe.ts` | each transcribed chunk is saved | a job that restarts doesn't pay for the AI again |
| `modules/projects/*`, `web/…/ProcessingCard.tsx` | "In line · N videos ahead" | people see their place in the queue |

## Earlier fixes (same week)

| Commit | Fix |
|---|---|
| `7e03a59` | ffmpeg crashed (code −11) on every "download only the clip parts" → normal ffmpeg for downloads; a download with no progress for 3 min is stopped and retried |
| `8a3f09f` | a setting added at the bottom of `.env` was ignored → the last line now wins |

## New in `devops/`

| File | What it is |
|---|---|
| `deploy/docker-compose.prod.yml` | the list of containers and how they're started |
| `deploy/Caddyfile` | HTTPS, load balancer, `/admin` lock |
| `deploy/sizing.env` | how many workers / videos / renders |
| `deploy/update.sh` | every-minute updater: new settings → new image → switch one by one → go back if broken |
| `deploy/install.sh` | one-time move to this setup |
| `secrets/secrets.sh` | edit / history / rollback of the settings |
| `gcp/setup.sh` | one-time Google Cloud setup (Secret Manager, permissions, billing export) |
| `dashboard/` | admin pages: overview, jobs board, costs |

## How it was checked

- Type checks and the web build pass; CI now also starts a worker and the admin pages from the image.
- Job queue, tested against a real Redis:
  - jobs spread over 2 workers
  - a waiting person's video jumps the line
  - a stuck job re-runs once, then fails with a refund
  - two deploys mid-video don't fail it
- Load balancer: tested with the real Caddy — one copy down → still 200s; `/admin` locked for non-admins.
- Updater: 10 scenarios (bad settings, broken version, database down…) — each went back correctly.
- Costs maths: checked against hand-worked numbers.
- An independent review found 6 problems (e.g. a restart could post a clip twice) — all fixed and re-tested.

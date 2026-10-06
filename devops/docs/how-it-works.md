# How CrestClip runs

One Google Cloud server (`crestclip-server-mumbai`, Mumbai) runs everything in Docker containers. One app image,
started several times — a setting called `ROLE` tells each copy what its job is.

## The picture

```
                       visitors
                          │
              ┌───────────▼───────────┐
              │  Caddy                │  HTTPS + load balancer
              └─────┬───────────┬─────┘
                    │           │                 /admin/* (admins only)
              ┌─────▼───┐ ┌─────▼───┐             ├─ dashboard   overview, jobs, costs
              │  web-1  │ │  web-2  │             └─ dozzle      live logs
              └─────┬───┘ └───┬─────┘
                    │ add job │
              ┌─────▼─────────▼─────┐
              │  Redis (job queue)  │
              └─────┬─────────┬─────┘
                    │ take job│
              ┌─────▼───┐ ┌───▼─────┐ ┌───────────┐
              │ worker  │ │ worker  │ │ scheduler │  posts, Autopilot, clean-up
              └─────────┘ └─────────┘ └───────────┘

   Settings: Google Secret Manager ──(server checks every minute)──▶ /opt/crestclip/.env
```

## The containers

| Container | Job | How many |
|---|---|---|
| `caddy` | HTTPS for crestclip.com, spreads visitors over the two website copies | 1 |
| `web-1`, `web-2` | the website + API. Only *adds* jobs, never does heavy work | 2 |
| `worker` | takes jobs from the queue: clip videos, render clips | 2 (`sizing.env`) |
| `scheduler` | posts at the booked time, Autopilot, deletes old projects, fixes the queue | exactly 1 |
| `redis` | the job queue (saved to disk — a restart loses nothing) | 1 |
| `pot` | helper that gets YouTube's "I'm a real player" token | 1 |
| `dashboard` | admin pages: overview, jobs, costs | 1 |
| `dozzle` | admin page: live logs | 1 |

## 1. Load balancing

**Load balancing** = spreading visitors across several copies of the website, and skipping one that's down.

1. A visitor arrives at Caddy.
2. Caddy picks `web-1` or `web-2` and gives the browser a small cookie, so it **keeps using the same copy**.
3. Every 5 seconds Caddy asks each copy "are you OK?" (`/api/live`).
4. A copy that doesn't answer is **skipped** until it's back. A request that hits a copy mid-restart is
   **retried on the other one** — the visitor never sees an error.

## 2. Jobs and workers

1. Someone clicks **New clips** → `web-1` saves the project and **adds a job** to the queue in Redis.
2. A free **worker** takes it. Each worker clips 2 videos and renders 2 clips at once (`sizing.env`).
3. The worker saves progress to the database → the website shows it.
4. Each job's own log lines are saved with it → visible in **/admin/queues/**.

What keeps it from getting messy:

| Problem | What happens now |
|---|---|
| A worker crashes or freezes | its job goes to another worker within ~3 min |
| A job runs too long (150 min) | its worker restarts and the job re-runs **once**, cleanly |
| A job gets stuck **twice** | it stops for good: project marked failed, credits refunded |
| We deploy while a job runs | the worker hands the job back straight away; another worker continues it |
| Two workers want the same clip | a shared lock — the second one waits its turn |
| Redis is emptied / a crash before queueing | every 10 min the scheduler re-queues unfinished work it finds in the database |
| A post is due while two processes run | a post can only be claimed once — never posted twice |

## 3. Settings (secrets)

1. All settings (API keys, passwords, the whole `.env`) are **one secret** in Google Secret Manager: `crestclip-env`.
2. You edit it from your Mac: `./devops/secrets/secrets.sh edit`. It shows which **names** changed, never the values.
3. Each save is a new **version**. The last 3 are kept (you can go back to any of them); older ones are deleted so it stays free.
4. The server checks every minute. A new version → it writes `/opt/crestclip/.env` (only root can read it) and
   restarts the app one piece at a time.
5. If the app won't start with the new settings → the server **goes back to the previous ones** by itself.

## 4. Deploys

1. You push to `main`.
2. **GitHub** checks the code, builds the app image, and tests that the website, a worker and the admin pages
   start. Then it uploads the image.
3. **The server** (every minute) sees the new image and switches **one piece at a time**:
   `web-1` → waits until it answers → `web-2` → waits → workers, scheduler, admin pages.
   Caddy keeps sending visitors to whichever copy is up, so the site stays up.
4. If the new version doesn't start → the server goes back to the old one and never tries the broken one again.

GitHub never logs in to the server. The server fetches everything itself with its own Google account.

## 5. Admin pages

All behind your CrestClip admin login. Caddy asks the app "is this person an admin?" before opening any of them.

| Page | Shows |
|---|---|
| `/admin/` | site up?, workers connected, jobs running/waiting/failed, CPU + memory per container |
| `/admin/queues/` | every job with progress, its own logs, errors; retry |
| `/admin/logs/` | live logs of every container |
| `/admin/costs` | monthly cost, which part uses the server most, AI spend per day / model / video / person |

## What it costs

| Piece | Per month |
|---|---|
| Server (e2-standard-4, Mumbai) | ≈ $118 — same as before |
| Redis, Caddy, workers, admin pages, logs | $0 — same server |
| Secret Manager | $0 — free tier |
| BigQuery (real bill on the Costs page, optional) | ≈ $0 — free tier |

# CrestClip devops

Everything about **running** CrestClip lives in this folder: the server layout, the deploys, the settings (secrets),
and the admin pages. The app's own code stays in `server/` and `web/`.

```
devops/
  README.md            this guide
  server/              what runs on the server
    docker-compose.prod.yml   the containers (web ×2, workers, scheduler, Redis, Caddy, admin pages)
    Caddyfile                 HTTPS + load balancer + the lock on /admin
    sizing.env                how many workers, how many videos at once
    update.sh                 the auto-updater (runs every minute on the server)
    install.sh                one-time server setup
    push-from-mac.sh          emergency deploy from your Mac (skips GitHub)
  secrets/
    secrets.sh                edit / push / pull the settings in Google Secret Manager
  gcp/
    setup.sh                  one-time Google Cloud setup
  dashboard/                  the admin pages (its own small app)
    prices.json               prices the Costs page uses — edit freely
```

---

## How it works (the short version)

```
                visitors
                   │
            Caddy (HTTPS + load balancer)
             ┌─────┴─────┐            /admin/*  → only for CrestClip admins
          web-1        web-2  ──────┐            ├─ /admin/         overview
             └─────┬─────┘          │            ├─ /admin/queues/  jobs
                   │ add job        │            ├─ /admin/logs/    live logs
                 Redis (job queue)  │            └─ /admin/costs    costs
             ┌─────┴─────┐          │
         worker      worker         │
        (videos, renders)       scheduler (posts, Autopilot, clean-up)
```

- **One image, many jobs.** The same app image runs as each container; a setting called `ROLE` says which job
  it does (`web`, `worker`, `scheduler`).
- **Load balancing.** Caddy spreads visitors over the two web copies. Each browser sticks to one copy; if a copy
  is down (crash, deploy), Caddy sends visitors to the other one.
- **The queue lives in Redis.** The website only *adds* jobs. Workers take them. Restarts lose nothing.
- **Stuck jobs re-run once, cleanly.** A worker that crashes or freezes loses its job to another worker within
  about 3 minutes. A job running past its time limit (`JOB_MAX_MINUTES`, default 150) restarts its worker and
  re-runs once. Stuck twice → the project is marked failed and the credits go back.
- **Settings live in one place** — Google Secret Manager, one secret called `crestclip-env` (the whole `.env`
  file). The server checks every minute and applies changes by itself.

---

## First-time setup (moving the current server to this layout)

You only do this once. About 15 minutes.

### Step 1 — Push the code

```bash
cd ~/OpenSource/peakclip && git push origin main
```

GitHub builds and tests the new image (about 10 minutes — wait for the green tick in GitHub → Actions).
**Nothing changes on the server yet** — the old updater doesn't understand the new layout, so the site keeps
running the old version until step 3. (Its log will say it couldn't copy files from the new image — expected.)

### Step 2 — Google Cloud setup (Cloud Shell)

Open [Cloud Shell](https://console.cloud.google.com/?cloudshell=true&project=peakclip-510216) and run (it reads the
setup script out of the new image — the repo is private, so no clone needed):

```bash
gcloud compute ssh crestclip-server-mumbai --project peakclip-510216 --zone asia-south1-a --command \
  'I=us-central1-docker.pkg.dev/peakclip-510216/crestclip/app:main; sudo docker pull -q $I >/dev/null; sudo docker run --rm --entrypoint cat $I /app/devops/gcp/setup.sh' > setup.sh
bash setup.sh
```

What it does:

- creates the secret `crestclip-env` and lets the server read it;
- **copies the settings that are on the server today** (`/opt/crestclip/.env`) into it, plus the key that unlocks
  connected YouTube/Instagram accounts — the values never appear on screen;
- prepares the billing export for the Costs page (step 6).

It only affects the CrestClip project — your default project (e.g. SellerGeni) is left alone.

> If it says the server's access scopes don't include `cloud-platform`, run the 3 commands it prints
> (a 1-minute stop of the server).

### Step 3 — Switch the server (Cloud Shell)

```bash
gcloud compute ssh crestclip-server-mumbai --project peakclip-510216 --zone asia-south1-a --command \
  'I=us-central1-docker.pkg.dev/peakclip-510216/crestclip/app:main; sudo docker pull -q $I >/dev/null; sudo docker run --rm --entrypoint cat $I /app/devops/server/install.sh | sudo bash'
```

The site blinks for about 30 seconds while the old single container stops and the new ones start. At the end
it lists the running containers — you should see `web-1`, `web-2`, two `worker`s, `scheduler`, `redis`, `pot`,
`caddy`, `dashboard` and `dozzle`.

### Step 4 — Check the admin pages

Sign in to crestclip.com with your admin account, then open:

| Page | What you see |
|---|---|
| [crestclip.com/admin/](https://crestclip.com/admin/) | Is the site up, workers connected, jobs running/waiting/failed, each container's CPU and memory |
| [crestclip.com/admin/queues/](https://crestclip.com/admin/queues/) | Every job: progress, its own log lines, errors; retry buttons |
| [crestclip.com/admin/logs/](https://crestclip.com/admin/logs/) | Live logs of every container, searchable |
| [crestclip.com/admin/costs](https://crestclip.com/admin/costs) | Monthly price, who uses the server, AI spend per day / video / person |

Anyone who isn't a signed-in admin gets "Sign in…" on all of these.

### Step 5 — Try one video

Clip a YouTube link on crestclip.com. On `/admin/queues/` you'll see it move from **waiting** → **active** →
**completed**, and its log lines under **Logs**.

### Step 6 (optional) — Real bill on the Costs page

Until this is on, the Costs page shows **estimates**. To see Google's real bill per service:

1. Open the link `setup.sh` printed (Billing → Billing export) → **BigQuery export** → **Standard usage cost** →
   Edit settings → project `peakclip-510216`, dataset `billing` → Save.
2. Add the line it printed (`BILLING_EXPORT_TABLE=…`) to the settings — see "Change a setting" below.
3. Numbers appear after a few hours.

---

## Every day

### Deploy a change

```bash
git push origin main
```

That's it. GitHub tests it, then the server switches **one piece at a time** (web-1, then web-2, then workers) —
the site stays up. If the new version doesn't start, the server goes back to the old one by itself.

Watch it: GitHub → Actions, or on the server `sudo journalctl -u crestclip-update -f`.

### Change a setting (API key, password, any `.env` value)

```bash
./devops/secrets/secrets.sh edit
```

It opens the live settings in an editor. Save and close → it shows **which names** changed (never the values) →
type `y`. The server applies them within a minute, restarting one piece at a time. If the app won't start with the
new settings, the server goes back to the previous ones by itself.

Other commands:

| Command | Does |
|---|---|
| `secrets.sh keys` | list setting names |
| `secrets.sh history` | list versions |
| `secrets.sh rollback 7` | make version 7 live again |
| `secrets.sh pull` / `push` | download to `devops/secrets/production.env` (git ignores it) / upload a file |

Never edit `/opt/crestclip/.env` on the server — the next settings change overwrites it.

### More workers / more videos at once

Edit `devops/server/sizing.env`, commit, push:

```
WORKERS=2         worker containers
WORKER_JOBS=2     videos each worker clips at once
WORKER_RENDERS=2  clip encodes each worker runs at once (≈1 CPU each)
```

Rule of thumb: `WORKERS × WORKER_RENDERS` ≈ the server's CPUs (e2-standard-4 = 4). Check the Overview page: if
CPU sits near 100% and jobs wait a long time, the server is too small; if it's mostly idle, it's too big.

### Something's stuck

1. [/admin/](https://crestclip.com/admin/) — "Workers connected" should be 2. If it's 0, open Live logs → `worker`.
2. [/admin/queues/](https://crestclip.com/admin/queues/) → **Failed** — the error and the job's own log lines.
   **Retry** runs it again.
3. A job that hangs is restarted automatically after `JOB_MAX_MINUTES` (150) — no need to restart anything.

---

## What it costs

No new monthly cost compared with before:

| Piece | Cost |
|---|---|
| Server (e2-standard-4, Mumbai) | ≈ $118 / month (same as before) |
| Redis, Caddy, admin pages, logs | $0 — they run on the same server |
| Secret Manager | $0 — inside the free tier (the server only *reads* the value when it changes; old versions are disabled) |
| BigQuery (billing export) | ≈ $0 — a few MB a month, inside the free tier |

The Costs page shows the full picture, including AI spend.

---

## Good to know

- `data/secret.key` (on the server) unlocks connected YouTube/Instagram accounts. It's also in the secret as
  `SECRET_KEY_HEX`, so a brand-new server can read them. **Never change it.**
- Run only one scheduler against the database (the layout already does). Posting is safe either way — a post can
  only be claimed once.
- Local development is unchanged: `npm run dev` runs everything in one process (`ROLE=all`). With Redis on your
  Mac it uses the same queue; without it, jobs run in memory like before. The admin pages locally:
  `npm run dashboard` → http://127.0.0.1:8790/admin/.

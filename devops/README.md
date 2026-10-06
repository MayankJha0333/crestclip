# CrestClip devops

Everything about **running** CrestClip in production. The app's own code stays in `server/` and `web/`.

## What's in here

```
devops/
├── README.md          ← you are here: the map + everyday commands
├── docs/
│   ├── how-it-works.md       the picture: containers, load balancing, queue, settings, deploys
│   ├── first-time-setup.md   one-time move of the server to this setup (≈15 min)
│   └── what-changed.md       before vs after, and every change explained
├── deploy/            what runs on the server
│   ├── docker-compose.prod.yml   the list of containers (website ×2, workers, scheduler, Redis…)
│   ├── Caddyfile                 HTTPS + load balancer + the lock on /admin
│   ├── sizing.env                how many workers, how many videos at once
│   ├── update.sh                 auto-updater — runs on the server every minute
│   ├── install.sh                one-time server setup
│   └── push-from-mac.sh          emergency deploy from your Mac (skips GitHub)
├── secrets/
│   └── secrets.sh     edit the live settings (they live in Google Secret Manager)
├── gcp/
│   └── setup.sh       one-time Google Cloud setup
└── dashboard/         the admin pages (a small app of its own)
    ├── src/                  overview, jobs, costs
    └── prices.json           prices the Costs page uses — edit freely
```

## Everyday commands

| I want to… | Do this |
|---|---|
| **Ship a change** | `git push origin main` — the site updates itself in ~10 min, one piece at a time, no downtime |
| **Change a setting** (API key, password…) | `./devops/secrets/secrets.sh edit` → save → type `y` — live within a minute |
| **See what's running** | [crestclip.com/admin/](https://crestclip.com/admin/) |
| **See jobs** (waiting, running, failed + their logs) | [crestclip.com/admin/queues/](https://crestclip.com/admin/queues/) |
| **See live logs** | [crestclip.com/admin/logs/](https://crestclip.com/admin/logs/) |
| **See costs** | [crestclip.com/admin/costs](https://crestclip.com/admin/costs) |
| **Clip more videos at once** | edit `deploy/sizing.env` → commit → push |
| **Undo a bad setting** | `./devops/secrets/secrets.sh history` → `secrets.sh rollback <number>` |

The admin pages only open for people signed in to CrestClip as an admin.

## When something's wrong

1. **[/admin/](https://crestclip.com/admin/)** — "Workers connected" should be 2. If it's 0, open Live logs → `worker`.
2. **[/admin/queues/](https://crestclip.com/admin/queues/) → Failed** — shows the error and the job's own log lines.
   **Retry** runs it again.
3. A job that hangs restarts by itself after 150 minutes (`JOB_MAX_MINUTES`) — nothing to do.
4. A deploy that didn't go live: GitHub → Actions, or on the server `sudo journalctl -u crestclip-update -n 100`.

## Rules

- **Never edit `/opt/crestclip/.env` on the server** — use `secrets.sh`. The next settings change overwrites the file.
- **Never change `SECRET_KEY_HEX`** — it unlocks connected YouTube/Instagram accounts.
- **Local development is unchanged** — `npm run dev` runs everything in one process. Admin pages locally:
  `npm run dashboard` → http://127.0.0.1:8790/admin/.

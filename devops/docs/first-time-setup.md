# First-time setup

Moves the current server to the new setup. Once only, about 15 minutes, a ~30-second blip for the site.

## Step 1 — Push the code (your Mac)

```bash
cd ~/OpenSource/peakclip && git push origin main
```

Wait for the green tick in GitHub → Actions (~10 min).
**The site doesn't change yet** — the server's old updater can't read the new layout, so it keeps the old version.

## Step 2 — Google Cloud setup (Cloud Shell)

Open [Cloud Shell](https://console.cloud.google.com/?cloudshell=true&project=peakclip-510216) and paste:

```bash
gcloud compute ssh crestclip-server-mumbai --project peakclip-510216 --zone asia-south1-a --command \
  'I=us-central1-docker.pkg.dev/peakclip-510216/crestclip/app:main; sudo docker pull -q $I >/dev/null; sudo docker run --rm --entrypoint cat $I /app/devops/gcp/setup.sh' > setup.sh
bash setup.sh
```

It:

- creates the secret `crestclip-env` and lets the server read it
- **copies the server's current settings into it** (values never shown on screen), plus the key for connected
  YouTube/Instagram accounts
- prepares the optional billing export (step 6)

Only the CrestClip project is touched — your SellerGeni default project is left alone.

> If it says the access scopes don't include `cloud-platform`, run the 3 commands it prints (1-minute server stop).

## Step 3 — Switch the server (Cloud Shell)

```bash
gcloud compute ssh crestclip-server-mumbai --project peakclip-510216 --zone asia-south1-a --command \
  'I=us-central1-docker.pkg.dev/peakclip-510216/crestclip/app:main; sudo docker pull -q $I >/dev/null; sudo docker run --rm --entrypoint cat $I /app/devops/deploy/install.sh | sudo bash'
```

At the end it lists the containers. You should see: `web-1`, `web-2`, 2× `worker`, `scheduler`, `redis`, `pot`,
`caddy`, `dashboard`, `dozzle`.

## Step 4 — Check

Sign in to crestclip.com as admin → open [crestclip.com/admin/](https://crestclip.com/admin/):

- Website: **2 of 2 up**
- Workers connected: **2**

## Step 5 — Try one video

Clip a YouTube link. On [/admin/queues/](https://crestclip.com/admin/queues/) watch it go
**waiting → active → completed**, with its log lines under **Logs**.

## Step 6 (optional) — Real bill on the Costs page

Without this, the Costs page shows **estimates**.

1. Open the billing link `setup.sh` printed → **BigQuery export** → **Standard usage cost** → Edit settings →
   project `peakclip-510216`, dataset `billing` → Save.
2. `./devops/secrets/secrets.sh edit` → add the `BILLING_EXPORT_TABLE=…` line it printed → save → `y`.
3. Numbers appear after a few hours.

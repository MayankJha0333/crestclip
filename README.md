# CrestClip

**CrestClip clips the moment everyone rewatches.** Paste a long video link or upload a file, and you get vertical 9:16 clips of the best moments. Each clip comes with word-by-word captions, a hook headline, face-tracked framing and a virality score.

All AI runs on **Gemini through Google Cloud Vertex AI**, so it's billed to your Google Cloud credits.

![Landing page](docs/screenshots/landing.png)
![Project page](docs/screenshots/project.png)

---

## What makes it different

Most clipping tools only _guess_ what's viral. CrestClip starts from what viewers **already rewatched**:

1. **YouTube "Most replayed" heatmap.** yt-dlp reads it for free: 100 points showing where people rewind.
2. **Timestamps in comments.** For example "12:41 😂", weighted by likes.
3. **Audio energy.** Laughs, raised voices and excitement. This is the fallback when there's no audience data.
4. **Gemini's 9-point rubric.** Hook, makes sense alone, payoff, emotion, shareability, pacing, clean ending, length fit and trend.

The **Crest score** blends 1–3 (the audience) with 4 (the AI). See `docs/RESEARCH.md` for the research behind every choice.

---

## Setup on a Mac (about 5 minutes)

**1. Install Node and the Google Cloud CLI**

```bash
brew install node@22
brew install --cask google-cloud-sdk
```

You don't install any video tools. CrestClip brings its own:

- **ffmpeg** (with caption support) comes inside the app through npm.
- **yt-dlp** (the YouTube/Twitch downloader) is downloaded on first start into `data/bin`. CrestClip checks for a new version every day, and updates straight away if YouTube breaks a download, then retries it.

**2. Connect Google Cloud** (use the project that has your credits)

```bash
gcloud auth application-default login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable aiplatform.googleapis.com
```

**3. Create the database (MongoDB Atlas, free tier is enough to start)**

In [MongoDB Atlas](https://www.mongodb.com/atlas): create a cluster → **Database Access** → add a user → **Network Access** → add your IP (or your server's) → **Connect → Drivers** → copy the connection string.

**4. Configure CrestClip**

```bash
cp .env.example .env
# open .env and set GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID
# and MONGODB_URI=mongodb+srv://USER:PASSWORD@your-cluster.mongodb.net
```

Coming from an older CrestClip that kept everything in `data/crestclip.db` (SQLite)? On the first start with MongoDB set, it copies all of it over by itself (accounts, credits, payments, projects, clips, posts, Autopilots) and keeps the old file as a backup.

**5. Install and run**

```bash
npm install
npm run doctor   # checks Node, the video tools and Gemini, and tells you what to fix
npm run dev      # app → http://localhost:5173   ·   API → http://localhost:8787
```

**Just want to see the UI without Google Cloud?** Set `CRESTCLIP_FAKE_AI=1` in `.env`. You'll get placeholder AI answers, but real cutting and rendering.

**Production build (one port):**

```bash
npm run build && npm start   # → http://localhost:8787
```

**Or with Docker:**

```bash
docker compose up --build
```

The image needs no system packages. The build pre-downloads yt-dlp so the first request is instant.

### Launching it for real (one Google Cloud machine + automatic deploys)

CrestClip runs on one Compute Engine VM (an always-on machine) in the same project as your credits. The app,
Redis and Caddy (free automatic HTTPS) run together from `docker-compose.prod.yml` in `/opt/crestclip`.
Cloud Run doesn't fit: it refuses uploads over 32 MB, and its disk is wiped on every restart.

**Every push to `main` deploys itself** (`.github/workflows/pipeline.yml`):

1. **Check** — server types, web app types and build (also on pull requests).
2. **Image** — build the Docker image, start it against a test MongoDB + Redis and check it answers. On `main`,
   upload it to Artifact Registry and tag it `main`. GitHub logs in to Google without a stored key (Workload
   Identity Federation) and can only upload images — it never logs in to the server.
3. **Live** — the server checks for a new `main` every minute (`deploy/pull-deploy.sh`, a systemd timer), takes the
   compose file and Caddyfile out of the new image, switches, waits for `/api/live`, and goes back to the previous
   version by itself if the new one doesn't start. GitHub waits until `https://crestclip.com/api/live` reports the
   new commit.

One-time setup:

1. Service account `crestclip-server` with **Vertex AI User** ("Agent Platform User") and **Logs Writer**, plus
   **Storage Admin** on your bucket.
2. VM `crestclip-server-mumbai` in `asia-south1-a` (Mumbai, next to the MongoDB Atlas cluster) with that service account (e2-standard-4, Ubuntu 24.04, 50 GB, HTTP + HTTPS allowed) and a
   static IP. Point the domain's A record at it. In MongoDB Atlas → Network Access, allow the IP.
3. Run `deploy/gcp-setup.sh` in Cloud Shell and add the GitHub variable `GCP_WIF_PROVIDER` it prints
   (Settings → Secrets and variables → Actions → Variables).
4. On the server: put the settings in `/opt/crestclip/.env` and `/opt/crestclip/data/secret.key`, upload
   `deploy/server-install.sh` + `deploy/pull-deploy.sh` and run `sudo bash server-install.sh`.
5. Push to `main` (or Actions → CI/CD → Run workflow). Watch the server: `journalctl -u crestclip-update -f`.

Keep `data/secret.key` — connected YouTube/Instagram accounts can't be read without it. Run only one server against
the same database (Autopilot would otherwise post twice). `/api/live` is a public "is it up, which version?" check.

### Clip storage: Cloud Storage + 7-day auto-delete

Create a bucket and set `GCS_BUCKET` in `.env` (it uses the same Google login as Gemini):

```bash
gcloud storage buckets create gs://YOUR-BUCKET --location=us
```

With a bucket:

- **Every rendered clip** (and its thumbnail) is copied to `gs://YOUR-BUCKET/crestclip/media/…`, the same path it has in the data folder. If a clip isn't on this disk (a new server, a wiped disk), it's fetched back from the bucket when someone watches, downloads or posts it. Clips rendered before the bucket was set are copied up on the next start.
- **Gemini can also watch uploaded files**, not just listen. (YouTube links get video analysis without a bucket.)

**Auto-delete:** every project — its video, clips and work files, on this disk and in the bucket — is deleted **7 days after it's made** (`RETENTION_DAYS`). CrestClip checks every hour. A project is kept a little longer only while it's still processing or a clip from it is still scheduled to post. Each project shows "Deletes in N days". As a safety net, CrestClip adds one lifecycle rule to the bucket: files under `crestclip/` are deleted by Google a day after the storage time, even if CrestClip is off. Other files and rules in the bucket aren't touched. Temporary previews for Gemini go under `crestclip/tmp/` and are deleted right after use; if you keep a short "delete after 1 day" rule for them, limit it to that prefix, otherwise it deletes the stored clips too (CrestClip warns about this at start-up). Projects made before this existed got 7 days from the day it was switched on.

`CLOUD_CLIPS=false` keeps clips on this disk only. Without a bucket, everything still works and auto-delete still runs; uploads are judged from the transcript and audio only.

Still on this disk only: the original video and work files, needed while editing. On Cloud Run (temporary disk), a clip can still be watched, downloaded and posted after a restart, but re-rendering an edit needs the original again.

---

## Explore (find something worth clipping)

Open **Explore** in the sidebar:

- **YouTube:** search Videos, Shorts, Channels or Live. You can filter by length (e.g. "Over 20 min" for podcasts), sort by most viewed or newest, and pick an upload date. Click a channel to browse its Videos, Shorts and past streams.
- **Twitch:** type a channel name to see its past streams (VODs) and top clips. Keyword search for Twitch channels needs a free Twitch app key (`TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` in `.env`).
- **Peek:** click any result to watch it and see its **"Most replayed" graph** with its top 5 peaks. Click a peak to jump there. Then pick a platform and hit **Clip this video**.

No YouTube API key is needed. Explore uses yt-dlp, which CrestClip keeps up to date by itself.

## Editing: motion, music and your own picks

- **Edit motion:** _Subtle_ adds a punch-in zoom every few seconds at natural pauses and glides between speakers in the same shot. _Dynamic_ zooms more often and opens with a quick zoom-out on the hook. _Off_ keeps steady framing.
- **Background music:** pick a mood (Chill lo-fi, Upbeat, Inspiring, Hype, Suspense, Funny, Emotional, Clean tech), _Auto_ (matches each clip's category), or upload your own track. Mood tracks are instrumental, made once with Google's **Lyria** model on Vertex AI (your credits) and reused. Music loops smoothly, fades in/out, and ducks under speech.
- **Cut pauses:** _Natural_ (default) shortens pauses longer than ~0.6 s and drops a lone "um" sitting between two pauses; _Fast_ cuts nearly every pause; _Off_ keeps everything. Cuts are made only on real silences measured from the audio, and each cut gets a small zoom change so the jump isn't noticeable. Stories and emotional moments keep more breathing room.
- **Key words:** the AI marks 3–8 important words per clip; captions show them bigger and in an accent colour (one per line). Turn on **Emoji on key words** to pop a matching emoji above them.
- **Hooks:** the AI writes 3 headline options per clip; pick one in Edit → Hook & captions, or write your own.
- **Flash-forward opening:** plays the clip's punchiest line (1–3 s, punched in) first, then the story from the start. Off by default; the AI only offers it when a line works as a tease.
- **Auto length** aims for 20–45 seconds (where short clips keep the most viewers to the end) and only runs to 60 s when the story needs it.
- **Pick your own parts:** on a project's "Where viewers rewatch" graph, drag across the parts you want (drag the yellow edges to adjust). Then **Make N clips** or **Join into 1 clip**. In **Explore**, click the graph to jump the preview there, drag to pick parts, and clip just those; only those parts are downloaded.

## Autopilot (clips that post themselves)

Sidebar → **Autopilot**. Pick sources (YouTube channels, or a topic + country), how many posts a day and at what times,
which accounts to post to, and whether you approve each clip first. Every hour CrestClip checks for new videos, skips weak
ones (views, length, age), waits for YouTube's "most rewatched" graph, clips the best video, and books the clips into your
time slots. The **Schedule** tab shows every upcoming post — cancel any one, or pause the whole autopilot.

Timing runs on **Redis** (BullMQ): set `REDIS_URL`, or let CrestClip use a local Redis / build its own (see `.env.example`).
MongoDB stays the record of truth, so Redis can restart empty — every job is put back on start-up.
Posting only happens while CrestClip is running; for 24/7 posting, run it on a server.

## Post to YouTube & Instagram

Open **Settings → Connected accounts** to connect each account once. Then press **Post** on any clip: post now or schedule it. **Schedule** in the sidebar shows every upcoming and past post (yours and Autopilot's).

|            | YouTube Shorts                                                                                                   | Instagram Reels                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Sign-in    | Google OAuth (`youtube.upload`)                                                                                  | Instagram Login (`instagram_business_basic`, `instagram_business_content_publish`)        |
| Upload     | Resumable upload, YouTube Data API v3                                                                            | Resumable upload to Instagram, then publish                                               |
| Scheduling | YouTube's own `publishAt`: goes live even if CrestClip is off                                                    | CrestClip's scheduler publishes at the time: **keep CrestClip running**                   |
| Limits     | Apps that haven't passed YouTube's API audit can only upload **private** videos. Request the audit before launch | Business/Creator accounts only, about 100 API posts a day, redirect URL must be **https** |

Setup: add `YOUTUBE_CLIENT_ID/SECRET` and/or `INSTAGRAM_APP_ID/SECRET` to `.env` (Settings shows the exact steps and redirect URLs). Account tokens are stored encrypted in the database.

## How it works (the pipeline)

| Step                 | What happens                                                                                                                                                                                              | Tool                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1. Get video         | Read title, **Most replayed heatmap**, chapters and top comments. For long links, download **only the audio** (a 2-hour podcast is ~100 MB instead of ~3 GB). Short links and uploads use the whole video | yt-dlp              |
| 2. Listen            | Pull out 16 kHz audio. Measure loudness per second and find pauses                                                                                                                                        | ffmpeg              |
| 3. Transcribe        | Cut the audio into 8-minute chunks. Transcribe them in parallel with timestamps                                                                                                                           | Gemini (fast model) |
| 4. Find peaks        | Build the engagement curve. Gemini reads the transcript, hotspots and (if possible) the video, then returns ranked clips with a rubric, title, hook, caption and hashtags                                 | Gemini (main model) |
| 5. Clean cuts        | Snap starts to the first word of the hook and ends to the sentence end or a pause. Enforce the length for the platform. Remove overlapping clips                                                          | code                |
| 5b. Fetch clip parts | Long links only: download the video just for the chosen clips (+20 s padding), cut to the exact frame. Edits outside that range fetch their part on demand                                                | yt-dlp + ffmpeg     |
| 6. Reframe           | Sample a frame every ~1.5 s. Gemini boxes the speaking face. The crop holds steady per camera shot (it doesn't wobble). Two people → split screen; screen or game content → fit on a blurred background   | Gemini + ffmpeg     |
| 7. Render            | 1080×1920, 30 fps, H.264. Word-by-word `.ass` captions, a hook headline for 0–3 s, and loudness normalized to −14 LUFS                                                                                    | ffmpeg + libass     |

Then on the project page (**Clips** tab) you can:

- edit the hook, captions, framing, trim (click transcript lines), title and hashtags, then re-render
- make **variants** (same moment, new look) so you can post again without being flagged as duplicate content
- download clips or copy the ready-made post text

---

## Project layout

```
crestclip/
├─ server/                    Node + Express + TypeScript (run with tsx)
│  └─ src/
│     ├─ index.ts             start-up: HTTP server + background workers
│     ├─ app.ts               Express app: routers, /media, web app, error handler
│     ├─ config.ts            settings from .env
│     ├─ lib/                 http (HttpError, validate, asyncHandler), paths, secrets, processes
│     ├─ db/                  MongoDB: connection + indexes, one repository per collection, one-time SQLite import
│     ├─ infra/               job queue, Redis, managed tools (ffmpeg, yt-dlp), local https
│     ├─ modules/             one folder per feature: *.routes (HTTP) → *.service (logic) → *.presenter (JSON)
│     │  ├─ projects/  clips/  music/  explore/  publishing/  autopilot/  system/
│     ├─ pipeline/            video → clips: ytdlp, media, gemini, transcribe, signals, moments, reframe, captions, render, process
│     └─ scripts/             `npm run doctor`, `npm run setup-tools`
├─ web/                       Vite + React + TypeScript + Tailwind CSS ("soft clay" design, light + dark)
│  └─ src/
│     ├─ app/                 router + layout (sidebar, phone nav, status banner)
│     ├─ components/ui/       design system: Button, Card, Badge, Field, Segmented, Tabs, Dialog, Menu, EmptyState…
│     ├─ features/            one folder per area: create, explore, projects, clips, media, schedule, autopilot, settings, landing
│     ├─ lib/                 API client + types, formatting, hooks, theme, storage, toasts
│     └─ styles/index.css     colour tokens (light/dark), clay shadows, base styles
└─ docs/RESEARCH.md           why each decision was made, with sources
```

## Accounts, plans & credits

Everyone signs up (email + password, or **Continue with Google**) and gets their own projects, clips, connected accounts, watermark and music. **The first account is the owner**: an admin on the Pro plan.

**Credits** are spent per clip: **every clip costs 5 credits** (`CREDITS_PER_CLIP` in `plans.ts`). Asking for 8 clips takes 40 credits up front; if only 6 good moments come out, 10 go back. Clips you pick on the rewatch graph cost the same. Editing and re-rendering is free, and a video that fails gives all its credits back. Video length is limited per plan, which keeps the AI cost of very long videos in check.

| Plan    | Price | Credits / month (clips) | Limits                                                                                                    |
| ------- | ----- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| Free    | $0    | 60 (12 clips)           | videos up to 30 min · 3 videos per project · 720p with a small CrestClip mark · post now only             |
| Creator | $15   | 400 (80 clips)          | videos up to 2 h · 15 per project · 1080p · your own logo · scheduling · unused credits roll over 1 month |
| Pro     | $29   | 1,000 (200 clips)       | videos up to 3 h · everything in Creator · Autopilot                                                      |

**Top-up:** 100 credits for $5, on any plan, usable for 12 months. Credits are used soonest-to-expire first. **Currency:** every price and every payment is in **US dollars (USD)** — one currency for everyone, so international customers pay exactly what they see (their bank converts if their card is in another currency). To change prices or limits, edit `PLANS` / `TOPUP` in `server/src/modules/billing/plans.ts`, then create Razorpay plans with the same amounts.

### Company and policy pages

`/about`, `/contact`, `/terms`, `/privacy`, `/refunds` and `/shipping` are linked in the footer of every public page. Razorpay needs them on your live website before it allows live payments and international cards, and Google needs the Privacy page for the YouTube connection. Your business details on them come from `.env`: `BUSINESS_NAME`, `BUSINESS_LEGAL_NAME`, `SUPPORT_EMAIL`, `SUPPORT_PHONE`, `BUSINESS_ADDRESS`, `BUSINESS_JURISDICTION`, `SUPPORT_HOURS`, `GRIEVANCE_OFFICER` — use the same details as in your Razorpay account. Numbers like the storage time and credits per clip come from the app's settings, so the pages always match how CrestClip works. Each page has its own file in `web/src/features/legal/` (shared layout in `LegalLayout.tsx`); it's a solid starting point, not legal advice.

### Taking payments with Razorpay

1. **API keys:** Razorpay Dashboard → API Keys → copy the Key Id and Secret into `.env` (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`). Start with **Test Mode** keys.
2. **Dollar payments:** Dashboard → Payment Methods → _International Payments_ → Request (Razorpay asks for your live website with these policy pages; approval takes up to 5 working days). CrestClip charges only in USD, so upgrades and top-ups stay off until this is approved.
3. **Plans:** Dashboard → Subscriptions → Plans → create two **monthly USD** plans: Creator **$15** → `RAZORPAY_PLAN_CREATOR`, Pro **$29** → `RAZORPAY_PLAN_PRO`. CrestClip checks each plan before checkout and shows a clear message if its currency, amount or period doesn't match `plans.ts`.
4. **Webhook** (renewals, and payments made after someone closes the tab): Dashboard → Webhooks → URL `<PUBLIC_URL>/api/billing/webhook`, pick a secret and put it in `RAZORPAY_WEBHOOK_SECRET`. Turn on these events:
   - `subscription.activated`, `subscription.charged`, `subscription.cancelled`, `subscription.halted`, `subscription.completed`
   - `payment.captured`

   Locally (no public URL), renewals are still picked up: CrestClip checks the subscription with Razorpay when a month runs out.

5. Restart CrestClip. **Plan & credits** in the app now shows working Upgrade and Buy credits buttons.

Without Razorpay keys, everything else works (credits, limits, monthly refills). Upgrades are off, and an admin can give plans and credits by hand in **Settings → Admin**.

**Cancelling** keeps the plan until the paid month ends, then moves to Free. Credits already bought stay until they expire. Failed renewals (Razorpay "halted") move the account to Free.

## API (for automation)

Every call needs a signed-in session (the `cc_session` cookie from `POST /api/auth/login`). Public: `/api/auth/*`, `/api/billing/plans`, `/api/billing/webhook`.

```
POST   /api/auth/signup | /api/auth/login | /api/auth/logout
GET    /api/auth/me                you, your plan and credits ({ user: null } when signed out)
GET    /api/billing/plans          the pricing table
GET    /api/billing/account        plan, credits, history, payments
GET    /api/health                 setup status (Gemini, ffmpeg, yt-dlp)
POST   /api/projects               { url, options }        → start from a link
POST   /api/projects/upload        multipart: file, options → start from a file
POST   /api/projects/folder/preview { url }               → what's inside a shared Google Drive folder
POST   /api/projects/folder        { url, options }        → AI reads the folder (briefs, names), picks the videos, clips them
GET    /api/projects               list
GET    /api/projects/:id           project + signals + clips
POST   /api/projects/:id/retry
DELETE /api/projects/:id
PATCH  /api/clips/:id              { title, hook, start, end, layout, captionStyle, showHook, description, hashtags }
POST   /api/clips/:id/render       re-render
POST   /api/clips/:id/variant      same moment, next caption style
GET    /api/clips/:id/download
GET    /api/clips/:id/transcript
```

`options` = `{ platform: shorts|tiktok|reels, length: auto|short|medium|long, clipCount, layout: auto|fill|split|fit, captionStyle: pop|clay|neon|comic|minimal|none, showHook, useAudienceData, language, focus }`

## Cost (rough)

A 1-hour podcast costs about **$0.30–0.60 in Gemini usage**. That covers transcription on Flash-Lite, one moment-finding pass on 3.8 Flash, and ~40 frames per clip for reframing.

## Next steps to make it a full SaaS

- Email verification and password-reset emails (needs an email provider). Until then, Free credits can be farmed with throwaway emails — new accounts are capped at 5 per network per day.
- Keep the original videos in Cloud Storage too (so edits can re-render on any server) and run render workers on Cloud Run Jobs.
- YouTube Analytics API (`audienceWatchRatio`) for creators clipping their **own** channel. This is the most accurate retention data there is.
- Live-chat spike detection for streams (`yt-dlp --sub-langs live_chat`).
- Auto-posting to TikTok / YouTube / Instagram.

## Credits

Caption emoji are [Twemoji](https://github.com/jdecked/twemoji) graphics, © Twitter, Inc and other contributors, licensed under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Use responsibly

Only clip videos you have the rights to: your own, a client's, or an approved clipping campaign. Downloading from YouTube with yt-dlp may conflict with YouTube's Terms of Service. Uploading your own files always works.

# CrestClip

**CrestClip clips the moment everyone rewatches.** Paste a long video link or upload a file, and you get vertical 9:16 clips of the best moments. Each clip comes with word-by-word captions, a hook headline, face-tracked framing and a virality score.

All AI runs on **Gemini through Google Cloud Vertex AI**, so it's billed to your Google Cloud credits.

![Landing page](docs/screenshots/landing.png)
![Project page](docs/screenshots/project.png)

---

## What makes it different

Most clipping tools only *guess* what's viral. CrestClip starts from what viewers **already rewatched**:

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

**3. Configure CrestClip**

```bash
cp .env.example .env
# open .env and set GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID
```

**4. Install and run**

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

### Launching it for real (recommended: Cloud Run)

Host the Docker image on **Google Cloud Run** in the same project as your credits. Attach a service account with the **Vertex AI User** role to the service. Gemini then works with no keys at all, and your credits pay for both the AI and the hosting.

```bash
gcloud run deploy crestclip --source . --region us-central1 \
  --service-account crestclip@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --set-env-vars GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID,GCS_BUCKET=YOUR-BUCKET \
  --memory 4Gi --cpu 2 --timeout 3600 --no-cpu-throttling
```

Cloud Run disks are temporary. For many users, move jobs and clips to Cloud SQL and Cloud Storage (see "Next steps").

### Optional: let Gemini *watch* uploaded files too

YouTube links are sent to Gemini directly. For uploaded files, create a bucket and set `GCS_BUCKET` in `.env`:

```bash
gcloud storage buckets create gs://YOUR-BUCKET --location=us
```

Without a bucket, uploads are judged from the transcript and audio only. That still works well for podcasts.

---

## Explore (find something worth clipping)

Open **Explore** in the sidebar:

- **YouTube:** search Videos, Shorts, Channels or Live. You can filter by length (e.g. "Over 20 min" for podcasts), sort by most viewed or newest, and pick an upload date. Click a channel to browse its Videos, Shorts and past streams.
- **Twitch:** type a channel name to see its past streams (VODs) and top clips. Keyword search for Twitch channels needs a free Twitch app key (`TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` in `.env`).
- **Peek:** click any result to watch it and see its **"Most replayed" graph** with its top 5 peaks. Click a peak to jump there. Then pick a platform and hit **Clip this video**.

No YouTube API key is needed. Explore uses yt-dlp, which CrestClip keeps up to date by itself.

## Editing: motion, music and your own picks

- **Edit motion:** *Subtle* adds a punch-in zoom every few seconds at natural pauses and glides between speakers in the same shot. *Dynamic* zooms more often and opens with a quick zoom-out on the hook. *Off* keeps steady framing.
- **Background music:** pick a mood (Chill lo-fi, Upbeat, Inspiring, Hype, Suspense, Funny, Emotional, Clean tech), *Auto* (matches each clip's category), or upload your own track. Mood tracks are instrumental, made once with Google's **Lyria** model on Vertex AI (your credits) and reused. Music loops smoothly, fades in/out, and ducks under speech.
- **Pick your own parts:** on a project's "Where viewers rewatch" graph, drag across the parts you want (drag the yellow edges to adjust). Then **Make N clips** or **Join into 1 clip**. In **Explore**, click the graph to jump the preview there, drag to pick parts, and clip just those; only those parts are downloaded.

## Autopilot (clips that post themselves)

Sidebar → **Autopilot**. Pick sources (YouTube channels, or a topic + country), how many posts a day and at what times,
which accounts to post to, and whether you approve each clip first. Every hour CrestClip checks for new videos, skips weak
ones (views, length, age), waits for YouTube's "most rewatched" graph, clips the best video, and books the clips into your
time slots. The **Schedule** tab shows every upcoming post — cancel any one, or pause the whole autopilot.

Timing runs on **Redis** (BullMQ): set `REDIS_URL`, or let CrestClip use a local Redis / build its own (see `.env.example`).
SQLite stays the record of truth, so Redis can restart empty — every job is put back on start-up.
Posting only happens while CrestClip is running; for 24/7 posting, run it on a server.

## Post to YouTube & Instagram

Open **Settings → Connected accounts** to connect each account once. Then press **Post** on any clip: post now or schedule it. **Schedule** in the sidebar shows every upcoming and past post (yours and Autopilot's).

| | YouTube Shorts | Instagram Reels |
|---|---|---|
| Sign-in | Google OAuth (`youtube.upload`) | Instagram Login (`instagram_business_basic`, `instagram_business_content_publish`) |
| Upload | Resumable upload, YouTube Data API v3 | Resumable upload to Instagram, then publish |
| Scheduling | YouTube's own `publishAt`: goes live even if CrestClip is off | CrestClip's scheduler publishes at the time: **keep CrestClip running** |
| Limits | Apps that haven't passed YouTube's API audit can only upload **private** videos. Request the audit before launch | Business/Creator accounts only, about 100 API posts a day, redirect URL must be **https** |

Setup: add `YOUTUBE_CLIENT_ID/SECRET` and/or `INSTAGRAM_APP_ID/SECRET` to `.env` (Settings shows the exact steps and redirect URLs). Account tokens are stored encrypted in the local database.

## How it works (the pipeline)

| Step | What happens | Tool |
|---|---|---|
| 1. Get video | Read title, **Most replayed heatmap**, chapters and top comments. For long links, download **only the audio** (a 2-hour podcast is ~100 MB instead of ~3 GB). Short links and uploads use the whole video | yt-dlp |
| 2. Listen | Pull out 16 kHz audio. Measure loudness per second and find pauses | ffmpeg |
| 3. Transcribe | Cut the audio into 8-minute chunks. Transcribe them in parallel with timestamps | Gemini (fast model) |
| 4. Find peaks | Build the engagement curve. Gemini reads the transcript, hotspots and (if possible) the video, then returns ranked clips with a rubric, title, hook, caption and hashtags | Gemini (main model) |
| 5. Clean cuts | Snap starts to the first word of the hook and ends to the sentence end or a pause. Enforce the length for the platform. Remove overlapping clips | code |
| 5b. Fetch clip parts | Long links only: download the video just for the chosen clips (+20 s padding), cut to the exact frame. Edits outside that range fetch their part on demand | yt-dlp + ffmpeg |
| 6. Reframe | Sample a frame every ~1.5 s. Gemini boxes the speaking face. The crop holds steady per camera shot (it doesn't wobble). Two people → split screen; screen or game content → fit on a blurred background | Gemini + ffmpeg |
| 7. Render | 1080×1920, 30 fps, H.264. Word-by-word `.ass` captions, a hook headline for 0–3 s, and loudness normalized to −14 LUFS | ffmpeg + libass |

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
│     ├─ db/                  SQLite (built into Node 22): connection + migrations, one repository per table
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

## API (for automation)

```
GET    /api/health                 setup status (Gemini, ffmpeg, yt-dlp)
POST   /api/projects               { url, options }        → start from a link
POST   /api/projects/upload        multipart: file, options → start from a file
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

- Accounts and billing (for example Clerk + Stripe) and per-user minute limits. The pricing on the landing page is placeholder copy.
- Move storage to Cloud Storage and run render workers on Cloud Run Jobs.
- YouTube Analytics API (`audienceWatchRatio`) for creators clipping their **own** channel. This is the most accurate retention data there is.
- Live-chat spike detection for streams (`yt-dlp --sub-langs live_chat`).
- Auto-posting to TikTok / YouTube / Instagram.

## Use responsibly

Only clip videos you have the rights to: your own, a client's, or an approved clipping campaign. Downloading from YouTube with yt-dlp may conflict with YouTube's Terms of Service. Uploading your own files always works.

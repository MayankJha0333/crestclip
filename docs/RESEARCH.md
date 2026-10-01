# CrestClip research notes (September 2026)

The research behind CrestClip's product decisions. Each point is tagged:

- **[FACT]**: stated by the platform itself, or taken from a large named study.
- **[VENDOR]**: numbers published by a tool company without its method.
- **[FOLK]**: common creator wisdom with no hard proof.

---

## 1. How to find the "most watched" part of a video

**Short answer:** read YouTube's *Most replayed* heatmap. Add timestamps viewers write in comments, and use audio energy as a fallback when neither exists.

### A. YouTube "Most replayed" heatmap (the best signal) [FACT]

- `yt-dlp -J <url>` returns a `heatmap` field. It is always **100 points**, in this form: `{start_time, end_time, value}`.
- `value` runs from 0 to 1 and is relative to the video's *own* peak (1.0 = the most replayed moment). You can't compare values across videos.
- yt-dlp reads it from `ytInitialData.frameworkUpdates.entityBatchUpdate.mutations[*].payload.macroMarkersListEntity.markersList` (where `markerType == MARKER_TYPE_HEATMAP`).
- **When it's missing:** new or low-view videos (roughly <80–90K views, <1 week old; YouTube publishes no official threshold), most Shorts, and live streams that are still running.
- **How CrestClip handles it:**
  - It damps the first ~3% of the curve, because every viewer starts at 0:00.
  - It scores each clip by *percentile rank* ("this moment is rewatched more than 87% of the video").
- Code: `server/src/pipeline/ytdlp.ts` and `signals.ts`.

### B. Timestamped comments

```bash
yt-dlp -J --write-comments --extractor-args "youtube:comment_sort=top;max_comments=400,all,0" URL
```

- Regex `mm:ss` / `h:mm:ss` out of the comment text.
- Weight each timestamp by `1 + log10(1 + likes)`.
- Put them into the same 100 bins and smooth slightly, because people usually type a timestamp just *before* the moment.

### C. Other audience signals (not built yet, good next steps)

- **YouTube Analytics API `audienceWatchRatio`** (owner's own videos only, OAuth `yt-analytics.readonly`):
  - 100 points of `elapsedVideoTimeRatio`.
  - Values above 1 mean re-watching.
  - This is the best possible signal for creators clipping their *own* channel.
- **Live-chat replay** (`--sub-langs live_chat`): chat messages per 5–10 s, then z-scored. This is ideal for streams.
- **Twitch VODs:** `TwitchDownloaderCLI chatdownload`.

### D. Content signals (always available)

- **RMS loudness per second:**
  ```
  ffmpeg ... astats=metadata=1:reset=1 ... RMS_level
  ```
  Z-scored, so laughs, shouting and excitement stand out.
- **Silence detection** (`silencedetect`): used to snap cuts into natural pauses.
- **Scene cuts** (`scdet`): used to switch the crop position only on real camera cuts.

### E. How the Crest score is calculated

```
peak = 0.6 × AI virality score + 0.4 × audience score   (when replay/comment data exists)
peak = 0.88 × AI score + 0.12 × energy score             (when only audio energy exists)
```

---

## 2. What makes a clip get views (2025–2026)

### What each platform rewards

- **Instagram** [FACT]: Mosseri (Jan 2025) said the top signals are **watch time, likes and sends (DM shares)**. Sends matter most for reaching new people.
- **YouTube Shorts** [FACT]:
  - Tracks "viewed vs. swiped away".
  - Since 31 Mar 2025, every replay counts as a view.
- **TikTok** [FACT]: ranks on completion, rewatches, shares, comments and "not interested".

### Originality rules

- **Plain re-uploads are penalized** on all three platforms:
  - TikTok: another platform's watermark means the video isn't eligible for the For You feed.
  - Instagram (Apr 2026): accounts that mostly repost aren't recommended.
  - YouTube (Jul 2025): "inauthentic content" rules for monetization.
- **What this means for CrestClip:** always add transformation (captions, reframing, hook text), plus **one-click variants**.

### The first 3 seconds

- TikTok's creative guidance: make the key message in the first 3 s [FACT].
- About 50–60% of drop-off happens in the first 3 s [VENDOR].
- **What this means for CrestClip:**
  - Start clips on the hook sentence, not the setup.
  - Add an on-screen **hook headline** for 0–3 s.

### Length

- Reels: 45–60 s had the highest median views (Socialinsider, 6M Reels, H1 2026) [FACT].
- TikTok: 120–180 s had about 11× the median views of 15–30 s [FACT].
- TikTok Creator Rewards only pays on videos of 1 min or more.
- Shorts: 15–30 s has the best retention [VENDOR].
- **CrestClip defaults:**
  - Shorts: 20–50 s
  - Reels: 30–60 s
  - TikTok: 30–90 s

### Captions

- 69% of viewers watch with sound off in public (Verizon/Publicis, 2019) [FACT].
- Word-by-word highlight is the standard look [FOLK].

### Safe zones on 1080×1920

- **Reels:** keep clear of the top 14%, bottom 35% and sides 6%.
- **TikTok:** keep clear of the right-hand ~120 px (the button column).
- **CrestClip placement:**
  - Captions at ~61% of the height.
  - Hook at y≈300.
  - Fit layout: captions at y≈1290.

### Framing

- Keep the speaker's face centered.
- Use a stacked split-screen when two people talk.
- Instagram reduces reach for borders and low resolution [FACT].

### Clipping economy

- Whop Content Rewards and similar marketplaces pay about $0.20–$6 per 1K views.
- Clippers optimize for:
  - hook strength
  - word-level captions
  - **variation between posts**, to avoid duplicate flags

---

## 3. The AI rubric (Gemini scores each clip 0–10)

| Signal | Weight | What it means |
|---|---|---|
| Hook | 20% | The first 3 s contain a claim, question, conflict, surprising fact or open loop |
| Standalone | 15% | Makes sense with zero context |
| Payoff | 15% | A punchline, reveal or takeaway lands before the end |
| Emotion | 15% | Humor, disagreement, surprise, vulnerability |
| Shareability | 10% | "I need to send this to someone" |
| Pacing | 10% | No dead air or slow wind-up |
| Loop / clean end | 5% | Ends cleanly or flows back to the start |
| Length fit | 5% | Natural end within the platform's range |
| Trend | 5% | A current topic, known person or searchable keyword |

---

## 4. Gemini on Vertex AI: the facts we built on

- **Name change:** Vertex AI is now also called **Gemini Enterprise Agent Platform**. Same API host (`aiplatform.googleapis.com`) and same roles (`roles/aiplatform.user`).
- **Models** (Sept 2026, location `global`):
  - `gemini-3.8-flash` (stable, 2 Sep 2026): main model.
  - `gemini-3.5-flash-lite`: cheap tasks.
  - **The `gemini-2.5-*` models retire on 20 Oct 2026.**
- **SDK:** `@google/genai` with `new GoogleGenAI({ vertexai: true, project, location })`. `@google-cloud/vertexai` is deprecated.
- **Video input:**
  - `fileData` with a `gs://` URI, or a public **YouTube URL** (preview feature, one per prompt).
  - `videoMetadata.fps` and `startOffset` / `endOffset` are supported.
  - Cost is about 70 tokens per frame at low/medium resolution, plus 32 tokens per second of audio.
  - Limit is about 45 min of video with audio per request.
- **Audio timestamps:** set `audioTimestamp: true`. Accuracy is about ±1 s. CrestClip snaps cuts to phrase boundaries and silences to make up for this.
- **Bounding boxes:** returned as `box_2d [ymin, xmin, ymax, xmax]` on a 0–1000 scale. CrestClip uses them to find the speaking face in frames sampled every ~1.5 s.
- **Pricing (intro price until 31 Dec 2026):**
  - 3.8 Flash: $0.75 per 1M input tokens, $3.75 per 1M output tokens.
  - 3.5 Flash-Lite: $0.30 in, $2.50 out.
  - One hour of video at low resolution costs about $0.27 in input on 3.8 Flash.

---

## Sources

- **yt-dlp** source and wiki: https://github.com/yt-dlp/yt-dlp (`extractor/youtube/_video.py`, `common.py`, wiki EJS / PO-Token-Guide)
- **YouTube Analytics metrics:** https://developers.google.com/youtube/analytics/metrics
- **Vertex video understanding:** https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/video-understanding
- **Gemini 3.8 Flash:** https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash
- **Model lifecycle:** https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versions
- **Vertex pricing:** https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing
- **JS SDK:** https://github.com/googleapis/js-genai
- **Instagram:**
  - Mosseri on signals: https://www.highstyle.ai/insights/instagram-reels-algorithm-2026
  - Originality policy: https://petapixel.com/2026/04/30/new-instagram-policies-target-reposted-content/
- **YouTube Shorts:**
  - View-count change: https://ppc.land/youtube-changes-how-shorts-views-are-counted-from-march-31/
  - Shorts lead Todd Sherman: https://techcrunch.com/2023/08/25/youtube-demystifies-the-shorts-algorithm-views-and-answers-other-creator-questions/
  - Inauthentic-content policy: https://www.socialmediatoday.com/news/youtube-clarifies-monetization-update-inauthentic-repeated-content/752892/
- **TikTok:**
  - Recommendation system: https://www.tiktok.com/transparency/en/recommendation-system
  - For You feed eligibility: https://www.tiktok.com/community-guidelines/en/fyf-standards
  - Creative best practices: https://ads.tiktok.com/help/article/creative-best-practices
- **Length studies:**
  - https://www.socialinsider.io/blog/instagram-reels-length/
  - https://socialrails.com/blog/best-tiktok-video-length-maximum-engagement
  - https://www.opus.pro/blog/ideal-youtube-shorts-length-format-retention
- **Safe zones:** https://kreatli.com/guides/safe-zone-guide
- **Clipping economy:**
  - https://docs.whop.com/memberships-and-access/third-party-apps/content-rewards
  - https://digiday.com/media/the-case-for-and-against-clipping/

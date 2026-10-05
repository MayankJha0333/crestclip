# Getting YouTube and Instagram out of test mode

Everything to click and paste, in order. Code side is done: `/privacy`, `/terms` and the new
`/data-deletion` page, plus **Settings → Your account → Delete my account**. Push the code first, so the
reviewers see the new pages.

---

## Google (YouTube + "Sign in with Google")

Both use the same Google app (project `peakclip-510216`), so this also fixes sign-up with Google.

### 1. Publish the app — 1 minute, do this today

Google Cloud → **Google Auth Platform → Audience → Publish app → Confirm**.

- "Sign in with Google" works for everyone straight away (it only asks for name + email).
- Connecting YouTube works too, but shows "Google hasn't verified this app" until step 4 passes, and is
  capped at 100 users.

### 2. Prove you own crestclip.com — 15 minutes

1. Open <https://search.google.com/search-console> → **Add property → Domain** → `crestclip.com`.
2. Copy the `google-site-verification=…` text it shows.
3. Hostinger → Domains → crestclip.com → **DNS / Nameservers → Add record**:
   type **TXT**, name **@**, value = the copied text, TTL 3600.
4. Back in Search Console press **Verify** (can take up to an hour).

Use the same Google account that owns the Cloud project (mayankjha0330@gmail.com).

### 3. Declare the YouTube permissions — 5 minutes

Google Auth Platform → **Data Access → Add or remove scopes** → paste both in "Manually add scopes":

```
https://www.googleapis.com/auth/youtube.upload
https://www.googleapis.com/auth/youtube.readonly
```

**Update → Save.**

### 4. Submit for verification — 20 minutes + the demo video

Google Auth Platform → **Verification Center → Prepare for verification**.

**Why we need `youtube.upload`** (paste):

> CrestClip turns a creator's long videos into short vertical clips. When the user connects their YouTube
> channel and presses "Post" (or schedules a post / turns on Autopilot for their own channel), CrestClip
> uploads that clip to the user's own channel as a YouTube Short with the title and description the user
> chose. We never upload anything the user didn't create or choose, and only to the channel they connected.

**Why we need `youtube.readonly`** (paste):

> After the user connects YouTube we read their own channel's name, handle and profile picture, so the app
> can show which channel is connected and the user can pick it when posting. We also read the status of
> videos we uploaded for them (processing / live / failed) to show it on the Schedule page. We do not read
> any other channel data.

**Demo video** — record your screen (QuickTime → New Screen Recording), 2–3 minutes, upload to YouTube as
**Unlisted**, paste the link:

1. Show the browser address bar on `https://crestclip.com`, then log in.
2. Open **Settings → Connected accounts → Connect YouTube**.
3. On Google's screen, show the **app name "CrestClip"** and the permissions list (scroll slowly).
   Pick your channel and allow.
4. Back in CrestClip, show the connected channel name and picture (that's `youtube.readonly`).
5. Open a project → a clip → **Post → YouTube** → post it.
6. Open YouTube Studio and show the clip arrived on your channel (that's `youtube.upload`).
7. Show **Settings → Disconnect** and the `/data-deletion` page.

### 5. YouTube API audit — so uploads can be public

Until this passes, YouTube keeps every video uploaded through CrestClip **private**.

Form: <https://support.google.com/youtube/contact/yt_api_form> → **"YouTube API Services – Audit and Quota
Extension Form"**. Use the same project number and the same demo video. Short answers:

- **What it does:** posts short clips the user made in CrestClip to the user's own channel, now or at a
  time they choose. No viewing, searching, analytics or downloading of other people's content through the API.
- **Who uses it:** creators and clippers posting to their own channels.
- **Data stored:** channel id, name, handle, picture, and encrypted access tokens; deleted on Disconnect,
  on account deletion, or on request (see /data-deletion).
- **Quota needed:** say how many posts per day you expect (e.g. 200 uploads/day for launch).

---

## Meta (Instagram)

### 1. App settings — 10 minutes

developers.facebook.com → **CrestClip → App settings → Basic**:

- **App icon:** 1024×1024 PNG (your logo).
- **Category:** "Business and pages" (or "Photo and video").
- **Privacy policy URL:** `https://crestclip.com/privacy` (already set)
- **Terms of Service URL:** `https://crestclip.com/terms` (already set)
- **User data deletion → Data deletion instructions URL:** change it to
  `https://crestclip.com/data-deletion`
- **Save changes.**

### 2. Business verification ("Become a Tech Provider") — you, with documents

Dashboard → **Become a Tech Provider** → follow the steps. Meta needs your business details and a document
that shows the business name and address (GST certificate, Udyam registration, utility bill or bank
statement in the business name). Meta reviews it in a few days. **App Review can't be submitted before this.**

### 3. Make one real test call per permission

In CrestClip (with your Instagram **professional** account — Business or Creator): Settings → Connect
Instagram, then post one clip. That uses `instagram_business_basic` and `instagram_business_content_publish`,
so the "Test use cases" step on the dashboard turns green. (Wait up to 24 hours for it to update.)

### 4. App Review — request both permissions

App Review → **Requests → add** `instagram_business_basic` and `instagram_business_content_publish`
(Advanced access).

**How we use `instagram_business_content_publish`** (paste):

> CrestClip turns a creator's long videos into short vertical clips. When the user connects their own
> Instagram professional account and presses "Post" (or schedules it, or turns on Autopilot for their own
> account), CrestClip publishes that clip to their account as a Reel with the caption they wrote. We only
> publish content the user created and chose, only to the account they connected.

**How we use `instagram_business_basic`** (paste):

> After the user connects Instagram we read their account's id, username, name and profile picture to show
> which account is connected and let them pick it when posting. We don't read followers, messages,
> comments or insights.

**Screencast** (one per permission, or one video covering both — 1–2 minutes each):

1. Log in to `https://crestclip.com`.
2. **Settings → Connect Instagram** → show Instagram's login and the permissions screen → allow.
3. Show the connected username and picture in CrestClip (`instagram_business_basic`).
4. Open a clip → **Post → Instagram** → post.
5. Open Instagram and show the Reel on the profile (`instagram_business_content_publish`).

**Test login for the reviewer** — make a CrestClip account just for Meta (e.g.
`meta-review@crestclip.com` with a strong password), give it credits from the Admin page, and make one
finished project in it so there's a clip to post. Put the email + password in "Testing instructions" with:

> Log in at https://crestclip.com/login with the account above. Open Projects → the "Review demo"
> project → any clip → Post → Instagram, connect your test Instagram professional account, and post.

### 5. Publish the Meta app

After App Review approves: **Publish → switch the app to Live**.

---

## How long it takes

| Step | Usually |
|---|---|
| Google publish | instant |
| Google verification (sensitive scopes) | 3–7 working days, sometimes longer |
| YouTube API audit | 1–4 weeks |
| Meta business verification | 2–5 working days |
| Meta App Review | about 1–2 weeks after submitting |

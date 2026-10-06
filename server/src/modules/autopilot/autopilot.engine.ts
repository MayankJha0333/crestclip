import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { apClips, apSkips, apVideos, autopilots, clips, connections, credits, posts, projects, users, type ApClipRow, type AutopilotRow, type ClipRow, type PostRow } from '../../db/index.js';
import { enqueueProject } from '../../infra/queue.js';
import { ensureRedis, redisStatus } from '../../infra/redis.js';
import { runPost } from '../publishing/publishing.service.js';
import { refreshAccount } from '../billing/billing.service.js';
import { creditsForClips, planOf } from '../billing/plans.js';
import type { ProjectOptions } from '../../types.js';
import { channelVideos, topicVideos, uploadDateMs, videoDetails, type FoundVideo } from './autopilot.sources.js';
import { upcomingSlots, type Slot } from './autopilot.time.js';
import { guessSpokenLanguage, languageMismatch } from '../../pipeline/language.js';
import { purgeProject } from '../projects/retention.js';

/**
 * Autopilot, step by step (every few minutes, for each active autopilot):
 *   1. scan    — look for new videos in its sources (hourly)
 *   2. harvest — when a clipping job finishes, take its best clips (→ "review" or straight to "ready")
 *   3. clip    — keep about two days of clips in stock; start clipping the best waiting video when low
 *   4. plan    — put ready clips into the next empty posting times (next 3 days) and set a Redis timer for each post
 *   5. tidy    — mark clips posted / failed, return clips of cancelled times to the pool
 *
 * Redis (BullMQ) does the timing: a repeating "tick" job, plus one delayed job per post that fires at the exact
 * minute. MongoDB stays the record of truth, so everything is rebuilt in Redis on start-up.
 */

const log = (...a: unknown[]) => console.log('  [autopilot]', ...a);
const PREFIX = 'crestclip';
const PLAN_DAYS = 3;
const SCAN_EVERY = 60 * 60_000;
const RECHECK_EVERY = 6 * 3600_000;

let jobs: Queue | null = null;
let postQueue: Queue | null = null;

export const autopilotReady = () => Boolean(jobs && postQueue);

// ---------------- helpers ----------------
const hoursAgo = (h: number) => Date.now() - h * 3600_000;
const fill = (tpl: string, vars: Record<string, string>) =>
  tpl
    .replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export const DEFAULT_CAPTION = '{title}\n\n{hashtags}\n\n🎥 Credit: {channel}';

async function captionFor(ap: AutopilotRow, clip: ClipRow) {
  const p = await projects.get(clip.projectId);
  const tags = (clip.hashtags ?? []).map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ');
  return fill(ap.config.caption || DEFAULT_CAPTION, {
    title: clip.title ?? '',
    hook: clip.hook ?? '',
    description: clip.description ?? '',
    hashtags: tags,
    channel: p?.channel ?? '',
    link: p?.sourceUrl ?? '',
  }).slice(0, 2200);
}

/** clips waiting in line or already booked — what the autopilot has "in stock" */
const stock = async (apId: string) => (await apClips.withStatus(apId, 'review')).length + (await apClips.withStatus(apId, 'ready')).length + (await apClips.withStatus(apId, 'scheduled')).length;

/** The person's own skip rules: words in the title, channels they never want. Null = fine. */
function blockedReason(f: AutopilotRow['config']['filters'], title: string | null, channel: string | null) {
  const t = (title ?? '').toLowerCase();
  const word = (f.excludeWords ?? []).find((w) => w && t.includes(w.toLowerCase()));
  if (word) return `Title has “${word}”`;
  const ch = (channel ?? '').trim().toLowerCase().replace(/^@/, '');
  const blocked = ch ? (f.blockChannels ?? []).find((b) => b.trim().toLowerCase().replace(/^@/, '') === ch) : undefined;
  if (blocked) return `From ${channel} — a channel you blocked`;
  return null;
}

// ---------------- 1. scan ----------------
async function scan(ap: AutopilotRow) {
  const f = ap.config.filters;
  const errors: string[] = [];
  let added = 0;
  // the person's other autopilots that post to at least one of the same accounts: the same video must not be clipped
  // twice for one account (double credits, and near-identical posts)
  const mine = new Set(ap.config.targets.map((t) => t.connectionId));
  const siblings = ap.userId ? (await autopilots.list(ap.userId)).filter((o) => o.id !== ap.id && o.config.targets.some((t) => mine.has(t.connectionId))) : [];
  const siblingName = new Map(siblings.map((o) => [o.id, o.name]));
  for (const src of ap.config.sources) {
    let found: FoundVideo[] = [];
    try {
      if (src.kind === 'youtube_channel') {
        if (!src.channelId) continue;
        found = await channelVideos(src.channelId);
      } else {
        found = await topicVideos(src.value, src.region ?? null, f.maxAgeDays, f.languages?.length === 1 ? f.languages[0] : null, src.sort ?? 'views');
      }
    } catch (e) {
      errors.push(`${src.label ?? src.value}: ${(e as Error).message}`);
      continue;
    }
    for (const v of found) {
      if (await apVideos.has(ap.id, v.videoId)) continue;
      let status: 'waiting' | 'skipped' = 'waiting';
      let reason: string | null = null;
      if (v.publishedAt && v.publishedAt < Date.now() - f.maxAgeDays * 86400_000) [status, reason] = ['skipped', `Older than ${f.maxAgeDays} days`];
      else if (v.duration != null && v.duration < f.minMinutes * 60) [status, reason] = ['skipped', v.duration <= 60 ? 'A Short' : `Shorter than ${f.minMinutes} min`];
      else if (v.duration != null && v.duration > f.maxMinutes * 60) [status, reason] = ['skipped', `Longer than ${f.maxMinutes} min`];
      else if (languageMismatch(f.languages, null, v.title)) [status, reason] = ['skipped', languageMismatch(f.languages, null, v.title)];
      else if (blockedReason(f, v.title, v.channel)) [status, reason] = ['skipped', blockedReason(f, v.title, v.channel)];
      else {
        const taken = await apVideos.takenBy(v.videoId, [...siblingName.keys()]);
        if (taken) [status, reason] = ['skipped', `Already used by your autopilot “${siblingName.get(taken.autopilotId)}” (same account)`];
      }
      if (status === 'skipped' && !v.publishedAt) continue; // don't fill the list with junk from searches
      if (await apVideos.add({ autopilotId: ap.id, ...v, status, reason })) added++;
    }
  }
  await autopilots.update(ap.id, { lastScanAt: Date.now(), lastError: errors.length ? errors.join(' · ').slice(0, 500) : null });
  if (added) log(`${ap.name}: found ${added} new video${added > 1 ? 's' : ''}`);
  return added;
}

// ---------------- 2. harvest ----------------
async function harvest(ap: AutopilotRow) {
  for (const v of await apVideos.withStatus(ap.id, 'clipping')) {
    const p = v.projectId ? await projects.get(v.projectId) : null;
    if (!p) {
      await apVideos.update(v.id, { status: 'failed', reason: 'The clipping project was deleted' });
      continue;
    }
    if (p.status === 'failed' && p.errorCode === 'credits') {
      // credits ran out between the check and the start (e.g. another autopilot or a manual project took them):
      // not the video's fault — put it back and try again once credits are added
      await purgeProject(p).catch(() => projects.remove(p.id));
      await apVideos.update(v.id, { status: 'waiting', projectId: null, reason: 'Waiting for credits — tries again when credits are added' });
      await autopilots.update(ap.id, { lastError: 'Out of credits: clipping is paused. It continues by itself when credits are added (top-up or next month). Booked posts still go out.' });
      continue;
    }
    if (p.status === 'failed') {
      await apVideos.update(v.id, { status: 'failed', reason: p.error?.slice(0, 300) ?? 'Clipping failed' });
      continue;
    }
    if (p.status !== 'done') continue;
    const ready = (await clips.forProject(p.id))
      .filter((c) => c.status === 'ready' && c.filePath)
      .sort((a, b) => b.peakScore - a.peakScore)
      .slice(0, Math.max(1, ap.config.clipsPerVideo));
    for (const c of ready) await apClips.add({ autopilotId: ap.id, clipId: c.id, videoRowId: v.id, status: ap.config.mode === 'auto' ? 'ready' : 'review', score: c.peakScore });
    await apVideos.update(v.id, { status: 'done', reason: ready.length ? `${ready.length} clip${ready.length > 1 ? 's' : ''} made` : 'No clip-worthy moments' });
  }
}

// ---------------- 3. clip ----------------
async function startClipping(ap: AutopilotRow) {
  const perDay = ap.config.times.length;
  const want = perDay * 2; // keep about two days of clips in stock
  if ((await stock(ap.id)) >= want) return;
  if ((await apVideos.withStatus(ap.id, 'clipping')).length >= 2) return; // a couple at a time is plenty
  // daily budget so Gemini credits aren't spent faster than clips get posted
  const budget = Math.ceil(perDay / Math.max(1, ap.config.clipsPerVideo)) + 1;
  // …except when a posting time in the next 24 hours has nothing to post (e.g. a clip was removed from it)
  if ((await apVideos.startedSince(ap.id, hoursAgo(24))) >= budget && !(await emptySlotSoon(ap))) return;

  const f = ap.config.filters;
  const owner = ap.userId ? await users.get(ap.userId) : null;
  if (!owner) return;
  // the plan's video-length limit wins over the autopilot's own max (longer videos would fail when clipping starts)
  const planMax = planOf(owner.plan).maxVideoMinutes;
  const maxMinutes = Math.min(f.maxMinutes, planMax);
  // the owner pays in credits: wait (don't fail) until there's enough. Credits already promised to projects that
  // haven't been charged yet (other autopilots, manual clipping) don't count as free. Checked before opening any
  // video, so an autopilot without credits doesn't keep asking YouTube every few minutes.
  const fresh = await refreshAccount(owner);
  const clipCount = Math.min(10, ap.config.clipsPerVideo + 1);
  const need = creditsForClips(clipCount);
  const free = (await credits.balance(fresh.id)) - creditsForClips(await projects.unchargedClips(fresh.id));
  if (free < need) {
    await autopilots.update(ap.id, {
      lastError: `Out of credits: the next video needs ${need} and ${Math.max(0, free)} are free. Clipping continues by itself when credits are added (top-up or next month). Booked posts still go out.`,
    });
    return;
  }
  for (const v of await apVideos.withStatus(ap.id, 'waiting')) {
    if (v.publishedAt && v.publishedAt > hoursAgo(f.waitHours)) continue; // give YouTube time to build the rewatch graph
    if (v.updatedAt > Date.now() - RECHECK_EVERY && v.reason) continue; // checked recently and not good enough yet
    let d;
    try {
      d = await videoDetails(v.videoId);
    } catch (e) {
      await apVideos.update(v.id, { reason: `Couldn’t open the video: ${(e as Error).message}` });
      continue;
    }
    const published = v.publishedAt ?? uploadDateMs(d);
    const views = d.views ?? v.views;
    await apVideos.update(v.id, { views, duration: d.duration, title: d.title || v.title });
    if (d.isLive) {
      await apVideos.update(v.id, { status: 'skipped', reason: 'A live stream' });
      continue;
    }
    const blocked = blockedReason(f, d.title || v.title, d.channel || v.channel);
    if (blocked) {
      await apVideos.update(v.id, { status: 'skipped', reason: blocked });
      continue;
    }
    // no captions to tell the spoken language → ask the AI from the title and description (a Spanish title in Latin letters passes the script check)
    const spoken = d.language ?? (f.languages?.length ? await guessSpokenLanguage(d.title || v.title || '', d.description ?? '') : null);
    const wrongLanguage = languageMismatch(f.languages, spoken, d.title || v.title || '');
    if (wrongLanguage) {
      await apVideos.update(v.id, { status: 'skipped', reason: wrongLanguage });
      continue;
    }
    if (d.duration > planMax * 60 && d.duration <= f.maxMinutes * 60) {
      await apVideos.update(v.id, { status: 'skipped', reason: `${Math.round(d.duration / 60)} min long — your plan clips videos up to ${planMax} min` });
      continue;
    }
    if (d.duration < f.minMinutes * 60 || d.duration > maxMinutes * 60) {
      await apVideos.update(v.id, { status: 'skipped', reason: `${Math.round(d.duration / 60)} min long — outside ${f.minMinutes}–${maxMinutes} min` });
      continue;
    }
    if (published && published < Date.now() - f.maxAgeDays * 86400_000) {
      await apVideos.update(v.id, { status: 'skipped', reason: `Older than ${f.maxAgeDays} days` });
      continue;
    }
    if ((views ?? 0) < f.minViews) {
      await apVideos.update(v.id, { reason: `${(views ?? 0).toLocaleString('en-US')} views so far — waiting for ${f.minViews.toLocaleString('en-US')}` });
      continue;
    }
    if (ap.lastError?.startsWith('Out of credits')) await autopilots.update(ap.id, { lastError: null });
    // good to go → a normal CrestClip project with this autopilot's style
    const options: ProjectOptions = { ...ap.config.options, clipCount, useAudienceData: true };
    delete options.ranges;
    const p = await projects.create({ userId: owner.id, sourceType: 'url', sourceUrl: v.url, title: d.title || v.title || undefined, options });
    await apVideos.update(v.id, { status: 'clipping', projectId: p.id, reason: d.heatmap?.length ? 'Clipping (rewatch graph found)' : 'Clipping (no rewatch graph yet — AI picks)' });
    enqueueProject(p.id);
    log(`${ap.name}: clipping “${d.title}”`);
    return; // one new video per tick
  }
}

// ---------------- 4. plan ----------------
async function schedulePostJob(post: PostRow) {
  if (!postQueue || !post.scheduledAt) return;
  const existing = await postQueue.getJob(post.id);
  if (existing) return;
  await postQueue.add('post', { postId: post.id }, { jobId: post.id, delay: Math.max(0, post.scheduledAt - Date.now()), attempts: 1, removeOnComplete: true, removeOnFail: 200 });
}

async function plan(ap: AutopilotRow) {
  const cfg = ap.config;
  if (!cfg.times.length || !cfg.targets.length) return;
  const skips = await apSkips.list(ap.id);
  const slots = upcomingSlots(cfg.times, cfg.timezone, Date.now() + 2 * 60_000, PLAN_DAYS);
  const targets = await targetsOf(ap);
  if (!targets.length) {
    await autopilots.update(ap.id, { lastError: 'None of the chosen accounts are connected any more — edit the autopilot and pick an account.' });
    return;
  }
  const ready = await apClips.withStatus(ap.id, 'ready');
  for (const slot of slots) {
    if (!ready.length) break;
    if (skips.has(slot.key)) continue;
    if ((await posts.forSlot(ap.id, slot.key)).some((p) => p.status !== 'canceled')) continue;
    if (await apClips.bySlot(ap.id, slot.key)) continue;
    const item = ready.shift()!;
    await bookClip(ap, item, slot, targets);
  }
  await closeGaps(ap, slots, skips);
}

/** The accounts this autopilot posts to (only those still connected). */
async function targetsOf(ap: AutopilotRow) {
  return (await Promise.all(ap.config.targets.map(async (t) => ({ ...t, conn: await connections.get(t.connectionId) })))).filter((t) => t.conn);
}

/** Book one clip into one posting time: a post per account, each with a timer. Returns false if the clip is gone. */
async function bookClip(ap: AutopilotRow, item: ApClipRow, slot: Slot, targets: Awaited<ReturnType<typeof targetsOf>>) {
  const clip = await clips.get(item.clipId);
  if (!clip?.filePath) {
    await apClips.update(item.id, { status: 'failed' });
    return false;
  }
  const caption = await captionFor(ap, clip);
  for (const t of targets) {
    const post = await posts.create({
      clipId: clip.id,
      connectionId: t.connectionId,
      platform: t.conn!.platform,
      title: t.conn!.platform === 'youtube' ? (clip.title || 'New clip').slice(0, 100) : null,
      caption,
      privacy: t.conn!.platform === 'youtube' ? (t.privacy ?? 'public') : null,
      scheduledAt: slot.at,
      autopilotId: ap.id,
      slotKey: slot.key,
    });
    await schedulePostJob(post);
  }
  await apClips.update(item.id, { status: 'scheduled', slotKey: slot.key });
  return true;
}

/** A posting time's state: its live posts and the autopilot clip booked for it. */
async function slotState(apId: string, key: string) {
  const ps = (await posts.forSlot(apId, key)).filter((p) => p.status !== 'canceled');
  return { ps, item: await apClips.bySlot(apId, key) };
}

/**
 * A time left empty (its clip was removed and nothing is in line) doesn't stay a hole in the middle of the plan:
 * every later clip moves up one time, in order, so the gap ends up at the far end — where Autopilot has the most
 * time to make a new clip. Only posts that haven't started uploading move.
 */
async function closeGaps(ap: AutopilotRow, slots: Slot[], skips: Set<string>) {
  const open = slots.filter((s) => !skips.has(s.key));
  const state = await Promise.all(open.map((s) => slotState(ap.id, s.key)));
  const movable = (i: number) => {
    const x = state[i];
    return Boolean(x.item && x.item.status === 'scheduled' && x.ps.length && x.ps.every((p) => p.status === 'scheduled'));
  };
  for (let i = 0; i < open.length; i++) {
    if (state[i].ps.length || state[i].item) continue; // filled
    let j = i + 1;
    while (j < open.length && !movable(j)) j++;
    if (j >= open.length) break; // nothing later to pull forward
    const to = open[i];
    for (const p of state[j].ps) {
      await postQueue?.remove(p.id).catch(() => {});
      await posts.update(p.id, { scheduledAt: to.at, slotKey: to.key });
      await schedulePostJob({ ...p, scheduledAt: to.at, slotKey: to.key });
    }
    await apClips.update(state[j].item!.id, { slotKey: to.key });
    log(`${ap.name}: moved a clip up to ${to.date} ${to.time} to fill an empty time`);
    state[i] = state[j];
    state[j] = { ps: [], item: null };
  }
}

/** Is a posting time in the next 24 hours still empty? */
async function emptySlotSoon(ap: AutopilotRow) {
  const cfg = ap.config;
  if (!cfg.times.length || !cfg.targets.length) return false;
  const skips = await apSkips.list(ap.id);
  const soon = upcomingSlots(cfg.times, cfg.timezone, Date.now() + 2 * 60_000, 2).filter((s) => s.at < Date.now() + 24 * 3600_000 && !skips.has(s.key));
  for (const s of soon) {
    const st = await slotState(ap.id, s.key);
    if (!st.ps.length && !st.item) return true;
  }
  return false;
}

// ---------------- 5. tidy ----------------
/** Posts the person made themselves (not an autopilot) for a clip, that count as done: live, posting, or booked. */
export async function handPosts(clipId: string) {
  return (await posts.forClip(clipId)).filter((p) => !p.autopilotId && ['scheduled', 'uploading', 'processing', 'published'].includes(p.status));
}

/**
 * The person already posted (or booked) this clip themselves, so Autopilot doesn't post it again on those accounts.
 * A booked time keeps the clip and shows "Posted by you"; a clip still waiting in line is marked done.
 */
async function syncHandPosted(ap: AutopilotRow, item: ApClipRow) {
  const mine = await handPosts(item.clipId);
  if (!mine.length) return;
  const done = new Set(mine.map((p) => p.connectionId));
  if (item.status === 'scheduled' && item.slotKey) {
    const ofClip = async () => (await posts.forSlot(ap.id, item.slotKey!)).filter((p) => p.clipId === item.clipId);
    for (const p of await ofClip()) {
      if (p.status !== 'scheduled' || !done.has(p.connectionId)) continue;
      await posts.update(p.id, { status: 'canceled', error: 'Already posted by you' });
      await postQueue?.remove(p.id).catch(() => {});
    }
    // nothing left for Autopilot to post → this time is done (it keeps the clip, so nothing else is booked there)
    if ((await ofClip()).every((p) => p.status === 'canceled')) await apClips.update(item.id, { status: 'posted' });
    log(`${ap.name}: "${item.clipId}" was posted by hand — not posting it again`);
  } else if (item.status === 'ready' || item.status === 'review') {
    if (ap.config.targets.every((t) => done.has(t.connectionId))) await apClips.update(item.id, { status: 'posted', slotKey: null });
  }
}

/** Right after the person posts a clip themselves: update every autopilot that has it (no waiting for the tick). */
export async function clipPostedByHand(clipId: string) {
  for (const item of await apClips.forClip(clipId)) {
    if (!['scheduled', 'ready', 'review'].includes(item.status)) continue;
    const ap = await autopilots.get(item.autopilotId);
    if (ap) await syncHandPosted(ap, item);
  }
}

async function tidy(ap: AutopilotRow) {
  for (const status of ['scheduled', 'ready', 'review'] as const) for (const c of await apClips.withStatus(ap.id, status)) await syncHandPosted(ap, c);
  for (const c of await apClips.withStatus(ap.id, 'scheduled')) {
    if (!c.slotKey) continue;
    const list = (await posts.forSlot(ap.id, c.slotKey)).filter((p) => p.clipId === c.clipId);
    if (!list.length) continue;
    if (list.every((p) => p.status === 'canceled')) {
      // cancelled from the Schedule page → the clip is taken off, the same as "Remove" on the Autopilot page
      await apClips.update(c.id, { status: 'rejected', slotKey: null });
    } else if (list.every((p) => ['published', 'failed', 'canceled'].includes(p.status))) {
      await apClips.update(c.id, { status: list.some((p) => p.status === 'published') ? 'posted' : 'failed' });
    }
  }
}

// ---------------- the tick ----------------
let ticking = false;
let again = false; // a kick arrived while a tick was running → run once more right after
async function tickAll() {
  if (ticking) {
    again = true;
    return;
  }
  ticking = true;
  try {
    // emptiest stock first: when a person's credits are short, the autopilot that's about to run dry gets them
    const list = await autopilots.active();
    const need = new Map<string, number>();
    for (const ap of list) need.set(ap.id, (await stock(ap.id)) / Math.max(1, ap.config.times.length * 2));
    list.sort((a, b) => need.get(a.id)! - need.get(b.id)!);
    for (const ap of list) {
      try {
        // Autopilot is a Pro feature: if the owner's plan changed, stop it (nothing is lost — it can be turned back on)
        const owner = ap.userId ? await users.get(ap.userId) : null;
        if (!owner || !planOf(owner.plan).autopilot) {
          await autopilots.update(ap.id, { status: 'paused', lastError: 'Paused: Autopilot is on the Pro plan. Upgrade to turn it back on.' });
          await releaseScheduled(ap.id);
          continue;
        }
        await tidy(ap);
        await harvest(ap);
        if (!ap.lastScanAt || ap.lastScanAt < Date.now() - SCAN_EVERY) await scan(ap);
        await startClipping((await autopilots.get(ap.id))!);
        await plan((await autopilots.get(ap.id))!);
      } catch (e) {
        log(`${ap.name}:`, (e as Error).message);
        await autopilots.update(ap.id, { lastError: (e as Error).message.slice(0, 500) });
      }
    }
  } finally {
    ticking = false;
    if (again) {
      again = false;
      void tickAll();
    }
  }
}

// ---------------- actions from the UI ----------------
/** Cancel every not-yet-posted post of this autopilot (optionally only from one slot) and put the clips back in line. */
export async function releaseScheduled(apId: string, onlySlot?: string) {
  for (const p of await posts.scheduledForAutopilot(apId)) {
    if (onlySlot && p.slotKey !== onlySlot) continue;
    await posts.update(p.id, { status: 'canceled', error: null });
    await postQueue?.remove(p.id).catch(() => {});
  }
  for (const c of await apClips.withStatus(apId, 'scheduled')) {
    if (onlySlot && c.slotKey !== onlySlot) continue;
    await apClips.update(c.id, { status: 'ready', slotKey: null });
  }
}

export async function skipSlot(apId: string, key: string) {
  await apSkips.add(apId, key);
  await releaseScheduled(apId, key);
  await kick();
}
export async function restoreSlot(apId: string, key: string) {
  await apSkips.remove(apId, key);
  await kick();
}

/**
 * A post was cancelled on the Schedule page. Once the clip has no live post left at that time, the Autopilot drops
 * it straight away (it won't come back at another time) and later clips move up — no waiting for the next tick.
 */
export async function postCanceled(post: PostRow) {
  if (!post.autopilotId || !post.slotKey) return;
  const live = (await posts.forSlot(post.autopilotId, post.slotKey)).filter((p) => p.clipId === post.clipId && p.status !== 'canceled');
  if (live.length) return; // still posting to another account at that time
  await postQueue?.remove(post.id).catch(() => {});
  const item = await apClips.bySlot(post.autopilotId, post.slotKey);
  if (item && item.clipId === post.clipId) await apClips.update(item.id, { status: 'rejected', slotKey: null });
  await kick();
}

export async function rejectClip(item: ApClipRow) {
  if (item.status === 'scheduled' && item.slotKey) {
    for (const p of await posts.forSlot(item.autopilotId, item.slotKey)) {
      if (p.status !== 'scheduled') continue;
      await posts.update(p.id, { status: 'canceled' });
      await postQueue?.remove(p.id).catch(() => {});
    }
  }
  await apClips.update(item.id, { status: 'rejected', slotKey: null });
  await kick();
}

/**
 * Clips that could take a time's place: finished clips in line, plus the other finished clips Autopilot made from
 * the same videos that were never put in line (each video gives a spare). Best first.
 */
export async function alternatives(ap: AutopilotRow) {
  const used = new Set((await apClips.list(ap.id)).map((c) => c.clipId));
  const inLine = (await apClips.withStatus(ap.id, 'ready')).map((c) => ({ clipId: c.clipId, apClipId: c.id as string | null }));
  const spare: { clipId: string; apClipId: string | null; score: number }[] = [];
  for (const v of await apVideos.list(ap.id, 100)) {
    if (!v.projectId) continue;
    for (const c of await clips.forProject(v.projectId)) if (c.status === 'ready' && c.filePath && !used.has(c.id)) spare.push({ clipId: c.id, apClipId: null, score: c.peakScore });
  }
  spare.sort((a, b) => b.score - a.score);
  return [...inLine, ...spare.map(({ clipId, apClipId }) => ({ clipId, apClipId }))].slice(0, 30);
}

/**
 * Put a different clip into a booked time: the current clip is taken off (not posted), the chosen one is booked at
 * the same time. `choice` is a clip in line (apClipId) or a spare clip from this autopilot's videos (clipId).
 */
export async function swapSlot(ap: AutopilotRow, key: string, choice: { apClipId?: string; clipId?: string }) {
  const slot = upcomingSlots(ap.config.times, ap.config.timezone, Date.now() + 2 * 60_000, 8).find((s) => s.key === key);
  if (!slot) throw new Error('This time has passed or is too close to change.');
  const targets = await targetsOf(ap);
  if (!targets.length) throw new Error('None of the chosen accounts are connected any more.');
  // the clip that goes in
  let next: ApClipRow | null = null;
  if (choice.apClipId) {
    next = await apClips.get(choice.apClipId);
    if (!next || next.autopilotId !== ap.id || !['ready', 'review'].includes(next.status)) throw new Error('That clip isn’t available any more.');
  } else if (choice.clipId) {
    const ok = (await alternatives(ap)).some((a) => a.clipId === choice.clipId && !a.apClipId);
    if (!ok) throw new Error('That clip isn’t available any more.');
    const c = (await clips.get(choice.clipId))!;
    const v = (await apVideos.list(ap.id, 100)).find((x) => x.projectId === c.projectId);
    next = await apClips.add({ autopilotId: ap.id, clipId: c.id, videoRowId: v?.id ?? null, status: 'ready', score: c.peakScore });
    if (!next) throw new Error('That clip isn’t available any more.');
  } else throw new Error('Pick a clip.');
  // the clip that comes out (only if nothing has started uploading yet)
  const live = (await posts.forSlot(ap.id, key)).filter((p) => p.status !== 'canceled');
  if (live.some((p) => p.status !== 'scheduled')) throw new Error('This clip is already being posted.');
  for (const p of live) {
    await posts.update(p.id, { status: 'canceled' });
    await postQueue?.remove(p.id).catch(() => {});
  }
  const out = await apClips.bySlot(ap.id, key);
  if (out) await apClips.update(out.id, { status: 'rejected', slotKey: null });
  await apSkips.remove(ap.id, key);
  await bookClip(ap, next, slot, targets);
  await kick();
}

/** Run a tick now (after a change in the UI) instead of waiting for the next one. */
export async function kick() {
  if (jobs) await jobs.add('tick', {}, { removeOnComplete: true, removeOnFail: 50 }).catch(() => tickAll());
  else void tickAll();
}

export async function scanNow(apId: string) {
  await autopilots.update(apId, { lastScanAt: null });
  await kick();
}

/** The next `days` days of posting times with what will go out at each. */
export async function schedule(ap: AutopilotRow, days = 7) {
  const slots: Slot[] = upcomingSlots(ap.config.times, ap.config.timezone, Date.now() - 60 * 60_000, days);
  // all lookups at the same time (one wait, not one per slot)
  const [skips, rows] = await Promise.all([
    apSkips.list(ap.id),
    Promise.all(slots.map((s) => Promise.all([posts.forSlot(ap.id, s.key), apClips.bySlot(ap.id, s.key)]))),
  ]);
  return Promise.all(
    slots.map(async (s, i) => {
      const list = rows[i][0].filter((p) => p.status !== 'canceled');
      const item = rows[i][1];
      return { ...s, skipped: skips.has(s.key), posts: list, clipId: list[0]?.clipId ?? item?.clipId ?? null, apClipId: item?.id ?? null, itemStatus: item?.status ?? null };
    }),
  );
}

// ---------------- start-up ----------------
export async function startAutopilot() {
  const url = await ensureRedis();
  if (!url) {
    // try again later (e.g. Redis is still being set up, or the computer was offline)
    setTimeout(() => void startAutopilot(), 5 * 60_000).unref();
    return;
  }
  try {
    const connection = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
    connection.on('error', (e) => {
      if (redisStatus.state === 'ready') log('redis:', e.message);
    });
    jobs = new Queue('autopilot', { connection, prefix: PREFIX });
    postQueue = new Queue('autopilot-post', { connection, prefix: PREFIX });
    const w1 = new Worker('autopilot', async () => tickAll(), { connection, prefix: PREFIX, concurrency: 1 });
    const w2 = new Worker('autopilot-post', async (job) => runPost(String(job.data.postId)), { connection, prefix: PREFIX, concurrency: 2 });
    for (const w of [w1, w2]) w.on('error', (e) => log('worker:', e.message));
    // the heartbeat: every 5 minutes
    await jobs.upsertJobScheduler('autopilot-tick', { every: 5 * 60_000 }, { name: 'tick', opts: { removeOnComplete: true, removeOnFail: 50 } });
    // put back a timer for every booked post (Redis may have restarted empty)
    for (const p of await posts.allScheduledAutopilot()) await schedulePostJob(p);
    log(`scheduler ready (Redis: ${redisStatus.source})`);
    await kick();
  } catch (e) {
    redisStatus.state = 'error';
    redisStatus.detail = `Couldn’t use Redis: ${(e as Error).message}`;
    log(redisStatus.detail);
    jobs = postQueue = null;
    setTimeout(() => void startAutopilot(), 5 * 60_000).unref();
  }
}

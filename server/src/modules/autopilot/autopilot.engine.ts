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

/**
 * Autopilot, step by step (every few minutes, for each active autopilot):
 *   1. scan    — look for new videos in its sources (hourly)
 *   2. harvest — when a clipping job finishes, take its best clips (→ "review" or straight to "ready")
 *   3. clip    — keep about two days of clips in stock; start clipping the best waiting video when low
 *   4. plan    — put ready clips into the next empty posting times (next 3 days) and set a Redis timer for each post
 *   5. tidy    — mark clips posted / failed, return clips of cancelled times to the pool
 *
 * Redis (BullMQ) does the timing: a repeating "tick" job, plus one delayed job per post that fires at the exact
 * minute. SQLite stays the record of truth, so everything is rebuilt in Redis on start-up.
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

function captionFor(ap: AutopilotRow, clip: ClipRow) {
  const p = projects.get(clip.projectId);
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
const stock = (apId: string) => apClips.withStatus(apId, 'review').length + apClips.withStatus(apId, 'ready').length + apClips.withStatus(apId, 'scheduled').length;

// ---------------- 1. scan ----------------
async function scan(ap: AutopilotRow) {
  const f = ap.config.filters;
  const errors: string[] = [];
  let added = 0;
  for (const src of ap.config.sources) {
    let found: FoundVideo[] = [];
    try {
      if (src.kind === 'youtube_channel') {
        if (!src.channelId) continue;
        found = await channelVideos(src.channelId);
      } else {
        found = await topicVideos(src.value, src.region ?? null, f.maxAgeDays);
      }
    } catch (e) {
      errors.push(`${src.label ?? src.value}: ${(e as Error).message}`);
      continue;
    }
    for (const v of found) {
      if (apVideos.has(ap.id, v.videoId)) continue;
      let status: 'waiting' | 'skipped' = 'waiting';
      let reason: string | null = null;
      if (v.publishedAt && v.publishedAt < Date.now() - f.maxAgeDays * 86400_000) [status, reason] = ['skipped', `Older than ${f.maxAgeDays} days`];
      else if (v.duration != null && v.duration < f.minMinutes * 60) [status, reason] = ['skipped', v.duration <= 60 ? 'A Short' : `Shorter than ${f.minMinutes} min`];
      else if (v.duration != null && v.duration > f.maxMinutes * 60) [status, reason] = ['skipped', `Longer than ${f.maxMinutes} min`];
      if (status === 'skipped' && !v.publishedAt) continue; // don't fill the list with junk from searches
      if (apVideos.add({ autopilotId: ap.id, ...v, status, reason })) added++;
    }
  }
  autopilots.update(ap.id, { lastScanAt: Date.now(), lastError: errors.length ? errors.join(' · ').slice(0, 500) : null });
  if (added) log(`${ap.name}: found ${added} new video${added > 1 ? 's' : ''}`);
  return added;
}

// ---------------- 2. harvest ----------------
function harvest(ap: AutopilotRow) {
  for (const v of apVideos.withStatus(ap.id, 'clipping')) {
    const p = v.projectId ? projects.get(v.projectId) : null;
    if (!p) {
      apVideos.update(v.id, { status: 'failed', reason: 'The clipping project was deleted' });
      continue;
    }
    if (p.status === 'failed') {
      apVideos.update(v.id, { status: 'failed', reason: p.error?.slice(0, 300) ?? 'Clipping failed' });
      continue;
    }
    if (p.status !== 'done') continue;
    const ready = clips
      .forProject(p.id)
      .filter((c) => c.status === 'ready' && c.filePath)
      .sort((a, b) => b.peakScore - a.peakScore)
      .slice(0, Math.max(1, ap.config.clipsPerVideo));
    for (const c of ready) apClips.add({ autopilotId: ap.id, clipId: c.id, videoRowId: v.id, status: ap.config.mode === 'auto' ? 'ready' : 'review', score: c.peakScore });
    apVideos.update(v.id, { status: 'done', reason: ready.length ? `${ready.length} clip${ready.length > 1 ? 's' : ''} made` : 'No clip-worthy moments' });
  }
}

// ---------------- 3. clip ----------------
async function startClipping(ap: AutopilotRow) {
  const perDay = ap.config.times.length;
  const want = perDay * 2; // keep about two days of clips in stock
  if (stock(ap.id) >= want) return;
  if (apVideos.withStatus(ap.id, 'clipping').length >= 2) return; // a couple at a time is plenty
  // daily budget so Gemini credits aren't spent faster than clips get posted
  const budget = Math.ceil(perDay / Math.max(1, ap.config.clipsPerVideo)) + 1;
  if (apVideos.startedSince(ap.id, hoursAgo(24)) >= budget) return;

  const f = ap.config.filters;
  for (const v of apVideos.withStatus(ap.id, 'waiting')) {
    if (v.publishedAt && v.publishedAt > hoursAgo(f.waitHours)) continue; // give YouTube time to build the rewatch graph
    if (v.updatedAt > Date.now() - RECHECK_EVERY && v.reason) continue; // checked recently and not good enough yet
    let d;
    try {
      d = await videoDetails(v.videoId);
    } catch (e) {
      apVideos.update(v.id, { reason: `Couldn’t open the video: ${(e as Error).message}` });
      continue;
    }
    const published = v.publishedAt ?? uploadDateMs(d);
    const views = d.views ?? v.views;
    apVideos.update(v.id, { views, duration: d.duration, title: d.title || v.title });
    if (d.isLive) {
      apVideos.update(v.id, { status: 'skipped', reason: 'A live stream' });
      continue;
    }
    if (d.duration < f.minMinutes * 60 || d.duration > f.maxMinutes * 60) {
      apVideos.update(v.id, { status: 'skipped', reason: `${Math.round(d.duration / 60)} min long — outside ${f.minMinutes}–${f.maxMinutes} min` });
      continue;
    }
    if (published && published < Date.now() - f.maxAgeDays * 86400_000) {
      apVideos.update(v.id, { status: 'skipped', reason: `Older than ${f.maxAgeDays} days` });
      continue;
    }
    if ((views ?? 0) < f.minViews) {
      apVideos.update(v.id, { reason: `${(views ?? 0).toLocaleString('en-US')} views so far — waiting for ${f.minViews.toLocaleString('en-US')}` });
      continue;
    }
    // the owner pays for it in credits: wait (don't fail) until they have enough
    const owner = ap.userId ? await refreshAccount(users.get(ap.userId)!) : null;
    const clipCount = Math.min(10, ap.config.clipsPerVideo + 1);
    const need = creditsForClips(clipCount);
    if (!owner || credits.balance(owner.id) < need) {
      autopilots.update(ap.id, { lastError: `Out of credits: “${d.title || v.title}” needs ${need}. Clipping continues when credits are added (top-up or next month).` });
      return;
    }
    if (ap.lastError?.startsWith('Out of credits')) autopilots.update(ap.id, { lastError: null });
    // good to go → a normal CrestClip project with this autopilot's style
    const options: ProjectOptions = { ...ap.config.options, clipCount, useAudienceData: true };
    delete options.ranges;
    if (!ap.userId) return;
    const p = projects.create({ userId: ap.userId, sourceType: 'url', sourceUrl: v.url, title: d.title || v.title || undefined, options });
    apVideos.update(v.id, { status: 'clipping', projectId: p.id, reason: d.heatmap?.length ? 'Clipping (rewatch graph found)' : 'Clipping (no rewatch graph yet — AI picks)' });
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
  const skips = apSkips.list(ap.id);
  const slots = upcomingSlots(cfg.times, cfg.timezone, Date.now() + 2 * 60_000, PLAN_DAYS);
  const targets = cfg.targets.map((t) => ({ ...t, conn: connections.get(t.connectionId) })).filter((t) => t.conn);
  if (!targets.length) {
    autopilots.update(ap.id, { lastError: 'None of the chosen accounts are connected any more — edit the autopilot and pick an account.' });
    return;
  }
  const ready = apClips.withStatus(ap.id, 'ready');
  for (const slot of slots) {
    if (!ready.length) break;
    if (skips.has(slot.key)) continue;
    if (posts.forSlot(ap.id, slot.key).some((p) => p.status !== 'canceled')) continue;
    if (apClips.bySlot(ap.id, slot.key)) continue;
    const item = ready.shift()!;
    const clip = clips.get(item.clipId);
    if (!clip?.filePath) {
      apClips.update(item.id, { status: 'failed' });
      continue;
    }
    const caption = captionFor(ap, clip);
    for (const t of targets) {
      const post = posts.create({
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
    apClips.update(item.id, { status: 'scheduled', slotKey: slot.key });
  }
}

// ---------------- 5. tidy ----------------
function tidy(ap: AutopilotRow) {
  for (const c of apClips.withStatus(ap.id, 'scheduled')) {
    if (!c.slotKey) continue;
    const list = posts.forSlot(ap.id, c.slotKey).filter((p) => p.clipId === c.clipId);
    if (!list.length) continue;
    if (list.every((p) => p.status === 'canceled')) {
      // cancelled from the Publishing page → treat as "skip that time", keep the clip for later
      apSkips.add(ap.id, c.slotKey);
      apClips.update(c.id, { status: 'ready', slotKey: null });
    } else if (list.every((p) => ['published', 'failed', 'canceled'].includes(p.status))) {
      apClips.update(c.id, { status: list.some((p) => p.status === 'published') ? 'posted' : 'failed' });
    }
  }
}

// ---------------- the tick ----------------
let ticking = false;
async function tickAll() {
  if (ticking) return;
  ticking = true;
  try {
    for (const ap of autopilots.active()) {
      try {
        // Autopilot is a Pro feature: if the owner's plan changed, stop it (nothing is lost — it can be turned back on)
        const owner = ap.userId ? users.get(ap.userId) : null;
        if (!owner || !planOf(owner.plan).autopilot) {
          autopilots.update(ap.id, { status: 'paused', lastError: 'Paused: Autopilot is on the Pro plan. Upgrade to turn it back on.' });
          await releaseScheduled(ap.id);
          continue;
        }
        tidy(ap);
        harvest(ap);
        if (!ap.lastScanAt || ap.lastScanAt < Date.now() - SCAN_EVERY) await scan(ap);
        await startClipping(autopilots.get(ap.id)!);
        await plan(autopilots.get(ap.id)!);
      } catch (e) {
        log(`${ap.name}:`, (e as Error).message);
        autopilots.update(ap.id, { lastError: (e as Error).message.slice(0, 500) });
      }
    }
  } finally {
    ticking = false;
  }
}

// ---------------- actions from the UI ----------------
/** Cancel every not-yet-posted post of this autopilot (optionally only from one slot) and put the clips back in line. */
export async function releaseScheduled(apId: string, onlySlot?: string) {
  for (const p of posts.scheduledForAutopilot(apId)) {
    if (onlySlot && p.slotKey !== onlySlot) continue;
    posts.update(p.id, { status: 'canceled', error: null });
    await postQueue?.remove(p.id).catch(() => {});
  }
  for (const c of apClips.withStatus(apId, 'scheduled')) {
    if (onlySlot && c.slotKey !== onlySlot) continue;
    apClips.update(c.id, { status: 'ready', slotKey: null });
  }
}

export async function skipSlot(apId: string, key: string) {
  apSkips.add(apId, key);
  await releaseScheduled(apId, key);
  await kick();
}
export async function restoreSlot(apId: string, key: string) {
  apSkips.remove(apId, key);
  await kick();
}

export async function rejectClip(item: ApClipRow) {
  if (item.status === 'scheduled' && item.slotKey) {
    for (const p of posts.forSlot(item.autopilotId, item.slotKey)) {
      if (p.status !== 'scheduled') continue;
      posts.update(p.id, { status: 'canceled' });
      await postQueue?.remove(p.id).catch(() => {});
    }
  }
  apClips.update(item.id, { status: 'rejected', slotKey: null });
  await kick();
}

/** Run a tick now (after a change in the UI) instead of waiting for the next one. */
export async function kick() {
  if (jobs) await jobs.add('tick', {}, { removeOnComplete: true, removeOnFail: 50 }).catch(() => tickAll());
  else void tickAll();
}

export async function scanNow(apId: string) {
  autopilots.update(apId, { lastScanAt: null });
  await kick();
}

/** The next `days` days of posting times with what will go out at each. */
export function schedule(ap: AutopilotRow, days = 7) {
  const skips = apSkips.list(ap.id);
  const slots: Slot[] = upcomingSlots(ap.config.times, ap.config.timezone, Date.now() - 60 * 60_000, days);
  return slots.map((s) => {
    const list = posts.forSlot(ap.id, s.key).filter((p) => p.status !== 'canceled');
    const item = apClips.bySlot(ap.id, s.key);
    return { ...s, skipped: skips.has(s.key), posts: list, clipId: list[0]?.clipId ?? item?.clipId ?? null, apClipId: item?.id ?? null };
  });
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
    for (const p of posts.allScheduledAutopilot()) await schedulePostJob(p);
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

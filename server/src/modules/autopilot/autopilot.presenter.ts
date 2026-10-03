import { apClips, apVideos, clips, connections, posts, projects, type AutopilotRow } from '../../db/index.js';
import { redisStatus } from '../../infra/redis.js';
import { toMediaUrl } from '../../lib/paths.js';
import { publicPost } from '../publishing/publishing.presenter.js';
import { autopilotReady, handPosts, schedule } from './autopilot.engine.js';

/** The short clip card Autopilot shows (by clip id; null if the clip is gone). */
async function autopilotClip(id: string) {
  const c = await clips.get(id);
  if (!c) return null;
  const p = await projects.get(c.projectId);
  return {
    id: c.id,
    projectId: c.projectId,
    title: c.title,
    hook: c.hook,
    score: Math.round(c.peakScore),
    duration: Math.round(c.end - c.start),
    thumbUrl: toMediaUrl(c.thumbPath),
    videoUrl: toMediaUrl(c.filePath),
    source: p ? { title: p.title, channel: p.channel, url: p.sourceUrl } : null,
  };
}

export async function autopilotSummary(ap: AutopilotRow) {
  const soon = await schedule(ap, 3);
  const next = soon.find((s) => !s.skipped && s.at > Date.now());
  const booked = soon.find((s) => s.posts.length && s.at > Date.now());
  const [review, ready, scheduled, posted, clipping, waiting] = await Promise.all([
    apClips.withStatus(ap.id, 'review'),
    apClips.withStatus(ap.id, 'ready'),
    apClips.withStatus(ap.id, 'scheduled'),
    apClips.withStatus(ap.id, 'posted'),
    apVideos.withStatus(ap.id, 'clipping'),
    apVideos.withStatus(ap.id, 'waiting'),
  ]);
  return {
    id: ap.id,
    name: ap.name,
    status: ap.status,
    config: ap.config,
    lastScanAt: ap.lastScanAt,
    lastError: ap.lastError,
    createdAt: ap.createdAt,
    nextTime: next?.at ?? null,
    nextPost: booked ? { at: booked.at, clip: booked.clipId ? await autopilotClip(booked.clipId) : null } : null,
    counts: {
      review: review.length,
      ready: ready.length,
      scheduled: scheduled.length,
      posted: posted.length,
      clipping: clipping.length,
      waiting: waiting.length,
    },
  };
}

/** The autopilot page: summary + the next 7 days of posting times, the clip queue, found videos and past posts. */
export async function autopilotDetail(ap: AutopilotRow) {
  const items = await apClips.list(ap.id);
  const withClip = async (status: string) =>
    (
      await Promise.all(items.filter((i) => i.status === status).map(async (i) => ({ id: i.id, status: i.status, slotKey: i.slotKey, createdAt: i.createdAt, clip: await autopilotClip(i.clipId) })))
    ).filter((i) => i.clip);
  const accountName = async (connectionId: string) => {
    const c = await connections.get(connectionId);
    return c?.handle ?? c?.name ?? null;
  };
  const schedule7 = await Promise.all(
    (await schedule(ap, 7)).map(async (s) => ({
      key: s.key,
      at: s.at,
      date: s.date,
      time: s.time,
      skipped: s.skipped,
      apClipId: s.apClipId,
      clip: s.clipId ? await autopilotClip(s.clipId) : null,
      posts: await Promise.all(s.posts.map(async (p) => ({ id: p.id, platform: p.platform, status: p.status, error: p.error, remoteUrl: p.remoteUrl, account: await accountName(p.connectionId) }))),
      // the same clip posted by the person themselves (shown as "by you"; Autopilot won't post it again there)
      byYou: s.clipId
        ? await Promise.all(
            (await handPosts(s.clipId)).map(async (p) => ({ id: p.id, platform: p.platform, status: p.status, at: p.scheduledAt ?? p.updatedAt, remoteUrl: p.remoteUrl, account: await accountName(p.connectionId) })),
          )
        : [],
    })),
  );
  // Posted tab: Autopilot's own posts, plus clips of this autopilot the person posted by hand
  const handDone = items.filter((i) => i.status === 'posted').map((i) => i.clipId);
  const byHand = (await posts.forClips(handDone)).filter((p) => !p.autopilotId && ['uploading', 'processing', 'published'].includes(p.status));
  const past = [...(await posts.forAutopilot(ap.id, 100)).filter((p) => p.status !== 'scheduled'), ...byHand].sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    ...(await autopilotSummary(ap)),
    schedule: schedule7,
    review: await withClip('review'),
    ready: await withClip('ready'),
    videos: await apVideos.list(ap.id, 100),
    history: await Promise.all(past.map(publicPost)),
  };
}

/** Is the scheduler running, and on which Redis (a custom REDIS_URL is not shown — it may hold a password). */
/** Clips that could replace a booked one, as clip cards (gone clips left out). */
export async function alternativesView(list: { clipId: string; apClipId: string | null }[]) {
  const out = await Promise.all(list.map(async (a) => ({ apClipId: a.apClipId, inLine: Boolean(a.apClipId), clip: await autopilotClip(a.clipId) })));
  return out.filter((a) => a.clip);
}

export const autopilotStatus = () => ({ ...redisStatus, url: redisStatus.source === 'env' ? 'custom' : redisStatus.url, running: autopilotReady() });

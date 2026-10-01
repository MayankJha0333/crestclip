import { apClips, apVideos, clips, connections, posts, projects, type AutopilotRow } from '../../db/index.js';
import { redisStatus } from '../../infra/redis.js';
import { toMediaUrl } from '../../lib/paths.js';
import { publicPost } from '../publishing/publishing.presenter.js';
import { autopilotReady, schedule } from './autopilot.engine.js';

/** The short clip card Autopilot shows (by clip id; null if the clip is gone). */
function autopilotClip(id: string) {
  const c = clips.get(id);
  if (!c) return null;
  const p = projects.get(c.projectId);
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

export function autopilotSummary(ap: AutopilotRow) {
  const next = schedule(ap, 3).find((s) => !s.skipped && s.at > Date.now());
  const booked = schedule(ap, 3).find((s) => s.posts.length && s.at > Date.now());
  return {
    id: ap.id,
    name: ap.name,
    status: ap.status,
    config: ap.config,
    lastScanAt: ap.lastScanAt,
    lastError: ap.lastError,
    createdAt: ap.createdAt,
    nextTime: next?.at ?? null,
    nextPost: booked ? { at: booked.at, clip: booked.clipId ? autopilotClip(booked.clipId) : null } : null,
    counts: {
      review: apClips.withStatus(ap.id, 'review').length,
      ready: apClips.withStatus(ap.id, 'ready').length,
      scheduled: apClips.withStatus(ap.id, 'scheduled').length,
      posted: apClips.withStatus(ap.id, 'posted').length,
      clipping: apVideos.withStatus(ap.id, 'clipping').length,
      waiting: apVideos.withStatus(ap.id, 'waiting').length,
    },
  };
}

/** The autopilot page: summary + the next 7 days of posting times, the clip queue, found videos and past posts. */
export function autopilotDetail(ap: AutopilotRow) {
  const items = apClips.list(ap.id);
  const withClip = (status: string) =>
    items
      .filter((i) => i.status === status)
      .map((i) => ({ id: i.id, status: i.status, slotKey: i.slotKey, createdAt: i.createdAt, clip: autopilotClip(i.clipId) }))
      .filter((i) => i.clip);
  return {
    ...autopilotSummary(ap),
    schedule: schedule(ap, 7).map((s) => ({
      key: s.key,
      at: s.at,
      date: s.date,
      time: s.time,
      skipped: s.skipped,
      apClipId: s.apClipId,
      clip: s.clipId ? autopilotClip(s.clipId) : null,
      posts: s.posts.map((p) => ({ id: p.id, platform: p.platform, status: p.status, error: p.error, remoteUrl: p.remoteUrl, account: connections.get(p.connectionId)?.handle ?? connections.get(p.connectionId)?.name ?? null })),
    })),
    review: withClip('review'),
    ready: withClip('ready'),
    videos: apVideos.list(ap.id, 100),
    history: posts
      .forAutopilot(ap.id, 100)
      .filter((p) => p.status !== 'scheduled')
      .map(publicPost),
  };
}

/** Is the scheduler running, and on which Redis (a custom REDIS_URL is not shown — it may hold a password). */
export const autopilotStatus = () => ({ ...redisStatus, url: redisStatus.source === 'env' ? 'custom' : redisStatus.url, running: autopilotReady() });

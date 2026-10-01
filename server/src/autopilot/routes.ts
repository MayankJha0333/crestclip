import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { apClips, apVideos, autopilots, clips, connections, posts, projects, type AutopilotConfig, type AutopilotRow } from '../db.js';
import { optionsSchema } from '../options.js';
import { toMediaUrl } from '../pipeline/process.js';
import { publicPost } from '../publish.js';
import { redisStatus } from '../redis.js';
import type { ProjectOptions } from '../types.js';
import { autopilotReady, DEFAULT_CAPTION, kick, rejectClip, releaseScheduled, restoreSlot, scanNow, schedule, skipSlot } from './engine.js';
import { channelVideos, resolveChannel, topicVideos } from './sources.js';
import { isValidZone, upcomingSlots } from './time.js';

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
const configSchema = z.object({
  name: z.string().trim().min(1).max(80),
  sources: z
    .array(
      z.object({
        kind: z.enum(['youtube_channel', 'youtube_topic']),
        value: z.string().trim().min(1).max(300),
        channelId: z.string().max(40).nullish(),
        label: z.string().max(200).nullish(),
        region: z.string().max(4).nullish(),
      }),
    )
    .min(1, 'Add at least one source')
    .max(20),
  filters: z.object({
    minViews: z.coerce.number().int().min(0).max(1e10).default(10_000),
    minMinutes: z.coerce.number().min(1).max(600).default(5),
    maxMinutes: z.coerce.number().min(1).max(900).default(180),
    maxAgeDays: z.coerce.number().int().min(1).max(365).default(14),
    waitHours: z.coerce.number().min(0).max(240).default(24),
  }),
  options: optionsSchema.partial().default({}),
  clipsPerVideo: z.coerce.number().int().min(1).max(5).default(2),
  times: z.array(z.string().regex(timeRe, 'Times look like 13:00')).min(1, 'Pick at least one posting time').max(12),
  timezone: z.string().refine(isValidZone, 'Unknown time zone'),
  targets: z
    .array(z.object({ connectionId: z.string(), privacy: z.enum(['public', 'unlisted', 'private']).optional() }))
    .min(1, 'Pick at least one account to post to'),
  mode: z.enum(['review', 'auto']).default('review'),
  caption: z.string().max(2200).default(DEFAULT_CAPTION),
  rightsConfirmed: z.literal(true, { errorMap: () => ({ message: 'Confirm you have the rights to clip and repost these videos' }) }),
});

function toConfig(body: z.infer<typeof configSchema>): { name: string; config: AutopilotConfig } {
  const times = [...new Set(body.times)].sort();
  const options = optionsSchema.parse({ ...body.options, ranges: undefined }) as ProjectOptions;
  return {
    name: body.name,
    config: {
      sources: body.sources.map((s) => ({ ...s, channelId: s.channelId ?? null, label: s.label ?? null, region: s.region ?? null })),
      filters: { ...body.filters, maxMinutes: Math.max(body.filters.maxMinutes, body.filters.minMinutes + 1) },
      options,
      clipsPerVideo: body.clipsPerVideo,
      times,
      timezone: body.timezone,
      targets: body.targets.filter((t) => connections.get(t.connectionId)),
      mode: body.mode,
      caption: body.caption,
      rightsConfirmed: true,
    },
  };
}

/** channel sources need their YouTube id — look up any that don't have one yet */
async function resolveSources(cfg: AutopilotConfig) {
  for (const s of cfg.sources) {
    if (s.kind !== 'youtube_channel' || s.channelId) continue;
    const r = await resolveChannel(s.value);
    s.channelId = r.channelId;
    s.label = r.label;
  }
}

function publicClip(id: string) {
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

function summary(ap: AutopilotRow) {
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
    nextPost: booked ? { at: booked.at, clip: booked.clipId ? publicClip(booked.clipId) : null } : null,
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

export const autopilotRouter = Router();

autopilotRouter.get('/autopilot/status', (_req, res) => {
  res.json({ ...redisStatus, url: redisStatus.source === 'env' ? 'custom' : redisStatus.url, running: autopilotReady() });
});

autopilotRouter.post(
  '/autopilot/resolve-channel',
  wrap(async (req, res) => {
    try {
      res.json(await resolveChannel(String(req.body?.input ?? '')));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  }),
);

autopilotRouter.get('/autopilots', (_req, res) => {
  res.json(autopilots.list().map(summary));
});

autopilotRouter.post(
  '/autopilots',
  wrap(async (req, res) => {
    const body = configSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Check the form' });
    const { name, config } = toConfig(body.data);
    try {
      await resolveSources(config);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
    const ap = autopilots.create(name, config);
    await kick();
    res.status(201).json(summary(ap));
  }),
);

autopilotRouter.get('/autopilots/:id', (req, res) => {
  const ap = autopilots.get(req.params.id);
  if (!ap) return res.status(404).json({ error: 'Autopilot not found' });
  const items = apClips.list(ap.id);
  const withClip = (status: string) =>
    items
      .filter((i) => i.status === status)
      .map((i) => ({ id: i.id, status: i.status, slotKey: i.slotKey, createdAt: i.createdAt, clip: publicClip(i.clipId) }))
      .filter((i) => i.clip);
  res.json({
    ...summary(ap),
    schedule: schedule(ap, 7).map((s) => ({
      key: s.key,
      at: s.at,
      date: s.date,
      time: s.time,
      skipped: s.skipped,
      apClipId: s.apClipId,
      clip: s.clipId ? publicClip(s.clipId) : null,
      posts: s.posts.map((p) => ({ id: p.id, platform: p.platform, status: p.status, error: p.error, remoteUrl: p.remoteUrl, account: connections.get(p.connectionId)?.handle ?? connections.get(p.connectionId)?.name ?? null })),
    })),
    review: withClip('review'),
    ready: withClip('ready'),
    videos: apVideos.list(ap.id, 100),
    history: posts
      .forAutopilot(ap.id, 100)
      .filter((p) => p.status !== 'scheduled')
      .map(publicPost),
  });
});

autopilotRouter.put(
  '/autopilots/:id',
  wrap(async (req, res) => {
    const ap = autopilots.get(req.params.id);
    if (!ap) return res.status(404).json({ error: 'Autopilot not found' });
    const body = configSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Check the form' });
    const { name, config } = toConfig(body.data);
    // keep already-resolved channel ids
    for (const s of config.sources) {
      const old = ap.config.sources.find((o) => o.kind === s.kind && o.value === s.value);
      if (old?.channelId && !s.channelId) Object.assign(s, { channelId: old.channelId, label: old.label });
    }
    try {
      await resolveSources(config);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
    const timesChanged = config.times.join() !== ap.config.times.join() || config.timezone !== ap.config.timezone || JSON.stringify(config.targets) !== JSON.stringify(ap.config.targets) || config.caption !== ap.config.caption;
    autopilots.update(ap.id, { name, config });
    if (timesChanged) await releaseScheduled(ap.id); // re-book everything at the new times
    if (ap.config.mode === 'review' && config.mode === 'auto') for (const c of apClips.withStatus(ap.id, 'review')) apClips.update(c.id, { status: 'ready' });
    await kick();
    res.json(summary(autopilots.get(ap.id)!));
  }),
);

autopilotRouter.post(
  '/autopilots/:id/pause',
  wrap(async (req, res) => {
    const ap = autopilots.get(req.params.id);
    if (!ap) return res.status(404).json({ error: 'Autopilot not found' });
    autopilots.update(ap.id, { status: 'paused' });
    await releaseScheduled(ap.id);
    res.json(summary(autopilots.get(ap.id)!));
  }),
);

autopilotRouter.post(
  '/autopilots/:id/resume',
  wrap(async (req, res) => {
    const ap = autopilots.get(req.params.id);
    if (!ap) return res.status(404).json({ error: 'Autopilot not found' });
    autopilots.update(ap.id, { status: 'active', lastError: null });
    await kick();
    res.json(summary(autopilots.get(ap.id)!));
  }),
);

autopilotRouter.post(
  '/autopilots/:id/scan',
  wrap(async (req, res) => {
    const ap = autopilots.get(req.params.id);
    if (!ap) return res.status(404).json({ error: 'Autopilot not found' });
    await scanNow(ap.id);
    res.json({ ok: true });
  }),
);

autopilotRouter.delete(
  '/autopilots/:id',
  wrap(async (req, res) => {
    const ap = autopilots.get(req.params.id);
    if (!ap) return res.status(404).json({ error: 'Autopilot not found' });
    await releaseScheduled(ap.id);
    autopilots.remove(ap.id);
    res.json({ ok: true });
  }),
);

autopilotRouter.post(
  '/autopilots/:id/slots/:key/skip',
  wrap(async (req, res) => {
    const ap = autopilots.get(req.params.id);
    if (!ap) return res.status(404).json({ error: 'Autopilot not found' });
    await skipSlot(ap.id, req.params.key);
    res.json({ ok: true });
  }),
);
autopilotRouter.post(
  '/autopilots/:id/slots/:key/restore',
  wrap(async (req, res) => {
    const ap = autopilots.get(req.params.id);
    if (!ap) return res.status(404).json({ error: 'Autopilot not found' });
    await restoreSlot(ap.id, req.params.key);
    res.json({ ok: true });
  }),
);

autopilotRouter.post(
  '/autopilots/:id/clips/:itemId/:action',
  wrap(async (req, res) => {
    const item = apClips.get(req.params.itemId);
    if (!item || item.autopilotId !== req.params.id) return res.status(404).json({ error: 'Clip not found' });
    if (req.params.action === 'approve') {
      if (item.status === 'review' || item.status === 'rejected') apClips.update(item.id, { status: 'ready' });
      await kick();
    } else if (req.params.action === 'reject') await rejectClip(item);
    else return res.status(400).json({ error: 'Unknown action' });
    res.json({ ok: true });
  }),
);

/** Preview the posting times a form would produce (for the editor). */
autopilotRouter.post('/autopilot/preview-times', (req, res) => {
  const times = (Array.isArray(req.body?.times) ? req.body.times : []).filter((t: unknown) => typeof t === 'string' && timeRe.test(t));
  const tz = isValidZone(String(req.body?.timezone)) ? String(req.body.timezone) : 'UTC';
  res.json(upcomingSlots(times, tz, Date.now(), 2).slice(0, 6));
});

/** What a source would find right now (read-only) — shown under each source in the editor. */
autopilotRouter.post(
  '/autopilot/preview-source',
  wrap(async (req, res) => {
    try {
      const kind = String(req.body?.kind);
      const list =
        kind === 'youtube_channel'
          ? await channelVideos(String(req.body?.channelId ?? ''))
          : await topicVideos(String(req.body?.value ?? ''), req.body?.region ? String(req.body.region) : null, Number(req.body?.maxAgeDays) || 14);
      res.json({ count: list.length, newest: list.reduce((m, v) => Math.max(m, v.publishedAt ?? 0), 0) || null, sample: list.slice(0, 3).map((v) => ({ title: v.title, views: v.views })) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  }),
);

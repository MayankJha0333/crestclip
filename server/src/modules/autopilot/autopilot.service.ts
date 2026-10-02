import { apClips, autopilots, connections, type AutopilotConfig, type AutopilotRow, type UserRow } from '../../db/index.js';
import { assertAutopilot } from '../billing/billing.service.js';
import { HttpError, toHttpError } from '../../lib/http.js';
import type { ProjectOptions } from '../../types.js';
import { optionsSchema } from '../projects/projects.schemas.js';
import { kick, rejectClip, releaseScheduled, restoreSlot, scanNow, skipSlot } from './autopilot.engine.js';
import type { AutopilotForm } from './autopilot.schemas.js';
import { channelVideos, resolveChannel, topicVideos } from './autopilot.sources.js';

/** An Autopilot the person owns (404 otherwise). */
export async function getAutopilot(id: string, user: UserRow): Promise<AutopilotRow> {
  const ap = await autopilots.get(id);
  if (!ap || ap.userId !== user.id) throw new HttpError(404, 'Autopilot not found');
  return ap;
}

/** Only accounts this person connected. */
async function ownTargets(user: UserRow, targets: AutopilotForm['targets']) {
  const mine = new Set((await connections.list(user.id)).map((c) => c.id));
  return targets.filter((t) => mine.has(t.connectionId));
}

async function toConfig(user: UserRow, body: AutopilotForm): Promise<{ name: string; config: AutopilotConfig }> {
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
      targets: await ownTargets(user, body.targets),
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

export async function createAutopilot(user: UserRow, form: AutopilotForm): Promise<AutopilotRow> {
  assertAutopilot(user);
  const { name, config } = await toConfig(user, form);
  await resolveSources(config).catch(toHttpError(400));
  const ap = await autopilots.create(user.id, name, config);
  await kick();
  return ap;
}

export async function updateAutopilot(user: UserRow, ap: AutopilotRow, form: AutopilotForm): Promise<AutopilotRow> {
  const { name, config } = await toConfig(user, form);
  // keep already-resolved channel ids
  for (const s of config.sources) {
    const old = ap.config.sources.find((o) => o.kind === s.kind && o.value === s.value);
    if (old?.channelId && !s.channelId) Object.assign(s, { channelId: old.channelId, label: old.label });
  }
  await resolveSources(config).catch(toHttpError(400));
  const timesChanged =
    config.times.join() !== ap.config.times.join() ||
    config.timezone !== ap.config.timezone ||
    JSON.stringify(config.targets) !== JSON.stringify(ap.config.targets) ||
    config.caption !== ap.config.caption;
  await autopilots.update(ap.id, { name, config });
  if (timesChanged) await releaseScheduled(ap.id); // re-book everything at the new times
  if (ap.config.mode === 'review' && config.mode === 'auto') for (const c of await apClips.withStatus(ap.id, 'review')) await apClips.update(c.id, { status: 'ready' });
  await kick();
  return (await autopilots.get(ap.id))!;
}

export async function pauseAutopilot(id: string, user: UserRow): Promise<AutopilotRow> {
  const ap = await getAutopilot(id, user);
  await autopilots.update(ap.id, { status: 'paused' });
  await releaseScheduled(ap.id);
  return (await autopilots.get(ap.id))!;
}

export async function resumeAutopilot(id: string, user: UserRow): Promise<AutopilotRow> {
  assertAutopilot(user);
  const ap = await getAutopilot(id, user);
  await autopilots.update(ap.id, { status: 'active', lastError: null });
  await kick();
  return (await autopilots.get(ap.id))!;
}

export async function scanAutopilot(id: string, user: UserRow) {
  await scanNow((await getAutopilot(id, user)).id);
}

export async function deleteAutopilot(id: string, user: UserRow) {
  const ap = await getAutopilot(id, user);
  await releaseScheduled(ap.id);
  await autopilots.remove(ap.id);
}

export async function skipAutopilotSlot(id: string, user: UserRow, key: string) {
  await skipSlot((await getAutopilot(id, user)).id, key);
}

export async function restoreAutopilotSlot(id: string, user: UserRow, key: string) {
  await restoreSlot((await getAutopilot(id, user)).id, key);
}

/** Approve or reject a clip waiting in an autopilot's queue. */
export async function reviewClip(autopilotId: string, user: UserRow, itemId: string, action: string) {
  await getAutopilot(autopilotId, user);
  const item = await apClips.get(itemId);
  if (!item || item.autopilotId !== autopilotId) throw new HttpError(404, 'Clip not found');
  if (action === 'approve') {
    if (item.status === 'review' || item.status === 'rejected') await apClips.update(item.id, { status: 'ready' });
    await kick();
  } else if (action === 'reject') await rejectClip(item);
  else throw new HttpError(400, 'Unknown action');
}

/** What a source would find right now (read-only) — shown under each source in the editor. */
export async function previewSource(body: { kind?: unknown; channelId?: unknown; value?: unknown; region?: unknown; maxAgeDays?: unknown } | undefined) {
  const kind = String(body?.kind);
  const list = await (
    kind === 'youtube_channel' ? channelVideos(String(body?.channelId ?? '')) : topicVideos(String(body?.value ?? ''), body?.region ? String(body.region) : null, Number(body?.maxAgeDays) || 14)
  ).catch(toHttpError(400));
  return { count: list.length, newest: list.reduce((m, v) => Math.max(m, v.publishedAt ?? 0), 0) || null, sample: list.slice(0, 3).map((v) => ({ title: v.title, views: v.views })) };
}

export const findChannel = (input: unknown) => resolveChannel(String(input ?? '')).catch(toHttpError(400));

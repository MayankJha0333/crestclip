import { clips, projects, type ClipRow, type ProjectRow, type UserRow } from '../../db/index.js';
import { ensureLocal } from '../../infra/cloudStore.js';
import { enqueueRender } from '../../infra/queue.js';
import { HttpError } from '../../lib/http.js';
import { clipOutputForUser } from './clip-output.js';
import type { ClipPatch } from './clips.schemas.js';

/** Edits to these fields change the video, so the clip is rendered again. */
const RENDER_KEYS = ['hook', 'start', 'end', 'layout', 'captionStyle', 'showHook', 'motion', 'music', 'pace', 'emoji', 'flashForward'] as const;
const VARIANT_STYLES = ['pop', 'clay', 'neon', 'comic', 'minimal'];

/** The clip and the project it was cut from — only for the person who owns them (404 otherwise). */
export async function getClipWithProject(id: string, user: UserRow): Promise<{ clip: ClipRow; project: ProjectRow }> {
  const clip = await clips.get(id);
  const project = clip && (await projects.get(clip.projectId));
  if (!clip || !project || project.userId !== user.id) throw new HttpError(404, 'Clip not found');
  return { clip, project };
}

/** Transcript lines around a clip (for the trim editor). */
export async function clipTranscript(id: string, user: UserRow) {
  const { clip: c, project: p } = await getClipWithProject(id, user);
  const pad = 30;
  const segs = (p.transcript ?? []).filter((s) => s.e >= c.start - pad && s.s <= c.end + pad).map((s) => ({ s: s.s, e: s.e, text: s.text, speaker: s.speaker }));
  return { start: c.start, end: c.end, duration: p.duration, segments: segs };
}

export async function updateClip(c: ClipRow, p: ProjectRow, edit: ClipPatch): Promise<ClipRow> {
  const patch: ClipPatch & { segments?: { start: number; end: number }[] | null } = { ...edit };
  const dur = p.duration || Infinity;
  const start = Math.max(0, patch.start ?? c.start);
  const end = Math.min(dur, patch.end ?? c.end);
  if (c.segments?.length) {
    // joined clip: trimming moves the start of the first part and the end of the last part
    const segs = c.segments.map((r) => ({ ...r }));
    segs[0].start = +start.toFixed(3);
    segs[segs.length - 1].end = +end.toFixed(3);
    if (segs.some((r) => r.end - r.start < 1)) throw new HttpError(400, 'Each part must stay at least 1 second long.');
    const total = segs.reduce((a, r) => a + r.end - r.start, 0);
    if (total > 180) throw new HttpError(400, 'Clips can be at most 3 minutes long.');
    if (patch.start !== undefined || patch.end !== undefined) patch.segments = segs;
  } else {
    if (end - start < 3) throw new HttpError(400, 'Clips must be at least 3 seconds long.');
    if (end - start > 180) throw new HttpError(400, 'Clips can be at most 3 minutes long.');
  }
  if (patch.start !== undefined) patch.start = +start.toFixed(3);
  if (patch.end !== undefined) patch.end = +end.toFixed(3);
  if (patch.hashtags) patch.hashtags = patch.hashtags.map((h) => '#' + h.replace(/^#+/, '').replace(/\s+/g, '')).filter((h) => h.length > 1);

  const same = (a: unknown, b: unknown) => (typeof a === 'object' ? JSON.stringify(a) === JSON.stringify(b) : a === b);
  const needsRender = RENDER_KEYS.some((k) => patch[k] !== undefined && !same(patch[k], (c as unknown as Record<string, unknown>)[k]));
  await clips.update(c.id, { ...patch, ...(needsRender ? { status: 'pending' as const } : {}) });
  if (needsRender) enqueueRender(c.id);
  return (await clips.get(c.id))!;
}

/** Render again from scratch (the framing is worked out again too). */
export async function rerenderClip(id: string, user: UserRow): Promise<ClipRow> {
  const { clip: c } = await getClipWithProject(id, user);
  await clips.update(c.id, { status: 'pending', reframe: null });
  enqueueRender(c.id);
  return (await clips.get(c.id))!;
}

/** Same moment with the next caption style — posting variations avoids duplicate-content flags. */
export async function createVariant(id: string, user: UserRow): Promise<ClipRow> {
  const { clip: c } = await getClipWithProject(id, user);
  const nextStyle = VARIANT_STYLES[(VARIANT_STYLES.indexOf(c.captionStyle) + 1) % VARIANT_STYLES.length];
  const v = await clips.duplicate(c.id, { captionStyle: nextStyle, titleSuffix: ' (variant)' });
  if (!v) throw new HttpError(500, 'Could not create variant');
  enqueueRender(v.id);
  return v;
}

/** The rendered file and a safe download name for it. */
export async function clipDownload(id: string, user: UserRow): Promise<{ file: string; name: string }> {
  const { clip: c } = await getClipWithProject(id, user);
  const file = await clipOutputForUser(c, user.id);
  if (!(await ensureLocal(file))) throw new HttpError(404, 'This clip is not rendered yet.');
  const safe =
    (c.title || 'clip')
      .replace(/[^\p{L}\p{M}\p{N} _-]+/gu, '')
      .trim()
      .slice(0, 60) || 'clip';
  return { file: file!, name: `${safe}.mp4` };
}

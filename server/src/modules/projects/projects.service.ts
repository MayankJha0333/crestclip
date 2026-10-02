import fs from 'node:fs';
import path from 'node:path';
import { aiReady } from '../../config.js';
import { credits, projects, type ClipRow, type ProjectRow, type UserRow } from '../../db/index.js';
import { enqueueJob, enqueueProject, enqueueRender } from '../../infra/queue.js';
import { HttpError } from '../../lib/http.js';
import { projectDir } from '../../lib/paths.js';
import { classifyFileLink, fileLinkLabel } from '../../pipeline/filelink.js';
import { applyInstructions } from '../../pipeline/instructions.js';
import { createPickedClips, preparePickedClips } from '../../pipeline/process.js';
import type { ProjectOptions, TimeRange } from '../../types.js';
import { assertHasCredits, assertVideosPerProject, chargeClips } from '../billing/billing.service.js';
import { creditsForClips } from '../billing/plans.js';
import { optionsSchema } from './projects.schemas.js';
import { purgeProject } from './retention.js';

/** How many clips a project will make (and pay for): the parts picked in Explore, or the clip count asked for. */
export const clipsAsked = (o: ProjectOptions) => (o.ranges?.length ? (o.joinRanges ? 1 : o.ranges.length) : Math.max(1, o.clipCount || 1));

/** New projects need Gemini. */
function requireAi() {
  if (!aiReady()) throw new HttpError(400, 'Gemini is not configured yet. Set VERTEX_API_KEY or GOOGLE_CLOUD_PROJECT in .env and restart.');
}

/** A project the person owns (404 otherwise — never reveal that someone else's exists). */
export function getProject(id: string, user: UserRow): ProjectRow {
  const p = projects.get(id);
  if (!p || p.userId !== user.id) throw new HttpError(404, 'Project not found');
  return p;
}

/** One project from one link. Drive / Dropbox / OneDrive / direct .mp4 are downloaded as plain files (like uploads). */
function projectFromLink(userId: string, url: string, options: ProjectOptions, parentId: string | null = null) {
  const file = classifyFileLink(url);
  if (file && 'error' in file) throw new HttpError(400, file.error);
  const opts = { ...options };
  delete opts.ranges;
  return file
    ? projects.create({ userId, sourceType: 'upload', sourceUrl: url, title: `Video from ${fileLinkLabel[file.kind]}`, options: opts, parentId })
    : projects.create({ userId, sourceType: 'url', sourceUrl: url, options: opts, parentId });
}

export async function createFromLink(user: UserRow, url: string, options: ProjectOptions) {
  requireAi();
  await assertHasCredits(user, clipsAsked(options));
  const p = projectFromLink(user.id, url, await applyInstructions(options));
  enqueueProject(p.id);
  return p;
}

/** Several links at once (same settings + instructions). Several links = ONE project that holds every video. */
export async function createFromLinks(user: UserRow, links: string[], options: ProjectOptions) {
  requireAi();
  const urls = [...new Set(links.map((u) => u.trim()))];
  assertVideosPerProject(user, urls.length);
  await assertHasCredits(user, clipsAsked(options) * urls.length);
  for (const u of urls) {
    const f = classifyFileLink(u);
    if (f && 'error' in f) throw new HttpError(400, `${u.slice(0, 60)}… — ${f.error}`);
  }
  const understood = await applyInstructions(options); // read the instructions once for all links
  // each video in a group is still clipped on its own
  const group = urls.length > 1 ? projects.create({ userId: user.id, sourceType: 'group', options: understood }) : null;
  const made = urls.map((u) => projectFromLink(user.id, u, understood, group?.id ?? null));
  for (const p of made) enqueueProject(p.id);
  return { group: group ? projects.get(group.id)! : null, made, options: understood };
}

/** An uploaded file (already saved to a temp path by multer). Bad options fall back to the defaults. */
export async function createFromUpload(user: UserRow, file: { path: string; originalname: string }, rawOptions: unknown) {
  if (!aiReady()) fs.rmSync(file.path, { force: true }); // nothing will use the upload
  requireAi();
  let opts: unknown = {};
  try {
    opts = JSON.parse(String(rawOptions ?? '{}'));
  } catch {
    /* default */
  }
  const parsed = optionsSchema.safeParse(opts);
  const chosen = (parsed.success ? parsed.data : optionsSchema.parse({})) as ProjectOptions;
  await assertHasCredits(user, clipsAsked(chosen)).catch((e) => {
    fs.rmSync(file.path, { force: true });
    throw e;
  });
  const options = await applyInstructions(chosen);
  const title = file.originalname
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .slice(0, 120);
  const p = projects.create({ userId: user.id, sourceType: 'upload', title, options });
  const dir = projectDir(p.id);
  fs.mkdirSync(dir, { recursive: true });
  const ext = (path.extname(file.originalname) || '.mp4').toLowerCase();
  const dest = path.join(dir, `source${ext}`);
  fs.renameSync(file.path, dest);
  projects.update(p.id, { mediaPath: dest });
  enqueueProject(p.id);
  return projects.get(p.id)!;
}

/** Run a failed project again (for a group: every video in it that failed). */
export function retryProject(id: string, user: UserRow) {
  const p = getProject(id, user);
  const list = p.sourceType === 'group' ? projects.children(p.id).filter((k) => k.status === 'failed') : [p];
  for (const k of list) {
    projects.update(k.id, { status: 'queued', error: null, errorCode: null, stage: 'queued', progress: 0 });
    enqueueProject(k.id);
  }
}

export async function deleteProject(id: string, user: UserRow) {
  const p = getProject(id, user);
  const kids = p.sourceType === 'group' ? projects.children(p.id) : [];
  if (p.status === 'processing' || kids.some((k) => k.status === 'processing')) throw new HttpError(409, 'Wait for this project to finish before deleting it.');
  await purgeProject(p); // here and in the cloud bucket
}

export function assertCanAddClips(p: ProjectRow) {
  if (p.status === 'processing' || p.status === 'queued') throw new HttpError(409, 'Wait until this project finishes, then add your own clips.');
}

/**
 * Clip the parts picked on the "Where viewers rewatch" graph (each part its own clip, or joined into one).
 * Each new clip costs 5 credits, like any other clip (taken now; given back if the clips can't be made).
 */
export async function addPickedClips(user: UserRow, p: ProjectRow, ranges: TimeRange[], join: boolean): Promise<ClipRow[]> {
  const projectId = p.id;
  const asked = join ? 1 : ranges.length;
  const paid = await chargeClips(user.id, p.id, asked, 'Picked parts');
  let created: ClipRow[];
  try {
    created = createPickedClips(projectId, ranges, join);
  } catch (e) {
    if (paid) credits.refund(paid, 'Refund · no clips made');
    throw new HttpError(400, (e as Error).message);
  }
  if (paid && created.length < asked) credits.reduceSpend(paid, creditsForClips(created.length), `Picked parts · ${created.length} clip${created.length === 1 ? '' : 's'}`);
  const ids = created.map((c) => c.id);
  enqueueJob(`pick:${projectId}:${ids.join(',')}`, async () => {
    try {
      await preparePickedClips(projectId, ids);
    } catch (e) {
      if (paid) credits.refund(paid, 'Refund · picked parts couldn’t be prepared');
      throw e;
    }
    for (const id of ids) enqueueRender(id);
  });
  return created;
}

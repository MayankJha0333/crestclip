import fs from 'node:fs';
import path from 'node:path';
import { aiReady } from '../../config.js';
import { credits, projects, type ClipRow, type ProjectRow, type UserRow } from '../../db/index.js';
import { enqueueJob, enqueueProject, enqueueRender } from '../../infra/queue.js';
import { HttpError } from '../../lib/http.js';
import { projectDir } from '../../lib/paths.js';
import { classifyFileLink, fileLinkLabel } from '../../pipeline/filelink.js';
import { assertPublicUrl } from '../../lib/net.js';
import { applyInstructions } from '../../pipeline/instructions.js';
import { driveFileUrl, driveFolderId, listDriveFolderCached, readDriveDocs, type DriveFolder } from '../../pipeline/drivefolder.js';
import { dedupeVideos, planFolder, type FolderPlan } from '../../pipeline/folderplan.js';
import { rangeFor } from '../../pipeline/moments.js';
import { createPickedClips, preparePickedClips } from '../../pipeline/process.js';
import type { ProjectOptions, TimeRange } from '../../types.js';
import { assertHasCredits, assertVideosPerProject, chargeClips } from '../billing/billing.service.js';
import { creditsForClips, planOf } from '../billing/plans.js';
import { optionsSchema } from './projects.schemas.js';
import { purgeProject } from './retention.js';

/** How many clips a project will make (and pay for): the parts picked in Explore, or the clip count asked for. */
const clipsAsked = (o: ProjectOptions) => (o.ranges?.length ? (o.joinRanges ? 1 : o.ranges.length) : Math.max(1, o.clipCount || 1));

/** New projects need Gemini. */
function requireAi() {
  if (!aiReady()) throw new HttpError(400, 'The AI isn’t set up on this server yet, so new clips can’t be made. Please try again later.');
}

/** A project the person owns (404 otherwise — never reveal that someone else's exists). */
export async function getProject(id: string, user: UserRow): Promise<ProjectRow> {
  const p = await projects.get(id);
  if (!p || p.userId !== user.id) throw new HttpError(404, 'Project not found');
  return p;
}

/** One project from one link. Drive / Dropbox / OneDrive / direct .mp4 are downloaded as plain files (like uploads). */
async function projectFromLink(userId: string, url: string, options: ProjectOptions, parentId: string | null = null) {
  await assertPublicUrl(url);
  const file = classifyFileLink(url);
  if (file && 'error' in file) throw new HttpError(400, file.error);
  const opts = { ...options };
  delete opts.ranges;
  return file
    ? await projects.create({ userId, sourceType: 'upload', sourceUrl: url, title: `Video from ${fileLinkLabel[file.kind]}`, options: opts, parentId })
    : await projects.create({ userId, sourceType: 'url', sourceUrl: url, options: opts, parentId });
}

export async function createFromLink(user: UserRow, url: string, options: ProjectOptions) {
  requireAi();
  await assertHasCredits(user, clipsAsked(options));
  const p = await projectFromLink(user.id, url, await applyInstructions(options, user.id));
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
    await assertPublicUrl(u);
    const f = classifyFileLink(u);
    if (f && 'error' in f) throw new HttpError(400, `${u.slice(0, 60)}… — ${f.error}`);
  }
  const understood = await applyInstructions(options, user.id); // read the instructions once for all links
  // each video in a group is still clipped on its own
  const group = urls.length > 1 ? await projects.create({ userId: user.id, sourceType: 'group', options: understood }) : null;
  const made: ProjectRow[] = [];
  for (const u of urls) made.push(await projectFromLink(user.id, u, understood, group?.id ?? null)); // in the order given
  for (const p of made) enqueueProject(p.id);
  return { group: group ? (await projects.get(group.id))! : null, made, options: understood };
}

/** Open a shared Drive folder for New clips; problems come back as a 400 the person can act on. */
async function openFolder(url: string): Promise<DriveFolder> {
  const id = driveFolderId(url);
  if (!id) throw new HttpError(400, 'That isn’t a Google Drive folder link. Use “Share → Copy link” on the folder.');
  try {
    return await listDriveFolderCached(id);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

const cleanTitle = (name: string) =>
  name
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

/** New clips → a Drive folder link: what's inside, before anything is spent (no AI, no credits). */
export async function previewFolder(user: UserRow, url: string) {
  const folder = await openFolder(url);
  const { videos, duplicates } = dedupeVideos(folder.files);
  const count = (k: string) => folder.files.filter((f) => f.kind === k).length;
  const max = planOf(user.plan).maxVideosPerProject;
  return {
    name: folder.name,
    videos: videos.length,
    duplicates,
    docs: folder.files.filter((f) => f.kind === 'doc').map((f) => (f.folder ? `${f.folder}/${f.name}` : f.name)),
    images: count('image'),
    other: count('other'),
    subfolders: [...new Set(folder.files.map((f) => f.folder.split('/')[0]).filter(Boolean))],
    sample: videos.slice(0, 6).map((f) => cleanTitle(f.name)),
    willClip: Math.min(videos.length, max),
    max,
    truncated: folder.truncated,
  };
}

/**
 * A shared Drive folder → one project. The AI reads the whole folder (subfolders, brief docs, PDFs, file names) with
 * the person's instructions, then picks which videos to clip (no duplicates, nothing off-brief) — up to the plan's
 * videos-per-project limit and what the credits cover. Each picked video is downloaded and clipped like a Drive file link.
 */
export async function createFromFolder(user: UserRow, url: string, options: ProjectOptions) {
  requireAi();
  const folder = await openFolder(url);
  const perVideo = clipsAsked(options);
  await assertHasCredits(user, perVideo); // at least one video's worth (also refreshes monthly credits)
  const planMax = planOf(user.plan).maxVideosPerProject;
  const byCredits = Math.floor((await credits.balance(user.id)) / creditsForClips(perVideo));
  const max = Math.max(1, Math.min(planMax, byCredits));

  const docs = await readDriveDocs(folder.files);
  let plan: FolderPlan;
  try {
    plan = await planFolder({ folder, docs, instructions: options.instructions ?? '', max, lengthHint: rangeFor(options).label });
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }

  // the person's own words first, then whatever the brief files say; the folder summary guides the moment finder
  const instructions = [options.instructions?.trim(), plan.brief.trim() && `From the brief in the Drive folder:\n${plan.brief.trim()}`].filter(Boolean).join('\n\n');
  const understood = await applyInstructions({ ...options, instructions: instructions || undefined, focus: [options.focus, plan.summary].filter(Boolean).join(' ').slice(0, 600) }, user.id);
  delete understood.ranges;

  const limitedBy = plan.picks.length < plan.videos && plan.picks.length === max ? (byCredits < planMax ? 'credits' : 'plan') : null;
  const notes = [
    plan.summary,
    `Picked ${plan.picks.length} of ${plan.videos} video${plan.videos === 1 ? '' : 's'} from “${folder.name}”${plan.duplicates ? ` (${plan.duplicates} extra cop${plan.duplicates === 1 ? 'y' : 'ies'} of the same take left out)` : ''}.`,
    limitedBy === 'credits' ? 'Your credits covered this many — top up to clip more.' : limitedBy === 'plan' ? `That’s your plan’s limit per project.` : '',
    docs.length ? `Read: ${docs.map((d) => d.file.name).join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 900);

  const group =
    plan.picks.length > 1 ? await projects.create({ userId: user.id, sourceType: 'group', sourceUrl: url, title: folder.name.slice(0, 120), options: understood }) : null;
  if (group) await projects.update(group.id, { aiNotes: notes });
  const made: ProjectRow[] = [];
  for (const p of plan.picks)
    made.push(
      await projects.create({ userId: user.id, sourceType: 'upload', sourceUrl: driveFileUrl(p.file.id), title: cleanTitle(p.file.name), options: understood, parentId: group?.id ?? null }),
    );
  for (const p of made) enqueueProject(p.id);
  return {
    group: group ? (await projects.get(group.id))! : null,
    made,
    options: understood,
    folder: {
      name: folder.name,
      videos: plan.videos,
      duplicates: plan.duplicates,
      picked: plan.picks.map((p) => ({ title: cleanTitle(p.file.name), folder: p.file.folder, reason: p.reason })),
      docsRead: docs.map((d) => d.file.name),
      summary: plan.summary,
      limitedBy,
      readBy: plan.readBy,
    },
  };
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
  const options = await applyInstructions(chosen, user.id);
  const title = file.originalname
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .slice(0, 120);
  const p = await projects.create({ userId: user.id, sourceType: 'upload', title, options });
  const dir = projectDir(p.id);
  fs.mkdirSync(dir, { recursive: true });
  const ext = (path.extname(file.originalname) || '.mp4').toLowerCase();
  const dest = path.join(dir, `source${ext}`);
  fs.renameSync(file.path, dest);
  await projects.update(p.id, { mediaPath: dest });
  enqueueProject(p.id);
  return (await projects.get(p.id))!;
}

/** Run a failed project again (for a group: every video in it that failed). */
export async function retryProject(id: string, user: UserRow) {
  const p = await getProject(id, user);
  const list = p.sourceType === 'group' ? (await projects.children(p.id)).filter((k) => k.status === 'failed') : [p];
  for (const k of list) {
    await projects.update(k.id, { status: 'queued', error: null, errorCode: null, stage: 'queued', progress: 0 });
    enqueueProject(k.id);
  }
}

export async function deleteProject(id: string, user: UserRow) {
  const p = await getProject(id, user);
  const kids = p.sourceType === 'group' ? await projects.children(p.id) : [];
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
    created = await createPickedClips(projectId, ranges, join);
  } catch (e) {
    if (paid) await credits.refund(paid, 'Refund · no clips made');
    throw new HttpError(400, (e as Error).message);
  }
  if (paid && created.length < asked) await credits.reduceSpend(paid, creditsForClips(created.length), `Picked parts · ${created.length} clip${created.length === 1 ? '' : 's'}`);
  const ids = created.map((c) => c.id);
  enqueueJob(`pick:${projectId}:${ids.join(',')}`, async () => {
    try {
      await preparePickedClips(projectId, ids);
    } catch (e) {
      if (paid) await credits.refund(paid, 'Refund · picked parts couldn’t be prepared');
      throw e;
    }
    for (const id of ids) enqueueRender(id);
  });
  return created;
}

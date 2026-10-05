import fs from 'node:fs';
import { clips, projects, type ClipSummary, type ProjectRow } from '../../db/index.js';
import { projectDir, toMediaUrl } from '../../lib/paths.js';
import { readFootage } from '../../pipeline/footage.js';
import { publicClips } from '../clips/clips.presenter.js';

/** The original video, if a full copy is on disk (uploads, short links). Long links only keep the clip parts. */
function sourceVideoUrl(p: ProjectRow): string | null {
  if (!p.mediaPath || !fs.existsSync(p.mediaPath) || /source-audio\./.test(p.mediaPath)) return null;
  if (readFootage(projectDir(p.id))) return null;
  return toMediaUrl(p.mediaPath);
}

/**
 * Errors saved on older projects may name the AI provider or its settings ("Gemini did not find…", "Vertex AI said…").
 * The app never shows those: setup problems become a plain message, any other mention becomes "the AI".
 */
export function publicError(e: string | null): string | null {
  if (!e) return e;
  if (/vertex|aiplatform|VERTEX_|GEMINI_|GOOGLE_CLOUD|gcloud/i.test(e)) return 'The AI had trouble with this video. Press Try again — it usually works the second time.';
  return e.replace(/^Gemini\b/, 'The AI').replace(/\bGemini\b/g, 'the AI');
}

/** The project's own thumbnail, when its file is on this computer (projects made elsewhere may not have it here). */
const ownThumbUrl = (p: ProjectRow) => (p.thumbPath && fs.existsSync(p.thumbPath) ? toMediaUrl(p.thumbPath) : null);

/** A thumbnail for a project: its own, else its best clip's (clip thumbnails are also kept in the cloud bucket). */
async function thumbFor(p: ProjectRow, known?: ClipSummary[]): Promise<string | null> {
  const own = ownThumbUrl(p);
  if (own) return own;
  const list = known ? known.filter((c) => c.projectId === p.id) : await clips.forProject(p.id);
  const best = list.filter((c) => c.thumbPath).sort((a, b) => b.peakScore - a.peakScore)[0];
  return best ? toMediaUrl(best.thumbPath) : null;
}

export function publicProject(p: ProjectRow, withDetail = false) {
  return {
    id: p.id,
    createdAt: p.createdAt,
    /** when it's deleted (with all its clips) — the storage time */
    expiresAt: p.expiresAt,
    sourceType: p.sourceType,
    parentId: p.parentId,
    sourceUrl: p.sourceUrl,
    title: p.title,
    channel: p.channel,
    duration: p.duration,
    width: p.width,
    height: p.height,
    viewCount: p.viewCount,
    status: p.status,
    stage: p.stage,
    // progress text only while working: finished projects saved before may hold download sizes and AI usage
    stageDetail: p.status === 'queued' || p.status === 'processing' ? p.stageDetail : null,
    progress: p.progress,
    error: publicError(p.error),
    /** 'credits' | 'plan_limit' — the person can fix it by upgrading */
    errorCode: p.errorCode,
    creditsCharged: p.creditsCharged,
    options: p.options,
    thumbUrl: ownThumbUrl(p),
    ...(withDetail
      ? {
          aiNotes: p.aiNotes,
          signals: p.signals
            ? {
                sources: p.signals.sources,
                curve: p.signals.curve,
                curveKind: p.signals.curveKind,
                hotspots: p.signals.hotspots,
                chapters: p.signals.chapters,
                hasHeatmap: Boolean(p.signals.heatmap?.length),
              }
            : null,
          hasTranscript: Boolean(p.transcript?.length),
          sourceVideoUrl: sourceVideoUrl(p),
        }
      : {}),
  };
}

/** A multi-video project: its status, progress and numbers come from the videos inside it. */
async function groupSummary(g: ProjectRow) {
  const kids = await projects.children(g.id);
  const all = (await Promise.all(kids.map((k) => clips.forProject(k.id)))).flat();
  return { kids, all, view: await groupView(g, kids, all) };
}

/** A multi-video project's card, from its videos and their clips (already read). */
async function groupView(g: ProjectRow, kids: ProjectRow[], all: ClipSummary[]) {
  const busy = kids.some((k) => k.status === 'queued' || k.status === 'processing');
  const failed = kids.length > 0 && kids.every((k) => k.status === 'failed');
  const first = kids.find((k) => k.thumbPath) ?? kids[0];
  const thumbUrl = first ? await thumbFor(first, all) : null;
  const named = kids.filter((k) => k.title);
  const title = g.title || (named.length ? `${named[0].title}${kids.length > 1 ? ` + ${kids.length - 1} more` : ''}` : `${kids.length} videos`);
  const working = kids.find((k) => k.status === 'processing');
  return {
    ...publicProject(g),
    title,
    status: busy ? 'processing' : failed ? 'failed' : 'done',
    stage: busy ? 'processing' : 'done',
    progress: kids.length ? kids.reduce((a, k) => a + (k.status === 'done' || k.status === 'failed' ? 100 : k.progress), 0) / kids.length : 100,
    stageDetail: busy
      ? `${kids.filter((k) => k.status === 'done').length} of ${kids.length} videos done${working?.stageDetail ? ` · ${working.stageDetail}` : ''}`
      : failed
        ? 'All videos failed'
        : `${kids.length} videos`,
    error: failed ? publicError(kids[0]?.error ?? null) : null,
    errorCode: kids.find((k) => k.status === 'failed' && k.errorCode)?.errorCode ?? null,
    creditsCharged: kids.reduce((a, k) => a + k.creditsCharged, 0),
    duration: kids.reduce((a, k) => a + (k.duration ?? 0), 0) || null,
    thumbUrl,
    videoCount: kids.length,
    /** a Drive-folder project: what the AI understood and which videos it picked */
    aiNotes: g.aiNotes ?? null,
    clipCount: all.length,
    readyCount: all.filter((c) => c.status === 'ready').length,
    bestScore: all.length ? Math.max(...all.map((c) => c.peakScore)) : null,
  };
}

export const publicGroupSummary = async (g: ProjectRow) => (await groupSummary(g)).view;

async function publicGroup(g: ProjectRow) {
  const { kids, all, view } = await groupSummary(g);
  const index = new Map(kids.map((k, i) => [k.id, i]));
  return {
    ...view,
    parts: kids.map((k, i) => ({
      ...publicProject(k),
      index: i + 1,
      clipCount: all.filter((c) => c.projectId === k.id).length,
      readyCount: all.filter((c) => c.projectId === k.id && c.status === 'ready').length,
    })),
    clips: (await publicClips(all)).map((c) => ({ ...c, part: (index.get(c.projectId) ?? 0) + 1 })),
  };
}

/**
 * The whole projects list with as few trips to the database as possible: the videos inside every multi-video project
 * in one query, then the clips of all of them (just status, score and thumbnail) in one more — never one query per video.
 */
export async function publicProjectList(rows: Awaited<ReturnType<typeof projects.list>>) {
  const groups = rows.filter((r) => r.sourceType === 'group');
  const kidsOf = await projects.childrenOf(groups.map((g) => g.id));
  const kids = [...kidsOf.values()].flat();
  const needThumb = rows.filter((r) => r.sourceType !== 'group' && !ownThumbUrl(r));
  const known = await clips.summaryFor([...kids.map((k) => k.id), ...needThumb.map((r) => r.id)]);
  return Promise.all(
    rows.map(async (p) => {
      if (p.sourceType === 'group') {
        const mine = kidsOf.get(p.id) ?? [];
        const ids = new Set(mine.map((k) => k.id));
        return groupView(p, mine, known.filter((c) => ids.has(c.projectId)));
      }
      return { ...publicProject(p), thumbUrl: await thumbFor(p, known), clipCount: p.clipCount, readyCount: p.readyCount, bestScore: p.bestScore };
    }),
  );
}

/** The project page: a group with its videos + clips, or one video with its details + clips. */
export async function publicProjectDetail(p: ProjectRow) {
  if (p.sourceType === 'group') return await publicGroup(p);
  return { ...publicProject(p, true), thumbUrl: await thumbFor(p), clips: await publicClips(await clips.forProject(p.id)) };
}

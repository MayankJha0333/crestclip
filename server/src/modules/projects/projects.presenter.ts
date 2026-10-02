import fs from 'node:fs';
import { clips, projects, type ProjectRow } from '../../db/index.js';
import { projectDir, toMediaUrl } from '../../lib/paths.js';
import { footageSavings, readFootage } from '../../pipeline/footage.js';
import { publicClip } from '../clips/clips.presenter.js';

/** The original video, if a full copy is on disk (uploads, short links). Long links only keep the clip parts. */
function sourceVideoUrl(p: ProjectRow): string | null {
  if (!p.mediaPath || !fs.existsSync(p.mediaPath) || /source-audio\./.test(p.mediaPath)) return null;
  if (readFootage(projectDir(p.id))) return null;
  return toMediaUrl(p.mediaPath);
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
    stageDetail: p.stageDetail,
    progress: p.progress,
    error: p.error,
    /** 'credits' | 'plan_limit' — the person can fix it by upgrading */
    errorCode: p.errorCode,
    creditsCharged: p.creditsCharged,
    options: p.options,
    thumbUrl: toMediaUrl(p.thumbPath),
    ...(withDetail
      ? {
          download: footageSavings(projectDir(p.id)),
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
function groupSummary(g: ProjectRow) {
  const kids = projects.children(g.id);
  const busy = kids.some((k) => k.status === 'queued' || k.status === 'processing');
  const failed = kids.length > 0 && kids.every((k) => k.status === 'failed');
  const all = kids.flatMap((k) => clips.forProject(k.id));
  const first = kids.find((k) => k.thumbPath) ?? kids[0];
  const named = kids.filter((k) => k.title);
  const title = g.title || (named.length ? `${named[0].title}${kids.length > 1 ? ` + ${kids.length - 1} more` : ''}` : `${kids.length} videos`);
  const working = kids.find((k) => k.status === 'processing');
  return {
    kids,
    all,
    view: {
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
      error: failed ? (kids[0]?.error ?? null) : null,
      errorCode: kids.find((k) => k.status === 'failed' && k.errorCode)?.errorCode ?? null,
      creditsCharged: kids.reduce((a, k) => a + k.creditsCharged, 0),
      duration: kids.reduce((a, k) => a + (k.duration ?? 0), 0) || null,
      thumbUrl: first ? toMediaUrl(first.thumbPath) : null,
      videoCount: kids.length,
      clipCount: all.length,
      readyCount: all.filter((c) => c.status === 'ready').length,
      bestScore: all.length ? Math.max(...all.map((c) => c.peakScore)) : null,
    },
  };
}

export const publicGroupSummary = (g: ProjectRow) => groupSummary(g).view;

function publicGroup(g: ProjectRow) {
  const { kids, all, view } = groupSummary(g);
  const index = new Map(kids.map((k, i) => [k.id, i]));
  return {
    ...view,
    parts: kids.map((k, i) => ({
      ...publicProject(k),
      index: i + 1,
      clipCount: all.filter((c) => c.projectId === k.id).length,
      readyCount: all.filter((c) => c.projectId === k.id && c.status === 'ready').length,
    })),
    clips: all.map((c) => ({ ...publicClip(c), part: (index.get(c.projectId) ?? 0) + 1 })),
  };
}

/** One row of the projects list. */
export function publicProjectListItem(p: ReturnType<typeof projects.list>[number]) {
  return p.sourceType === 'group' ? publicGroupSummary(p) : { ...publicProject(p), clipCount: p.clipCount, readyCount: p.readyCount, bestScore: p.bestScore };
}

/** The project page: a group with its videos + clips, or one video with its details + clips. */
export function publicProjectDetail(p: ProjectRow) {
  if (p.sourceType === 'group') return publicGroup(p);
  return { ...publicProject(p, true), clips: clips.forProject(p.id).map(publicClip) };
}

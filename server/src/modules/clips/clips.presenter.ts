import { posts, type ClipRow, type PostRow } from '../../db/index.js';
import { toMediaUrl } from '../../lib/paths.js';
import { clipParts } from '../../pipeline/process.js';

/** Clips as the app shows them, with their posts (fetched in one go). */
export async function publicClips(list: ClipRow[]) {
  const byClip = new Map<string, PostRow[]>();
  for (const p of await posts.forClips(list.map((c) => c.id))) byClip.set(p.clipId, [...(byClip.get(p.clipId) ?? []), p]);
  return list.map((c) => present(c, byClip.get(c.id) ?? []));
}

export const publicClip = async (c: ClipRow) => (await publicClips([c]))[0];

function present(c: ClipRow, clipPosts: PostRow[]) {
  return {
    id: c.id,
    projectId: c.projectId,
    start: c.start,
    end: c.end,
    /** length of the finished clip (after pause cuts and any flash-forward), or of the source range before the first render */
    duration:
      c.outDuration ??
      +clipParts(c)
        .reduce((a, r) => a + r.end - r.start, 0)
        .toFixed(2),
    segments: c.segments,
    posts: clipPosts.map((p) => ({ id: p.id, platform: p.platform, status: p.status, scheduledAt: p.scheduledAt, remoteUrl: p.remoteUrl, error: p.error })),
    motion: c.motion,
    music: c.music,
    pace: c.pace,
    emoji: c.emoji,
    flashForward: c.flashForward,
    hasTeaser: Boolean(c.teaser),
    hooks: c.hooks,
    keywords: c.keywords,
    source: c.source,
    title: c.title,
    hook: c.hook,
    description: c.description,
    hashtags: c.hashtags,
    reason: c.reason,
    category: c.category,
    rubric: c.rubric,
    aiScore: c.aiScore,
    audienceScore: c.audienceScore,
    peakScore: c.peakScore,
    layout: c.layout,
    appliedLayout: c.reframe?.layout ?? null,
    captionStyle: c.captionStyle,
    showHook: c.showHook,
    status: c.status,
    error: c.error,
    videoUrl: toMediaUrl(c.filePath),
    thumbUrl: toMediaUrl(c.thumbPath),
    version: c.version,
  };
}

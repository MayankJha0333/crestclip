import { collection, COLLECTIONS, fromDoc, newId, setFields, stamp, type Doc } from './connection.js';
import type { ClipCandidate, Keyword, Motion, MusicSettings, Pace, ReframePlan, Rubric, TimeRange } from '../types.js';

export interface ClipRow {
  id: string;
  projectId: string;
  idx: number;
  createdAt: number;
  updatedAt: number;
  start: number;
  end: number;
  title: string;
  hook: string;
  description: string;
  hashtags: string[];
  reason: string;
  category: string;
  rubric: Rubric | null;
  aiScore: number;
  audienceScore: number | null;
  peakScore: number;
  layout: string;
  captionStyle: string;
  showHook: boolean;
  status: 'pending' | 'rendering' | 'ready' | 'failed';
  error: string | null;
  filePath: string | null;
  thumbPath: string | null;
  reframe: ReframePlan | null;
  version: number;
  /** null = one continuous part (start..end) */
  segments: TimeRange[] | null;
  motion: Motion;
  music: MusicSettings;
  source: 'ai' | 'manual';
  pace: Pace;
  hooks: string[];
  keywords: Keyword[];
  teaser: TimeRange | null;
  emoji: boolean;
  flashForward: boolean;
  /** length of the rendered video; null until rendered */
  outDuration: number | null;
}

const DEFAULT_MUSIC: MusicSettings = { track: 'none', volume: 15, duck: true };

const col = () => collection<Doc<ClipRow>>(COLLECTIONS.clips);
const toClip = (d: Doc<ClipRow>): ClipRow => {
  const c = fromDoc<ClipRow>(d);
  return { ...c, music: { ...DEFAULT_MUSIC, ...(c.music ?? {}) }, hooks: c.hooks ?? [], keywords: c.keywords ?? [], hashtags: c.hashtags ?? [] };
};

const UPDATABLE = [
  'start',
  'end',
  'title',
  'hook',
  'description',
  'hashtags',
  'layout',
  'captionStyle',
  'showHook',
  'status',
  'error',
  'filePath',
  'thumbPath',
  'reframe',
  'version',
  'audienceScore',
  'peakScore',
  'aiScore',
  'category',
  'reason',
  'rubric',
  'segments',
  'motion',
  'music',
  'pace',
  'hooks',
  'keywords',
  'teaser',
  'emoji',
  'flashForward',
  'outDuration',
] as const;

type NewClip = ClipCandidate & { aiScore: number; audienceScore: number | null; peakScore: number; segments?: TimeRange[] | null };

export interface ClipDefaults {
  layout: string;
  captionStyle: string;
  showHook: boolean;
  motion: Motion;
  music: MusicSettings;
  pace: Pace;
  emoji: boolean;
  flashForward: boolean;
}
/** Highest clip number in a project (-1 when it has none). */
async function lastIdx(projectId: string): Promise<number> {
  const top = await col()
    .find({ projectId }, { projection: { idx: 1 } })
    .sort({ idx: -1 })
    .limit(1)
    .next();
  return top?.idx ?? -1;
}

/** Remove clips and everything that points at them (their posts and Autopilot entries). */
async function removeClips(filter: { projectId: string }) {
  const ids = (
    await col()
      .find(filter, { projection: { _id: 1 } })
      .toArray()
  ).map((c) => c._id);
  if (!ids.length) return;
  await Promise.all([
    collection(COLLECTIONS.posts).deleteMany({ clipId: { $in: ids } }),
    collection(COLLECTIONS.autopilotClips).deleteMany({ clipId: { $in: ids } }),
    col().deleteMany({ _id: { $in: ids } }),
  ]);
}

export const clips = {
  async replaceForProject(projectId: string, list: NewClip[], defaults: ClipDefaults, source: 'ai' | 'manual' = 'ai'): Promise<ClipRow[]> {
    await removeClips({ projectId });
    await this.insert(projectId, list, defaults, 0, source);
    return this.forProject(projectId);
  },
  /** Add clips (keeps existing ones). Returns the new rows. */
  async insert(projectId: string, list: NewClip[], defaults: ClipDefaults, startIdx?: number, source: 'ai' | 'manual' = 'ai'): Promise<ClipRow[]> {
    if (!list.length) return [];
    const base = startIdx ?? (await lastIdx(projectId)) + 1;
    const docs: Doc<ClipRow>[] = list.map((c, j) => {
      const at = stamp();
      return {
        _id: newId(),
        projectId,
        idx: base + j,
        createdAt: at,
        updatedAt: at,
        start: c.start,
        end: c.end,
        title: c.title,
        hook: c.hook,
        description: c.description,
        hashtags: c.hashtags ?? [],
        reason: c.reason,
        category: c.category,
        rubric: c.rubric ?? null,
        aiScore: c.aiScore,
        audienceScore: c.audienceScore,
        peakScore: c.peakScore,
        layout: defaults.layout,
        captionStyle: defaults.captionStyle,
        showHook: defaults.showHook,
        status: 'pending',
        error: null,
        filePath: null,
        thumbPath: null,
        reframe: null,
        version: 0,
        segments: c.segments && c.segments.length > 1 ? c.segments : null,
        motion: defaults.motion,
        music: defaults.music,
        source,
        pace: defaults.pace,
        hooks: c.hooks?.length ? c.hooks : c.hook ? [c.hook] : [],
        keywords: c.keywords ?? [],
        teaser: c.teaser ?? null,
        emoji: defaults.emoji,
        flashForward: Boolean(defaults.flashForward && c.teaser),
        outDuration: null,
      };
    });
    await col().insertMany(docs);
    return docs.map(toClip);
  },
  /** every rendered clip (for copying older clips to the cloud) */
  async allReady(): Promise<ClipRow[]> {
    return (
      await col()
        .find({ status: 'ready', filePath: { $ne: null } })
        .toArray()
    ).map(toClip);
  },
  async forProject(projectId: string): Promise<ClipRow[]> {
    return (await col().find({ projectId }).sort({ peakScore: -1, idx: 1 }).toArray()).map(toClip);
  },
  async getMany(ids: string[]): Promise<ClipRow[]> {
    return ids.length
      ? (
          await col()
            .find({ _id: { $in: [...new Set(ids)] } })
            .toArray()
        ).map(toClip)
      : [];
  },
  async get(id: string): Promise<ClipRow | null> {
    const d = await col().findOne({ _id: id });
    return d ? toClip(d) : null;
  },
  async update(id: string, patch: Partial<Omit<ClipRow, 'id' | 'projectId' | 'createdAt'>>) {
    await col().updateOne({ _id: id }, { $set: setFields(patch, UPDATABLE) });
  },
  async unfinished(): Promise<ClipRow[]> {
    return (
      await col()
        .find({ status: { $in: ['pending', 'rendering'] } })
        .toArray()
    ).map(toClip);
  },
  /** Copy a clip (same moment) with a different look — posting variations avoids duplicate-content flags. */
  async duplicate(id: string, o: { captionStyle: string; titleSuffix: string }): Promise<ClipRow | null> {
    const c = await col().findOne({ _id: id });
    if (!c) return null;
    const at = stamp();
    const copy: Doc<ClipRow> = {
      ...c,
      _id: newId(),
      idx: (await lastIdx(c.projectId)) + 1,
      createdAt: at,
      updatedAt: at,
      title: `${c.title ?? ''}${o.titleSuffix}`,
      peakScore: (c.peakScore ?? 0) - 0.01,
      captionStyle: o.captionStyle,
      status: 'pending',
      error: null,
      filePath: null,
      thumbPath: null,
      version: 0,
      outDuration: null,
    };
    await col().insertOne(copy);
    return toClip(copy);
  },
};

import { config } from '../config.js';
import { collection, COLLECTIONS, fromDoc, newId, now, setFields, stamp, type Doc } from './connection.js';
import { inDataDir } from '../lib/paths.js';
import type { ProjectOptions, Segment, Signals } from '../types.js';

export interface ProjectRow {
  id: string;
  /** owner */
  userId: string | null;
  /** credits taken for this video (0 = not charged yet, or refunded) */
  creditsCharged: number;
  /** why it failed, when the person can do something about it: 'credits' | 'plan_limit' */
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
  /** when this project and all its files are deleted (RETENTION_DAYS after it was made) */
  expiresAt: number | null;
  sourceType: 'url' | 'upload' | 'group';
  sourceUrl: string | null;
  title: string | null;
  channel: string | null;
  description: string | null;
  /** set when this video is part of a multi-video project */
  parentId: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  viewCount: number | null;
  status: 'queued' | 'processing' | 'done' | 'failed';
  stage: string | null;
  stageDetail: string | null;
  progress: number;
  error: string | null;
  options: ProjectOptions;
  signals: Signals | null;
  transcript: Segment[] | null;
  mediaPath: string | null;
  thumbPath: string | null;
  aiNotes: string | null;
}

const col = () => collection<Doc<ProjectRow>>(COLLECTIONS.projects);
const toProject = (d: Doc<ProjectRow>): ProjectRow => {
  const p = fromDoc<ProjectRow>(d);
  // rows made on another computer keep its paths — point them into this data folder
  return { ...p, mediaPath: inDataDir(p.mediaPath ?? null), thumbPath: inDataDir(p.thumbPath ?? null) };
};

const UPDATABLE = [
  'sourceUrl',
  'title',
  'channel',
  'description',
  'duration',
  'width',
  'height',
  'viewCount',
  'status',
  'stage',
  'stageDetail',
  'progress',
  'error',
  'options',
  'signals',
  'transcript',
  'mediaPath',
  'thumbPath',
  'aiNotes',
  'creditsCharged',
  'errorCode',
] as const;

/** Fields the projects list needs (the big transcript and signals stay out). */
const LIST_FIELDS = { transcript: 0, signals: 0, description: 0, aiNotes: 0, mediaPath: 0 } as const;

export const projects = {
  async create(p: { userId: string; sourceType: 'url' | 'upload' | 'group'; sourceUrl?: string; title?: string; options: ProjectOptions; parentId?: string | null }): Promise<ProjectRow> {
    // a group only holds its videos; its status is worked out from them
    const status = p.sourceType === 'group' ? 'done' : 'queued';
    // a video inside a multi-video project goes with the project
    const parentExpiry = p.parentId ? (await this.get(p.parentId))?.expiresAt : null;
    const at = stamp();
    const row: Doc<ProjectRow> = {
      _id: newId(),
      userId: p.userId,
      creditsCharged: 0,
      errorCode: null,
      createdAt: at,
      updatedAt: at,
      expiresAt: parentExpiry ?? at + config.retentionDays * 86400_000,
      sourceType: p.sourceType,
      sourceUrl: p.sourceUrl ?? null,
      title: p.title ?? null,
      channel: null,
      description: null,
      parentId: p.parentId ?? null,
      duration: null,
      width: null,
      height: null,
      viewCount: null,
      status,
      stage: status,
      stageDetail: null,
      progress: 0,
      error: null,
      options: p.options,
      signals: null,
      transcript: null,
      mediaPath: null,
      thumbPath: null,
      aiNotes: null,
    };
    await col().insertOne(row);
    return toProject(row);
  },
  async get(id: string): Promise<ProjectRow | null> {
    const d = await col().findOne({ _id: id });
    return d ? toProject(d) : null;
  },
  /**
   * Credits this person has promised but not paid yet: projects waiting in the queue or just started, not charged so
   * far (they pay once the video is opened). Counted so two Autopilots can't both start on the same last credits.
   */
  async unchargedClips(userId: string): Promise<number> {
    const rows = await col()
      .find({ userId, status: { $in: ['queued', 'processing'] }, creditsCharged: { $lte: 0 }, sourceType: { $ne: 'group' } }, { projection: { 'options.clipCount': 1 } })
      .toArray();
    return rows.reduce((n, r) => n + Math.max(1, r.options?.clipCount ?? 1), 0);
  },
  /** One person's projects (newest first) with their clip counts and best score. */
  async list(userId: string): Promise<(ProjectRow & { clipCount: number; readyCount: number; bestScore: number | null })[]> {
    const rows = (await col().find({ userId, parentId: null }, { projection: LIST_FIELDS }).sort({ createdAt: -1 }).toArray()).map((d) => ({
      ...toProject(d),
      transcript: null,
      signals: null,
      description: null,
      aiNotes: null,
      mediaPath: null,
    }));
    const stats = await collection(COLLECTIONS.clips)
      .aggregate<{ _id: string; clipCount: number; readyCount: number; bestScore: number | null }>([
        { $match: { projectId: { $in: rows.map((r) => r.id) } } },
        {
          $group: {
            _id: '$projectId',
            clipCount: { $sum: 1 },
            readyCount: { $sum: { $cond: [{ $eq: ['$status', 'ready'] }, 1, 0] } },
            bestScore: { $max: '$peakScore' },
          },
        },
      ])
      .toArray();
    const byId = new Map(stats.map((s) => [s._id, s]));
    return rows.map((r) => ({ ...r, clipCount: byId.get(r.id)?.clipCount ?? 0, readyCount: byId.get(r.id)?.readyCount ?? 0, bestScore: byId.get(r.id)?.bestScore ?? null }));
  },
  async update(id: string, patch: Partial<Omit<ProjectRow, 'id' | 'createdAt'>>) {
    await col().updateOne({ _id: id }, { $set: setFields(patch, UPDATABLE) });
  },
  /** Delete a project with its clips (and those clips' posts and Autopilot entries). Its videos are removed by the caller. */
  async remove(id: string) {
    const clipIds = (
      await collection<{ _id: string }>(COLLECTIONS.clips)
        .find({ projectId: id }, { projection: { _id: 1 } })
        .toArray()
    ).map((c) => c._id);
    await Promise.all([
      collection(COLLECTIONS.clips).deleteMany({ projectId: id }),
      collection(COLLECTIONS.posts).deleteMany({ clipId: { $in: clipIds } }),
      collection(COLLECTIONS.autopilotClips).deleteMany({ clipId: { $in: clipIds } }),
    ]);
    await col().deleteOne({ _id: id });
  },
  /** the videos inside a multi-video project, in the order they were added */
  async children(parentId: string): Promise<ProjectRow[]> {
    return (await col().find({ parentId }).sort({ createdAt: 1, _id: 1 }).toArray()).map(toProject);
  },
  /** Top-level projects whose storage time is over (their videos go with them). */
  async expired(at = now()): Promise<ProjectRow[]> {
    return (
      await col()
        .find({ parentId: null, expiresAt: { $ne: null, $lte: at } })
        .sort({ expiresAt: 1 })
        .toArray()
    ).map(toProject);
  },
  /** Something still waiting to be posted from this project's clips? (then it isn't deleted yet) */
  async hasPendingPosts(id: string): Promise<boolean> {
    const ids = [
      id,
      ...(
        await col()
          .find({ parentId: id }, { projection: { _id: 1 } })
          .toArray()
      ).map((p) => p._id),
    ];
    return Boolean(await collection(COLLECTIONS.posts).findOne({ projectId: { $in: ids }, status: { $in: ['scheduled', 'uploading', 'processing'] } }, { projection: { _id: 1 } }));
  },
  async unfinished(): Promise<ProjectRow[]> {
    return (
      await col()
        .find({ status: { $in: ['queued', 'processing'] } })
        .sort({ createdAt: 1 })
        .toArray()
    ).map(toProject);
  },
};

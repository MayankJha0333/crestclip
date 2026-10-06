import { collection, COLLECTIONS, fromDoc, newId, now, setFields, stamp, type Doc } from './connection.js';

export type PostStatus = 'scheduled' | 'uploading' | 'processing' | 'published' | 'failed' | 'canceled';
export interface PostRow {
  id: string;
  clipId: string;
  /** the clip's project and its owner (kept here so a person's posts can be found directly) */
  projectId: string | null;
  userId: string | null;
  connectionId: string;
  platform: 'youtube' | 'instagram';
  title: string | null;
  caption: string | null;
  privacy: string | null;
  /** null = post now */
  scheduledAt: number | null;
  status: PostStatus;
  remoteId: string | null;
  remoteUrl: string | null;
  error: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  /** set when an Autopilot made this post */
  autopilotId: string | null;
  /** the Autopilot time slot it fills, e.g. "2026-10-02T13:00" */
  slotKey: string | null;
}

const col = () => collection<Doc<PostRow>>(COLLECTIONS.posts);
const toPost = (d: Doc<PostRow>) => fromDoc<PostRow>(d);
const list = async (filter: object, sort: Record<string, 1 | -1> = {}) => (await col().find(filter).sort(sort).toArray()).map(toPost);

/** Newest first by when it posts (or was made, for "post now"). */
async function newestFirst(filter: object, limit: number): Promise<PostRow[]> {
  const docs = await col()
    .aggregate<Doc<PostRow>>([{ $match: filter }, { $addFields: { _when: { $ifNull: ['$scheduledAt', '$createdAt'] } } }, { $sort: { _when: -1 } }, { $limit: limit }, { $project: { _when: 0 } }])
    .toArray();
  return docs.map(toPost);
}

export const posts = {
  /** Account deletion: every post this person made. */
  async removeAllFor(userId: string) {
    await col().deleteMany({ userId });
  },
  async create(p: {
    clipId: string;
    connectionId: string;
    platform: string;
    title: string | null;
    caption: string | null;
    privacy: string | null;
    scheduledAt: number | null;
    autopilotId?: string | null;
    slotKey?: string | null;
  }): Promise<PostRow> {
    const clip = await collection<{ _id: string; projectId: string }>(COLLECTIONS.clips).findOne({ _id: p.clipId }, { projection: { projectId: 1 } });
    const project = clip ? await collection<{ _id: string; userId: string | null }>(COLLECTIONS.projects).findOne({ _id: clip.projectId }, { projection: { userId: 1 } }) : null;
    const at = stamp();
    const row: Doc<PostRow> = {
      _id: newId(),
      clipId: p.clipId,
      projectId: clip?.projectId ?? null,
      userId: project?.userId ?? null,
      connectionId: p.connectionId,
      platform: p.platform as PostRow['platform'],
      title: p.title,
      caption: p.caption,
      privacy: p.privacy,
      scheduledAt: p.scheduledAt,
      status: 'scheduled',
      remoteId: null,
      remoteUrl: null,
      error: null,
      attempts: 0,
      createdAt: at,
      updatedAt: at,
      autopilotId: p.autopilotId ?? null,
      slotKey: p.slotKey ?? null,
    };
    await col().insertOne(row);
    return toPost(row);
  },
  async get(id: string): Promise<PostRow | null> {
    const d = await col().findOne({ _id: id });
    return d ? toPost(d) : null;
  },
  forClip: (clipId: string) => list({ clipId }, { createdAt: -1 }),
  forClips: (clipIds: string[]) => (clipIds.length ? list({ clipId: { $in: clipIds } }, { createdAt: -1 }) : Promise.resolve([])),
  /** One person's posts. */
  list: (userId: string, limit = 200) => newestFirst({ userId }, limit),
  /**
   * due = scheduled and its time has come (or "now" posts).
   * Autopilot posts are fired on time by their Redis job; this is only their safety net (10 min late).
   */
  due: () =>
    list(
      {
        status: 'scheduled',
        $or: [
          { autopilotId: null, $or: [{ scheduledAt: null }, { scheduledAt: { $lte: now() } }] },
          { autopilotId: { $ne: null }, scheduledAt: { $lte: now() - 10 * 60_000 } },
        ],
      },
      { scheduledAt: 1 },
    ),
  forAutopilot: (autopilotId: string, limit = 300) => newestFirst({ autopilotId }, limit),
  forSlot: (autopilotId: string, slotKey: string) => list({ autopilotId, slotKey }),
  scheduledForAutopilot: (autopilotId: string) => list({ autopilotId, status: 'scheduled' }),
  allScheduledAutopilot: () => list({ autopilotId: { $ne: null }, status: 'scheduled' }),
  /** Posts left mid-upload by a process that stopped. Only ones untouched for 30 min: a younger one may be uploading
   *  right now in another process (a website copy's "post now"), and resetting it would post the clip twice. */
  stuck: () => list({ status: { $in: ['uploading', 'processing'] }, updatedAt: { $lt: now() - 30 * 60_000 } }),
  /**
   * Take a booked post for uploading: true for exactly one caller, however many processes try at once (the scheduler
   * and a "post now" click on a website copy), so a clip is never posted twice.
   */
  async claim(id: string, attempts: number): Promise<boolean> {
    const r = await col().updateOne({ _id: id, status: 'scheduled' }, { $set: { status: 'uploading', attempts, error: null, updatedAt: now() } });
    return r.modifiedCount === 1;
  },
  async update(id: string, patch: Partial<Pick<PostRow, 'status' | 'remoteId' | 'remoteUrl' | 'error' | 'attempts' | 'scheduledAt' | 'slotKey'>>) {
    await col().updateOne({ _id: id }, { $set: setFields(patch, ['status', 'remoteId', 'remoteUrl', 'error', 'attempts', 'scheduledAt', 'slotKey']) });
  },
};

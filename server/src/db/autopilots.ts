import { collection, COLLECTIONS, fromDoc, isDuplicate, newId, setFields, stamp, type Doc } from './connection.js';
import type { ProjectOptions } from '../types.js';

export type TopicSort = 'trending' | 'views' | 'date';

export interface AutopilotSource {
  kind: 'youtube_channel' | 'youtube_topic';
  /** channel: the link/@handle the person typed; topic: the search words */
  value: string;
  /** resolved YouTube channel id (UC…) or topic region code (e.g. "IN") */
  channelId?: string | null;
  label?: string | null;
  region?: string | null;
  /** topics: which videos to take — trending (gaining views fastest), most viewed, or newest. Default: most viewed */
  sort?: TopicSort | null;
}
export interface AutopilotConfig {
  sources: AutopilotSource[];
  /** languages: spoken languages to keep (ISO codes like "en"); empty/missing = any language */
  filters: {
    minViews: number;
    minMinutes: number;
    maxMinutes: number;
    maxAgeDays: number;
    waitHours: number;
    languages?: string[];
    /** skip videos whose title contains any of these words */
    excludeWords?: string[];
    /** never clip videos from these channels (names) */
    blockChannels?: string[];
  };
  options: ProjectOptions;
  clipsPerVideo: number;
  /** local times "HH:MM", one per daily post */
  times: string[];
  timezone: string;
  /** which connected accounts to post to */
  targets: { connectionId: string; privacy?: 'public' | 'unlisted' | 'private' }[];
  mode: 'review' | 'auto';
  caption: string;
  rightsConfirmed: boolean;
}
export interface AutopilotRow {
  id: string;
  userId: string | null;
  name: string;
  status: 'active' | 'paused';
  config: AutopilotConfig;
  lastScanAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}
const apCol = () => collection<Doc<AutopilotRow>>(COLLECTIONS.autopilots);
const toAutopilot = (d: Doc<AutopilotRow>) => fromDoc<AutopilotRow>(d);

export const autopilots = {
  async create(userId: string, name: string, cfg: AutopilotConfig): Promise<AutopilotRow> {
    const at = stamp();
    const row: Doc<AutopilotRow> = { _id: newId(), userId, name, status: 'active', config: cfg, lastScanAt: null, lastError: null, createdAt: at, updatedAt: at };
    await apCol().insertOne(row);
    return toAutopilot(row);
  },
  async get(id: string): Promise<AutopilotRow | null> {
    const d = await apCol().findOne({ _id: id });
    return d ? toAutopilot(d) : null;
  },
  async list(userId: string): Promise<AutopilotRow[]> {
    return (await apCol().find({ userId }).sort({ createdAt: -1 }).toArray()).map(toAutopilot);
  },
  async active(): Promise<AutopilotRow[]> {
    return (await apCol().find({ status: 'active' }).toArray()).map(toAutopilot);
  },
  async update(id: string, patch: { name?: string; status?: AutopilotRow['status']; config?: AutopilotConfig; lastScanAt?: number | null; lastError?: string | null }) {
    await apCol().updateOne({ _id: id }, { $set: setFields(patch, ['name', 'status', 'config', 'lastScanAt', 'lastError'], { skipUndefined: true }) });
  },
  /** Delete an Autopilot with its found videos, clips and skipped times. */
  async remove(id: string) {
    await Promise.all([vidCol().deleteMany({ autopilotId: id }), clipCol().deleteMany({ autopilotId: id }), skipCol().deleteMany({ autopilotId: id })]);
    await apCol().deleteOne({ _id: id });
  },
};

type ApVideoStatus = 'waiting' | 'queued' | 'clipping' | 'done' | 'skipped' | 'failed';
interface ApVideoRow {
  id: string;
  autopilotId: string;
  videoId: string;
  url: string;
  title: string | null;
  channel: string | null;
  thumbnail: string | null;
  views: number | null;
  duration: number | null;
  publishedAt: number | null;
  status: ApVideoStatus;
  reason: string | null;
  projectId: string | null;
  foundAt: number;
  updatedAt: number;
}
const vidCol = () => collection<Doc<ApVideoRow>>(COLLECTIONS.autopilotVideos);
const toApVideo = (d: Doc<ApVideoRow>) => fromDoc<ApVideoRow>(d);

export const apVideos = {
  /** insert if new; returns null when this autopilot already knows the video */
  async add(v: {
    autopilotId: string;
    videoId: string;
    url: string;
    title: string | null;
    channel: string | null;
    thumbnail: string | null;
    views: number | null;
    duration: number | null;
    publishedAt: number | null;
    status: ApVideoStatus;
    reason?: string | null;
  }): Promise<ApVideoRow | null> {
    const at = stamp();
    const row: Doc<ApVideoRow> = { _id: newId(), ...v, reason: v.reason ?? null, projectId: null, foundAt: at, updatedAt: at };
    try {
      await vidCol().insertOne(row);
      return toApVideo(row);
    } catch (e) {
      if (isDuplicate(e)) return null;
      throw e;
    }
  },
  async get(id: string): Promise<ApVideoRow | null> {
    const d = await vidCol().findOne({ _id: id });
    return d ? toApVideo(d) : null;
  },
  async has(autopilotId: string, videoId: string): Promise<boolean> {
    return Boolean(await vidCol().findOne({ autopilotId, videoId }, { projection: { _id: 1 } }));
  },
  async list(autopilotId: string, limit = 200): Promise<ApVideoRow[]> {
    return (await vidCol().find({ autopilotId }).sort({ foundAt: -1 }).limit(limit).toArray()).map(toApVideo);
  },
  /** most-viewed first */
  async withStatus(autopilotId: string, status: ApVideoStatus): Promise<ApVideoRow[]> {
    return (await vidCol().find({ autopilotId, status }).sort({ views: -1 }).toArray()).map(toApVideo);
  },
  /** how many videos this autopilot started clipping since `since` */
  startedSince(autopilotId: string, since: number): Promise<number> {
    return vidCol().countDocuments({ autopilotId, projectId: { $ne: null }, updatedAt: { $gte: since } });
  },
  async update(id: string, patch: Partial<Pick<ApVideoRow, 'status' | 'reason' | 'projectId' | 'views' | 'duration' | 'title'>>) {
    await vidCol().updateOne({ _id: id }, { $set: setFields(patch, ['status', 'reason', 'projectId', 'views', 'duration', 'title']) });
  },
};

export type ApClipStatus = 'review' | 'ready' | 'scheduled' | 'posted' | 'rejected' | 'failed';
export interface ApClipRow {
  id: string;
  autopilotId: string;
  clipId: string;
  videoRowId: string | null;
  status: ApClipStatus;
  score: number | null;
  slotKey: string | null;
  createdAt: number;
  updatedAt: number;
}
const clipCol = () => collection<Doc<ApClipRow>>(COLLECTIONS.autopilotClips);
const toApClip = (d: Doc<ApClipRow>) => fromDoc<ApClipRow>(d);

export const apClips = {
  /** insert if new; returns null when this clip is already on the autopilot */
  async add(c: { autopilotId: string; clipId: string; videoRowId: string | null; status: ApClipStatus; score: number | null }): Promise<ApClipRow | null> {
    const at = stamp();
    const row: Doc<ApClipRow> = { _id: newId(), ...c, slotKey: null, createdAt: at, updatedAt: at };
    try {
      await clipCol().insertOne(row);
      return toApClip(row);
    } catch (e) {
      if (isDuplicate(e)) return null;
      throw e;
    }
  },
  async get(id: string): Promise<ApClipRow | null> {
    const d = await clipCol().findOne({ _id: id });
    return d ? toApClip(d) : null;
  },
  async list(autopilotId: string): Promise<ApClipRow[]> {
    return (await clipCol().find({ autopilotId }).sort({ createdAt: -1 }).toArray()).map(toApClip);
  },
  /** best first, then oldest first */
  async withStatus(autopilotId: string, status: ApClipStatus): Promise<ApClipRow[]> {
    return (await clipCol().find({ autopilotId, status }).sort({ score: -1, createdAt: 1 }).toArray()).map(toApClip);
  },
  async bySlot(autopilotId: string, slotKey: string): Promise<ApClipRow | null> {
    const d = await clipCol().findOne({ autopilotId, slotKey });
    return d ? toApClip(d) : null;
  },
  async update(id: string, patch: { status?: ApClipStatus; slotKey?: string | null }) {
    await clipCol().updateOne({ _id: id }, { $set: setFields(patch, ['status', 'slotKey'], { skipUndefined: true }) });
  },
};

/** Posting times the person chose to skip. */
interface ApSkipDoc {
  _id: string;
  autopilotId: string;
  slotKey: string;
}
const skipCol = () => collection<ApSkipDoc>(COLLECTIONS.autopilotSkips);

export const apSkips = {
  async list(autopilotId: string): Promise<Set<string>> {
    return new Set((await skipCol().find({ autopilotId }).toArray()).map((s) => s.slotKey));
  },
  async add(autopilotId: string, slotKey: string) {
    await skipCol().updateOne({ _id: `${autopilotId}|${slotKey}` }, { $setOnInsert: { autopilotId, slotKey } }, { upsert: true });
  },
  async remove(autopilotId: string, slotKey: string) {
    await skipCol().deleteOne({ _id: `${autopilotId}|${slotKey}` });
  },
};

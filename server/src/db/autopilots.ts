import { db, newId, now, parse, type Raw } from './connection.js';
import type { ProjectOptions } from '../types.js';

export interface AutopilotSource {
  kind: 'youtube_channel' | 'youtube_topic';
  /** channel: the link/@handle the person typed; topic: the search words */
  value: string;
  /** resolved YouTube channel id (UC…) or topic region code (e.g. "IN") */
  channelId?: string | null;
  label?: string | null;
  region?: string | null;
}
export interface AutopilotConfig {
  sources: AutopilotSource[];
  filters: { minViews: number; minMinutes: number; maxMinutes: number; maxAgeDays: number; waitHours: number };
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
const toAutopilot = (r: Raw): AutopilotRow => ({
  id: r.id as string,
  userId: (r.user_id as string) ?? null,
  name: r.name as string,
  status: r.status as AutopilotRow['status'],
  config: parse<AutopilotConfig>(r.config_json, {} as AutopilotConfig),
  lastScanAt: (r.last_scan_at as number) ?? null,
  lastError: (r.last_error as string) ?? null,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
});
export const autopilots = {
  create(userId: string, name: string, cfg: AutopilotConfig): AutopilotRow {
    const id = newId();
    db.prepare('INSERT INTO autopilots (id, user_id, name, status, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      userId,
      name,
      'active',
      JSON.stringify(cfg),
      now(),
      now(),
    );
    return this.get(id)!;
  },
  get(id: string): AutopilotRow | null {
    const r = db.prepare('SELECT * FROM autopilots WHERE id = ?').get(id) as Raw | undefined;
    return r ? toAutopilot(r) : null;
  },
  list(userId: string): AutopilotRow[] {
    return (db.prepare('SELECT * FROM autopilots WHERE user_id = ? ORDER BY created_at DESC').all(userId) as Raw[]).map(toAutopilot);
  },
  active(): AutopilotRow[] {
    return (db.prepare(`SELECT * FROM autopilots WHERE status = 'active'`).all() as Raw[]).map(toAutopilot);
  },
  update(id: string, patch: { name?: string; status?: AutopilotRow['status']; config?: AutopilotConfig; lastScanAt?: number | null; lastError?: string | null }) {
    const map: Record<string, [string, (v: unknown) => unknown]> = {
      name: ['name', (v) => v],
      status: ['status', (v) => v],
      config: ['config_json', (v) => JSON.stringify(v)],
      lastScanAt: ['last_scan_at', (v) => v],
      lastError: ['last_error', (v) => v],
    };
    const sets = ['updated_at = ?'];
    const vals: unknown[] = [now()];
    for (const [k, v] of Object.entries(patch)) {
      if (!map[k] || v === undefined) continue;
      sets.push(`${map[k][0]} = ?`);
      vals.push(map[k][1](v) ?? null);
    }
    vals.push(id);
    db.prepare(`UPDATE autopilots SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]));
  },
  remove(id: string) {
    db.prepare('DELETE FROM autopilots WHERE id = ?').run(id);
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
const toApVideo = (r: Raw): ApVideoRow => ({
  id: r.id as string,
  autopilotId: r.autopilot_id as string,
  videoId: r.video_id as string,
  url: r.url as string,
  title: (r.title as string) ?? null,
  channel: (r.channel as string) ?? null,
  thumbnail: (r.thumbnail as string) ?? null,
  views: (r.views as number) ?? null,
  duration: (r.duration as number) ?? null,
  publishedAt: (r.published_at as number) ?? null,
  status: r.status as ApVideoStatus,
  reason: (r.reason as string) ?? null,
  projectId: (r.project_id as string) ?? null,
  foundAt: r.found_at as number,
  updatedAt: r.updated_at as number,
});
export const apVideos = {
  /** insert if new; returns null when this autopilot already knows the video */
  add(v: {
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
  }): ApVideoRow | null {
    const id = newId();
    const r = db
      .prepare(
        `INSERT OR IGNORE INTO autopilot_videos (id, autopilot_id, video_id, url, title, channel, thumbnail, views, duration, published_at, status, reason, found_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, v.autopilotId, v.videoId, v.url, v.title, v.channel, v.thumbnail, v.views, v.duration, v.publishedAt, v.status, v.reason ?? null, now(), now());
    return r.changes ? this.get(id) : null;
  },
  get(id: string): ApVideoRow | null {
    const r = db.prepare('SELECT * FROM autopilot_videos WHERE id = ?').get(id) as Raw | undefined;
    return r ? toApVideo(r) : null;
  },
  has(autopilotId: string, videoId: string) {
    return Boolean(db.prepare('SELECT 1 FROM autopilot_videos WHERE autopilot_id = ? AND video_id = ?').get(autopilotId, videoId));
  },
  list(autopilotId: string, limit = 200): ApVideoRow[] {
    return (db.prepare('SELECT * FROM autopilot_videos WHERE autopilot_id = ? ORDER BY found_at DESC LIMIT ?').all(autopilotId, limit) as Raw[]).map(toApVideo);
  },
  withStatus(autopilotId: string, status: ApVideoStatus): ApVideoRow[] {
    return (db.prepare('SELECT * FROM autopilot_videos WHERE autopilot_id = ? AND status = ? ORDER BY COALESCE(views, 0) DESC').all(autopilotId, status) as Raw[]).map(toApVideo);
  },
  /** how many videos this autopilot started clipping since `since` */
  startedSince(autopilotId: string, since: number): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM autopilot_videos WHERE autopilot_id = ? AND project_id IS NOT NULL AND updated_at >= ?`).get(autopilotId, since) as Raw).n as number;
  },
  update(id: string, patch: Partial<Pick<ApVideoRow, 'status' | 'reason' | 'projectId' | 'views' | 'duration' | 'title'>>) {
    const map: Record<string, string> = { status: 'status', reason: 'reason', projectId: 'project_id', views: 'views', duration: 'duration', title: 'title' };
    const sets = ['updated_at = ?'];
    const vals: unknown[] = [now()];
    for (const [k, v] of Object.entries(patch)) {
      if (!map[k]) continue;
      sets.push(`${map[k]} = ?`);
      vals.push(v ?? null);
    }
    vals.push(id);
    db.prepare(`UPDATE autopilot_videos SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]));
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
const toApClip = (r: Raw): ApClipRow => ({
  id: r.id as string,
  autopilotId: r.autopilot_id as string,
  clipId: r.clip_id as string,
  videoRowId: (r.video_row_id as string) ?? null,
  status: r.status as ApClipStatus,
  score: (r.score as number) ?? null,
  slotKey: (r.slot_key as string) ?? null,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
});
export const apClips = {
  add(c: { autopilotId: string; clipId: string; videoRowId: string | null; status: ApClipStatus; score: number | null }): ApClipRow | null {
    const id = newId();
    const r = db
      .prepare('INSERT OR IGNORE INTO autopilot_clips (id, autopilot_id, clip_id, video_row_id, status, score, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, c.autopilotId, c.clipId, c.videoRowId, c.status, c.score, now(), now());
    return r.changes ? this.get(id) : null;
  },
  get(id: string): ApClipRow | null {
    const r = db.prepare('SELECT * FROM autopilot_clips WHERE id = ?').get(id) as Raw | undefined;
    return r ? toApClip(r) : null;
  },
  list(autopilotId: string): ApClipRow[] {
    return (db.prepare('SELECT * FROM autopilot_clips WHERE autopilot_id = ? ORDER BY created_at DESC').all(autopilotId) as Raw[]).map(toApClip);
  },
  withStatus(autopilotId: string, status: ApClipStatus): ApClipRow[] {
    // best first, then oldest first
    return (db.prepare('SELECT * FROM autopilot_clips WHERE autopilot_id = ? AND status = ? ORDER BY COALESCE(score, 0) DESC, created_at').all(autopilotId, status) as Raw[]).map(toApClip);
  },
  bySlot(autopilotId: string, slotKey: string): ApClipRow | null {
    const r = db.prepare('SELECT * FROM autopilot_clips WHERE autopilot_id = ? AND slot_key = ?').get(autopilotId, slotKey) as Raw | undefined;
    return r ? toApClip(r) : null;
  },
  update(id: string, patch: { status?: ApClipStatus; slotKey?: string | null }) {
    if (patch.status !== undefined) db.prepare('UPDATE autopilot_clips SET status = ?, updated_at = ? WHERE id = ?').run(patch.status, now(), id);
    if (patch.slotKey !== undefined) db.prepare('UPDATE autopilot_clips SET slot_key = ?, updated_at = ? WHERE id = ?').run(patch.slotKey, now(), id);
  },
};

export const apSkips = {
  list(autopilotId: string): Set<string> {
    return new Set((db.prepare('SELECT slot_key FROM autopilot_skips WHERE autopilot_id = ?').all(autopilotId) as Raw[]).map((r) => r.slot_key as string));
  },
  add(autopilotId: string, slotKey: string) {
    db.prepare('INSERT OR IGNORE INTO autopilot_skips (autopilot_id, slot_key) VALUES (?, ?)').run(autopilotId, slotKey);
  },
  remove(autopilotId: string, slotKey: string) {
    db.prepare('DELETE FROM autopilot_skips WHERE autopilot_id = ? AND slot_key = ?').run(autopilotId, slotKey);
  },
};

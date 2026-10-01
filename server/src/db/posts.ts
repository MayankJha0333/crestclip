import { db, newId, now, type Raw } from './connection.js';

export type PostStatus = 'scheduled' | 'uploading' | 'processing' | 'published' | 'failed' | 'canceled';
export interface PostRow {
  id: string;
  clipId: string;
  connectionId: string;
  platform: 'youtube' | 'instagram';
  title: string | null;
  caption: string | null;
  privacy: string | null;
  scheduledAt: number | null;
  status: PostStatus;
  remoteId: string | null;
  remoteUrl: string | null;
  error: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  autopilotId: string | null;
  slotKey: string | null;
}
const toPost = (r: Raw): PostRow => ({
  id: r.id as string,
  clipId: r.clip_id as string,
  connectionId: r.connection_id as string,
  platform: r.platform as PostRow['platform'],
  title: (r.title as string) ?? null,
  caption: (r.caption as string) ?? null,
  privacy: (r.privacy as string) ?? null,
  scheduledAt: (r.scheduled_at as number) ?? null,
  status: r.status as PostStatus,
  remoteId: (r.remote_id as string) ?? null,
  remoteUrl: (r.remote_url as string) ?? null,
  error: (r.error as string) ?? null,
  attempts: (r.attempts as number) ?? 0,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
  autopilotId: (r.autopilot_id as string) ?? null,
  slotKey: (r.slot_key as string) ?? null,
});
export const posts = {
  create(p: {
    clipId: string;
    connectionId: string;
    platform: string;
    title: string | null;
    caption: string | null;
    privacy: string | null;
    scheduledAt: number | null;
    autopilotId?: string | null;
    slotKey?: string | null;
  }): PostRow {
    const id = newId();
    db.prepare(
      `INSERT INTO posts (id, clip_id, connection_id, platform, title, caption, privacy, scheduled_at, status, created_at, updated_at, autopilot_id, slot_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?)`,
    ).run(id, p.clipId, p.connectionId, p.platform, p.title, p.caption, p.privacy, p.scheduledAt, now(), now(), p.autopilotId ?? null, p.slotKey ?? null);
    return this.get(id)!;
  },
  get(id: string): PostRow | null {
    const r = db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as Raw | undefined;
    return r ? toPost(r) : null;
  },
  forClip(clipId: string): PostRow[] {
    return (db.prepare('SELECT * FROM posts WHERE clip_id = ? ORDER BY created_at DESC').all(clipId) as Raw[]).map(toPost);
  },
  list(limit = 200): PostRow[] {
    return (db.prepare('SELECT * FROM posts ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT ?').all(limit) as Raw[]).map(toPost);
  },
  /**
   * due = scheduled and its time has come (or "now" posts).
   * Autopilot posts are fired on time by their Redis job; this is only their safety net (10 min late).
   */
  due(): PostRow[] {
    return (
      db
        .prepare(
          `SELECT * FROM posts WHERE status = 'scheduled' AND (
             (autopilot_id IS NULL AND (scheduled_at IS NULL OR scheduled_at <= ?)) OR (autopilot_id IS NOT NULL AND scheduled_at <= ?)
           ) ORDER BY scheduled_at`,
        )
        .all(now(), now() - 10 * 60_000) as Raw[]
    ).map(toPost);
  },
  forAutopilot(autopilotId: string, limit = 300): PostRow[] {
    return (db.prepare('SELECT * FROM posts WHERE autopilot_id = ? ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT ?').all(autopilotId, limit) as Raw[]).map(toPost);
  },
  forSlot(autopilotId: string, slotKey: string): PostRow[] {
    return (db.prepare('SELECT * FROM posts WHERE autopilot_id = ? AND slot_key = ?').all(autopilotId, slotKey) as Raw[]).map(toPost);
  },
  scheduledForAutopilot(autopilotId: string): PostRow[] {
    return (db.prepare(`SELECT * FROM posts WHERE autopilot_id = ? AND status = 'scheduled'`).all(autopilotId) as Raw[]).map(toPost);
  },
  allScheduledAutopilot(): PostRow[] {
    return (db.prepare(`SELECT * FROM posts WHERE autopilot_id IS NOT NULL AND status = 'scheduled'`).all() as Raw[]).map(toPost);
  },
  stuck(): PostRow[] {
    return (db.prepare(`SELECT * FROM posts WHERE status IN ('uploading', 'processing')`).all() as Raw[]).map(toPost);
  },
  update(id: string, patch: Partial<Pick<PostRow, 'status' | 'remoteId' | 'remoteUrl' | 'error' | 'attempts' | 'scheduledAt'>>) {
    const map: Record<string, string> = { status: 'status', remoteId: 'remote_id', remoteUrl: 'remote_url', error: 'error', attempts: 'attempts', scheduledAt: 'scheduled_at' };
    const sets = ['updated_at = ?'];
    const vals: unknown[] = [now()];
    for (const [k, v] of Object.entries(patch)) {
      if (!map[k]) continue;
      sets.push(`${map[k]} = ?`);
      vals.push(v ?? null);
    }
    vals.push(id);
    db.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]));
  },
};

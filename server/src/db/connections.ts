import { db, newId, now, type Raw } from './connection.js';

export interface ConnectionRow {
  id: string;
  userId: string | null;
  platform: 'youtube' | 'instagram';
  accountId: string;
  name: string | null;
  handle: string | null;
  avatar: string | null;
  tokens: string;
  createdAt: number;
  updatedAt: number;
}
const toConn = (r: Raw): ConnectionRow => ({
  id: r.id as string,
  userId: (r.user_id as string) ?? null,
  platform: r.platform as ConnectionRow['platform'],
  accountId: r.account_id as string,
  name: (r.name as string) ?? null,
  handle: (r.handle as string) ?? null,
  avatar: (r.avatar as string) ?? null,
  tokens: r.tokens as string,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
});
export const connections = {
  list(userId: string): ConnectionRow[] {
    return (db.prepare('SELECT * FROM connections WHERE user_id = ? ORDER BY platform, created_at').all(userId) as Raw[]).map(toConn);
  },
  /** The same YouTube / Instagram account saved by someone (to stop one account being linked to two people). */
  find(platform: string, accountId: string): ConnectionRow | null {
    const r = db.prepare('SELECT * FROM connections WHERE platform = ? AND account_id = ?').get(platform, accountId) as Raw | undefined;
    return r ? toConn(r) : null;
  },
  get(id: string): ConnectionRow | null {
    const r = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as Raw | undefined;
    return r ? toConn(r) : null;
  },
  /** insert or update (same platform + account = reconnect) */
  upsert(c: { userId: string; platform: string; accountId: string; name: string | null; handle: string | null; avatar: string | null; tokens: string }): ConnectionRow {
    const existing = db.prepare('SELECT id FROM connections WHERE platform = ? AND account_id = ?').get(c.platform, c.accountId) as Raw | undefined;
    const id = (existing?.id as string) ?? newId();
    if (existing) db.prepare('UPDATE connections SET name = ?, handle = ?, avatar = ?, tokens = ?, updated_at = ? WHERE id = ?').run(c.name, c.handle, c.avatar, c.tokens, now(), id);
    else
      db.prepare('INSERT INTO connections (id, user_id, platform, account_id, name, handle, avatar, tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        id,
        c.userId,
        c.platform,
        c.accountId,
        c.name,
        c.handle,
        c.avatar,
        c.tokens,
        now(),
        now(),
      );
    return this.get(id)!;
  },
  setTokens(id: string, tokens: string) {
    db.prepare('UPDATE connections SET tokens = ?, updated_at = ? WHERE id = ?').run(tokens, now(), id);
  },
  remove(id: string) {
    db.prepare('DELETE FROM connections WHERE id = ?').run(id);
  },
};

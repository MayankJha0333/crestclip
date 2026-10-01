import { db, newId, now, type Raw } from './connection.js';

export interface ConnectionRow {
  id: string;
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
  list(): ConnectionRow[] {
    return (db.prepare('SELECT * FROM connections ORDER BY platform, created_at').all() as Raw[]).map(toConn);
  },
  get(id: string): ConnectionRow | null {
    const r = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as Raw | undefined;
    return r ? toConn(r) : null;
  },
  /** insert or update (same platform + account = reconnect) */
  upsert(c: { platform: string; accountId: string; name: string | null; handle: string | null; avatar: string | null; tokens: string }): ConnectionRow {
    const existing = db.prepare('SELECT id FROM connections WHERE platform = ? AND account_id = ?').get(c.platform, c.accountId) as Raw | undefined;
    const id = (existing?.id as string) ?? newId();
    if (existing)
      db.prepare('UPDATE connections SET name = ?, handle = ?, avatar = ?, tokens = ?, updated_at = ? WHERE id = ?').run(c.name, c.handle, c.avatar, c.tokens, now(), id);
    else
      db.prepare('INSERT INTO connections (id, platform, account_id, name, handle, avatar, tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        id, c.platform, c.accountId, c.name, c.handle, c.avatar, c.tokens, now(), now(),
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

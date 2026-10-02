import crypto from 'node:crypto';
import { db, newId, now, type Raw } from './connection.js';

export type PlanId = 'free' | 'creator' | 'pro';

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string | null;
  googleSub: string | null;
  avatar: string | null;
  isAdmin: boolean;
  plan: PlanId;
  cycleStart: number | null;
  cycleEnd: number | null;
  rzSubscriptionId: string | null;
  /** a subscription opened in Checkout that hasn't been confirmed yet */
  pendingSubscriptionId: string | null;
  cancelAtPeriodEnd: boolean;
  createdAt: number;
}

const toUser = (r: Raw): UserRow => ({
  id: r.id as string,
  email: r.email as string,
  name: (r.name as string) ?? null,
  passwordHash: (r.password_hash as string) ?? null,
  googleSub: (r.google_sub as string) ?? null,
  avatar: (r.avatar as string) ?? null,
  isAdmin: Boolean(r.is_admin),
  plan: ((r.plan as string) || 'free') as PlanId,
  cycleStart: (r.cycle_start as number) ?? null,
  cycleEnd: (r.cycle_end as number) ?? null,
  rzSubscriptionId: (r.rz_subscription_id as string) ?? null,
  pendingSubscriptionId: (r.rz_pending_sub as string) ?? null,
  cancelAtPeriodEnd: Boolean(r.cancel_at_period_end),
  createdAt: r.created_at as number,
});

export const users = {
  count(): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as Raw).n as number;
  },
  create(u: { email: string; name: string | null; passwordHash?: string | null; googleSub?: string | null; avatar?: string | null; isAdmin?: boolean; plan?: PlanId }): UserRow {
    const id = newId();
    db.prepare('INSERT INTO users (id, email, name, password_hash, google_sub, avatar, is_admin, plan, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      u.email,
      u.name,
      u.passwordHash ?? null,
      u.googleSub ?? null,
      u.avatar ?? null,
      u.isAdmin ? 1 : 0,
      u.plan ?? 'free',
      now(),
      now(),
    );
    return this.get(id)!;
  },
  get(id: string): UserRow | null {
    const r = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Raw | undefined;
    return r ? toUser(r) : null;
  },
  byEmail(email: string): UserRow | null {
    const r = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as Raw | undefined;
    return r ? toUser(r) : null;
  },
  byGoogle(sub: string): UserRow | null {
    const r = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(sub) as Raw | undefined;
    return r ? toUser(r) : null;
  },
  bySubscription(subId: string): UserRow | null {
    const r = db.prepare('SELECT * FROM users WHERE rz_subscription_id = ?').get(subId) as Raw | undefined;
    return r ? toUser(r) : null;
  },
  list(): UserRow[] {
    return (db.prepare('SELECT * FROM users ORDER BY created_at').all() as Raw[]).map(toUser);
  },
  update(id: string, patch: Partial<Omit<UserRow, 'id' | 'createdAt'>>) {
    const map: Record<string, [string, (v: unknown) => unknown]> = {
      email: ['email', (v) => v],
      name: ['name', (v) => v],
      passwordHash: ['password_hash', (v) => v],
      googleSub: ['google_sub', (v) => v],
      avatar: ['avatar', (v) => v],
      isAdmin: ['is_admin', (v) => (v ? 1 : 0)],
      plan: ['plan', (v) => v],
      cycleStart: ['cycle_start', (v) => v],
      cycleEnd: ['cycle_end', (v) => v],
      rzSubscriptionId: ['rz_subscription_id', (v) => v],
      pendingSubscriptionId: ['rz_pending_sub', (v) => v],
      cancelAtPeriodEnd: ['cancel_at_period_end', (v) => (v ? 1 : 0)],
    };
    const sets: string[] = ['updated_at = ?'];
    const vals: unknown[] = [now()];
    for (const [k, v] of Object.entries(patch)) {
      const m = map[k];
      if (!m) continue;
      sets.push(`${m[0]} = ?`);
      vals.push(v === undefined || v === null ? null : m[1](v));
    }
    vals.push(id);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]));
  },
};

const SESSION_DAYS = 30;
const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export const sessions = {
  /** A new random session token (only its hash is stored). */
  create(userId: string): { token: string; expiresAt: number } {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now() + SESSION_DAYS * 86400_000;
    db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(hash(token), userId, now(), expiresAt);
    return { token, expiresAt };
  },
  user(token: string): UserRow | null {
    const r = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?').get(hash(token), now()) as Raw | undefined;
    return r ? toUser(r) : null;
  },
  remove(token: string) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(hash(token));
  },
  /** Log out everywhere (after a password change), optionally keeping one session. */
  removeAllFor(userId: string, keepToken?: string) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, keepToken ? hash(keepToken) : '');
  },
  prune() {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  },
};

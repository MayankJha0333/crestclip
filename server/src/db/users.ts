import crypto from 'node:crypto';
import { collection, COLLECTIONS, fromDoc, newId, now, setFields, stamp, type Doc } from './connection.js';

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

const col = () => collection<Doc<UserRow> & { updatedAt: number }>(COLLECTIONS.users);
const toUser = (d: Doc<UserRow>): UserRow => {
  const { updatedAt: _u, ...rest } = d as Doc<UserRow> & { updatedAt?: number };
  return fromDoc<UserRow>(rest);
};

const UPDATABLE = ['email', 'name', 'passwordHash', 'googleSub', 'avatar', 'isAdmin', 'plan', 'cycleStart', 'cycleEnd', 'rzSubscriptionId', 'pendingSubscriptionId', 'cancelAtPeriodEnd'] as const;

export const users = {
  count(): Promise<number> {
    return col().estimatedDocumentCount();
  },
  async create(u: { email: string; name: string | null; passwordHash?: string | null; googleSub?: string | null; avatar?: string | null; isAdmin?: boolean; plan?: PlanId }): Promise<UserRow> {
    const at = stamp();
    const row = {
      _id: newId(),
      email: u.email.toLowerCase(),
      name: u.name,
      passwordHash: u.passwordHash ?? null,
      googleSub: u.googleSub ?? null,
      avatar: u.avatar ?? null,
      isAdmin: Boolean(u.isAdmin),
      plan: u.plan ?? 'free',
      cycleStart: null,
      cycleEnd: null,
      rzSubscriptionId: null,
      pendingSubscriptionId: null,
      cancelAtPeriodEnd: false,
      createdAt: at,
      updatedAt: at,
    };
    await col().insertOne(row);
    return toUser(row);
  },
  async get(id: string): Promise<UserRow | null> {
    const d = await col().findOne({ _id: id });
    return d ? toUser(d) : null;
  },
  async byEmail(email: string): Promise<UserRow | null> {
    const d = await col().findOne({ email: email.toLowerCase() });
    return d ? toUser(d) : null;
  },
  async byGoogle(sub: string): Promise<UserRow | null> {
    const d = await col().findOne({ googleSub: sub });
    return d ? toUser(d) : null;
  },
  async bySubscription(subId: string): Promise<UserRow | null> {
    const d = await col().findOne({ rzSubscriptionId: subId });
    return d ? toUser(d) : null;
  },
  async list(): Promise<UserRow[]> {
    return (await col().find().sort({ createdAt: 1 }).toArray()).map(toUser);
  },
  async update(id: string, patch: Partial<Omit<UserRow, 'id' | 'createdAt'>>) {
    await col().updateOne({ _id: id }, { $set: setFields(patch, UPDATABLE) });
  },
};

const SESSION_DAYS = 30;
const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** A log-in. `_id` is the sha256 of the cookie token (the token itself is never stored). */
interface SessionDoc {
  _id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}
const sessionCol = () => collection<SessionDoc>(COLLECTIONS.sessions);

export const sessions = {
  /** A new random session token (only its hash is stored). */
  async create(userId: string): Promise<{ token: string; expiresAt: number }> {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now() + SESSION_DAYS * 86400_000;
    await sessionCol().insertOne({ _id: hash(token), userId, createdAt: now(), expiresAt });
    return { token, expiresAt };
  },
  async user(token: string): Promise<UserRow | null> {
    const s = await sessionCol().findOne({ _id: hash(token), expiresAt: { $gt: now() } });
    return s ? users.get(s.userId) : null;
  },
  async remove(token: string) {
    await sessionCol().deleteOne({ _id: hash(token) });
  },
  /** Log out everywhere (after a password change), optionally keeping one session. */
  async removeAllFor(userId: string, keepToken?: string) {
    await sessionCol().deleteMany({ userId, _id: { $ne: keepToken ? hash(keepToken) : '' } });
  },
  async prune() {
    await sessionCol().deleteMany({ expiresAt: { $lt: now() } });
  },
};

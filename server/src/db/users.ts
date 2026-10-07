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
  /** the person in Dodo Payments (made the first time they open a checkout) */
  dodoCustomerId: string | null;
  /** the Dodo subscription behind their paid plan */
  dodoSubscriptionId: string | null;
  /** its status as Dodo last reported it (active, on_hold = a renewal payment failed, …) */
  subscriptionStatus: string | null;
  /** a Razorpay subscription from before the move to Dodo (still renews there until cancelled) */
  rzSubscriptionId: string | null;
  /** legacy (Razorpay): a subscription opened in Checkout that hasn't been confirmed yet */
  pendingSubscriptionId: string | null;
  cancelAtPeriodEnd: boolean;
  createdAt: number;
}

const col = () => collection<Doc<UserRow> & { updatedAt: number }>(COLLECTIONS.users);
const toUser = (d: Doc<UserRow>): UserRow => {
  const { updatedAt: _u, ...rest } = d as Doc<UserRow> & { updatedAt?: number };
  const u = fromDoc<UserRow>(rest);
  // accounts made before the move to Dodo have no Dodo fields yet
  return { ...u, dodoCustomerId: u.dodoCustomerId ?? null, dodoSubscriptionId: u.dodoSubscriptionId ?? null, subscriptionStatus: u.subscriptionStatus ?? null };
};

const UPDATABLE = ['email', 'name', 'passwordHash', 'googleSub', 'avatar', 'isAdmin', 'plan', 'cycleStart', 'cycleEnd', 'dodoCustomerId', 'dodoSubscriptionId', 'subscriptionStatus', 'rzSubscriptionId', 'pendingSubscriptionId', 'cancelAtPeriodEnd'] as const;

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
      dodoCustomerId: null,
      dodoSubscriptionId: null,
      subscriptionStatus: null,
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
  /** Whose subscription this is (a Dodo id, or a Razorpay one from before the move). */
  async bySubscription(subId: string): Promise<UserRow | null> {
    const d = await col().findOne({ $or: [{ dodoSubscriptionId: subId }, { rzSubscriptionId: subId }] });
    return d ? toUser(d) : null;
  },
  async byDodoCustomer(customerId: string): Promise<UserRow | null> {
    const d = await col().findOne({ dodoCustomerId: customerId });
    return d ? toUser(d) : null;
  },
  /** Save the Dodo customer id unless one is already saved (two checkouts at once). Returns the one that's kept. */
  async claimDodoCustomer(id: string, customerId: string): Promise<string> {
    await col().updateOne({ _id: id, $or: [{ dodoCustomerId: null }, { dodoCustomerId: { $exists: false } }] }, { $set: { dodoCustomerId: customerId, updatedAt: now() } });
    return (await col().findOne({ _id: id }, { projection: { dodoCustomerId: 1 } }))?.dodoCustomerId ?? customerId;
  },
  async list(): Promise<UserRow[]> {
    return (await col().find().sort({ createdAt: 1 }).toArray()).map(toUser);
  },
  async update(id: string, patch: Partial<Omit<UserRow, 'id' | 'createdAt'>>) {
    await col().updateOne({ _id: id }, { $set: setFields(patch, UPDATABLE) });
  },
  /** Delete the account itself (see account-deletion.ts for everything that goes with it). */
  async remove(id: string) {
    await col().deleteOne({ _id: id });
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
  /** The person behind a session — the session and its user are read together, in one trip to the database. */
  async user(token: string): Promise<UserRow | null> {
    const [s] = await sessionCol()
      .aggregate<{ u: Doc<UserRow>[] }>([
        { $match: { _id: hash(token), expiresAt: { $gt: now() } } },
        { $limit: 1 },
        { $lookup: { from: COLLECTIONS.users, localField: 'userId', foreignField: '_id', as: 'u' } },
      ])
      .toArray();
    return s?.u[0] ? toUser(s.u[0]) : null;
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

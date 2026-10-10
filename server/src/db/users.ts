import crypto from 'node:crypto';
import { collection, COLLECTIONS, fromDoc, isDuplicate, newId, now, setFields, stamp, type Doc } from './connection.js';

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
  cancelAtPeriodEnd: boolean;
  /** A one-time Creator month granted by the founding offer; it does not auto-renew. */
  foundingOfferEndsAt: number | null;
  createdAt: number;
}

const col = () => collection<Doc<UserRow> & { updatedAt: number }>(COLLECTIONS.users);
const toUser = (d: Doc<UserRow>): UserRow => {
  const { updatedAt: _u, ...rest } = d as Doc<UserRow> & { updatedAt?: number };
  const u = fromDoc<UserRow>(rest);
  // accounts made before the move to Dodo have no Dodo fields yet
  return {
    ...u,
    dodoCustomerId: u.dodoCustomerId ?? null,
    dodoSubscriptionId: u.dodoSubscriptionId ?? null,
    subscriptionStatus: u.subscriptionStatus ?? null,
    foundingOfferEndsAt: u.foundingOfferEndsAt ?? null,
  };
};

const UPDATABLE = ['email', 'name', 'passwordHash', 'googleSub', 'avatar', 'isAdmin', 'plan', 'cycleStart', 'cycleEnd', 'dodoCustomerId', 'dodoSubscriptionId', 'subscriptionStatus', 'cancelAtPeriodEnd', 'foundingOfferEndsAt'] as const;

export const FOUNDING_CREATOR_OFFER_LIMIT = 50;
interface FoundingOfferStateDoc {
  _id: string;
  n: number;
  enabled: boolean;
  limit: number;
  endsAt: number | null;
  updatedAt: number;
}
const foundingOfferState = () => collection<FoundingOfferStateDoc>(COLLECTIONS.meta);
/** Kept for a one-time migration from the earlier two-document setting/counter shape. */
const legacyFoundingOfferSettings = () => collection<{ _id: string; enabled?: boolean; limit?: number; endsAt?: number | null; updatedAt?: number }>(COLLECTIONS.meta);
export interface FoundingCreatorOfferInfo {
  enabled: boolean;
  limit: number;
  claimed: number;
  remaining: number;
  available: boolean;
  endsAt: number | null;
}

async function ensureFoundingOfferState() {
  const existing = await foundingOfferState().findOne(
    { _id: 'founding_creator_offer' },
    { projection: { n: 1, enabled: 1, limit: 1, endsAt: 1, updatedAt: 1 } },
  );
  if (existing && existing.n !== undefined && existing.enabled !== undefined && existing.limit !== undefined && Object.hasOwn(existing, 'endsAt') && existing.updatedAt !== undefined) return;

  const legacy = await legacyFoundingOfferSettings().findOne({ _id: 'founding_creator_offer_settings' });
  const defaults = {
    enabled: legacy?.enabled ?? true,
    limit: legacy?.limit ?? FOUNDING_CREATOR_OFFER_LIMIT,
    endsAt: legacy?.endsAt ?? null,
    updatedAt: legacy?.updatedAt ?? now(),
  };
  try {
    await foundingOfferState().updateOne(
      { _id: 'founding_creator_offer' },
      { $setOnInsert: { n: 0, ...defaults } },
      { upsert: true },
    );
  } catch (e) {
    if (!isDuplicate(e)) throw e;
  }
  // Older deployments already have the counter record. Fill fields that were added with admin controls without
  // overwriting any values another app instance or admin has already saved.
  await Promise.all(
    Object.entries(defaults).map(([field, value]) =>
      foundingOfferState().updateOne({ _id: 'founding_creator_offer', [field]: { $exists: false } }, { $set: { [field]: value } }),
    ),
  );
}

export const users = {
  count(): Promise<number> {
    return col().estimatedDocumentCount();
  },
  async claimFoundingCreatorOffer(): Promise<boolean> {
    await ensureFoundingOfferState();
    const timestamp = now();
    const claim = await foundingOfferState().findOneAndUpdate(
      {
        _id: 'founding_creator_offer',
        enabled: true,
        $expr: { $lt: ['$n', '$limit'] },
        $or: [{ endsAt: null }, { endsAt: { $gt: timestamp } }],
      },
      { $inc: { n: 1 } },
      { returnDocument: 'after' },
    );
    return Boolean(claim);
  },
  async foundingCreatorOfferInfo(): Promise<FoundingCreatorOfferInfo> {
    await ensureFoundingOfferState();
    const state = await foundingOfferState().findOne({ _id: 'founding_creator_offer' });
    const enabled = state?.enabled ?? true;
    const limit = state?.limit ?? FOUNDING_CREATOR_OFFER_LIMIT;
    const endsAt = state?.endsAt ?? null;
    const claimed = state?.n ?? 0;
    const remaining = Math.max(0, limit - claimed);
    const beforeDeadline = endsAt === null || now() < endsAt;
    return { enabled, limit, endsAt, claimed, remaining, available: enabled && beforeDeadline && remaining > 0 };
  },
  async updateFoundingCreatorOffer(settings: { enabled: boolean; limit: number; endsAt: number | null }): Promise<FoundingCreatorOfferInfo> {
    await ensureFoundingOfferState();
    await foundingOfferState().updateOne(
      { _id: 'founding_creator_offer' },
      { $set: { ...settings, updatedAt: now() } },
    );
    return users.foundingCreatorOfferInfo();
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
      cancelAtPeriodEnd: false,
      foundingOfferEndsAt: null,
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
  /** Whose Dodo subscription this is. */
  async bySubscription(subId: string): Promise<UserRow | null> {
    const d = await col().findOne({ dodoSubscriptionId: subId });
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
  /**
   * Update only while the account still has these values (e.g. still the same subscription) — so a slow check of an
   * old subscription can't overwrite a newer one saved meanwhile. Returns false when nothing matched.
   */
  async updateIf(id: string, match: Partial<Pick<UserRow, 'dodoSubscriptionId'>>, patch: Partial<Omit<UserRow, 'id' | 'createdAt'>>) {
    const r = await col().updateOne({ _id: id, ...match }, { $set: setFields(patch, UPDATABLE) });
    return r.matchedCount > 0;
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

import { collection, COLLECTIONS, fromDoc, isDuplicate, newId, now, stamp, type Doc } from './connection.js';

/**
 * Credits are kept in "grants" (a batch of credits with an expiry date): the monthly plan allowance, a top-up pack,
 * a refund. Using credits takes from the grant that expires first. Every change is also written to `credit_events`
 * (the history the person sees). Each grant can carry a `ref` so the same payment never adds credits twice.
 *
 * There are no multi-document transactions here: every change to a balance is a single conditional update
 * ("take 5 only if at least 5 are left"), so two things spending at the same time can never go below zero.
 */

type GrantSource = 'plan' | 'topup' | 'bonus' | 'refund';
interface GrantRow {
  id: string;
  userId: string;
  source: GrantSource;
  amount: number;
  remaining: number;
  expiresAt: number;
  /** makes grants idempotent (payment / subscription cycle) */
  ref: string | null;
  createdAt: number;
}
/** Where a spend's credits came from: grant id → amount (so a refund can put them back). */
type SpendDetail = { from: { g: string; a: number }[] };
interface CreditEventRow {
  id: string;
  userId: string;
  /** + added, − used */
  delta: number;
  kind: 'grant' | 'topup' | 'spend' | 'refund' | 'adjust';
  note: string | null;
  projectId: string | null;
  detail: SpendDetail | null;
  refunded: boolean;
  createdAt: number;
}
interface PaymentRow {
  /** Razorpay payment id */
  id: string;
  userId: string;
  kind: 'subscription' | 'topup';
  plan: string | null;
  /** smallest currency unit (cents) */
  amount: number | null;
  currency: string | null;
  /** order / subscription id */
  ref: string | null;
  createdAt: number;
}

const grantCol = () => collection<Doc<GrantRow>>(COLLECTIONS.creditGrants);
const eventCol = () => collection<Doc<CreditEventRow>>(COLLECTIONS.creditEvents);
const paymentCol = () => collection<Doc<PaymentRow>>(COLLECTIONS.payments);

export class NotEnoughCredits extends Error {
  constructor(
    public needed: number,
    public have: number,
  ) {
    super(`Not enough credits: needs ${needed}, you have ${have}.`);
  }
}

async function event(userId: string, delta: number, kind: CreditEventRow['kind'], note: string, projectId: string | null = null, detail: SpendDetail | null = null) {
  const _id = newId();
  await eventCol().insertOne({ _id, userId, delta, kind, note, projectId, detail, refunded: false, createdAt: stamp() });
  return _id;
}

async function addGrant(userId: string, source: GrantSource, amount: number, expiresAt: number, ref: string | null = null) {
  await grantCol().insertOne({ _id: newId(), userId, source, amount, remaining: amount, expiresAt, ref, createdAt: stamp() });
}

/** Put credits back on the grants they came from; what can't go back (grant expired) becomes a fresh 30-day grant. */
async function giveBack(userId: string, parts: { g: string; a: number }[]) {
  let lapsed = 0;
  for (const { g, a } of parts) {
    if (a <= 0) continue;
    const r = await grantCol().updateOne({ _id: g, expiresAt: { $gt: now() } }, { $inc: { remaining: a } });
    if (!r.modifiedCount) lapsed += a;
  }
  if (lapsed) await addGrant(userId, 'refund', lapsed, now() + 30 * 86400_000);
}

export const credits = {
  /** Credits that can be used right now. */
  async balance(userId: string): Promise<number> {
    const [r] = await grantCol()
      .aggregate<{ n: number }>([{ $match: { userId, expiresAt: { $gt: now() } } }, { $group: { _id: null, n: { $sum: '$remaining' } } }])
      .toArray();
    return r?.n ?? 0;
  },
  /** Grants that still hold credits, soonest to expire first. */
  async liveGrants(userId: string): Promise<GrantRow[]> {
    return (
      await grantCol()
        .find({ userId, expiresAt: { $gt: now() }, remaining: { $gt: 0 } })
        .sort({ expiresAt: 1, createdAt: 1 })
        .toArray()
    ).map((d) => fromDoc<GrantRow>(d));
  },
  /** Add credits. With a `ref` that was used before, nothing happens (returns false). */
  async grant(userId: string, g: { amount: number; source: GrantSource; expiresAt: number; ref?: string; note: string; kind?: CreditEventRow['kind'] }): Promise<boolean> {
    try {
      await addGrant(userId, g.source, g.amount, g.expiresAt, g.ref ?? null);
    } catch (e) {
      if (isDuplicate(e)) return false; // this payment / month was already added
      throw e;
    }
    await event(userId, g.amount, g.kind ?? (g.source === 'topup' ? 'topup' : 'grant'), g.note);
    return true;
  },
  /**
   * Use credits (soonest-expiring first). Throws NotEnoughCredits without touching anything. Returns the event id.
   * kind 'adjust' = taken away by an admin (not counted as "used" in the monthly meter).
   */
  async spend(userId: string, amount: number, note: string, projectId: string | null, kind: 'spend' | 'adjust' = 'spend'): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const grants = await this.liveGrants(userId);
      const have = grants.reduce((a, g) => a + g.remaining, 0);
      if (have < amount) throw new NotEnoughCredits(amount, have);
      let left = amount;
      const from: SpendDetail['from'] = [];
      let raced = false;
      for (const g of grants) {
        if (!left) break;
        const take = Math.min(left, g.remaining);
        // only if the grant still has that much (something else may have used it a moment ago)
        const r = await grantCol().updateOne({ _id: g.id, remaining: { $gte: take } }, { $inc: { remaining: -take } });
        if (!r.modifiedCount) {
          raced = true;
          break;
        }
        from.push({ g: g.id, a: take });
        left -= take;
      }
      if (!raced) return event(userId, -amount, kind, note, projectId, { from });
      await giveBack(userId, from); // undo this attempt and try again with fresh numbers
    }
    throw new Error('Credits are busy — please try again.');
  },
  /** Give back what a spend took (to the same grants; if those have expired, as a fresh 30-day grant). */
  async refund(eventId: string, note: string): Promise<number> {
    // claim the spend first, so it can only be refunded once
    const e = await eventCol().findOneAndUpdate({ _id: eventId, kind: 'spend', refunded: false }, { $set: { refunded: true } });
    if (!e) return 0;
    await giveBack(e.userId, e.detail?.from ?? []);
    const amount = -e.delta;
    await event(e.userId, amount, 'refund', note, e.projectId ?? null);
    return amount;
  },
  /**
   * Lower a spend to `keep` credits (fewer clips came out than were paid for): the difference goes back to the
   * grants it came from (the last-used first), and the history line shows the final cost with `note`.
   * Returns the credits given back.
   */
  async reduceSpend(eventId: string, keep: number, note: string): Promise<number> {
    const e = await eventCol().findOne({ _id: eventId, kind: 'spend', refunded: false });
    if (!e) return 0;
    const paid = -e.delta;
    let back = paid - Math.max(0, keep);
    if (back <= 0) return 0;
    const given = back;
    const from = (e.detail?.from ?? []).map((f) => ({ ...f }));
    const returned: SpendDetail['from'] = [];
    for (let i = from.length - 1; i >= 0 && back > 0; i--) {
      const take = Math.min(back, from[i].a);
      returned.push({ g: from[i].g, a: take });
      from[i].a -= take;
      back -= take;
    }
    const left = paid - given;
    // change the spend only if nobody changed it in the meantime; then give the difference back
    const r = await eventCol().updateOne({ _id: eventId, refunded: false, delta: e.delta }, { $set: { delta: -left, note, detail: { from: from.filter((f) => f.a > 0) }, refunded: left === 0 } });
    if (!r.modifiedCount) return 0;
    await giveBack(e.userId, returned);
    return given;
  },
  /** The latest un-refunded spend for a project (to refund when it fails). */
  async lastSpendFor(projectId: string): Promise<string | null> {
    const d = await eventCol()
      .find({ projectId, kind: 'spend', refunded: false }, { projection: { _id: 1 } })
      .sort({ createdAt: -1 })
      .limit(1)
      .next();
    return d?._id ?? null;
  },
  /** Admin correction: + adds a 1-year bonus grant, − takes credits away. */
  async adjust(userId: string, delta: number, note: string) {
    if (delta > 0) return this.grant(userId, { amount: delta, source: 'bonus', expiresAt: now() + 365 * 86400_000, note, kind: 'adjust' });
    const take = Math.min(-delta, await this.balance(userId));
    if (take > 0) await this.spend(userId, take, note, null, 'adjust');
    return true;
  },
  /** Account deletion: their credits and credit history. Payment records are kept (tax law), see `payments`. */
  async removeAllFor(userId: string) {
    await Promise.all([grantCol().deleteMany({ userId }), eventCol().deleteMany({ userId })]);
  },
  async history(userId: string, limit = 100): Promise<Omit<CreditEventRow, 'userId' | 'detail'>[]> {
    const docs = await eventCol()
      .find({ userId }, { projection: { userId: 0, detail: 0 } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => fromDoc<CreditEventRow>(d));
  },
  /** Used this cycle (for the meter). */
  async spentSince(userId: string, since: number): Promise<number> {
    const [r] = await eventCol()
      .aggregate<{ n: number }>([{ $match: { userId, kind: 'spend', refunded: false, createdAt: { $gte: since } } }, { $group: { _id: null, n: { $sum: { $subtract: [0, '$delta'] } } } }])
      .toArray();
    return r?.n ?? 0;
  },
};

export const payments = {
  /** Record a payment once (the same Razorpay payment id is ignored the second time). */
  async record(p: { id: string; userId: string; kind: PaymentRow['kind']; plan?: string | null; amount?: number | null; currency?: string | null; ref?: string | null }) {
    await paymentCol().updateOne(
      { _id: p.id },
      { $setOnInsert: { userId: p.userId, kind: p.kind, plan: p.plan ?? null, amount: p.amount ?? null, currency: p.currency ?? null, ref: p.ref ?? null, createdAt: stamp() } },
      { upsert: true },
    );
  },
  /** One payment, only if it belongs to this user. */
  async get(userId: string, id: string): Promise<Omit<PaymentRow, 'userId' | 'ref'> | null> {
    const d = await paymentCol().findOne({ _id: id, userId }, { projection: { userId: 0, ref: 0 } });
    return d ? fromDoc<PaymentRow>(d) : null;
  },
  async forUser(userId: string): Promise<Omit<PaymentRow, 'userId' | 'ref'>[]> {
    const docs = await paymentCol()
      .find({ userId }, { projection: { userId: 0, ref: 0 } })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    return docs.map((d) => fromDoc<PaymentRow>(d));
  },
};

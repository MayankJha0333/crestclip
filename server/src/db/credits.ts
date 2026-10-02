import { db, newId, now, parse, type Raw } from './connection.js';

/**
 * Credits are kept in "grants" (a batch of credits with an expiry date): the monthly plan allowance, a top-up pack,
 * a refund. Using credits takes from the grant that expires first. Every change is also written to `credit_events`
 * (the history the person sees). Each grant can carry a `ref` so the same payment never adds credits twice.
 */

type GrantSource = 'plan' | 'topup' | 'bonus' | 'refund';
interface GrantRow {
  id: string;
  source: GrantSource;
  amount: number;
  remaining: number;
  expiresAt: number;
  createdAt: number;
}
interface CreditEventRow {
  id: string;
  delta: number;
  kind: 'grant' | 'topup' | 'spend' | 'refund' | 'adjust';
  note: string | null;
  projectId: string | null;
  refunded: boolean;
  createdAt: number;
}
interface PaymentRow {
  id: string;
  kind: 'subscription' | 'topup';
  plan: string | null;
  amount: number | null;
  currency: string | null;
  createdAt: number;
}

const toGrant = (r: Raw): GrantRow => ({
  id: r.id as string,
  source: r.source as GrantSource,
  amount: r.amount as number,
  remaining: r.remaining as number,
  expiresAt: r.expires_at as number,
  createdAt: r.created_at as number,
});
const toEvent = (r: Raw): CreditEventRow => ({
  id: r.id as string,
  delta: r.delta as number,
  kind: r.kind as CreditEventRow['kind'],
  note: (r.note as string) ?? null,
  projectId: (r.project_id as string) ?? null,
  refunded: Boolean(r.refunded),
  createdAt: r.created_at as number,
});

/** Run `fn` in one SQLite transaction (all or nothing). */
function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export class NotEnoughCredits extends Error {
  constructor(
    public needed: number,
    public have: number,
  ) {
    super(`Not enough credits: needs ${needed}, you have ${have}.`);
  }
}

function event(userId: string, delta: number, kind: CreditEventRow['kind'], note: string, projectId: string | null = null, detail: unknown = null) {
  const id = newId();
  db.prepare('INSERT INTO credit_events (id, user_id, delta, kind, note, project_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    userId,
    delta,
    kind,
    note,
    projectId,
    detail == null ? null : JSON.stringify(detail),
    now(),
  );
  return id;
}

export const credits = {
  /** Credits that can be used right now. */
  balance(userId: string): number {
    return ((db.prepare('SELECT COALESCE(SUM(remaining), 0) AS n FROM credit_grants WHERE user_id = ? AND expires_at > ?').get(userId, now()) as Raw).n as number) ?? 0;
  },
  /** Grants that still hold credits, soonest to expire first. */
  liveGrants(userId: string): GrantRow[] {
    return (db.prepare('SELECT * FROM credit_grants WHERE user_id = ? AND expires_at > ? AND remaining > 0 ORDER BY expires_at').all(userId, now()) as Raw[]).map(toGrant);
  },
  hasRef(ref: string): boolean {
    return Boolean(db.prepare('SELECT 1 FROM credit_grants WHERE ref = ?').get(ref));
  },
  /** Add credits. With a `ref` that was used before, nothing happens (returns false). */
  grant(userId: string, g: { amount: number; source: GrantSource; expiresAt: number; ref?: string; note: string; kind?: CreditEventRow['kind'] }): boolean {
    return tx(() => {
      if (g.ref && db.prepare('SELECT 1 FROM credit_grants WHERE ref = ?').get(g.ref)) return false;
      db.prepare('INSERT INTO credit_grants (id, user_id, source, amount, remaining, expires_at, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        newId(),
        userId,
        g.source,
        g.amount,
        g.amount,
        g.expiresAt,
        g.ref ?? null,
        now(),
      );
      event(userId, g.amount, g.kind ?? (g.source === 'topup' ? 'topup' : 'grant'), g.note);
      return true;
    });
  },
  /**
   * Use credits (soonest-expiring first). Throws NotEnoughCredits without touching anything. Returns the event id.
   * kind 'adjust' = taken away by an admin (not counted as "used" in the monthly meter).
   */
  spend(userId: string, amount: number, note: string, projectId: string | null, kind: 'spend' | 'adjust' = 'spend'): string {
    return tx(() => {
      const grants = this.liveGrants(userId);
      const have = grants.reduce((a, g) => a + g.remaining, 0);
      if (have < amount) throw new NotEnoughCredits(amount, have);
      let left = amount;
      const from: { g: string; a: number }[] = [];
      for (const g of grants) {
        if (!left) break;
        const take = Math.min(left, g.remaining);
        db.prepare('UPDATE credit_grants SET remaining = remaining - ? WHERE id = ?').run(take, g.id);
        from.push({ g: g.id, a: take });
        left -= take;
      }
      return event(userId, -amount, kind, note, projectId, { from });
    });
  },
  /** Give back what a spend took (to the same grants; if those have expired, as a fresh 30-day grant). */
  refund(eventId: string, note: string): number {
    return tx(() => {
      const r = db.prepare("SELECT * FROM credit_events WHERE id = ? AND kind = 'spend' AND refunded = 0").get(eventId) as Raw | undefined;
      if (!r) return 0;
      const userId = r.user_id as string;
      const from = parse(r.detail_json, { from: [] as { g: string; a: number }[] }).from;
      let lapsed = 0;
      for (const f of from) {
        const g = db.prepare('SELECT expires_at FROM credit_grants WHERE id = ?').get(f.g) as Raw | undefined;
        if (g && (g.expires_at as number) > now()) db.prepare('UPDATE credit_grants SET remaining = remaining + ? WHERE id = ?').run(f.a, f.g);
        else lapsed += f.a;
      }
      if (lapsed)
        db.prepare('INSERT INTO credit_grants (id, user_id, source, amount, remaining, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          newId(),
          userId,
          'refund',
          lapsed,
          lapsed,
          now() + 30 * 86400_000,
          now(),
        );
      db.prepare('UPDATE credit_events SET refunded = 1 WHERE id = ?').run(eventId);
      const amount = -(r.delta as number);
      event(userId, amount, 'refund', note, (r.project_id as string) ?? null);
      return amount;
    });
  },
  /**
   * Lower a spend to `keep` credits (fewer clips came out than were paid for): the difference goes back to the
   * grants it came from (the last-used first), and the history line shows the final cost with `note`.
   * Returns the credits given back.
   */
  reduceSpend(eventId: string, keep: number, note: string): number {
    return tx(() => {
      const r = db.prepare("SELECT * FROM credit_events WHERE id = ? AND kind = 'spend' AND refunded = 0").get(eventId) as Raw | undefined;
      if (!r) return 0;
      const paid = -(r.delta as number);
      let back = paid - Math.max(0, keep);
      if (back <= 0) return 0;
      const userId = r.user_id as string;
      const from = parse(r.detail_json, { from: [] as { g: string; a: number }[] }).from;
      const given = back;
      let lapsed = 0;
      for (let i = from.length - 1; i >= 0 && back > 0; i--) {
        const f = from[i];
        const take = Math.min(back, f.a);
        const g = db.prepare('SELECT expires_at FROM credit_grants WHERE id = ?').get(f.g) as Raw | undefined;
        if (g && (g.expires_at as number) > now()) db.prepare('UPDATE credit_grants SET remaining = remaining + ? WHERE id = ?').run(take, f.g);
        else lapsed += take;
        f.a -= take;
        back -= take;
      }
      if (lapsed)
        db.prepare('INSERT INTO credit_grants (id, user_id, source, amount, remaining, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          newId(),
          userId,
          'refund',
          lapsed,
          lapsed,
          now() + 30 * 86400_000,
          now(),
        );
      const left = paid - given;
      db.prepare('UPDATE credit_events SET delta = ?, note = ?, detail_json = ?, refunded = ? WHERE id = ?').run(
        -left,
        note,
        JSON.stringify({ from: from.filter((f) => f.a > 0) }),
        left === 0 ? 1 : 0,
        eventId,
      );
      return given;
    });
  },
  /** The latest un-refunded spend for a project (to refund when it fails). */
  lastSpendFor(projectId: string): string | null {
    const r = db.prepare("SELECT id FROM credit_events WHERE project_id = ? AND kind = 'spend' AND refunded = 0 ORDER BY created_at DESC LIMIT 1").get(projectId) as Raw | undefined;
    return (r?.id as string) ?? null;
  },
  /** Admin correction: + adds a 1-year bonus grant, − takes credits away. */
  adjust(userId: string, delta: number, note: string) {
    if (delta > 0) return this.grant(userId, { amount: delta, source: 'bonus', expiresAt: now() + 365 * 86400_000, note, kind: 'adjust' });
    const take = Math.min(-delta, this.balance(userId));
    if (take > 0) this.spend(userId, take, note, null, 'adjust');
    return true;
  },
  history(userId: string, limit = 100): CreditEventRow[] {
    return (db.prepare('SELECT * FROM credit_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit) as Raw[]).map(toEvent);
  },
  /** Used this cycle (for the meter). */
  spentSince(userId: string, since: number): number {
    const r = db.prepare("SELECT COALESCE(SUM(-delta), 0) AS n FROM credit_events WHERE user_id = ? AND kind = 'spend' AND refunded = 0 AND created_at >= ?").get(userId, since) as Raw;
    return r.n as number;
  },
};

export const payments = {
  record(p: { id: string; userId: string; kind: PaymentRow['kind']; plan?: string | null; amount?: number | null; currency?: string | null; ref?: string | null }) {
    db.prepare('INSERT OR IGNORE INTO payments (id, user_id, kind, plan, amount, currency, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      p.id,
      p.userId,
      p.kind,
      p.plan ?? null,
      p.amount ?? null,
      p.currency ?? null,
      p.ref ?? null,
      now(),
    );
  },
  forUser(userId: string): PaymentRow[] {
    return (db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(userId) as Raw[]).map((r) => ({
      id: r.id as string,
      kind: r.kind as PaymentRow['kind'],
      plan: (r.plan as string) ?? null,
      amount: (r.amount as number) ?? null,
      currency: (r.currency as string) ?? null,
      createdAt: r.created_at as number,
    }));
  },
};

import { config } from '../../config.js';
import { site } from '../system/system.service.js';
import { credits, creditsVersion, NotEnoughCredits, payments, projects, users, type PlanId, type UserRow } from '../../db/index.js';
import { HttpError } from '../../lib/http.js';
import { CREDITS_PER_CLIP, creditsForClips, CURRENCY, PLAN_ORDER, PLANS, planOf, POLICY_LINES, TOPUP, type Plan } from './plans.js';
import { dodo, DodoError, dodoReady, ms, planForProduct, productForPlan, validDodoWebhook, type DodoEvent, type DodoPayment, type DodoSubscription } from './dodo.js';
import { planForRazorpayPlan, razorpay, razorpayReady, validWebhook, type RzPayment, type RzSubscription } from './razorpay.js';

const DAY = 86400_000;
/** Same day next month (Jan 31 → Mar 3 is fine for a billing month). */
const nextMonth = (t: number) => {
  const d = new Date(t);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
};
const rank = (id: PlanId) => PLAN_ORDER.indexOf(id);

/** Something the person can fix by upgrading or buying credits — shown with an "Upgrade" button. */
export class BillingError extends Error {
  constructor(
    public code: 'credits' | 'plan_limit',
    message: string,
  ) {
    super(message);
  }
}

// ---------------- the credit month ----------------

/** Re-check a subscription with the payment provider at most this often per person (when their month has run out). */
const lastSync = new Map<string, number>();
const due = (map: Map<string, number>, key: string, everyMs: number) => {
  if (Date.now() - (map.get(key) ?? 0) < everyMs) return false;
  map.set(key, Date.now());
  return true;
};

/**
 * Keep the person's account current: start a new credit month when the old one ran out (adding that month's credits),
 * renew or end paid plans. Cheap to call often — it only does work at the turn of the month.
 */
export async function refreshAccount(user: UserRow): Promise<UserRow> {
  if (user.cycleEnd && Date.now() < user.cycleEnd) return user;
  const plan = planOf(user.plan);
  if (plan.id !== 'free' && user.dodoSubscriptionId) {
    // a renewal is due: ask Dodo (a renewal paid in India by UPI / e-mandate can arrive up to ~2 days late)
    if (dodoReady() && due(lastSync, user.id, 5 * 60_000)) {
      try {
        await syncDodo(user, await dodo.subscription(user.dodoSubscriptionId));
      } catch (e) {
        console.warn(`[billing] couldn't check the Dodo subscription of ${user.email}:`, (e as Error).message);
      }
    }
    const after = (await users.get(user.id))!;
    return after.plan === 'free' ? refreshAccount(after) : after; // the subscription ended → start the Free month
  }
  if (plan.id !== 'free' && user.rzSubscriptionId) {
    if (razorpayReady() && due(lastSync, user.id, 5 * 60_000)) {
      try {
        await syncRazorpay(user, await razorpay.subscription(user.rzSubscriptionId));
      } catch (e) {
        console.warn(`[billing] couldn't check the Razorpay subscription of ${user.email}:`, (e as Error).message);
      }
    }
    const after = (await users.get(user.id))!;
    return after.plan === 'free' ? refreshAccount(after) : after;
  }
  if (plan.id !== 'free' && user.cancelAtPeriodEnd) {
    await downgrade(user, 'The plan ended');
    return refreshAccount((await users.get(user.id))!);
  }
  // free plan, or a plan an admin gave (no subscription): roll the month forward and add its credits
  let start = user.cycleEnd && user.cycleEnd > Date.now() - 62 * DAY ? user.cycleEnd : Date.now();
  while (nextMonth(start) <= Date.now()) start = nextMonth(start);
  const end = nextMonth(start);
  await users.update(user.id, { cycleStart: start, cycleEnd: end });
  await credits.grant(user.id, {
    amount: plan.credits,
    source: 'plan',
    expiresAt: plan.rollover ? nextMonth(end) : end,
    ref: `${plan.id}_${user.id}_${start}`,
    note: `${plan.name} plan · monthly credits`,
  });
  return (await users.get(user.id))!;
}

/** "8 Nov" */
const day = (t: number | null) => (t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : 'the end of the month');
/** A plan change as a line in the person's credit history (it moves no credits). Never fails the caller. */
const logPlan = (userId: string, note: string) => credits.planEvent(userId, note).catch((e) => console.warn('[billing] history line:', (e as Error).message));

/** A failed renewal (Dodo "on hold") keeps the plan this long after the paid month ended — time to fix the card / UPI. */
const GRACE_DAYS = 7;

/** Which CrestClip plan a Dodo subscription is. */
const planOfDodo = (sub: DodoSubscription): PlanId | null =>
  planForProduct(sub.product_id) ?? (sub.metadata?.plan && sub.metadata.plan in PLANS && sub.metadata.plan !== 'free' ? (sub.metadata.plan as PlanId) : null);

/**
 * Apply what Dodo says about the person's subscription: a paid month (add its credits, once), an upgrade in the
 * middle of a month (add the extra credits, once), a failed renewal, or the end of the plan.
 */
/** Returns true when the subscription's latest payment has had its credits (now or before). */
async function syncDodo(user: UserRow, sub: DodoSubscription): Promise<boolean> {
  const planId = planOfDodo(sub);
  if (!planId) {
    console.warn(`[billing] ${user.email}: Dodo subscription ${sub.subscription_id} is for an unknown product ${sub.product_id} — check DODO_PRODUCT_* in the settings`);
    return false;
  }
  const start = ms(sub.previous_billing_date);
  const end = ms(sub.next_billing_date);
  const live = sub.status === 'active' || sub.status === 'on_hold' || sub.status === 'past_due' || sub.status === 'paused';
  if (live) {
    const problem = sub.status !== 'active';
    const paidUntil = end ?? user.cycleEnd;
    if (problem && paidUntil && Date.now() > paidUntil + GRACE_DAYS * DAY) {
      // Grace is over: end it at Dodo too, so a card fixed later can't restart billing next to a new plan.
      await dodo.updateSubscription(sub.subscription_id, { status: 'cancelled' }).catch((e) => console.warn('[billing] cancel unpaid Dodo subscription:', (e as Error).message));
      await downgrade(user, `Payment failed (Dodo: ${sub.status})`, { dodoSubscriptionId: sub.subscription_id });
      return false;
    }
    const p = PLANS[planId];
    // only while this is still the person's subscription (a slow check of an old one can't undo a newer one)
    const stillMine = await users.updateIf(
      user.id,
      { dodoSubscriptionId: sub.subscription_id },
      { plan: p.id, subscriptionStatus: sub.status, cycleStart: start, cycleEnd: end, cancelAtPeriodEnd: Boolean(sub.cancel_at_next_billing_date) },
    );
    if (stillMine) {
      // what changed, as lines in the credit history
      const ending = Boolean(sub.cancel_at_next_billing_date);
      if (user.plan !== p.id)
        await logPlan(user.id, user.plan === 'free' ? `Started the ${p.name} plan` : rank(p.id) > rank(user.plan) ? `Upgraded to ${p.name}` : `Switched to ${p.name}`);
      else if (!user.cancelAtPeriodEnd && ending) await logPlan(user.id, `${p.name} cancelled — stays active until ${day(end)}, then Free`);
      else if (user.cancelAtPeriodEnd && !ending) await logPlan(user.id, `${p.name} will keep renewing (cancellation undone)`);
      if (user.subscriptionStatus === 'active' && problem) await logPlan(user.id, `Renewal payment failed — update your payment method to keep ${p.name}`);
      else if (user.subscriptionStatus && user.subscriptionStatus !== 'active' && !problem) await logPlan(user.id, `Payment went through — ${p.name} is active again`);
    }
    if (!stillMine || sub.status !== 'active') return false;
    // the credits come with a PAYMENT: the subscription's newest one (first month, renewal, or an upgrade's charge)
    const pays = await dodo.paymentsOf({ subscription_id: sub.subscription_id });
    for (const pay of pays) await recordPayment(user.id, pay, planId);
    const latest = pays
      .filter((x) => x.status === 'succeeded' && x.total_amount > 0 && !x.is_update_payment_method)
      .sort((a, b) => (ms(b.created_at) ?? 0) - (ms(a.created_at) ?? 0))[0];
    if (!latest) return false;
    await grantDodoMonth(user.id, latest.payment_id, end ?? nextMonth(ms(latest.created_at) ?? Date.now()), p);
    return true;
  }
  if (sub.status === 'pending') return false; // the first payment isn't through yet
  // cancelled / failed / expired — only the person's current subscription ends their plan
  await downgrade(user, sub.status === 'failed' ? 'Payment failed' : 'The plan ended', { dodoSubscriptionId: sub.subscription_id });
  return false;
}

/**
 * The credits that come with one subscription payment (a first month, a renewal, an upgrade's charge), added in
 * "steps": step 1 = Creator's 400, step 2 = Pro's extra 600. Each step's key is the payment id + step, so however
 * many checks run — webhook, return from checkout, refresh, even at the same moment — each is added once, and
 * nothing is added without a payment (Dodo moves its billing dates when a change is merely asked for, and a
 * merchant can move them by hand; neither is a payment). An upgrade is its own payment in Dodo (Pro's price minus
 * what's left of the old month, starting a new month), so it brings Pro's 1,000.
 */
async function grantDodoMonth(userId: string, paymentId: string, end: number, p: Plan) {
  const paid: PlanId[] = PLAN_ORDER.filter((id) => id !== 'free');
  const upTo = paid.indexOf(p.id);
  const hadStep1 = await credits.hasRef(`dodo_${paymentId}_1`);
  for (let i = 0; i <= upTo; i++) {
    const amount = PLANS[paid[i]].credits - (i ? PLANS[paid[i - 1]].credits : 0);
    if (amount <= 0) continue;
    await credits.grant(userId, {
      amount,
      source: 'plan',
      expiresAt: nextMonth(end), // unused paid credits roll over one month
      ref: `dodo_${paymentId}_${i + 1}`,
      note: i && hadStep1 ? `${p.name} plan · upgrade (extra credits this month)` : `${p.name} plan · monthly credits${upTo ? ` (part ${i + 1} of ${upTo + 1})` : ''}`,
    });
  }
}

/** Legacy: apply what Razorpay says about a subscription made before the move to Dodo. */
async function syncRazorpay(user: UserRow, sub: RzSubscription) {
  const plan = planFromRazorpay(sub) ?? user.plan;
  const end = sub.current_end ? sub.current_end * 1000 : null;
  if ((sub.status === 'active' || sub.status === 'authenticated') && sub.paid_count > 0 && end && end > Date.now()) {
    const p = planOf(plan);
    if (!(await users.updateIf(user.id, { rzSubscriptionId: sub.id }, { plan: p.id, cycleStart: (sub.current_start ?? Date.now() / 1000) * 1000, cycleEnd: end }))) return;
    await credits.grant(user.id, {
      amount: p.credits,
      source: 'plan',
      expiresAt: nextMonth(end),
      ref: `sub_${sub.id}_${sub.paid_count}`,
      note: `${p.name} plan · monthly credits`,
    });
    return;
  }
  if (sub.status === 'cancelled' && end && end > Date.now()) {
    await users.updateIf(user.id, { rzSubscriptionId: sub.id }, { cancelAtPeriodEnd: true }); // paid until the end of this month
    return;
  }
  if (['cancelled', 'completed', 'expired', 'halted'].includes(sub.status)) await downgrade(user, sub.status === 'halted' ? 'Payments failed' : 'The plan ended', { rzSubscriptionId: sub.id });
  // 'pending' = Razorpay is retrying a failed renewal: keep the plan, add credits once it's paid
}

function planFromRazorpay(sub: RzSubscription): PlanId | null {
  if (sub.notes?.plan && sub.notes.plan in PLANS) return sub.notes.plan as PlanId;
  return planForRazorpayPlan(sub.plan_id);
}

/**
 * Back to Free (credits already paid for stay until they expire). With `onlyIf`, only while the account is still on
 * that subscription — a late "cancelled" for an old subscription can't end a newer plan bought meanwhile.
 */
async function downgrade(user: UserRow, why: string, onlyIf?: { dodoSubscriptionId: string } | { rzSubscriptionId: string }) {
  const patch = { plan: 'free' as const, dodoSubscriptionId: null, subscriptionStatus: null, rzSubscriptionId: null, cancelAtPeriodEnd: false, cycleEnd: Date.now() };
  if (onlyIf) {
    if (!(await users.updateIf(user.id, onlyIf, patch))) return;
  } else await users.update(user.id, patch);
  console.log(`[billing] ${user.email}: ${planOf(user.plan).name} → Free (${why})`);
  if (user.plan !== 'free') await logPlan(user.id, `${planOf(user.plan).name} ended${/fail/i.test(why) ? ' (payment failed)' : ''} — you’re on Free now. Credits you have stay until they expire.`);
}

// ---------------- what the app shows ----------------

/** A plan as the app shows it (price in US dollars, and how many clips its credits make). */
export const publicPlan = (p: Plan) => ({ ...p, currency: CURRENCY, clips: Math.floor(p.credits / CREDITS_PER_CLIP) });
/** The public pricing table (landing page, pricing page, Plan page). */
export const plansInfo = () => ({ currency: CURRENCY, creditsPerClip: CREDITS_PER_CLIP, plans: PLAN_ORDER.map((id) => publicPlan(PLANS[id])), topup: TOPUP, policy: POLICY_LINES });

type Summary = Awaited<ReturnType<typeof buildSummary>>;
const summaryCache = new Map<string, { key: string; at: number; value: Summary }>();
const SUMMARY_TTL = 30_000;

/**
 * The plan + credits block every page asks for (/auth/me). Cached for 30 s per person, keyed on everything that
 * can change it (credit changes on this server bump `creditsVersion`), so the usual page load costs one database
 * trip (the session) instead of four. Grants expiring exactly inside the 30 s window show a moment late — fine.
 */
export async function accountSummary(user: UserRow): Promise<Summary> {
  const key = [creditsVersion(user.id), user.plan, user.cycleStart, user.cycleEnd, user.cancelAtPeriodEnd, user.dodoSubscriptionId, user.subscriptionStatus, user.dodoCustomerId, user.rzSubscriptionId].join('|');
  const hit = summaryCache.get(user.id);
  if (hit && hit.key === key && Date.now() - hit.at < SUMMARY_TTL) return hit.value;
  const value = await buildSummary(user);
  summaryCache.set(user.id, { key, at: Date.now(), value });
  return value;
}

async function buildSummary(user: UserRow) {
  const plan = planOf(user.plan);
  // read together (one wait instead of three)
  const [balance, usedThisMonth, grants, lastChange] = await Promise.all([
    credits.balance(user.id),
    user.cycleStart ? credits.spentSince(user.id, user.cycleStart) : 0,
    credits.liveGrants(user.id),
    credits.lastPlanEvent(user.id),
  ]);
  return {
    plan: publicPlan(plan),
    cycleStart: user.cycleStart,
    cycleEnd: user.cycleEnd,
    cancelAtPeriodEnd: user.cancelAtPeriodEnd,
    /** the latest plan change ("Pro cancelled", "Pro ended", "Upgraded to Pro") and when */
    lastPlanChange: lastChange ? { what: lastChange.note.split(' — ')[0].replace(/ \(.*\)$/, ''), at: lastChange.createdAt } : null,
    hasSubscription: Boolean(user.dodoSubscriptionId || user.rzSubscriptionId),
    /** who bills the plan: Dodo, or Razorpay for people who subscribed before the move */
    billedBy: user.dodoSubscriptionId ? ('dodo' as const) : user.rzSubscriptionId ? ('razorpay' as const) : null,
    /** a renewal payment failed: the plan stays for a few days while the person updates their card / UPI */
    paymentProblem: Boolean(user.dodoSubscriptionId) && (user.subscriptionStatus === 'on_hold' || user.subscriptionStatus === 'past_due'),
    /** Dodo's customer portal (card / UPI mandate, invoices) */
    canManageBilling: Boolean(user.dodoCustomerId) && dodoReady(),
    credits: {
      perClip: CREDITS_PER_CLIP,
      balance,
      monthly: plan.credits,
      usedThisMonth,
      grants: grants.map((g) => ({ source: g.source, remaining: g.remaining, expiresAt: g.expiresAt })),
    },
    paymentsReady: dodoReady(),
    /** Dodo test mode: checkouts take test cards only, no real money moves */
    testMode: dodoReady() && config.dodoMode === 'test',
  };
}

export const creditHistory = async (user: UserRow, limit = 100) => await credits.history(user.id, limit);

/** The full credit history page: filtered, a page at a time, with the project each line was for. */
export async function creditHistoryPage(user: UserRow, o: { type?: 'all' | 'added' | 'used' | 'refunds' | 'plan'; days?: number; before?: number; q?: string }) {
  const since = o.days ? Date.now() - o.days * DAY : undefined;
  const page = await credits.historyPage(user.id, { type: o.type, since, before: o.before, q: o.q, limit: 40 });
  const titles = await projectTitles(page.items.map((e) => e.projectId));
  return { ...page, items: page.items.map((e) => ({ ...e, project: e.projectId ? (titles.get(e.projectId) ?? null) : null })) };
}

async function projectTitles(ids: (string | null)[]) {
  const out = new Map<string, { id: string; title: string; exists: boolean }>();
  for (const id of new Set(ids.filter((x): x is string => Boolean(x)))) {
    const p = await projects.get(id).catch(() => null);
    out.set(id, { id, title: p?.title || 'Untitled video', exists: Boolean(p) });
  }
  return out;
}

/**
 * Where the credits went over the last `days` days: added / used / given back, used per day (in the person's own
 * time zone, `tzOffset` minutes as the browser's getTimezoneOffset()), and which videos used the most.
 */
export async function creditUsage(user: UserRow, days: number, tzOffset = 0) {
  days = Math.min(365, Math.max(7, Math.round(days)));
  const local = (t: number) => t - tzOffset * 60_000;
  const todayStart = Math.floor(local(Date.now()) / DAY) * DAY; // local midnight, as a "local clock" time
  const firstDay = todayStart - (days - 1) * DAY;
  const since = firstDay + tzOffset * 60_000;
  const events = await credits.eventsSince(user.id, since);
  const daily = Array.from({ length: days }, (_, i) => ({ day: new Date(firstDay + i * DAY).toISOString().slice(0, 10), used: 0, added: 0 }));
  let added = 0;
  let used = 0;
  let refunded = 0;
  const perProject = new Map<string, number>();
  for (const e of events) {
    const i = Math.floor((local(e.createdAt) - firstDay) / DAY);
    const bucket = daily[i];
    if ((e.kind === 'spend' || e.kind === 'adjust') && e.delta < 0) {
      if (e.kind === 'spend' && e.refunded) continue; // given back in full: not used
      used += -e.delta;
      if (bucket) bucket.used += -e.delta;
      if (e.kind === 'spend' && e.projectId) perProject.set(e.projectId, (perProject.get(e.projectId) ?? 0) + -e.delta);
    } else if (e.kind === 'refund') refunded += e.delta;
    else if (e.delta > 0) {
      added += e.delta;
      if (bucket) bucket.added += e.delta;
    }
  }
  const top = [...perProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const titles = await projectTitles(top.map(([id]) => id));
  return {
    days,
    totals: { added, used, refunded, clips: Math.floor(used / CREDITS_PER_CLIP) },
    daily,
    projects: top.map(([id, n]) => ({ ...titles.get(id)!, used: n, clips: Math.floor(n / CREDITS_PER_CLIP) })),
  };
}
export const paymentHistory = async (user: UserRow) => await payments.forUser(user.id);

/** A receipt for one of this user's payments: what was bought, by whom, from whom. */
export async function receipt(user: UserRow, paymentId: string) {
  const payment = await payments.get(user.id, paymentId);
  if (!payment) throw new HttpError(404, 'We couldn’t find that payment on your account.');
  const item =
    payment.kind === 'topup'
      ? `Credit top-up — ${TOPUP.credits} credits`
      : `${planOf(payment.plan).name} plan — monthly subscription (${planOf(payment.plan).credits} credits)`;
  return { payment, item, customer: { name: user.name, email: user.email }, seller: site(), provider: payment.provider ?? 'razorpay' };
}

// ---------------- limits ----------------

export function assertVideosPerProject(user: UserRow, count: number) {
  const plan = planOf(user.plan);
  if (count > plan.maxVideosPerProject)
    throw new HttpError(403, `The ${plan.name} plan holds up to ${plan.maxVideosPerProject} videos per project. Remove some links or upgrade for up to ${PLANS.pro.maxVideosPerProject}.`);
}

export function assertCanSchedule(user: UserRow) {
  if (!planOf(user.plan).scheduling) throw new HttpError(403, 'Scheduling posts is on the Creator and Pro plans. You can still post right now.');
}

export function assertAutopilot(user: UserRow) {
  if (!planOf(user.plan).autopilot) throw new HttpError(403, 'Autopilot is on the Pro plan.');
}

/** What a Free user sees when they try a YouTube link (or YouTube in Explore). */
export const YOUTUBE_LOCKED = 'YouTube links aren’t supported right now. Please upload the video file, or provide a Google Drive or Dropbox link.';

export function assertYoutubeSource(user: UserRow) {
  if (!planOf(user.plan).youtubeSource) throw new HttpError(403, YOUTUBE_LOCKED);
}

export function assertCustomLogo(user: UserRow) {
  if (!planOf(user.plan).customLogo) throw new HttpError(403, 'Your own logo is on the Creator and Pro plans.');
}

/**
 * Before starting work: enough credits for `clips` clips (5 each)? Clear message if not, so the person can ask for
 * fewer clips, top up or upgrade.
 */
export async function assertHasCredits(user: UserRow, clips = 1) {
  const fresh = await refreshAccount(user);
  const need = creditsForClips(Math.max(1, clips));
  const have = await credits.balance(fresh.id);
  if (have >= need) return;
  if (have < CREDITS_PER_CLIP) throw new HttpError(402, 'You’ve used all your credits. Buy a top-up or upgrade your plan to keep clipping.');
  throw new HttpError(
    402,
    `${clips} clips need ${need} credits (${CREDITS_PER_CLIP} per clip) and you have ${have} — enough for ${Math.floor(have / CREDITS_PER_CLIP)}. Ask for fewer clips, buy a top-up or upgrade.`,
  );
}

/** How the owner's plan changes rendering. */
export async function renderRules(userId: string | null) {
  const plan = planOf(userId ? (await users.get(userId))?.plan : 'free');
  return { crestclipWatermark: plan.crestclipWatermark, customLogo: plan.customLogo, exportHeight: plan.exportHeight };
}

// ---------------- charging for clips ----------------

const clipWord = (n: number) => `${n} clip${n === 1 ? '' : 's'}`;

/**
 * Take the credits for a project's clips up front (5 per clip asked for — once; a project already charged is
 * skipped). `seconds` is the video length, checked against the plan's limit. After the clips are found,
 * settleProject() gives back the credits for any clips that didn't come out. Throws BillingError when the person
 * needs to upgrade or top up.
 */
export async function chargeProject(projectId: string, seconds: number, what: string, clips?: number) {
  const p = await projects.get(projectId);
  if (!p?.userId || p.creditsCharged > 0) return;
  const owner = await users.get(p.userId);
  if (!owner) return;
  const user = await refreshAccount(owner);
  const plan = planOf(user.plan);
  if (seconds > plan.maxVideoMinutes * 60) {
    const next = plan.id === 'free' ? PLANS.creator : PLANS.pro;
    throw new BillingError(
      'plan_limit',
      `This video is ${Math.round(seconds / 60)} min long. The ${plan.name} plan clips videos up to ${plan.maxVideoMinutes} min${plan.id !== 'pro' ? ` — ${next.name} goes up to ${next.maxVideoMinutes >= 120 ? `${next.maxVideoMinutes / 60} hours` : `${next.maxVideoMinutes} min`}` : ''}.`,
    );
  }
  const n = Math.max(1, clips ?? p.options.clipCount ?? 1);
  const need = creditsForClips(n);
  try {
    await credits.spend(user.id, need, `${what} · ${clipWord(n)}`, p.id);
  } catch (e) {
    if (e instanceof NotEnoughCredits)
      throw new BillingError('credits', `Not enough credits: ${clipWord(n)} need ${e.needed} (${CREDITS_PER_CLIP} per clip) and you have ${e.have}. Buy a top-up or upgrade, then press Retry.`);
    throw e;
  }
  await projects.update(p.id, { creditsCharged: need });
}

/** The clips are made: keep 5 credits per clip that came out, give back the rest. */
export async function settleProject(projectId: string, made: number, what: string) {
  const p = await projects.get(projectId);
  if (!p || p.creditsCharged <= 0) return;
  const keep = creditsForClips(made);
  if (keep >= p.creditsCharged) return;
  const ev = await credits.lastSpendFor(p.id);
  if (ev) await credits.reduceSpend(ev, keep, `${what} · ${clipWord(made)}`);
  await projects.update(p.id, { creditsCharged: keep });
}

/** A project failed: give its credits back (so Retry can charge again). */
export async function refundProject(projectId: string) {
  const p = await projects.get(projectId);
  if (!p || p.creditsCharged <= 0) return;
  const ev = await credits.lastSpendFor(p.id);
  if (ev) await credits.refund(ev, `Refund · ${p.title ?? 'video'} didn’t finish`);
  await projects.update(p.id, { creditsCharged: 0 });
}

/** Clips added by hand from the rewatch graph: 5 credits each. Returns the spend (to refund or settle). */
export async function chargeClips(userId: string, projectId: string, clips: number, what: string) {
  const owner = await users.get(userId);
  if (!owner) return null;
  const user = await refreshAccount(owner);
  try {
    return await credits.spend(user.id, creditsForClips(clips), `${what} · ${clipWord(clips)}`, projectId);
  } catch (e) {
    if (e instanceof NotEnoughCredits) throw new HttpError(402, `Not enough credits: ${clipWord(clips)} need ${e.needed} (${CREDITS_PER_CLIP} per clip) and you have ${e.have}.`);
    throw e;
  }
}

// ---------------- paying (Dodo Payments checkout) ----------------

function needPayments() {
  if (!dodoReady()) throw new HttpError(503, 'Payments aren’t set up yet. Add the Dodo Payments settings (see README → Plans, credits & payments).');
}

/** Dodo's own message, in a form the person can act on. */
function explainDodoError(e: unknown): never {
  if (e instanceof DodoError) {
    console.warn('[billing]', e.message);
    if (e.status === 401 || e.status === 403) throw new HttpError(503, 'Payments are temporarily unavailable. Please try again later.');
    throw new HttpError(502, e.message.replace(/^Dodo Payments: /, 'The payment provider said: '));
  }
  throw e;
}

/** The person's customer record in Dodo (made once, kept on the account). */
async function ensureCustomer(user: UserRow): Promise<string> {
  if (user.dodoCustomerId) return user.dodoCustomerId;
  const c = await dodo.createCustomer(user.email, user.name, { user_id: user.id }).catch(explainDodoError);
  return await users.claimDodoCustomer(user.id, c.customer_id);
}

const returnUrl = (what: 'plan' | 'topup') => `${config.publicUrl}/app/billing?checkout=${what}`;
/** Statuses where the subscription still bills (a plan change works on it). */
const billing = (status: string | null) => status === 'active' || status === 'on_hold' || status === 'past_due';

export type CheckoutResult =
  /** open this Dodo checkout page */
  | { url: string }
  /** done without a checkout (an upgrade charged to the saved card / mandate, or a plan that was ending resumed) */
  | { changed: true; pending: boolean };

/**
 * Start paying for a plan. No subscription yet → a Dodo checkout page. Already subscribing → the subscription
 * itself moves to the bigger plan (the difference for the rest of the month is charged to the saved card / UPI
 * mandate), so the person never pays for two plans at once.
 */
export async function startSubscription(user: UserRow, planId: PlanId): Promise<CheckoutResult> {
  needPayments();
  const plan = PLANS[planId];
  if (!plan || plan.id === 'free') throw new HttpError(400, 'Pick a paid plan.');
  const current = planOf(user.plan);
  const subscribed = Boolean(user.dodoSubscriptionId) && billing(user.subscriptionStatus);
  if (user.plan === plan.id && subscribed && user.cancelAtPeriodEnd) {
    await resumePlan(user);
    return { changed: true, pending: false };
  }
  if (user.plan === plan.id && (subscribed || user.rzSubscriptionId) && !user.cancelAtPeriodEnd) throw new HttpError(409, `You’re already on ${plan.name}.`);
  // Only upgrades: a lower plan isn't offered while a higher one is paid for (it already includes everything). One
  // that's ending can be followed by a lower plan only after it ends — never by moving down mid-month (that would
  // refund part of the month while keeping the bigger plan's credits).
  if (rank(plan.id) < rank(current.id)) {
    if (user.cancelAtPeriodEnd && (subscribed || user.rzSubscriptionId))
      throw new HttpError(409, `${current.name} stays active until ${user.cycleEnd ? new Date(user.cycleEnd).toDateString() : 'the end of this month'}. You can pick ${plan.name} after that.`);
    if (!user.cancelAtPeriodEnd) throw new HttpError(409, `You’re on ${current.name}, which already includes everything in ${plan.name}.`);
  }

  if (subscribed && user.dodoSubscriptionId) {
    if (user.subscriptionStatus !== 'active') throw new HttpError(409, 'Your last payment didn’t go through. Update your payment method (Manage billing) first, then upgrade.');
    const subId = user.dodoSubscriptionId;
    const wasEnding = user.cancelAtPeriodEnd;
    let sub: DodoSubscription | null = null;
    try {
      if (wasEnding) await dodo.updateSubscription(subId, { cancel_at_next_billing_date: false }).catch(explainDodoError);
      await dodo.changePlan(subId, productForPlan(plan.id)).catch(explainDodoError);
      // Dodo charges the difference and then switches the plan — usually within ~15 s. Wait for it (up to 30 s) so
      // the person sees the new plan right away; after that the webhook / next check finishes it.
      for (let i = 0; i < 15; i++) {
        sub = await dodo.subscription(subId).catch(explainDodoError);
        if (planOfDodo(sub) === plan.id || !billing(sub.status)) break;
        await new Promise((r) => setTimeout(r, config.dodoApiUrl ? 50 : 2000));
      }
    } finally {
      // the upgrade didn't happen: a plan that was ending must stay ending (they mustn't be charged for it again)
      if (wasEnding && !(sub && planOfDodo(sub) === plan.id)) {
        sub = await dodo.updateSubscription(subId, { cancel_at_next_billing_date: true }).catch((e) => {
          console.warn(`[billing] ${user.email}: couldn't put the cancellation back:`, (e as Error).message);
          return sub;
        });
      }
    }
    const moved = planOfDodo(sub!) === plan.id;
    await syncDodo(user, sub!);
    if (moved) await recordSubscriptionPayments(user.id, sub!); // the difference, when Dodo has charged it already (else: webhook)
    console.log(`[billing] ${user.email}: ${current.name} → ${plan.name} (plan change${moved ? '' : ' requested, waiting for the payment'})`);
    return { changed: true, pending: !moved };
  }

  // a new subscription (an old Razorpay one is cancelled once this one is paid)
  const customerId = await ensureCustomer(user);
  const session = await dodo
    .createCheckout({ productId: productForPlan(plan.id), customerId, returnUrl: returnUrl('plan'), metadata: { user_id: user.id, plan: plan.id, kind: 'subscription' } })
    .catch(explainDodoError);
  return { url: session.checkout_url };
}

/** Start buying a credit pack: a Dodo checkout page. */
export async function startTopup(user: UserRow): Promise<CheckoutResult> {
  needPayments();
  const customerId = await ensureCustomer(user);
  const session = await dodo.createCheckout({ productId: config.dodoProductTopup, customerId, returnUrl: returnUrl('topup'), metadata: { user_id: user.id, kind: 'topup' } }).catch(explainDodoError);
  return { url: session.checkout_url };
}

/** Is this Dodo object this person's? (Our own metadata first; the customer id as a fallback.) */
const isMine = (user: UserRow, o: { metadata?: Record<string, string> | null; customer?: { customer_id: string } | null }) =>
  o.metadata?.user_id ? o.metadata.user_id === user.id : Boolean(user.dodoCustomerId && o.customer?.customer_id === user.dodoCustomerId);

/** A paid credit pack (not refunded — a refund made before CrestClip ever saw the payment adds nothing). */
const isTopup = (pay: DodoPayment) =>
  !pay.subscription_id && !pay.refund_status && (pay.metadata?.kind === 'topup' || Boolean(pay.product_cart?.some((i) => i.product_id === config.dodoProductTopup)));

/**
 * A paid subscription that isn't the person's plan yet becomes it. It replaces an older one (cancelled right away, so
 * they're never billed twice) — but an OLDER subscription never replaces a newer one, whatever order events arrive in.
 */
async function adoptDodo(user: UserRow, sub: DodoSubscription): Promise<boolean> {
  if (sub.status !== 'active' || !planOfDodo(sub) || user.dodoSubscriptionId === sub.subscription_id) return false;
  if (user.dodoSubscriptionId) {
    const old = await dodo.subscription(user.dodoSubscriptionId).catch(() => null);
    if (old && billing(old.status)) {
      if ((ms(old.created_at) ?? 0) > (ms(sub.created_at) ?? 0)) {
        // two paid at once (two checkout tabs): keep the newer, end the older so it never renews next to it
        console.warn(`[billing] ${user.email}: two Dodo subscriptions were active — kept ${old.subscription_id}, cancelled the older ${sub.subscription_id} (refund its first payment in the Dodo dashboard if needed)`);
        await dodo.updateSubscription(sub.subscription_id, { status: 'cancelled' }).catch((e) => console.warn('[billing] cancel older Dodo subscription:', (e as Error).message));
        return false;
      }
      await dodo.updateSubscription(old.subscription_id, { status: 'cancelled' }).catch((e) => console.warn('[billing] old Dodo subscription cancel:', (e as Error).message));
    }
  }
  if (user.rzSubscriptionId && razorpayReady())
    await razorpay.cancelSubscription(user.rzSubscriptionId, false).catch((e) => console.warn('[billing] old Razorpay subscription cancel:', (e as Error).message));
  console.log(`[billing] ${user.email}: ${planOf(user.plan).name} → ${PLANS[planOfDodo(sub)!].name} (Dodo ${sub.subscription_id})`);
  await users.update(user.id, {
    dodoSubscriptionId: sub.subscription_id,
    dodoCustomerId: user.dodoCustomerId ?? sub.customer.customer_id,
    rzSubscriptionId: null,
    pendingSubscriptionId: null,
  });
  const fresh = (await users.get(user.id))!;
  await syncDodo(fresh, sub);
  await recordSubscriptionPayments(fresh.id, sub);
  return true;
}

/** Save the payments behind a subscription (the first one, renewals, an upgrade's difference) — each once. */
async function recordSubscriptionPayments(userId: string, sub: DodoSubscription) {
  const list = await dodo.paymentsOf({ subscription_id: sub.subscription_id }).catch((e) => {
    console.warn('[billing] list subscription payments:', (e as Error).message);
    return [] as DodoPayment[];
  });
  for (const pay of list) if (pay.status === 'succeeded') await recordPayment(userId, pay, planOfDodo(sub));
}

const recordPayment = (userId: string, pay: DodoPayment, plan: PlanId | null) =>
  payments.record({
    id: pay.payment_id,
    userId,
    kind: pay.subscription_id ? 'subscription' : 'topup',
    // the plan this payment was for (an older Creator payment stays "Creator" after an upgrade)
    plan: pay.subscription_id ? (planForProduct(pay.product_cart?.[0]?.product_id) ?? plan) : null,
    amount: pay.total_amount,
    currency: pay.currency,
    ref: pay.subscription_id ?? null,
    provider: 'dodo',
    invoiceUrl: pay.invoice_url ?? null,
    at: ms(pay.created_at),
  });

async function addTopup(userId: string, pay: DodoPayment) {
  await recordPayment(userId, pay, null);
  await credits.grant(userId, {
    amount: TOPUP.credits,
    source: 'topup',
    expiresAt: (ms(pay.created_at) ?? Date.now()) + TOPUP.validDays * DAY,
    ref: `topup_${pay.payment_id}`,
    note: `Top-up · ${TOPUP.credits} credits`,
  });
}

/**
 * Back from the Dodo checkout page (Dodo adds subscription_id / payment_id and status to our return link): look the
 * payment up with Dodo — the link itself proves nothing — and apply it. `pending` = not paid yet (e.g. a UPI
 * payment still being approved); the webhook or the next look finishes it.
 */
export async function confirmCheckout(user: UserRow, r: { subscriptionId?: string; paymentId?: string }) {
  needPayments();
  let pending = true;
  if (r.subscriptionId) {
    const sub = await dodo.subscription(r.subscriptionId).catch(explainDodoError);
    if (!isMine(user, sub)) throw new HttpError(403, 'That subscription belongs to another account.');
    if (sub.status === 'active') {
      if (user.dodoSubscriptionId !== sub.subscription_id) await adoptDodo(user, sub);
      const now = (await users.get(user.id))!;
      // pending until its payment shows up at Dodo with the credits added (the page asks again for a while)
      pending = now.dodoSubscriptionId === sub.subscription_id ? !(await syncDodo(now, sub)) : false;
    }
  } else if (r.paymentId) {
    const pay = await dodo.payment(r.paymentId).catch(explainDodoError);
    if (!isMine(user, pay)) throw new HttpError(403, 'That payment belongs to another account.');
    if (pay.subscription_id) return confirmCheckout(user, { subscriptionId: pay.subscription_id });
    if (pay.status === 'succeeded' && isTopup(pay)) {
      await addTopup(user.id, pay);
      pending = false;
    }
  } else throw new HttpError(400, 'Missing payment details.');
  return { user: (await users.get(user.id))!, pending };
}

const lastScan = new Map<string, number>();

/**
 * Plan-change lines for subscriptions from before the history recorded them (started, upgraded, ended), at the
 * times Dodo has for them. Runs only while the person has no plan lines at all, so it happens once.
 */
async function backfillPlanHistory(userId: string, subs: DodoSubscription[], pays: DodoPayment[]) {
  if ((await credits.lastPlanEvent(userId)) || !subs.length) return;
  for (const sub of subs) {
    const paid = pays.filter((p) => p.subscription_id === sub.subscription_id && p.status === 'succeeded').sort((a, b) => (ms(a.created_at) ?? 0) - (ms(b.created_at) ?? 0));
    const now = planOfDodo(sub);
    if (!paid.length || !now) continue; // never paid (declined checkout): nothing happened
    const first = (sub.metadata?.plan && sub.metadata.plan in PLANS && sub.metadata.plan !== 'free' ? sub.metadata.plan : now) as PlanId;
    await credits.planEvent(userId, `Started the ${PLANS[first].name} plan`, ms(paid[0].created_at) ?? ms(sub.created_at)!);
    if (first !== now && paid[1]) await credits.planEvent(userId, rank(now) > rank(first) ? `Upgraded to ${PLANS[now].name}` : `Switched to ${PLANS[now].name}`, ms(paid[1].created_at)!);
    if (sub.status === 'cancelled' || sub.status === 'expired' || sub.status === 'failed')
      await credits.planEvent(userId, `${PLANS[now].name} ended — you’re on Free now. Credits you have stay until they expire.`, ms(sub.cancelled_at) ?? Date.now());
    else if (sub.cancel_at_next_billing_date) await credits.planEvent(userId, `${PLANS[now].name} cancelled — stays active until ${day(ms(sub.next_billing_date))}, then Free`, Date.now());
  }
}

/**
 * Catch up with Dodo without webhooks (local runs, a webhook that never arrived): a subscription paid for but not
 * adopted yet, a renewal, a top-up paid after the tab was closed. At most every 2 minutes per person.
 */
export async function reconcileSubscriptions(user: UserRow, opts: { soon?: boolean } = {}): Promise<UserRow> {
  if (!dodoReady() || !user.dodoCustomerId) return user;
  // `soon`: the page is waiting for a payment to land (asks every few seconds) — look at most every 10 s then
  if (!due(lastScan, user.id, opts.soon ? 10_000 : 2 * 60_000)) return user;
  try {
    const subs = (await dodo.subscriptionsOf(user.dodoCustomerId)).filter((s) => isMine(user, s));
    const current = subs.find((s) => s.subscription_id === user.dodoSubscriptionId);
    if (current) await syncDodo(user, current);
    const newest = subs.filter((s) => s.status === 'active' && s.subscription_id !== user.dodoSubscriptionId).sort((a, b) => (ms(b.created_at) ?? 0) - (ms(a.created_at) ?? 0))[0];
    if (newest) await adoptDodo((await users.get(user.id))!, newest);
    const customerPays = await dodo.paymentsOf({ customer_id: user.dodoCustomerId });
    await backfillPlanHistory(user.id, subs, customerPays);
    for (const pay of customerPays) {
      if (pay.status !== 'succeeded' || !isMine(user, pay)) continue;
      if (isTopup(pay)) await addTopup(user.id, pay);
      else if (pay.subscription_id) {
        const sub = subs.find((s) => s.subscription_id === pay.subscription_id);
        await recordPayment(user.id, pay, sub ? planOfDodo(sub) : null);
      }
    }
  } catch (e) {
    console.warn(`[billing] couldn't check Dodo for ${user.email}:`, (e as Error).message);
  }
  return (await users.get(user.id))!;
}

/** Stop renewing: the plan stays until the paid month ends, then it's Free. */
export async function cancelPlan(user: UserRow) {
  if (user.plan === 'free') throw new HttpError(400, 'You’re on the Free plan.');
  if (user.dodoSubscriptionId) {
    needPayments();
    const sub = await dodo.updateSubscription(user.dodoSubscriptionId, { cancel_at_next_billing_date: true }).catch(explainDodoError);
    if (sub?.subscription_id) await syncDodo(user, sub);
  } else if (user.rzSubscriptionId) {
    if (!razorpayReady()) throw new HttpError(503, 'Your plan is billed through Razorpay, which isn’t connected right now. Please contact support to cancel.');
    await razorpay.cancelSubscription(user.rzSubscriptionId, true);
    await logPlan(user.id, `${planOf(user.plan).name} cancelled — stays active until ${day(user.cycleEnd)}, then Free`);
  }
  await users.update(user.id, { cancelAtPeriodEnd: true });
  console.log(`[billing] ${user.email}: cancelled ${planOf(user.plan).name} (ends at the end of the month)`);
  return (await users.get(user.id))!;
}

/** Changed their mind: keep renewing. */
export async function resumePlan(user: UserRow): Promise<UserRow> {
  if (!user.dodoSubscriptionId || !user.cancelAtPeriodEnd) throw new HttpError(400, user.rzSubscriptionId ? 'A cancelled Razorpay plan can’t be resumed — pick a plan again below.' : 'Your plan isn’t ending.');
  needPayments();
  const sub = await dodo.updateSubscription(user.dodoSubscriptionId, { cancel_at_next_billing_date: false }).catch(explainDodoError);
  if (sub?.subscription_id) await syncDodo(user, sub);
  else await users.update(user.id, { cancelAtPeriodEnd: false });
  console.log(`[billing] ${user.email}: resumed ${planOf(user.plan).name}`);
  return (await users.get(user.id))!;
}

/** Dodo's customer portal: update the card / UPI mandate, download invoices. */
export async function billingPortal(user: UserRow) {
  needPayments();
  if (!user.dodoCustomerId) throw new HttpError(400, 'There’s nothing to manage yet — you haven’t paid through Dodo Payments.');
  return { url: await dodo.portal(user.dodoCustomerId).catch(explainDodoError) };
}

// ---------------- webhooks (renewals, failed payments, payments made after the tab was closed) ----------------

/** Whose is this subscription / payment? The subscription id, then our own metadata, then the Dodo customer. */
async function userForDodo(o: { subscriptionId?: string | null; metadata?: Record<string, string> | null; customerId?: string | null }) {
  return (
    (o.subscriptionId ? await users.bySubscription(o.subscriptionId) : null) ??
    (o.metadata?.user_id ? await users.get(o.metadata.user_id) : null) ??
    (o.customerId ? await users.byDodoCustomer(o.customerId) : null)
  );
}

/**
 * A Dodo webhook. The event is only a nudge: the subscription / payment is read fresh from Dodo, so events that
 * arrive twice or out of order (Dodo doesn't promise an order) can't move an account backwards.
 */
export async function handleDodoWebhook(rawBody: Buffer | undefined, h: { id: string; timestamp: string; signature: string }) {
  if (!rawBody || !validDodoWebhook(rawBody, h)) throw new HttpError(401, 'Bad signature');
  const ev = JSON.parse(rawBody.toString('utf8')) as DodoEvent;
  const d = ev.data as { payload_type?: string; subscription_id?: string; payment_id?: string };
  if (!dodoReady()) return;
  // an id Dodo itself no longer knows (deleted test data…): nothing to do — answer 200 so Dodo stops retrying
  const gone = (e: unknown) => {
    if (e instanceof DodoError && e.status === 404) return null;
    throw e;
  };
  if (ev.type.startsWith('subscription.') && d.subscription_id) {
    const sub = await dodo.subscription(d.subscription_id).catch(gone);
    if (!sub) return void console.warn(`[billing] Dodo ${ev.type}: subscription ${d.subscription_id} not found`);
    const user = await userForDodo({ subscriptionId: sub.subscription_id, metadata: sub.metadata, customerId: sub.customer?.customer_id });
    if (!user) return void console.warn(`[billing] Dodo ${ev.type}: no account for subscription ${sub.subscription_id}`);
    if (user.dodoSubscriptionId !== sub.subscription_id) {
      if (sub.status === 'active') await adoptDodo(user, sub);
      return;
    }
    await syncDodo(user, sub);
    if (sub.status === 'active') await recordSubscriptionPayments(user.id, sub);
    return;
  }
  if (ev.type === 'payment.succeeded' && d.payment_id) {
    const pay = await dodo.payment(d.payment_id).catch(gone);
    if (!pay || pay.status !== 'succeeded') return;
    const user = await userForDodo({ subscriptionId: pay.subscription_id, metadata: pay.metadata, customerId: pay.customer?.customer_id });
    if (!user) return void console.warn(`[billing] Dodo payment ${pay.payment_id}: no account for it`);
    if (isTopup(pay)) return void (await addTopup(user.id, pay));
    if (pay.subscription_id) {
      const sub = await dodo.subscription(pay.subscription_id);
      if (user.dodoSubscriptionId !== sub.subscription_id) await adoptDodo(user, sub);
      else await syncDodo(user, sub); // a renewal: the new month's credits
      await recordPayment(user.id, pay, planOfDodo(sub));
    }
    return;
  }
  if (ev.type.startsWith('refund.') || ev.type.startsWith('dispute.'))
    console.warn(`[billing] Dodo ${ev.type} for payment ${(ev.data as { payment_id?: string }).payment_id ?? '?'} — check it in the Dodo dashboard; credits aren’t taken back automatically (Settings → Admin can remove them).`);
}

/** Legacy Razorpay webhooks: renewals and cancellations of subscriptions made before the move to Dodo. */
export async function handleRazorpayWebhook(rawBody: Buffer | undefined, signature: string) {
  if (!rawBody || !validWebhook(rawBody, signature)) throw new HttpError(400, 'Bad signature');
  const ev = JSON.parse(rawBody.toString('utf8')) as {
    event: string;
    payload: { subscription?: { entity: RzSubscription }; payment?: { entity: RzPayment } };
  };
  const sub = ev.payload.subscription?.entity;
  const pay = ev.payload.payment?.entity;
  if (!sub) return;
  const user = await users.bySubscription(sub.id);
  if (!user || user.rzSubscriptionId !== sub.id) return; // not (or no longer) anyone's plan
  if (pay && ev.event === 'subscription.charged')
    await payments.record({ id: pay.id, userId: user.id, kind: 'subscription', plan: planFromRazorpay(sub), amount: pay.amount, currency: pay.currency, ref: sub.id, provider: 'razorpay' });
  await syncRazorpay(user, sub);
}

// ---------------- admin ----------------

export async function adminSetPlan(userId: string, planId: PlanId) {
  const user = await users.get(userId);
  if (!user) throw new HttpError(404, 'User not found');
  if (!(planId in PLANS)) throw new HttpError(400, 'Unknown plan');
  if (user.dodoSubscriptionId) throw new HttpError(409, 'This person pays through Dodo Payments — change or cancel their subscription in the Dodo dashboard (Sales → Subscriptions).');
  if (user.rzSubscriptionId) throw new HttpError(409, 'This person pays through Razorpay — change or cancel their subscription in the Razorpay Dashboard.');
  // an admin-given plan has no subscription; it renews itself each month until changed
  await users.update(userId, { plan: planId, cancelAtPeriodEnd: false, cycleEnd: Date.now() });
  if (user.plan !== planId) await logPlan(userId, `Plan changed to ${PLANS[planId].name} by CrestClip`);
  return refreshAccount((await users.get(userId))!);
}

export async function adminAdjustCredits(userId: string, delta: number, note: string) {
  if (!(await users.get(userId))) throw new HttpError(404, 'User not found');
  await credits.adjust(userId, Math.trunc(delta), note || (delta > 0 ? 'Added by admin' : 'Removed by admin'));
}

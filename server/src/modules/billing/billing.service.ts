import { config } from '../../config.js';
import { credits, NotEnoughCredits, payments, projects, users, type PlanId, type UserRow } from '../../db/index.js';
import { HttpError } from '../../lib/http.js';
import { CREDITS_PER_CLIP, creditsForClips, CURRENCIES, HOME_CURRENCY, PLAN_ORDER, PLANS, planOf, priceIn, TOPUP, topupPriceIn, type Plan } from './plans.js';
import { chargeCurrency, shownCurrency } from './currency.js';
import {
  minorUnits,
  planForRazorpayPlan,
  razorpay,
  razorpayPlanId,
  razorpayReady,
  validOrderPayment,
  validSubscriptionPayment,
  validWebhook,
  type RzPayment,
  type RzSubscription,
} from './razorpay.js';

const DAY = 86400_000;
/** Same day next month (Jan 31 → Mar 3 is fine for a billing month). */
const nextMonth = (t: number) => {
  const d = new Date(t);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
};

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

/** Re-check a subscription with Razorpay at most this often per person (when their month has run out). */
const lastSync = new Map<string, number>();

/**
 * Keep the person's account current: start a new credit month when the old one ran out (adding that month's credits),
 * renew or end paid plans. Cheap to call often — it only does work at the turn of the month.
 */
export async function refreshAccount(user: UserRow): Promise<UserRow> {
  if (user.cycleEnd && Date.now() < user.cycleEnd) return user;
  const plan = planOf(user.plan);
  if (plan.id !== 'free' && user.rzSubscriptionId && razorpayReady()) {
    if (Date.now() - (lastSync.get(user.id) ?? 0) > 5 * 60_000) {
      lastSync.set(user.id, Date.now());
      try {
        await syncSubscription(user, await razorpay.subscription(user.rzSubscriptionId));
      } catch (e) {
        console.warn(`[billing] couldn't check subscription for ${user.email}:`, (e as Error).message);
      }
    }
    const after = users.get(user.id)!;
    return after.plan === 'free' ? refreshAccount(after) : after; // the subscription ended → start the Free month
  }
  if (plan.id !== 'free' && user.cancelAtPeriodEnd) {
    downgrade(user, 'The plan ended');
    return refreshAccount(users.get(user.id)!);
  }
  // free plan, or a plan an admin gave (no subscription): roll the month forward and add its credits
  let start = user.cycleEnd && user.cycleEnd > Date.now() - 62 * DAY ? user.cycleEnd : Date.now();
  while (nextMonth(start) <= Date.now()) start = nextMonth(start);
  const end = nextMonth(start);
  users.update(user.id, { cycleStart: start, cycleEnd: end });
  credits.grant(user.id, {
    amount: plan.credits,
    source: 'plan',
    expiresAt: plan.rollover ? nextMonth(end) : end,
    ref: `${plan.id}_${user.id}_${start}`,
    note: `${plan.name} plan · monthly credits`,
  });
  return users.get(user.id)!;
}

/** Apply what Razorpay says about a subscription: a paid month (add credits) or the end of the plan. */
function syncSubscription(user: UserRow, sub: RzSubscription, planHint?: PlanId) {
  const plan = planFromSubscription(sub) ?? planHint ?? user.plan;
  const end = sub.current_end ? sub.current_end * 1000 : null;
  if ((sub.status === 'active' || sub.status === 'authenticated') && sub.paid_count > 0 && end && end > Date.now()) {
    const p = planOf(plan);
    users.update(user.id, { plan: p.id, rzSubscriptionId: sub.id, cycleStart: (sub.current_start ?? Date.now() / 1000) * 1000, cycleEnd: end });
    credits.grant(user.id, {
      amount: p.credits,
      source: 'plan',
      expiresAt: nextMonth(end), // unused paid credits roll over one month
      ref: `sub_${sub.id}_${sub.paid_count}`,
      note: `${p.name} plan · monthly credits`,
    });
    return;
  }
  if (sub.status === 'cancelled' && end && end > Date.now()) {
    users.update(user.id, { cancelAtPeriodEnd: true }); // paid until the end of this month
    return;
  }
  if (['cancelled', 'completed', 'expired', 'halted'].includes(sub.status)) downgrade(user, sub.status === 'halted' ? 'Payments failed' : 'The plan ended');
  // 'pending' = Razorpay is retrying a failed renewal: keep the plan, add credits once it's paid
}

function planFromSubscription(sub: RzSubscription): PlanId | null {
  if (sub.notes?.plan && sub.notes.plan in PLANS) return sub.notes.plan as PlanId;
  return planForRazorpayPlan(sub.plan_id, CURRENCIES)?.plan ?? null;
}

/** The currency a subscription charges in (from its Razorpay plan; noted when it was made). */
const currencyOf = (sub: RzSubscription) => sub.notes?.currency || planForRazorpayPlan(sub.plan_id, CURRENCIES)?.currency || HOME_CURRENCY;

/** Back to Free (credits already paid for stay until they expire). */
function downgrade(user: UserRow, why: string) {
  console.log(`[billing] ${user.email}: ${planOf(user.plan).name} → Free (${why})`);
  users.update(user.id, { plan: 'free', rzSubscriptionId: null, cancelAtPeriodEnd: false, cycleEnd: Date.now() });
}

// ---------------- what the app shows ----------------

/**
 * A plan as the app shows it: price in the person's currency. When a payment would be made in another currency
 * (USD shown, but Razorpay can only charge INR yet), chargePrice/chargeCurrency say what's actually charged.
 */
export function publicPlan(p: Plan, shown = HOME_CURRENCY) {
  const charged = chargeCurrency(shown);
  return {
    ...p,
    price: priceIn(p.id, shown),
    currency: shown,
    ...(charged !== shown && p.id !== 'free' ? { chargePrice: priceIn(p.id, charged), chargeCurrency: charged } : {}),
    clips: Math.floor(p.credits / CREDITS_PER_CLIP),
  };
}

/** The credit pack, priced the same way. */
export function publicTopup(shown = HOME_CURRENCY) {
  const charged = chargeCurrency(shown);
  return { ...TOPUP, price: topupPriceIn(shown), ...(charged !== shown ? { chargePrice: topupPriceIn(charged), chargeCurrency: charged } : {}) };
}

export function accountSummary(user: UserRow, hint: string | null = null) {
  const plan = planOf(user.plan);
  const shown = shownCurrency(user, hint);
  return {
    plan: publicPlan(plan, shown),
    currency: shown,
    topup: publicTopup(shown),
    cycleStart: user.cycleStart,
    cycleEnd: user.cycleEnd,
    cancelAtPeriodEnd: user.cancelAtPeriodEnd,
    hasSubscription: Boolean(user.rzSubscriptionId),
    credits: {
      perClip: CREDITS_PER_CLIP,
      balance: credits.balance(user.id),
      monthly: plan.credits,
      usedThisMonth: user.cycleStart ? credits.spentSince(user.id, user.cycleStart) : 0,
      grants: credits.liveGrants(user.id).map((g) => ({ source: g.source, remaining: g.remaining, expiresAt: g.expiresAt })),
    },
    paymentsReady: razorpayReady(),
  };
}

export const creditHistory = (user: UserRow) => credits.history(user.id);
export const paymentHistory = (user: UserRow) => payments.forUser(user.id);

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
  const have = credits.balance(fresh.id);
  if (have >= need) return;
  if (have < CREDITS_PER_CLIP) throw new HttpError(402, 'You’ve used all your credits. Buy a top-up or upgrade your plan to keep clipping.');
  throw new HttpError(
    402,
    `${clips} clips need ${need} credits (${CREDITS_PER_CLIP} per clip) and you have ${have} — enough for ${Math.floor(have / CREDITS_PER_CLIP)}. Ask for fewer clips, buy a top-up or upgrade.`,
  );
}

/** How the owner's plan changes rendering. */
export function renderRules(userId: string | null) {
  const plan = planOf(userId ? users.get(userId)?.plan : 'free');
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
  const p = projects.get(projectId);
  if (!p?.userId || p.creditsCharged > 0) return;
  const owner = users.get(p.userId);
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
    credits.spend(user.id, need, `${what} · ${clipWord(n)}`, p.id);
  } catch (e) {
    if (e instanceof NotEnoughCredits)
      throw new BillingError('credits', `Not enough credits: ${clipWord(n)} need ${e.needed} (${CREDITS_PER_CLIP} per clip) and you have ${e.have}. Buy a top-up or upgrade, then press Retry.`);
    throw e;
  }
  projects.update(p.id, { creditsCharged: need });
}

/** The clips are made: keep 5 credits per clip that came out, give back the rest. */
export function settleProject(projectId: string, made: number, what: string) {
  const p = projects.get(projectId);
  if (!p || p.creditsCharged <= 0) return;
  const keep = creditsForClips(made);
  if (keep >= p.creditsCharged) return;
  const ev = credits.lastSpendFor(p.id);
  if (ev) credits.reduceSpend(ev, keep, `${what} · ${clipWord(made)}`);
  projects.update(p.id, { creditsCharged: keep });
}

/** A project failed: give its credits back (so Retry can charge again). */
export function refundProject(projectId: string) {
  const p = projects.get(projectId);
  if (!p || p.creditsCharged <= 0) return;
  const ev = credits.lastSpendFor(p.id);
  if (ev) credits.refund(ev, `Refund · ${p.title ?? 'video'} didn’t finish`);
  projects.update(p.id, { creditsCharged: 0 });
}

/** Clips added by hand from the rewatch graph: 5 credits each. Returns the spend (to refund or settle). */
export async function chargeClips(userId: string, projectId: string, clips: number, what: string) {
  const owner = users.get(userId);
  if (!owner) return null;
  const user = await refreshAccount(owner);
  try {
    return credits.spend(user.id, creditsForClips(clips), `${what} · ${clipWord(clips)}`, projectId);
  } catch (e) {
    if (e instanceof NotEnoughCredits) throw new HttpError(402, `Not enough credits: ${clipWord(clips)} need ${e.needed} (${CREDITS_PER_CLIP} per clip) and you have ${e.have}.`);
    throw e;
  }
}

// ---------------- paying (Razorpay Checkout) ----------------

function needPayments() {
  if (!razorpayReady()) throw new HttpError(503, 'Payments aren’t set up yet. Add the Razorpay keys to .env (see README → Plans, credits & payments).');
}

/** Start paying for a plan: a Razorpay subscription the browser opens in Checkout. */
export async function startSubscription(user: UserRow, planId: PlanId, hint: string | null = null) {
  needPayments();
  const plan = PLANS[planId];
  if (!plan || plan.id === 'free') throw new HttpError(400, 'Pick a paid plan.');
  // the currency they already pay in, or (first payment) the one for where they are
  const currency = user.billingCurrency ?? chargeCurrency(shownCurrency(user, hint));
  const rzPlan = razorpayPlanId(plan.id, currency);
  if (!rzPlan)
    throw new HttpError(
      503,
      `The ${plan.name} plan isn’t set up in Razorpay for ${currency} yet (RAZORPAY_PLAN_${plan.id.toUpperCase()}${currency === config.currency ? '' : `_${currency}`} in .env).`,
    );
  if (user.plan === plan.id && user.rzSubscriptionId && !user.cancelAtPeriodEnd) throw new HttpError(409, `You’re already on ${plan.name}.`);
  // Only upgrades: a lower plan isn't offered while a higher one is active (it already includes everything).
  if (PLAN_ORDER.indexOf(plan.id) < PLAN_ORDER.indexOf(planOf(user.plan).id) && !user.cancelAtPeriodEnd)
    throw new HttpError(409, `You’re on ${planOf(user.plan).name}, which already includes everything in ${plan.name}.`);
  const sub = await razorpay.createSubscription(rzPlan, { user_id: user.id, plan: plan.id, email: user.email, currency });
  users.update(user.id, { pendingSubscriptionId: sub.id }); // found again later even if Checkout never reports back
  return { key: config.razorpayKeyId, subscriptionId: sub.id, plan: plan.id, description: `${plan.name} plan · ${Math.floor(plan.credits / CREDITS_PER_CLIP)} clips a month` };
}

const isPaid = (s: RzSubscription) => (s.status === 'active' || s.status === 'authenticated') && s.paid_count > 0;

/**
 * A paid subscription becomes the person's plan: the one it replaces is cancelled (so they're never billed twice),
 * the payment is recorded and the month's credits are added (once — safe to call again for the same payment).
 */
async function adoptSubscription(user: UserRow, sub: RzSubscription, paymentId: string | null) {
  const plan = planFromSubscription(sub);
  if (!plan) throw new HttpError(400, 'Unknown plan.');
  if (user.rzSubscriptionId && user.rzSubscriptionId !== sub.id) {
    await razorpay.cancelSubscription(user.rzSubscriptionId, false).catch((e) => console.warn('[billing] old subscription cancel:', (e as Error).message));
    console.log(`[billing] ${user.email}: ${planOf(user.plan).name} → ${PLANS[plan].name}`);
  }
  users.update(user.id, {
    plan,
    rzSubscriptionId: sub.id,
    cancelAtPeriodEnd: false,
    pendingSubscriptionId: user.pendingSubscriptionId === sub.id ? null : user.pendingSubscriptionId,
  });
  const currency = currencyOf(sub);
  if (!user.billingCurrency) users.update(user.id, { billingCurrency: currency }); // their currency from now on
  const pay = paymentId ? { payment_id: paymentId, amount: minorUnits(priceIn(plan, currency)), currency } : await razorpay.lastPaymentOf(sub.id).catch(() => null);
  if (pay?.payment_id)
    payments.record({ id: pay.payment_id, userId: user.id, kind: 'subscription', plan, amount: pay.amount ?? minorUnits(priceIn(plan, currency)), currency: pay.currency ?? currency, ref: sub.id });
  syncSubscription(users.get(user.id)!, sub, plan);
}

/** Checkout said "paid": check the signature, switch the plan, add the month's credits. */
export async function confirmSubscription(user: UserRow, r: { paymentId: string; subscriptionId: string; signature: string }) {
  needPayments();
  if (!validSubscriptionPayment(r.paymentId, r.subscriptionId, r.signature)) throw new HttpError(400, 'That payment couldn’t be verified. If you were charged, it will show up shortly.');
  const sub = await razorpay.subscription(r.subscriptionId);
  if (sub.notes?.user_id && sub.notes.user_id !== user.id) throw new HttpError(403, 'That subscription belongs to another account.');
  if (!isPaid(sub)) {
    // e.g. UPI Autopay: approved, but Razorpay hasn't marked the first charge yet — picked up on the next check
    users.update(user.id, { pendingSubscriptionId: sub.id });
    return { user: users.get(user.id)!, pending: true };
  }
  await adoptSubscription(user, sub, r.paymentId);
  return { user: users.get(user.id)!, pending: false };
}

/** When the person's newest paid subscription isn't their plan yet, it is the one they just paid for. */
const lastScan = new Map<string, number>();
const lastPending = new Map<string, number>();

/**
 * Catch up with Razorpay: a plan that was paid for but never confirmed (the payment window closed early, UPI Autopay
 * took a while, the confirm call failed) becomes active here. Cheap: the pending one is checked directly; a wider look
 * through recent subscriptions runs at most every few minutes per person.
 */
export async function reconcileSubscriptions(user: UserRow, opts: { scan?: boolean } = {}): Promise<UserRow> {
  if (!razorpayReady()) return user;
  try {
    if (user.pendingSubscriptionId && Date.now() - (lastPending.get(user.id) ?? 0) > 15_000) {
      lastPending.set(user.id, Date.now());
      const sub = await razorpay.subscription(user.pendingSubscriptionId);
      const abandoned = sub.status === 'created' && Date.now() / 1000 - (sub.created_at ?? Date.now() / 1000) > 2 * 3600; // window closed without paying
      if (isPaid(sub) && (!sub.notes?.user_id || sub.notes.user_id === user.id) && sub.id !== user.rzSubscriptionId) await adoptSubscription(user, sub, null);
      else if (abandoned || ['cancelled', 'expired', 'completed', 'halted'].includes(sub.status) || sub.id === user.rzSubscriptionId) users.update(user.id, { pendingSubscriptionId: null });
      user = users.get(user.id)!;
    }
    if (opts.scan && Date.now() - (lastScan.get(user.id) ?? 0) > 5 * 60_000) {
      lastScan.set(user.id, Date.now());
      const mine = (await razorpay.recentSubscriptions()).filter((s) => s.notes?.user_id === user.id && isPaid(s));
      const current = mine.find((s) => s.id === user.rzSubscriptionId);
      const newer = mine.filter((s) => s.id !== user.rzSubscriptionId && (!current || (s.created_at ?? 0) > (current.created_at ?? 0))).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
      if (newer) await adoptSubscription(user, newer, null);
      user = users.get(user.id)!;
    }
  } catch (e) {
    console.warn(`[billing] couldn't check Razorpay for ${user.email}:`, (e as Error).message);
  }
  return user;
}

/** Start buying a credit pack: a Razorpay order the browser opens in Checkout. */
export async function startTopup(user: UserRow, hint: string | null = null) {
  needPayments();
  const currency = user.billingCurrency ?? chargeCurrency(shownCurrency(user, hint));
  const order = await razorpay.createOrder(minorUnits(topupPriceIn(currency)), currency, `topup_${user.id}_${Date.now()}`.slice(0, 40), { user_id: user.id, kind: 'topup' });
  return { key: config.razorpayKeyId, orderId: order.id, amount: order.amount, currency: order.currency, description: `${TOPUP.credits} credits` };
}

export async function confirmTopup(user: UserRow, r: { orderId: string; paymentId: string; signature: string }) {
  needPayments();
  if (!validOrderPayment(r.orderId, r.paymentId, r.signature)) throw new HttpError(400, 'That payment couldn’t be verified. If you were charged, it will show up shortly.');
  const pay = await razorpay.payment(r.paymentId);
  if (pay.order_id !== r.orderId) throw new HttpError(400, 'That payment doesn’t match the order.');
  if (pay.notes?.user_id && pay.notes.user_id !== user.id) throw new HttpError(403, 'That payment belongs to another account.');
  addTopup(user.id, pay);
  return users.get(user.id)!;
}

function addTopup(userId: string, pay: RzPayment) {
  payments.record({ id: pay.id, userId, kind: 'topup', amount: pay.amount, currency: pay.currency, ref: pay.order_id ?? null });
  credits.grant(userId, { amount: TOPUP.credits, source: 'topup', expiresAt: Date.now() + TOPUP.validDays * DAY, ref: `topup_${pay.id}`, note: `Top-up · ${TOPUP.credits} credits` });
}

/** Stop renewing: the plan stays until the paid month ends, then it's Free. */
export async function cancelPlan(user: UserRow) {
  if (user.plan === 'free') throw new HttpError(400, 'You’re on the Free plan.');
  if (user.rzSubscriptionId) {
    needPayments();
    await razorpay.cancelSubscription(user.rzSubscriptionId, true);
  }
  users.update(user.id, { cancelAtPeriodEnd: true });
  return users.get(user.id)!;
}

// ---------------- Razorpay webhooks (renewals, payments made while the tab was closed) ----------------

export async function handleWebhook(rawBody: Buffer | undefined, signature: string) {
  if (!rawBody || !validWebhook(rawBody, signature)) throw new HttpError(400, 'Bad signature');
  const ev = JSON.parse(rawBody.toString('utf8')) as {
    event: string;
    payload: { subscription?: { entity: RzSubscription }; payment?: { entity: RzPayment } };
  };
  const sub = ev.payload.subscription?.entity;
  const pay = ev.payload.payment?.entity;
  if (sub) {
    const user = users.bySubscription(sub.id) ?? (sub.notes?.user_id ? users.get(sub.notes.user_id) : null);
    if (!user) return;
    // a subscription paid for in a window that closed before it reported back (a first plan, or a switch to another)
    if (sub.id !== user.rzSubscriptionId && isPaid(sub) && (ev.event === 'subscription.activated' || ev.event === 'subscription.charged')) {
      const switching = !user.rzSubscriptionId || sub.id === user.pendingSubscriptionId;
      if (switching) await adoptSubscription(user, sub, pay?.id ?? null);
    }
    const fresh = users.get(user.id)!;
    if (fresh.rzSubscriptionId !== sub.id) return; // an old subscription
    if (pay && ev.event === 'subscription.charged')
      payments.record({ id: pay.id, userId: user.id, kind: 'subscription', plan: planFromSubscription(sub), amount: pay.amount, currency: pay.currency, ref: sub.id });
    syncSubscription(fresh, sub);
    return;
  }
  if (pay && ev.event === 'payment.captured' && pay.notes?.kind === 'topup' && pay.notes.user_id && users.get(pay.notes.user_id)) addTopup(pay.notes.user_id, pay);
}

// ---------------- admin ----------------

export function adminSetPlan(userId: string, planId: PlanId) {
  const user = users.get(userId);
  if (!user) throw new HttpError(404, 'User not found');
  if (!(planId in PLANS)) throw new HttpError(400, 'Unknown plan');
  if (user.rzSubscriptionId) throw new HttpError(409, 'This person pays through Razorpay — change or cancel their subscription in the Razorpay Dashboard.');
  // an admin-given plan has no subscription; it renews itself each month until changed
  users.update(userId, { plan: planId, cancelAtPeriodEnd: false, cycleEnd: Date.now() });
  return refreshAccount(users.get(userId)!);
}

export function adminAdjustCredits(userId: string, delta: number, note: string) {
  if (!users.get(userId)) throw new HttpError(404, 'User not found');
  credits.adjust(userId, Math.trunc(delta), note || (delta > 0 ? 'Added by admin' : 'Removed by admin'));
}

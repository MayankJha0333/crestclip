/**
 * The whole paying flow against a stand-in Dodo API (test/dodo-mock.ts) and a real database:
 * subscribe (US $ and India ₹), come back from checkout, webhooks (signed, repeated, out of order, forged),
 * upgrade, renewal, failed renewal + grace, cancel / keep, top-ups, a payment that only arrives by webhook,
 * catching up without webhooks, someone else's payment, an old Razorpay subscriber moving over.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27017/ npx tsx test/billing.dodo.test.ts
 *
 * Uses its own throwaway database (crestclip_billing_test_<time>) and drops it at the end.
 */
import assert from 'node:assert/strict';
import { sendWebhook } from './dodo-mock.js';
import { APP, closeAll, collection, credits, KEY, mock, P, payments, sessions, users, WHSEC } from './harness.js';

// ---------------- helpers ----------------

async function person(email: string, extra: Record<string, unknown> = {}) {
  const u = await users.create({ email, name: email.split('@')[0] });
  if (Object.keys(extra).length) await users.update(u.id, extra);
  const { token } = await sessions.create(u.id);
  return { id: u.id, email, cookie: `cc_session=${token}` };
}
type Person = Awaited<ReturnType<typeof person>>;

async function call(p: Person | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${APP}/api${path}`, {
    method,
    headers: { ...(p ? { cookie: p.cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => null)) as any;
  return { status: res.status, data };
}
const account = async (p: Person) => (await call(p, 'GET', '/billing/account')).data;
const balance = (p: Person) => credits.balance(p.id);
const fresh = async (p: Person) => (await users.get(p.id))!;
const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();
const confirmFrom = (q: string) => {
  const s = new URLSearchParams(q);
  return { subscriptionId: s.get('subscription_id') ?? undefined, paymentId: s.get('payment_id') ?? undefined };
};
const subData = (s: object) => ({ payload_type: 'Subscription', ...s });
/** A second checkout opened straight at Dodo (e.g. two tabs at once) — the app would upgrade in place instead. */
async function directCheckout(p: Person, product: string, plan: string) {
  const u = await fresh(p);
  const r = await fetch(`${mock.url}/checkouts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ product_cart: [{ product_id: product, quantity: 1 }], customer: { customer_id: u.dodoCustomerId }, return_url: 'x', metadata: { user_id: p.id, plan, kind: 'subscription' } }),
  });
  return ((await r.json()) as { checkout_url: string }).checkout_url;
}
const payData = (p: object) => ({ payload_type: 'Payment', ...p });

let passed = 0;
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ✗ ${name}`);
    throw e;
  }
}

// ---------------- the tests ----------------

try {
  console.log('\nDodo billing — end to end against a mock Dodo API\n');

  const us = await person('us-buyer@example.com');
  const india = await person('india-buyer@example.com');
  const other = await person('someone-else@example.com');
  let usSub = '';

  await step('Free account: 60 monthly credits, payments ready, test mode shown', async () => {
    const a = await account(us);
    assert.equal(a.plan.id, 'free');
    assert.equal(a.paymentsReady, true);
    assert.equal(a.testMode, true);
    assert.equal(a.hasSubscription, false);
    assert.equal(await balance(us), 60);
  });

  await step('Subscribe to Creator → a Dodo checkout page; customer made once with our user id', async () => {
    const r = await call(us, 'POST', '/billing/subscribe', { plan: 'creator' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.match(r.data.url, /^https:\/\/test\.checkout\.dodopayments\.com\/session\/cks_/);
    const co = mock.calls.filter((c) => c.path === '/checkouts').at(-1)!;
    assert.deepEqual((co.body as any).product_cart, [{ product_id: P.creator, quantity: 1 }]);
    assert.equal((co.body as any).return_url, 'https://crestclip.test/app/billing?checkout=plan');
    assert.deepEqual((co.body as any).metadata, { user_id: us.id, plan: 'creator', kind: 'subscription' });
    const u = await fresh(us);
    assert.ok(u.dodoCustomerId?.startsWith('cus_'));
    assert.deepEqual(mock.customers.get(u.dodoCustomerId!)!.metadata, { user_id: us.id });
    // a second checkout reuses the same customer
    await call(us, 'POST', '/billing/subscribe', { plan: 'creator' });
    assert.equal(mock.customers.size, 1);
    // the buyer pays the first one
    const paid = mock.pay(r.data.url);
    usSub = paid.sub!.subscription_id;
    (globalThis as any).usFirst = paid;
  });

  await step('Back from checkout → Creator, +400 credits, the $15 payment saved with its invoice', async () => {
    const paid = (globalThis as any).usFirst;
    const r = await call(us, 'POST', '/billing/checkout/confirm', confirmFrom(paid.returnQuery));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.pending, false);
    assert.equal(r.data.plan.id, 'creator');
    assert.equal(r.data.billedBy, 'dodo');
    assert.equal(r.data.canManageBilling, true);
    assert.equal(await balance(us), 460);
    const list = await payments.forUser(us.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].amount, 1500);
    assert.equal(list[0].currency, 'USD');
    assert.equal(list[0].kind, 'subscription');
    assert.equal(list[0].plan, 'creator');
    assert.match(list[0].invoiceUrl!, /invoices\/payments\/pay_/);
    const u = await fresh(us);
    assert.equal(u.dodoSubscriptionId, usSub);
    assert.equal(u.subscriptionStatus, 'active');
    assert.ok(u.cycleEnd! > Date.now() + 25 * 86400_000);
  });

  await step('The same return link again, and Dodo’s webhooks for it → nothing added twice', async () => {
    const paid = (globalThis as any).usFirst;
    await call(us, 'POST', '/billing/checkout/confirm', confirmFrom(paid.returnQuery));
    for (const t of ['subscription.active', 'subscription.updated']) assert.equal((await sendWebhook(APP, WHSEC, t, subData(paid.sub))).status, 200);
    assert.equal((await sendWebhook(APP, WHSEC, 'payment.succeeded', payData(paid.pay))).status, 200);
    const again = await sendWebhook(APP, WHSEC, 'payment.succeeded', payData(paid.pay)); // Dodo retries
    assert.equal(again.status, 200);
    assert.equal(await balance(us), 460);
    assert.equal((await payments.forUser(us.id)).length, 1);
  });

  await step('Someone else can’t claim this subscription or payment', async () => {
    const paid = (globalThis as any).usFirst;
    assert.equal((await call(other, 'POST', '/billing/checkout/confirm', { subscriptionId: usSub })).status, 403);
    assert.equal((await call(other, 'POST', '/billing/checkout/confirm', { paymentId: paid.pay.payment_id })).status, 403);
    assert.equal((await fresh(other)).plan, 'free');
    assert.equal((await call(null, 'POST', '/billing/checkout/confirm', { subscriptionId: usSub })).status, 401);
  });

  await step('Forged, replayed-late and unsigned webhooks are refused', async () => {
    const paid = (globalThis as any).usFirst;
    assert.equal((await sendWebhook(APP, WHSEC, 'subscription.active', subData(paid.sub), { badSignature: true })).status, 401);
    assert.equal((await sendWebhook(APP, WHSEC, 'subscription.active', subData(paid.sub), { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
    assert.equal((await sendWebhook(APP, 'whsec_' + Buffer.from('another-secret-another-secret!!!').toString('base64'), 'subscription.active', subData(paid.sub))).status, 401);
    const raw = await fetch(`${APP}/api/billing/dodo/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(raw.status, 401);
  });

  await step('Asking for Creator again → “already on Creator”; Free is never offered', async () => {
    const r = await call(us, 'POST', '/billing/subscribe', { plan: 'creator' });
    assert.equal(r.status, 409);
    assert.equal((await call(us, 'POST', '/billing/subscribe', { plan: 'free' })).status, 400);
  });

  await step('Upgrade Creator → Pro: same subscription, prorated charge, +600 credits now (not 1,000)', async () => {
    const before = await balance(us);
    const r = await call(us, 'POST', '/billing/subscribe', { plan: 'pro' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data, { changed: true, pending: false });
    const cp = mock.calls.filter((c) => c.path.endsWith('/change-plan')).at(-1)!;
    assert.equal(cp.path, `/subscriptions/${usSub}/change-plan`);
    assert.equal((cp.body as any).proration_billing_mode, 'prorated_immediately');
    assert.equal((cp.body as any).on_payment_failure, 'prevent_change');
    assert.equal(await balance(us), before + 600);
    const u = await fresh(us);
    assert.equal(u.plan, 'pro');
    assert.equal(u.dodoSubscriptionId, usSub);
    assert.equal(mock.customers.size, 1);
    // the plan-changed webhook and a page refresh don't add the credits again
    await sendWebhook(APP, WHSEC, 'subscription.plan_changed', subData(mock.subs.get(usSub)!));
    await account(us);
    assert.equal(await balance(us), before + 600);
    // the prorated difference is a payment of its own
    const list = await payments.forUser(us.id);
    assert.equal(list.length, 2);
    assert.ok(list.some((p) => p.amount! > 0 && p.amount! <= 1400 && p.plan === 'pro'));
  });

  await step('Renewal (webhook) → +1,000 Pro credits once; old credits roll over', async () => {
    const before = await balance(us);
    const s = mock.subs.get(usSub)!;
    const pay = mock.renew(s);
    await sendWebhook(APP, WHSEC, 'subscription.renewed', subData(s));
    await sendWebhook(APP, WHSEC, 'payment.succeeded', payData(pay));
    await sendWebhook(APP, WHSEC, 'subscription.renewed', subData(s)); // repeated
    assert.equal(await balance(us), before + 1000);
    const u = await fresh(us);
    assert.equal(u.cycleStart, Date.parse(s.previous_billing_date));
    assert.equal(u.cycleEnd, Date.parse(s.next_billing_date));
    assert.equal((await payments.forUser(us.id)).length, 3);
  });

  await step('Cancel → ends at the end of the month (Dodo told); Keep my plan → renews again', async () => {
    let r = await call(us, 'POST', '/billing/cancel');
    assert.equal(r.status, 200);
    assert.equal(r.data.cancelAtPeriodEnd, true);
    assert.equal(mock.subs.get(usSub)!.cancel_at_next_billing_date, true);
    assert.equal((await fresh(us)).plan, 'pro');
    r = await call(us, 'POST', '/billing/resume');
    assert.equal(r.status, 200);
    assert.equal(r.data.cancelAtPeriodEnd, false);
    assert.equal(mock.subs.get(usSub)!.cancel_at_next_billing_date, false);
  });

  await step('Customer portal link (Manage billing)', async () => {
    const r = await call(us, 'POST', '/billing/portal');
    assert.equal(r.status, 200);
    assert.match(r.data.url, /^https:\/\/customer\.dodopayments\.test\/portal\/cus_/);
    assert.equal((await call(other, 'POST', '/billing/portal')).status, 400);
  });

  await step('Failed renewal (on hold) → plan kept, “payment failed” shown, no new credits', async () => {
    const before = await balance(us);
    const s = mock.subs.get(usSub)!;
    s.status = 'on_hold';
    await sendWebhook(APP, WHSEC, 'subscription.on_hold', subData(s));
    const a = await account(us);
    assert.equal(a.plan.id, 'pro');
    assert.equal(a.paymentProblem, true);
    assert.equal(await balance(us), before);
    assert.equal((await call(us, 'POST', '/billing/subscribe', { plan: 'pro' })).status, 409);
  });

  await step('Fixed in time → active again, no double credits', async () => {
    const before = await balance(us);
    const s = mock.subs.get(usSub)!;
    s.status = 'active';
    await sendWebhook(APP, WHSEC, 'subscription.active', subData(s));
    const a = await account(us);
    assert.equal(a.paymentProblem, false);
    assert.equal(await balance(us), before);
  });

  await step('Still unpaid 7 days after the month ended → Free (credits already paid for stay)', async () => {
    const before = await balance(us);
    const s = mock.subs.get(usSub)!;
    s.status = 'on_hold';
    s.previous_billing_date = ago(40);
    s.next_billing_date = ago(9);
    await users.update(us.id, { cycleEnd: Date.now() - 9 * 86400_000 });
    const a = await account(us); // the month ran out → refresh asks Dodo
    assert.equal(a.plan.id, 'free');
    assert.equal(a.hasSubscription, false);
    assert.ok((await balance(us)) >= before); // paid credits stay (+ the Free month's 60)
  });

  await step('Comes back later: the old subscription becomes active again → adopted again', async () => {
    const s = mock.subs.get(usSub)!;
    const pay = mock.renew(s);
    s.previous_billing_date = new Date().toISOString();
    s.next_billing_date = new Date(Date.now() + 30 * 86400_000).toISOString();
    await sendWebhook(APP, WHSEC, 'subscription.renewed', subData(s));
    await sendWebhook(APP, WHSEC, 'payment.succeeded', payData(pay));
    assert.equal((await fresh(us)).plan, 'pro');
  });

  await step('Dodo ends the subscription (cancelled) → Free', async () => {
    const s = mock.subs.get(usSub)!;
    s.status = 'cancelled';
    await sendWebhook(APP, WHSEC, 'subscription.cancelled', subData(s));
    const u = await fresh(us);
    assert.equal(u.plan, 'free');
    assert.equal(u.dodoSubscriptionId, null);
  });

  await step('India: Creator paid in ₹ (UPI) → plan on, payment saved in INR', async () => {
    const r = await call(india, 'POST', '/billing/subscribe', { plan: 'creator' });
    const paid = mock.pay(r.data.url, { currency: 'INR', amount: 178100 });
    const c = await call(india, 'POST', '/billing/checkout/confirm', confirmFrom(paid.returnQuery));
    assert.equal(c.data.plan.id, 'creator');
    const [p] = await payments.forUser(india.id);
    assert.equal(p.currency, 'INR');
    assert.equal(p.amount, 178100);
  });

  await step('India top-up paid, tab closed (only the webhook arrives) → +100 credits once, in ₹', async () => {
    const before = await balance(india);
    const r = await call(india, 'POST', '/billing/topup');
    assert.equal(r.status, 200);
    const co = mock.calls.filter((c) => c.path === '/checkouts').at(-1)!;
    assert.deepEqual((co.body as any).metadata, { user_id: india.id, kind: 'topup' });
    assert.equal((co.body as any).return_url, 'https://crestclip.test/app/billing?checkout=topup');
    const paid = mock.pay(r.data.url, { currency: 'INR', amount: 59400 });
    await sendWebhook(APP, WHSEC, 'payment.succeeded', payData(paid.pay));
    await sendWebhook(APP, WHSEC, 'payment.succeeded', payData(paid.pay));
    assert.equal(await balance(india), before + 100);
    // and coming back to the page afterwards doesn't add it again
    await call(india, 'POST', '/billing/checkout/confirm', confirmFrom(paid.returnQuery));
    assert.equal(await balance(india), before + 100);
    const top = (await payments.forUser(india.id)).find((p) => p.kind === 'topup')!;
    assert.equal(top.currency, 'INR');
    const grant = await collection<any>('credit_grants').findOne({ ref: `topup_${paid.pay!.payment_id}` });
    assert.ok(grant.expiresAt > Date.now() + 360 * 86400_000);
  });

  await step('A top-up still processing → “pending”, then counted once it succeeds', async () => {
    const before = await balance(india);
    const r = await call(india, 'POST', '/billing/topup');
    const paid = mock.pay(r.data.url);
    paid.pay!.status = 'processing';
    const c1 = await call(india, 'POST', '/billing/checkout/confirm', confirmFrom(paid.returnQuery));
    assert.equal(c1.data.pending, true);
    assert.equal(await balance(india), before);
    paid.pay!.status = 'succeeded';
    const c2 = await call(india, 'POST', '/billing/checkout/confirm', confirmFrom(paid.returnQuery));
    assert.equal(c2.data.pending, false);
    assert.equal(await balance(india), before + 100);
  });

  await step('Paid but never came back and no webhook → picked up when the Plan page opens', async () => {
    const lost = await person('lost-tab@example.com');
    await account(lost);
    const r = await call(lost, 'POST', '/billing/subscribe', { plan: 'pro' });
    mock.pay(r.data.url);
    const t = mock.pay((await call(lost, 'POST', '/billing/topup')).data.url);
    assert.ok(t.pay);
    const a = await account(lost);
    assert.equal(a.plan.id, 'pro');
    assert.equal(await balance(lost), 60 + 1000 + 100);
    assert.equal((await payments.forUser(lost.id)).length, 2);
  });

  await step('A plan change whose payment fails → plan unchanged, told it’s waiting', async () => {
    const up = await person('upgrade-fails@example.com');
    const r = await call(up, 'POST', '/billing/subscribe', { plan: 'creator' });
    const paid = mock.pay(r.data.url);
    await call(up, 'POST', '/billing/checkout/confirm', confirmFrom(paid.returnQuery));
    const before = await balance(up);
    mock.failNextPlanChange = true;
    const u = await call(up, 'POST', '/billing/subscribe', { plan: 'pro' });
    assert.deepEqual(u.data, { changed: true, pending: true });
    assert.equal((await fresh(up)).plan, 'creator');
    assert.equal(await balance(up), before);
  });

  await step('A first payment still pending (UPI mandate) → pending, then active by webhook', async () => {
    const p = await person('upi-pending@example.com');
    const r = await call(p, 'POST', '/billing/subscribe', { plan: 'creator' });
    const paid = mock.pay(r.data.url, { status: 'pending', currency: 'INR', amount: 178100 });
    const c = await call(p, 'POST', '/billing/checkout/confirm', confirmFrom(paid.returnQuery));
    assert.equal(c.data.pending, true);
    assert.equal((await fresh(p)).plan, 'free');
    paid.sub!.status = 'active';
    const pay = mock.addPayment(paid.sub!, 178100, 'INR');
    await sendWebhook(APP, WHSEC, 'subscription.active', subData(paid.sub!));
    await sendWebhook(APP, WHSEC, 'payment.succeeded', payData(pay));
    assert.equal((await fresh(p)).plan, 'creator');
  });

  await step('Two subscriptions active: an older one’s late event never replaces the newer one', async () => {
    const p = await person('two-subs@example.com');
    const a = mock.pay((await call(p, 'POST', '/billing/subscribe', { plan: 'creator' })).data.url);
    a.sub!.created_at = ago(2);
    const b = mock.pay((await call(p, 'POST', '/billing/subscribe', { plan: 'pro' })).data.url);
    await call(p, 'POST', '/billing/checkout/confirm', confirmFrom(b.returnQuery));
    assert.equal((await fresh(p)).dodoSubscriptionId, b.sub!.subscription_id);
    await sendWebhook(APP, WHSEC, 'subscription.active', subData(a.sub!)); // the older one, late
    const u = await fresh(p);
    assert.equal(u.dodoSubscriptionId, b.sub!.subscription_id);
    assert.equal(u.plan, 'pro');
    assert.equal(mock.subs.get(b.sub!.subscription_id)!.status, 'active');
  });

  await step('A newer subscription replaces an older one and cancels it (never billed twice)', async () => {
    const p = await person('replace@example.com');
    const a = mock.pay((await call(p, 'POST', '/billing/subscribe', { plan: 'creator' })).data.url);
    a.sub!.created_at = ago(1);
    await call(p, 'POST', '/billing/checkout/confirm', confirmFrom(a.returnQuery));
    const b = mock.pay(await directCheckout(p, P.pro, 'pro'));
    await sendWebhook(APP, WHSEC, 'subscription.active', subData(b.sub!));
    assert.equal((await fresh(p)).dodoSubscriptionId, b.sub!.subscription_id);
    assert.equal(mock.subs.get(a.sub!.subscription_id)!.status, 'cancelled');
  });

  await step('Old Razorpay subscriber subscribing through Dodo → moved over, Razorpay link cleared', async () => {
    const p = await person('old-razorpay@example.com', { plan: 'creator', rzSubscriptionId: 'sub_rz_legacy', cycleStart: Date.now() - 86400_000, cycleEnd: Date.now() + 20 * 86400_000 });
    let a = await account(p);
    assert.equal(a.billedBy, 'razorpay');
    const r = await call(p, 'POST', '/billing/subscribe', { plan: 'pro' });
    assert.ok(r.data.url, JSON.stringify(r.data));
    const paid = mock.pay(r.data.url);
    await call(p, 'POST', '/billing/checkout/confirm', confirmFrom(paid.returnQuery));
    const u = await fresh(p);
    assert.equal(u.plan, 'pro');
    assert.equal(u.rzSubscriptionId, null);
    a = await account(p);
    assert.equal(a.billedBy, 'dodo');
  });

  await step('Webhook for a subscription nobody has → ignored (200, so Dodo stops retrying)', async () => {
    const stranger = { ...mock.subs.get(usSub)!, subscription_id: 'sub_unknown', metadata: {}, customer: { customer_id: 'cus_nobody', email: 'x@y.z', name: 'x' } };
    mock.subs.set('sub_unknown', stranger);
    assert.equal((await sendWebhook(APP, WHSEC, 'subscription.active', subData(stranger))).status, 200);
  });

  await step('Admin can’t hand-change the plan of someone paying through Dodo', async () => {
    const { adminSetPlan } = await import('../src/modules/billing/billing.service.js');
    const p = await person('admin-check@example.com');
    const paid = mock.pay((await call(p, 'POST', '/billing/subscribe', { plan: 'creator' })).data.url);
    await call(p, 'POST', '/billing/checkout/confirm', confirmFrom(paid.returnQuery));
    await assert.rejects(adminSetPlan(p.id, 'pro'), /Dodo Payments/);
  });

  await step('Receipt: Dodo payment shows provider and invoice', async () => {
    const [p] = await payments.forUser(india.id);
    const r = await call(india, 'GET', `/billing/payments/${p.id}/receipt`);
    assert.equal(r.status, 200);
    assert.equal(r.data.provider, 'dodo');
    assert.match(r.data.payment.invoiceUrl, /invoices\/payments/);
    assert.equal((await call(us, 'GET', `/billing/payments/${p.id}/receipt`)).status, 404);
  });

  console.log(`\n${passed} checks passed\n`);
} finally {
  await closeAll();
}
process.exit(0);

/**
 * Help requests end to end: a person raises one, the team sees it on the Admin side, answers, the person reads and
 * replies, the team resolves it — plus who may see what.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27017/ npx tsx test/support.test.ts
 */
import assert from 'node:assert/strict';
import { APP, closeAll, sessions, users } from './harness.js';

async function person(email: string, isAdmin = false) {
  const u = await users.create({ email, name: email.split('@')[0], isAdmin });
  return { id: u.id, cookie: `cc_session=${(await sessions.create(u.id)).token}` };
}
type P = Awaited<ReturnType<typeof person>>;
async function call(p: P | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${APP}/api${path}`, {
    method,
    headers: { ...(p ? { cookie: p.cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), 'user-agent': 'support-test' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
let passed = 0;
async function step(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

try {
  console.log('\nHelp requests\n');
  const ana = await person('ana@example.com');
  const bob = await person('bob@example.com');
  const admin = await person('team@example.com', true);
  let id = '';

  await step('A person raises a request → numbered, open, with plan / page / browser filled in', async () => {
    const r = await call(ana, 'POST', '/support/tickets', { category: 'billing', subject: 'Charged twice', message: 'I see two payments for Creator this month.', page: '/app/billing' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.number >= 1001);
    assert.equal(r.data.status, 'open');
    assert.equal(r.data.messages.length, 1);
    assert.equal(r.data.priority, undefined); // the team's fields aren't shown to the person
    id = r.data.id;
    const list = (await call(ana, 'GET', '/support/tickets')).data;
    assert.equal(list.length, 1);
    assert.equal(list[0].lastMessage.from, 'user');
  });

  await step('Empty or too-short requests are refused with a clear message; a second one right away waits', async () => {
    const r = await call(ana, 'POST', '/support/tickets', { category: 'bug', subject: 'x', message: '' });
    assert.equal(r.status, 400);
    const again = await call(ana, 'POST', '/support/tickets', { category: 'bug', subject: 'Another thing', message: 'Something else broke.' });
    assert.equal(again.status, 429);
  });

  await step('Nobody else can see it; non-admins can’t open the team’s side', async () => {
    assert.equal((await call(bob, 'GET', `/support/tickets/${id}`)).status, 404);
    assert.equal((await call(bob, 'POST', `/support/tickets/${id}/messages`, { body: 'hello there' })).status, 404);
    assert.equal((await call(bob, 'GET', '/admin/tickets')).status, 403);
    assert.equal((await call(null, 'GET', '/support/tickets')).status, 401);
  });

  await step('The team sees it as new, with who sent it (plan, credits) and the context', async () => {
    const me = (await call(admin, 'GET', '/auth/me')).data;
    assert.equal(me.support.adminUnread, 1);
    const l = (await call(admin, 'GET', '/admin/tickets')).data;
    assert.equal(l.counts.open, 1);
    assert.equal(l.counts.unread, 1);
    assert.equal(l.items[0].subject, 'Charged twice');
    assert.equal(l.items[0].priority, 'high'); // billing comes first
    const t = (await call(admin, 'GET', `/admin/tickets/${id}`)).data;
    assert.equal(t.user.email, 'ana@example.com');
    assert.equal(t.context.page, '/app/billing');
    assert.equal(t.context.userAgent, 'support-test');
    assert.equal((await call(admin, 'GET', '/admin/tickets')).data.counts.unread, 0); // opening it = read
  });

  await step('Search by #number, email or subject', async () => {
    const t = (await call(admin, 'GET', `/admin/tickets/${id}`)).data;
    for (const q of [`%23${t.number}`, 'ana@', 'twice']) assert.equal((await call(admin, 'GET', `/admin/tickets?status=all&q=${q}`)).data.items.length, 1, q);
    assert.equal((await call(admin, 'GET', '/admin/tickets?status=all&q=nothing-like-this')).data.items.length, 0);
  });

  await step('The team answers → waiting for the person, who sees “1 new answer”', async () => {
    const r = await call(admin, 'POST', `/admin/tickets/${id}/messages`, { body: 'Sorry about that — the second one is refunded.' });
    assert.equal(r.data.status, 'waiting');
    assert.equal(r.data.messages.at(-1).from, 'admin');
    assert.equal((await call(ana, 'GET', '/auth/me')).data.support.unread, 1);
    const t = (await call(ana, 'GET', `/support/tickets/${id}`)).data;
    assert.equal(t.messages.length, 2);
    assert.equal((await call(ana, 'GET', '/auth/me')).data.support.unread, 0); // read now
  });

  await step('The person replies → open again and new for the team', async () => {
    const r = await call(ana, 'POST', `/support/tickets/${id}/messages`, { body: 'Thanks! When will I see it?' });
    assert.equal(r.data.status, 'open');
    assert.equal((await call(admin, 'GET', '/admin/tickets')).data.counts.unread, 1);
  });

  await step('The team answers and resolves in one go; marks priority; the person closes it', async () => {
    const r = await call(admin, 'POST', `/admin/tickets/${id}/messages`, { body: 'Within 5–7 working days.', status: 'resolved' });
    assert.equal(r.data.status, 'resolved');
    const p = await call(admin, 'PATCH', `/admin/tickets/${id}`, { priority: 'urgent' });
    assert.equal(p.data.priority, 'urgent');
    assert.equal((await call(admin, 'GET', '/admin/tickets')).data.items.length, 0); // not in "active" any more
    assert.equal((await call(admin, 'GET', '/admin/tickets?status=resolved')).data.items.length, 1);
    const c = await call(ana, 'POST', `/support/tickets/${id}/close`);
    assert.equal(c.data.status, 'closed');
    assert.equal((await call(ana, 'POST', `/support/tickets/${id}/messages`, { body: 'one more thing' })).status, 409);
  });

  console.log(`\n${passed} checks passed\n`);
} finally {
  await closeAll();
}
process.exit(0);

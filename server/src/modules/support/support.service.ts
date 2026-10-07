import { credits, projects, tickets, users, type TicketCategory, type TicketPriority, type TicketRow, type TicketStatus, type UserRow } from '../../db/index.js';
import { HttpError } from '../../lib/http.js';
import { planOf } from '../billing/plans.js';

/**
 * Help requests ("tickets"). A person writes in from Help → New request; the team answers on Admin → Support; both
 * sides reply in one thread. Status follows the conversation: a new message from the person → open, an answer from
 * the team → waiting (for the person). The team marks it resolved; a reply from the person opens it again.
 */

/** No more than this many open requests per person, and a short pause between new ones (stops accidental floods). */
const MAX_OPEN = 10;
const NEW_GAP_MS = 20_000;
const lastNew = new Map<string, number>();

/** What the person sees: the thread, without the team's internal fields. */
const forUser = (t: TicketRow) => {
  const { unreadForAdmin: _a, priority: _p, context: _c, ...rest } = t;
  return rest;
};

async function projectRef(id: string | null) {
  if (!id) return null;
  const p = await projects.get(id).catch(() => null);
  return { id, title: p?.title || 'Untitled video', status: p?.status ?? 'deleted', exists: Boolean(p) };
}

// ---------------- the person ----------------

export async function createTicket(
  user: UserRow,
  b: { category: TicketCategory; subject: string; message: string; projectId?: string | null; page?: string | null },
  userAgent: string | null,
) {
  const mine = await tickets.forUser(user.id);
  if (mine.filter((t) => t.status === 'open' || t.status === 'in_progress' || t.status === 'waiting').length >= MAX_OPEN)
    throw new HttpError(429, `You have ${MAX_OPEN} requests open already. Add to one of them, or wait for an answer.`);
  if (Date.now() - (lastNew.get(user.id) ?? 0) < NEW_GAP_MS) throw new HttpError(429, 'You just sent a request — give it a moment before sending another.');
  let projectId = b.projectId || null;
  if (projectId && (await projects.get(projectId))?.userId !== user.id) projectId = null; // only their own videos
  lastNew.set(user.id, Date.now());
  const t = await tickets.create({
    userId: user.id,
    email: user.email,
    name: user.name,
    category: b.category,
    subject: b.subject.trim(),
    body: b.message.trim(),
    projectId,
    context: { plan: planOf(user.plan).id, page: b.page?.slice(0, 300) || null, userAgent: userAgent?.slice(0, 300) || null },
  });
  console.log(`[support] #${t.number} from ${user.email} (${t.category}): ${t.subject}`);
  return forUser(t);
}

export const myTickets = (user: UserRow) => tickets.forUser(user.id).then((list) => list.map(({ unreadForAdmin: _a, priority: _p, context: _c, ...t }) => t));

async function mine(user: UserRow, id: string) {
  const t = await tickets.get(id);
  if (!t || t.userId !== user.id) throw new HttpError(404, 'We couldn’t find that request.');
  return t;
}

/** One request with its whole thread (and it's now read). */
export async function myTicket(user: UserRow, id: string) {
  const t = await mine(user, id);
  if (t.unreadForUser) await tickets.update(t.id, { unreadForUser: false }, false);
  return { ...forUser({ ...t, unreadForUser: false }), project: await projectRef(t.projectId) };
}

export async function userReply(user: UserRow, id: string, body: string) {
  const t = await mine(user, id);
  if (t.status === 'closed') throw new HttpError(409, 'This request is closed. Please start a new one.');
  await tickets.addMessage(t.id, { from: 'user', authorName: user.name, body: body.trim() }, 'open');
  return myTicket(user, id);
}

/** "This is sorted": the person closes their own request. */
export async function userClose(user: UserRow, id: string) {
  const t = await mine(user, id);
  if (t.status !== 'closed') await tickets.update(t.id, { status: 'closed', unreadForUser: false });
  return myTicket(user, id);
}

// ---------------- the team (Admin → Support) ----------------

export async function adminList(o: { status?: TicketStatus | 'active' | 'all'; category?: TicketCategory; q?: string }) {
  const [list, counts] = await Promise.all([tickets.list(o), tickets.counts()]);
  return { items: list, counts };
}

/** One request for the team: the thread, who sent it (plan, credits, account age) and the video it's about. */
export async function adminTicket(id: string, markRead = true) {
  const t = await tickets.get(id);
  if (!t) throw new HttpError(404, 'Ticket not found');
  if (markRead && t.unreadForAdmin) await tickets.update(t.id, { unreadForAdmin: false }, false);
  const u = await users.get(t.userId);
  return {
    ...t,
    unreadForAdmin: false,
    project: await projectRef(t.projectId),
    user: u
      ? { id: u.id, email: u.email, name: u.name, plan: planOf(u.plan).id, paying: Boolean(u.dodoSubscriptionId || u.rzSubscriptionId), balance: await credits.balance(u.id), createdAt: u.createdAt }
      : null,
  };
}

/** The team answers (optionally setting the status at the same time — e.g. answer + resolve). */
export async function adminReply(admin: UserRow, id: string, body: string, status?: TicketStatus) {
  const t = await tickets.get(id);
  if (!t) throw new HttpError(404, 'Ticket not found');
  await tickets.addMessage(t.id, { from: 'admin', authorName: admin.name ?? 'CrestClip support', body: body.trim() }, status ?? 'waiting');
  console.log(`[support] #${t.number} answered by ${admin.email}${status ? ` (${status})` : ''}`);
  return adminTicket(id, false);
}

export async function adminUpdate(id: string, patch: { status?: TicketStatus; priority?: TicketPriority; unread?: boolean }) {
  const t = await tickets.get(id);
  if (!t) throw new HttpError(404, 'Ticket not found');
  await tickets.update(t.id, {
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.priority ? { priority: patch.priority } : {}),
    ...(patch.unread !== undefined ? { unreadForAdmin: patch.unread } : {}),
  });
  return adminTicket(id, false);
}

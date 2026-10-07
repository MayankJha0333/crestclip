import { collection, COLLECTIONS, fromDoc, newId, now, stamp, type Doc } from './connection.js';

/**
 * Support tickets: someone reports a problem or asks a question (Help → New request), the team answers from the
 * Admin page, and both sides write back and forth in one thread until it's resolved.
 */

export const TICKET_CATEGORIES = ['billing', 'clips', 'publishing', 'account', 'bug', 'idea', 'other'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
/** open = waiting for the team · waiting = the team answered, waiting for the person · resolved / closed = done */
export const TICKET_STATUSES = ['open', 'in_progress', 'waiting', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketPriority = 'normal' | 'high' | 'urgent';

export interface TicketMessage {
  id: string;
  from: 'user' | 'admin';
  /** who wrote it (the person's name, or the admin's) */
  authorName: string | null;
  body: string;
  at: number;
}

export interface TicketRow {
  id: string;
  /** short number people can quote: 1042 → "#1042" */
  number: number;
  userId: string;
  /** a copy, so the ticket still says who wrote it if the account changes */
  email: string;
  name: string | null;
  category: TicketCategory;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  /** the video it's about, if one was picked */
  projectId: string | null;
  /** filled in automatically: plan, page, browser — so the team needn't ask */
  context: { plan: string; page: string | null; userAgent: string | null };
  messages: TicketMessage[];
  /** the team hasn't read the person's latest message / the person hasn't read the team's latest answer */
  unreadForAdmin: boolean;
  unreadForUser: boolean;
  createdAt: number;
  updatedAt: number;
}

const col = () => collection<Doc<TicketRow>>(COLLECTIONS.tickets);
const counter = () => collection<{ _id: string; n: number }>(COLLECTIONS.meta);

/** The next ticket number (1001, 1002, …), shared by every app copy. */
async function nextNumber() {
  const r = await counter().findOneAndUpdate({ _id: 'ticket_number' }, { $inc: { n: 1 } }, { upsert: true, returnDocument: 'after' });
  return 1000 + (r?.n ?? 1);
}

export type TicketSummary = Omit<TicketRow, 'messages'> & { messageCount: number; lastMessage: { from: 'user' | 'admin'; body: string; at: number } | null };
const summary = (t: TicketRow): TicketSummary => {
  const { messages, ...rest } = t;
  const last = messages.at(-1);
  return { ...rest, messageCount: messages.length, lastMessage: last ? { from: last.from, body: last.body.slice(0, 160), at: last.at } : null };
};

export const tickets = {
  async create(t: { userId: string; email: string; name: string | null; category: TicketCategory; subject: string; body: string; projectId: string | null; context: TicketRow['context'] }) {
    const at = stamp();
    const row: Doc<TicketRow> = {
      _id: newId(),
      number: await nextNumber(),
      userId: t.userId,
      email: t.email,
      name: t.name,
      category: t.category,
      subject: t.subject,
      status: 'open',
      priority: t.category === 'billing' ? 'high' : 'normal',
      projectId: t.projectId,
      context: t.context,
      messages: [{ id: newId(), from: 'user', authorName: t.name, body: t.body, at }],
      unreadForAdmin: true,
      unreadForUser: false,
      createdAt: at,
      updatedAt: at,
    };
    await col().insertOne(row);
    return fromDoc<TicketRow>(row);
  },

  async get(id: string): Promise<TicketRow | null> {
    const d = await col().findOne({ _id: id });
    return d ? fromDoc<TicketRow>(d) : null;
  },

  /** One person's tickets, newest activity first. */
  async forUser(userId: string): Promise<TicketSummary[]> {
    const docs = await col().find({ userId }).sort({ updatedAt: -1 }).limit(200).toArray();
    return docs.map((d) => summary(fromDoc<TicketRow>(d)));
  },

  /** Everyone's tickets for the Admin page: filter by status / category / text, newest activity first. */
  async list(o: { status?: TicketStatus | 'active' | 'all'; category?: TicketCategory; q?: string; limit?: number }): Promise<TicketSummary[]> {
    const filter: Record<string, unknown> = {};
    if (o.status === 'active') filter.status = { $in: ['open', 'in_progress', 'waiting'] };
    else if (o.status && o.status !== 'all') filter.status = o.status;
    if (o.category) filter.category = o.category;
    const q = o.q?.trim();
    if (q) {
      const rx = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 80), $options: 'i' };
      const n = Number(q.replace(/^#/, ''));
      filter.$or = [{ subject: rx }, { email: rx }, { name: rx }, ...(Number.isInteger(n) && n > 0 ? [{ number: n }] : [])];
    }
    const docs = await col()
      .find(filter)
      .sort({ updatedAt: -1 })
      .limit(Math.min(500, o.limit ?? 200))
      .toArray();
    return docs.map((d) => summary(fromDoc<TicketRow>(d)));
  },

  /** How many tickets are in each status (Admin page tabs), and how many have news for the team. */
  async counts() {
    const docs = await col().find({}, { projection: { status: 1, unreadForAdmin: 1 } }).toArray();
    const by: Record<TicketStatus, number> = { open: 0, in_progress: 0, waiting: 0, resolved: 0, closed: 0 };
    let unread = 0;
    for (const d of docs) {
      by[d.status as TicketStatus] = (by[d.status as TicketStatus] ?? 0) + 1;
      if (d.unreadForAdmin) unread++;
    }
    return { ...by, active: by.open + by.in_progress + by.waiting, all: docs.length, unread };
  },

  /** Requests with something new for the team. */
  async adminUnread() {
    return col().countDocuments({ unreadForAdmin: true });
  },
  /** How many of this person's tickets have an answer they haven't seen. */
  async unreadFor(userId: string) {
    return col().countDocuments({ userId, unreadForUser: true });
  },

  /** Add a message; the other side now has something new, and the status follows who wrote last. */
  async addMessage(id: string, m: { from: 'user' | 'admin'; authorName: string | null; body: string }, status: TicketStatus) {
    const msg: TicketMessage = { id: newId(), from: m.from, authorName: m.authorName, body: m.body, at: stamp() };
    await col().updateOne(
      { _id: id },
      {
        $push: { messages: msg },
        $set: { status, updatedAt: msg.at, ...(m.from === 'user' ? { unreadForAdmin: true } : { unreadForUser: true, unreadForAdmin: false }) },
      },
    );
    return msg;
  },

  async update(id: string, patch: Partial<Pick<TicketRow, 'status' | 'priority' | 'unreadForAdmin' | 'unreadForUser'>>, touch = true) {
    await col().updateOne({ _id: id }, { $set: { ...patch, ...(touch ? { updatedAt: now() } : {}) } });
  },

  /** Account deletion: their tickets go too. */
  async removeAllFor(userId: string) {
    await col().deleteMany({ userId });
  },
};

import type { Job } from 'bullmq';
import type { Db, Document } from 'mongodb';
import type { makeQueues } from './system.js';

/**
 * Data for the Users and Running-now pages, read straight from the app's database (read-only) and the job queue.
 * Only simple lookups with field projections (no big documents, no fancy aggregation) — the counting is done here.
 */

type Queues = ReturnType<typeof makeQueues>;
const DAY = 86400_000;

export interface QueueSpot {
  state: 'running' | 'waiting';
  /** jobs ahead of it (waiting only) */
  ahead: number;
  kind: string;
  /** when it was added / started */
  since: number;
  worker: string | null;
  jobId: string;
  queue: string;
}

/** Every job running or waiting right now, in line order, with the project it belongs to. */
async function queueJobs(db: Db, queues: Queues) {
  const out: (QueueSpot & { projectId: string | null; clipId: string | null })[] = [];
  for (const q of queues.filter((x) => x.name === 'cc-videos' || x.name === 'cc-renders')) {
    const [active, prioritized, waiting] = await Promise.all([
      q.queue.getJobs(['active'], 0, 500),
      q.queue.getJobs(['prioritized'], 0, 1000, true),
      q.queue.getJobs(['waiting'], 0, 1000, true),
    ]);
    const line = [...prioritized.sort((a, b) => (a.priority || 0) - (b.priority || 0) || a.timestamp - b.timestamp), ...waiting];
    const add = (j: Job, state: QueueSpot['state'], ahead: number) =>
      out.push({
        state,
        ahead,
        kind: j.name,
        since: state === 'running' ? (j.processedOn ?? j.timestamp) : j.timestamp,
        worker: j.processedBy ?? null,
        jobId: String(j.id),
        queue: q.name,
        projectId: (j.data?.id ?? j.data?.projectId ?? null) as string | null,
        clipId: (j.data?.clipId ?? null) as string | null,
      });
    for (const j of active) add(j, 'running', 0);
    line.forEach((j, i) => add(j, 'waiting', i));
  }
  // renders only know their clip: look up the clip's project
  const clipIds = out.filter((j) => !j.projectId && j.clipId).map((j) => j.clipId!);
  if (clipIds.length) {
    const clips = await db.collection('clips').find({ _id: { $in: clipIds } } as Document, { projection: { projectId: 1 } }).toArray();
    const proj = new Map(clips.map((c) => [String(c._id), String(c.projectId)]));
    for (const j of out) if (!j.projectId && j.clipId) j.projectId = proj.get(j.clipId) ?? null;
  }
  return out;
}

// ---------------- all users ----------------
export interface UserListRow {
  id: string;
  email: string;
  name: string;
  plan: string;
  paying: boolean;
  isAdmin: boolean;
  credits: number;
  used30: number;
  videos: number;
  videos30: number;
  running: number;
  waiting: number;
  lastActive: number;
  joined: number;
}

export async function usersList(db: Db, queues: Queues) {
  const now = Date.now();
  const since30 = now - 30 * DAY;
  const [people, grants, spends, projects, sessions, jobs] = await Promise.all([
    db.collection('users').find({}, { projection: { email: 1, name: 1, plan: 1, rzSubscriptionId: 1, dodoSubscriptionId: 1, isAdmin: 1, createdAt: 1 } }).toArray(),
    db.collection('credit_grants').find({ expiresAt: { $gt: now }, remaining: { $gt: 0 } }, { projection: { userId: 1, remaining: 1 } }).toArray(),
    db.collection('credit_events').find({ kind: 'spend', refunded: false, createdAt: { $gte: since30 } }, { projection: { userId: 1, delta: 1 } }).toArray(),
    db.collection('projects').find({ sourceType: { $ne: 'group' } }, { projection: { userId: 1, createdAt: 1 } }).toArray(),
    db.collection('sessions').find({}, { projection: { userId: 1, createdAt: 1 } }).toArray(),
    queueJobs(db, queues),
  ]);
  const sum = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
  const max = (m: Map<string, number>, k: string, n: number) => m.set(k, Math.max(m.get(k) ?? 0, n));
  const credits = new Map<string, number>();
  for (const g of grants) sum(credits, String(g.userId), Number(g.remaining) || 0);
  const used = new Map<string, number>();
  for (const e of spends) sum(used, String(e.userId), -(Number(e.delta) || 0));
  const videos = new Map<string, number>();
  const videos30 = new Map<string, number>();
  const last = new Map<string, number>();
  const ownerOf = new Map<string, string>();
  for (const p of projects) {
    const u = String(p.userId);
    ownerOf.set(String(p._id), u);
    sum(videos, u, 1);
    if (Number(p.createdAt) >= since30) sum(videos30, u, 1);
    max(last, u, Number(p.createdAt) || 0);
  }
  for (const s of sessions) max(last, String(s.userId), Number(s.createdAt) || 0);
  const running = new Map<string, number>();
  const waiting = new Map<string, number>();
  for (const j of jobs) {
    const u = j.projectId ? ownerOf.get(j.projectId) : undefined;
    if (u) sum(j.state === 'running' ? running : waiting, u, 1);
  }
  const rows: UserListRow[] = people.map((p) => {
    const id = String(p._id);
    return {
      id,
      email: String(p.email ?? ''),
      name: String(p.name ?? ''),
      plan: String(p.plan ?? 'free'),
      paying: Boolean(p.dodoSubscriptionId || p.rzSubscriptionId),
      isAdmin: Boolean(p.isAdmin),
      credits: credits.get(id) ?? 0,
      used30: used.get(id) ?? 0,
      videos: videos.get(id) ?? 0,
      videos30: videos30.get(id) ?? 0,
      running: running.get(id) ?? 0,
      waiting: waiting.get(id) ?? 0,
      lastActive: Math.max(last.get(id) ?? 0, Number(p.createdAt) || 0),
      joined: Number(p.createdAt) || 0,
    };
  });
  return {
    rows,
    totals: {
      users: rows.length,
      newThisWeek: rows.filter((r) => r.joined >= now - 7 * DAY).length,
      activeThisWeek: rows.filter((r) => r.lastActive >= now - 7 * DAY).length,
      paying: rows.filter((r) => r.paying).length,
      videos30: rows.reduce((s, r) => s + r.videos30, 0),
      used30: rows.reduce((s, r) => s + r.used30, 0),
      running: jobs.filter((j) => j.state === 'running').length,
      waiting: jobs.filter((j) => j.state === 'waiting').length,
    },
  };
}

// ---------------- one user ----------------
export async function userDetail(db: Db, queues: Queues, id: string) {
  const now = Date.now();
  const user = await db.collection('users').findOne({ _id: id } as Document, { projection: { passwordHash: 0, googleSub: 0 } });
  if (!user) return null;
  const [grants, events, projects, connections, posts, jobs, spent30] = await Promise.all([
    db.collection('credit_grants').find({ userId: id, expiresAt: { $gt: now }, remaining: { $gt: 0 } }).sort({ expiresAt: 1 }).toArray(),
    db.collection('credit_events').find({ userId: id }).sort({ createdAt: -1 }).limit(40).toArray(),
    db
      .collection('projects')
      .find(
        { userId: id, sourceType: { $ne: 'group' } },
        { projection: { title: 1, status: 1, stage: 1, stageDetail: 1, progress: 1, error: 1, createdAt: 1, creditsCharged: 1, sourceType: 1, sourceUrl: 1, duration: 1 } },
      )
      .sort({ createdAt: -1 })
      .limit(60)
      .toArray(),
    db.collection('connections').find({ userId: id }, { projection: { platform: 1, name: 1, handle: 1 } }).toArray(),
    db.collection('posts').find({ userId: id }, { projection: { platform: 1, status: 1, title: 1, scheduledAt: 1, createdAt: 1, error: 1, remoteUrl: 1 } }).sort({ createdAt: -1 }).limit(15).toArray(),
    queueJobs(db, queues),
    db.collection('credit_events').find({ userId: id, kind: 'spend', refunded: false, createdAt: { $gte: now - 30 * DAY } }, { projection: { delta: 1 } }).toArray(),
  ]);
  const ids = projects.map((p) => String(p._id));
  const clips = ids.length ? await db.collection('clips').find({ projectId: { $in: ids } }, { projection: { projectId: 1, status: 1 } }).toArray() : [];
  const clipCount = new Map<string, { ready: number; all: number }>();
  for (const c of clips) {
    const k = String(c.projectId);
    const v = clipCount.get(k) ?? { ready: 0, all: 0 };
    v.all++;
    if (c.status === 'ready') v.ready++;
    clipCount.set(k, v);
  }
  const spot = new Map<string, QueueSpot>();
  for (const j of jobs) if (j.projectId && (!spot.has(j.projectId) || j.state === 'running')) spot.set(j.projectId, j);
  return {
    user: {
      id,
      email: String(user.email ?? ''),
      name: String(user.name ?? ''),
      avatar: (user.avatar as string | null) ?? null,
      plan: String(user.plan ?? 'free'),
      paying: Boolean(user.dodoSubscriptionId || user.rzSubscriptionId),
      cancelAtPeriodEnd: Boolean(user.cancelAtPeriodEnd),
      cycleEnd: (user.cycleEnd as number | null) ?? null,
      isAdmin: Boolean(user.isAdmin),
      joined: Number(user.createdAt) || 0,
    },
    credits: grants.reduce((s, g) => s + (Number(g.remaining) || 0), 0),
    used30: spent30.reduce((s, e) => s - (Number(e.delta) || 0), 0),
    grants: grants.map((g) => ({ source: ({ plan: 'Plan (monthly)', topup: 'Top-up', bonus: 'Bonus', refund: 'Refund' } as Record<string, string>)[String(g.source)] ?? String(g.source ?? ''), amount: Number(g.amount) || 0, remaining: Number(g.remaining) || 0, expiresAt: Number(g.expiresAt) || 0 })),
    events: events.map((e) => ({ at: Number(e.createdAt) || 0, kind: String(e.kind), delta: Number(e.delta) || 0, note: String(e.note ?? ''), refunded: Boolean(e.refunded) })),
    projects: projects.map((p) => {
      const pid = String(p._id);
      return {
        id: pid,
        title: String(p.title ?? (p.sourceUrl as string | null) ?? 'Untitled'),
        status: String(p.status),
        stage: (p.stage as string | null) ?? null,
        stageDetail: (p.stageDetail as string | null) ?? null,
        progress: Number(p.progress) || 0,
        error: (p.error as string | null) ?? null,
        createdAt: Number(p.createdAt) || 0,
        credits: Number(p.creditsCharged) || 0,
        minutes: p.duration ? Math.round(Number(p.duration) / 60) : null,
        clips: clipCount.get(pid) ?? { ready: 0, all: 0 },
        queue: spot.get(pid) ?? null,
      };
    }),
    connections: connections.map((c) => ({ platform: String(c.platform), name: String(c.name ?? c.handle ?? '') })),
    posts: posts.map((p) => ({ platform: String(p.platform), status: String(p.status), title: String(p.title ?? ''), at: Number(p.scheduledAt ?? p.createdAt) || 0, error: (p.error as string | null) ?? null, url: (p.remoteUrl as string | null) ?? null })),
  };
}

// ---------------- running now ----------------
export async function runningNow(db: Db, queues: Queues) {
  const jobs = await queueJobs(db, queues);
  const pids = [...new Set(jobs.map((j) => j.projectId).filter(Boolean) as string[])];
  const projects = pids.length
    ? await db.collection('projects').find({ _id: { $in: pids } } as Document, { projection: { title: 1, userId: 1, status: 1, stage: 1, stageDetail: 1, progress: 1, sourceUrl: 1 } }).toArray()
    : [];
  const pmap = new Map(projects.map((p) => [String(p._id), p]));
  const uids = [...new Set(projects.map((p) => String(p.userId)))];
  const people = uids.length ? await db.collection('users').find({ _id: { $in: uids } } as Document, { projection: { email: 1 } }).toArray() : [];
  const email = new Map(people.map((u) => [String(u._id), String(u.email ?? '')]));
  return jobs.map((j) => {
    const p = j.projectId ? pmap.get(j.projectId) : undefined;
    return {
      ...j,
      title: p ? String(p.title ?? p.sourceUrl ?? 'Untitled') : '(deleted project)',
      userId: p ? String(p.userId) : null,
      email: p ? (email.get(String(p.userId)) ?? '') : '',
      progress: p ? Number(p.progress) || 0 : 0,
      stage: p ? String(p.stageDetail || p.stage || '') : '',
    };
  });
}

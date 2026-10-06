import { AsyncLocalStorage } from 'node:async_hooks';
import os from 'node:os';
import { format } from 'node:util';
import { Queue as BullQueue, QueueEvents, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { clips, projects } from '../db/index.js';
import { ensureRedis } from './redis.js';

/**
 * CrestClip's work queue.
 *
 * Production: jobs live in Redis (BullMQ). The website only *adds* jobs; worker containers take them, as many at once
 * as their JOB_CONCURRENCY / RENDER_CONCURRENCY allow — add worker containers to go faster. Because the queue is in
 * Redis, nothing is lost when a container restarts:
 *   - a worker that dies or freezes stops renewing its lock; within ~3 minutes another worker re-runs the job
 *     from where it left off (projects resume: found moments are kept, only missing clips are rendered);
 *   - a job running past JOB_MAX_MINUTES / RENDER_MAX_MINUTES stops its worker container (Docker starts a fresh
 *     one), which re-runs it once the same way;
 *   - a job that gets stuck twice fails for good: the project is marked failed and its credits refunded.
 * Every job's own log lines are saved with it — see them at /admin/queues.
 *
 * No Redis (local dev with REDIS_URL=off): the same jobs run in this process, in memory, like before.
 */

export type JobKind = 'project' | 'render' | 'pick';
type Data = Record<string, unknown>;
type Handler = (data: Data) => Promise<void>;

const PREFIX = 'crestclip';
const QUEUE_OF: Record<JobKind, 'cc-videos' | 'cc-renders'> = { project: 'cc-videos', pick: 'cc-videos', render: 'cc-renders' };
const log = (...a: unknown[]) => console.log('  [queue]', ...a);

// ---------------- what each kind of job does (registered by infra/jobs.ts) ----------------
const handlers = new Map<JobKind, Handler>();
const giveUps = new Map<JobKind, (data: Data, reason: string) => Promise<void>>();
/** `run` does the job; `giveUp` cleans up when it fails for good (e.g. stuck twice). */
export function defineJob(kind: JobKind, run: Handler, giveUp?: (data: Data, reason: string) => Promise<void>) {
  handlers.set(kind, run);
  if (giveUp) giveUps.set(kind, giveUp);
}
async function runJob(kind: JobKind, data: Data) {
  const h = handlers.get(kind);
  if (!h) throw new Error(`No handler for "${kind}" jobs in this process`);
  await h(data);
}

// ---------------- the in-memory queue (no Redis) ----------------
class MemoryQueue {
  private running = 0;
  private items: { key: string; job: () => Promise<void> }[] = [];
  private keys = new Set<string>();
  private active = new Set<string>();
  private dirty = new Map<string, () => Promise<void>>();
  constructor(private limit: number) {}
  /** `front`: ahead of everything waiting (what a person just started beats resumed and Autopilot work). */
  push(key: string, job: () => Promise<void>, front = false) {
    if (this.active.has(key)) {
      this.dirty.set(key, job); // already running → run it again when it finishes (the user changed something mid-render)
      return;
    }
    if (this.keys.has(key)) return;
    this.keys.add(key);
    if (front) this.items.unshift({ key, job });
    else this.items.push({ key, job });
    this.tick();
  }
  /** 0 = running now, n = n jobs ahead of it, null = not here. */
  position(key: string): number | null {
    if (this.active.has(key)) return 0;
    const i = this.items.findIndex((x) => x.key === key);
    return i < 0 ? null : i + this.running;
  }
  private tick() {
    while (this.running < this.limit && this.items.length) {
      const { key, job } = this.items.shift()!;
      this.running++;
      this.active.add(key);
      job()
        .catch((e) => console.error('[queue]', e))
        .finally(() => {
          this.running--;
          this.keys.delete(key);
          this.active.delete(key);
          const again = this.dirty.get(key);
          if (again) {
            this.dirty.delete(key);
            this.push(key, again);
          }
          this.tick();
        });
    }
  }
}
const memory = { 'cc-videos': new MemoryQueue(config.jobConcurrency), 'cc-renders': new MemoryQueue(config.renderConcurrency) };

// ---------------- Redis (BullMQ) ----------------
let conn: Redis | null = null;
const queues: Partial<Record<'cc-videos' | 'cc-renders', BullQueue>> = {};
let mode: 'starting' | 'redis' | 'memory' = 'starting';
let ready: Promise<void> | null = null;

/** Connect to the queue (Redis if there is one). Safe to call more than once. */
export function initQueue(): Promise<void> {
  ready ??= (async () => {
    const url = await ensureRedis();
    if (!url) {
      mode = 'memory';
      log('no Redis — jobs run in this process (in memory)');
      return;
    }
    conn = new Redis(url, { maxRetriesPerRequest: null });
    conn.on('error', (e) => console.warn('  [queue] redis:', e.message));
    for (const name of ['cc-videos', 'cc-renders'] as const) queues[name] = new BullQueue(name, { connection: conn, prefix: PREFIX });
    mode = 'redis';
    log(`using Redis (${config.role})`);
  })();
  return ready;
}
export const queueMode = () => mode;
/** For the /admin/queues dashboard. */
export const bullQueues = () => Object.values(queues).filter(Boolean) as BullQueue[];

/** BullMQ ids can't contain ":" */
const jobId = (kind: JobKind, key: string) => `${kind}-${key}`.replace(/[:]/g, '_');

/**
 * Put a job on the queue. Never throws (logs instead): a project whose job couldn't be queued is picked up again by
 * the scheduler's repair pass (see repairQueue).
 *   'add'    — queue it; if it's running right now, run it again once it finishes (edited mid-render).
 *   'ensure' — queue it only if it isn't queued or running already (repair pass).
 */
async function add(
  kind: JobKind,
  key: string,
  data: Data,
  front: boolean,
  how: 'add' | 'ensure' = 'add',
  /** repair only: is the work still unfinished right now? (re-read just before queueing, so a job that finished a
   *  moment ago isn't run a second time) */
  stillNeeded?: () => Promise<boolean>,
): Promise<void> {
  try {
    await initQueue();
    const qname = QUEUE_OF[kind];
    if (mode === 'memory') {
      if (how === 'ensure' && memory[qname].position(jobId(kind, key)) !== null) return; // queued or running already
      if (stillNeeded && !(await stillNeeded())) return;
      memory[qname].push(jobId(kind, key), () => runJob(kind, data), front);
      return;
    }
    const q = queues[qname]!;
    const id = jobId(kind, key);
    const againKey = `${PREFIX}:again:${id}`;
    const existing = await q.getJob(id);
    if (existing) {
      const state = await existing.getState();
      if (state === 'active') {
        if (how === 'ensure') return;
        // running: ask for one more run when it finishes (the worker checks this key at the end)…
        await conn!.set(againKey, JSON.stringify({ kind, key, data }), 'EX', 86400);
        // …unless it finished in the meantime and already looked: then queue it now ourselves
        if ((await existing.getState()) === 'active' || !(await conn!.getdel(againKey))) return;
      } else if (state === 'waiting' || state === 'prioritized' || state === 'delayed' || state === 'waiting-children') {
        if (front) await existing.changePriority({ priority: 1 }).catch(() => {});
        return;
      } else if (how === 'ensure' && existing.finishedOn && Date.now() - existing.finishedOn < 10 * 60_000) {
        return; // finished minutes ago — the database read that sent us here was older than that
      }
      if (stillNeeded && !(await stillNeeded())) return;
      await existing.remove().catch(() => {}); // finished or failed earlier: start fresh
    } else if (stillNeeded && !(await stillNeeded())) return;
    await q.add(kind, data, {
      jobId: id,
      priority: front ? 1 : 10, // a person waiting beats resumed and Autopilot work
      attempts: kind === 'render' ? 2 : 1, // projects and picks handle (and refund) their own errors; renders get one retry
      backoff: { type: 'fixed', delay: 30_000 },
      removeOnComplete: { age: 2 * 86400, count: 1000 }, // keep two days of history for the dashboard
      removeOnFail: { age: 14 * 86400 },
    });
  } catch (e) {
    console.error(`  [queue] couldn't queue ${kind} ${key}:`, (e as Error).message);
  }
}

/** `front` = a person is waiting for it (New clips, Retry); resumed and Autopilot work queues behind. */
export const enqueueProject = (id: string, front = false) => add('project', id, { id }, front);
export const enqueueRender = (clipId: string) => add('render', clipId, { clipId }, false);
/** Prepare hand-picked parts of a project, then render them (see projects.service runPick). */
export const enqueuePick = (data: { projectId: string; ids: string[]; paid: string | null }) => add('pick', `${data.projectId}-${data.ids.join('_')}`.slice(0, 200), data, true);

// ---------------- "In line · N videos ahead" ----------------
let snapshot = new Map<string, number>();
let snapshotAt = 0;
async function refreshSnapshot() {
  const q = queues['cc-videos'];
  if (!q) return;
  const [active, prioritized, waiting] = await Promise.all([q.getJobs(['active'], 0, 200), q.getJobs(['prioritized'], 0, 500, true), q.getJobs(['waiting'], 0, 500, true)]);
  const next = new Map<string, number>();
  for (const j of active) if (j.name === 'project') next.set(String(j.data.id), 0);
  // prioritized jobs come out lowest priority number first, then oldest first
  const line = [...prioritized.sort((a, b) => (a.priority || 0) - (b.priority || 0) || a.timestamp - b.timestamp), ...waiting];
  line.forEach((j, i) => j.name === 'project' && next.set(String(j.data.id), i + active.length));
  snapshot = next;
  snapshotAt = Date.now();
}
/** How many jobs run before this project starts (0 = running now; null = not known). Refreshed every few seconds. */
export function projectQueuePosition(id: string): number | null {
  if (mode === 'memory') return memory['cc-videos'].position(jobId('project', id));
  if (mode === 'redis' && Date.now() - snapshotAt > 3000) {
    snapshotAt = Date.now(); // one refresh at a time
    void refreshSnapshot().catch(() => {});
  }
  return snapshot.get(id) ?? null;
}

// ---------------- workers (ROLE=worker, or all) ----------------

/** The job whose code is running right now — its console lines are saved with it (seen in the dashboard). */
const current = new AsyncLocalStorage<Job>();
let consoleHooked = false;
function hookConsole() {
  if (consoleHooked) return;
  consoleHooked = true;
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      const job = current.getStore();
      if (job) void job.log(`${new Date().toISOString().slice(11, 19)} ${level === 'log' || level === 'info' ? '' : level.toUpperCase() + ' '}${format(...args)}`.slice(0, 4000)).catch(() => {});
    };
  }
}

/** How long a worker may go without renewing a job's lock before another worker takes the job over. */
const LOCK_MS = Number(process.env.QUEUE_LOCK_MS) || 3 * 60_000;
const running = new Map<string, { kind: JobKind; since: number; job: Job; token?: string }>();
/** Put these running jobs straight back in line (not counted as "stuck"), so another worker picks them up now. */
async function handBack(skip?: string) {
  await Promise.all(
    [...running.entries()]
      .filter(([id]) => id !== skip)
      .map(([, r]) => r.job.moveToWait(r.token).catch((e: Error) => console.warn(`  [queue] couldn't hand back ${r.job.id}: ${e.message}`))),
  );
}
const workers: Worker[] = [];

/** Start taking jobs from Redis. Returns false when there is no Redis (then add() runs jobs in memory instead). */
export async function startWorkers(): Promise<boolean> {
  await initQueue();
  if (mode !== 'redis') return false;
  hookConsole();
  const make = (name: 'cc-videos' | 'cc-renders', concurrency: number) => {
    const w = new Worker(
      name,
      async (job, token) => {
        running.set(job.id!, { kind: job.name as JobKind, since: Date.now(), job, token });
        try {
          await current.run(job, () => runJob(job.name as JobKind, job.data as Data));
        } finally {
          running.delete(job.id!);
          // edited while it ran → once more with the latest settings
          const again = await conn!.getdel(`${PREFIX}:again:${job.id}`).catch(() => null);
          if (again) {
            const a = JSON.parse(again) as { kind: JobKind; key: string; data: Data };
            setTimeout(() => void add(a.kind, a.key, a.data, false), 500);
          }
        }
      },
      {
        connection: conn!.duplicate(),
        prefix: PREFIX,
        name: `${os.hostname()}-${process.pid}`, // which container — shown in the dashboard's worker list
        concurrency: Math.max(1, concurrency),
        lockDuration: LOCK_MS, // a worker that stops renewing for 3 min (dead, frozen) loses the job to another
        stalledInterval: Math.min(60_000, LOCK_MS / 2),
        maxStalledCount: 1, // re-run a stuck job once; the second time it fails for good
      },
    );
    w.on('error', (e) => console.warn(`  [queue] ${name} worker:`, e.message));
    w.on('failed', (job, e) => job && console.warn(`  [queue] ${job.name} ${job.id} failed: ${e.message}`));
    workers.push(w);
  };
  make('cc-videos', config.jobConcurrency);
  make('cc-renders', config.renderConcurrency);
  log(`worker ready — ${config.jobConcurrency} video(s) + ${config.renderConcurrency} render(s) at once`);

  // Overdue watchdog: a job past its time limit is stuck somewhere we can't reach (a hung download, a frozen call).
  // Leave the process: Docker starts a fresh container, and the job's lock runs out so it's re-run once, cleanly.
  let leaving = false;
  setInterval(() => {
    if (leaving) return;
    for (const [id, r] of running) {
      const max = (r.kind === 'render' ? config.renderMaxMinutes : config.jobMaxMinutes) * 60_000;
      if (Date.now() - r.since > max) {
        console.error(`  [queue] ✗ ${id} has run ${Math.round((Date.now() - r.since) / 60_000)} min (limit ${max / 60_000}) — restarting this worker so it re-runs cleanly`);
        leaving = true;
        // the other jobs here are fine: put them back in line first; only the stuck one counts as stuck
        void handBack(id).finally(() => setTimeout(() => process.exit(1), 500));
        return;
      }
    }
  }, Math.min(30_000, LOCK_MS / 4)).unref();

  // Deploys stop containers with SIGTERM: finish quickly or hand the jobs back.
  const stop = async () => {
    log(`stopping — ${running.size} unfinished job(s) go back in line for another worker`);
    // take no new jobs, hand the running ones back (not counted as stuck — deploys never fail a video)
    await Promise.race([Promise.all(workers.map((w) => w.pause(true))), new Promise((r) => setTimeout(r, 3000))]).catch(() => {});
    await handBack();
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  return true;
}

// ---------------- repair + give-up (ROLE=scheduler, or all) ----------------

/** Queue every unfinished project/clip in the database that has no job (Redis emptied, a crash before queueing…). */
export async function repairQueue() {
  await initQueue();
  const recent = Date.now() - 30 * 60_000;
  const list = await projects.unfinished();
  const busy = new Set<string>();
  // what someone started in the last half hour goes first; long jobs that were mid-way resume after it
  for (const p of [...list.filter((p) => p.createdAt >= recent), ...list.filter((p) => p.createdAt < recent)]) {
    busy.add(p.id);
    const stillOpen = async () => ['queued', 'processing'].includes((await projects.get(p.id))?.status ?? '');
    await add('project', p.id, { id: p.id }, p.createdAt >= recent, 'ensure', stillOpen);
  }
  for (const c of await clips.unfinished()) {
    if (busy.has(c.projectId)) continue;
    const stillOpen = async () => ['pending', 'rendering'].includes((await clips.get(c.id))?.status ?? '');
    await add('render', c.id, { clipId: c.id }, false, 'ensure', stillOpen);
  }
}

/** When a job fails for good (stuck twice), tell its project/clip and refund — once, from the scheduler. */
export async function watchFailures() {
  await initQueue();
  if (mode !== 'redis') return;
  for (const name of ['cc-videos', 'cc-renders'] as const) {
    const events = new QueueEvents(name, { connection: conn!.duplicate(), prefix: PREFIX });
    events.on('failed', ({ jobId: id, failedReason }) => {
      void (async () => {
        const job = await queues[name]!.getJob(id);
        if (!job) return;
        // Only jobs that got stuck: a job that failed with an error already cleaned up (and refunded) itself.
        if (!/stalled/i.test(failedReason)) return;
        await giveUps.get(job.name as JobKind)?.(job.data as Data, 'It got stuck twice and was stopped. Please try again.');
      })().catch((e) => console.warn('  [queue] give-up:', (e as Error).message));
    });
  }
}

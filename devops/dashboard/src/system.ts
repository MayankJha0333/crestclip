import fs from 'node:fs';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { containers, dockerAvailable, groupOf, type ContainerNow } from './docker.js';

/** The queues the app uses (same names and prefix as server/src/infra/queue.ts and the Autopilot engine). */
export const QUEUE_NAMES = [
  { name: 'cc-videos', label: 'Videos (clipping)' },
  { name: 'cc-renders', label: 'Clip renders' },
  { name: 'autopilot', label: 'Autopilot checks' },
  { name: 'autopilot-post', label: 'Autopilot posts' },
] as const;
export const PREFIX = 'crestclip';

export function makeQueues(conn: Redis) {
  return QUEUE_NAMES.map((q) => ({ ...q, queue: new Queue(q.name, { connection: conn, prefix: PREFIX }) }));
}

/** The website copies (Caddy balances between them). */
const WEB = (process.env.WEB_PORTS || '8787,8788').split(',').map((p) => Number(p.trim()));

async function webHealth() {
  return Promise.all(
    WEB.map(async (port) => {
      const t = Date.now();
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/live`, { signal: AbortSignal.timeout(3000) });
        const j = (await r.json().catch(() => ({}))) as { version?: string };
        return { port, ok: r.ok, ms: Date.now() - t, version: j.version ?? '' };
      } catch {
        return { port, ok: false, ms: Date.now() - t, version: '' };
      }
    }),
  );
}

function disk() {
  try {
    const s = fs.statfsSync(process.env.DATA_DIR || '/data');
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { totalGb: +(total / 1e9).toFixed(1), usedGb: +((total - free) / 1e9).toFixed(1), pct: Math.round(((total - free) / total) * 100) };
  } catch {
    return null;
  }
}

export async function overview(conn: Redis, queues: ReturnType<typeof makeQueues>) {
  const [web, qs, info, list] = await Promise.all([
    webHealth(),
    Promise.all(
      queues.map(async (q) => {
        const [counts, workers, line] = await Promise.all([
          q.queue.getJobCounts('active', 'waiting', 'prioritized', 'delayed', 'failed', 'completed'),
          // each worker holds two connections — count distinct worker names, not connections
          q.queue
            .getWorkers()
            .then((ws) => new Set(ws.map((w) => String((w as { rawname?: string }).rawname ?? w.addr))).size)
            .catch(() => 0),
          q.queue.getJobs(['waiting', 'prioritized'], 0, 300).catch(() => []),
        ]);
        const oldest = line.length ? Math.min(...line.map((j) => j.timestamp)) : 0;
        const n = (k: string) => Number(counts[k] ?? 0);
        return { name: q.name, label: q.label, workers, active: n('active'), waiting: n('waiting') + n('prioritized') + n('delayed'), failed: n('failed'), completed: n('completed'), longestWaitMin: oldest ? Math.round((Date.now() - oldest) / 60_000) : 0 };
      }),
    ),
    conn.info('memory').catch(() => ''),
    dockerAvailable() ? containers().catch(() => [] as ContainerNow[]) : Promise.resolve(null),
  ]);
  const mem = Number(info.match(/used_memory:(\d+)/)?.[1] ?? 0);
  const maxMem = Number(info.match(/maxmemory:(\d+)/)?.[1] ?? 0);
  return {
    web,
    queues: qs,
    redis: { usedMb: Math.round(mem / 1048576), maxMb: Math.round(maxMem / 1048576) },
    disk: disk(),
    containers: list?.map((c) => ({ ...c, group: groupOf(c.service) })).sort((a, b) => a.service.localeCompare(b.service)) ?? null,
  };
}

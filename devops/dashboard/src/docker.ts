import fs from 'node:fs';
import http from 'node:http';

/**
 * Read-only questions to Docker on this server (through its socket, mounted read-only into this container):
 * which CrestClip containers run, and how much CPU and memory each uses right now.
 */

const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
export const dockerAvailable = () => fs.existsSync(SOCKET);

function get<T>(path: string, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath: SOCKET, path, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        if ((res.statusCode ?? 500) >= 300) return reject(new Error(`docker ${path}: ${res.statusCode}`));
        try {
          resolve(JSON.parse(body) as T);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('docker: timed out')));
    req.on('error', reject);
  });
}

interface RawContainer {
  Id: string;
  Names: string[];
  State: string;
  Status: string;
  Image: string;
  Labels: Record<string, string>;
}
interface RawStats {
  cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number };
  memory_stats: { usage?: number; limit?: number; stats?: Record<string, number> };
}

export interface ContainerNow {
  name: string;
  /** compose service: web-1, worker, redis… */
  service: string;
  state: string;
  status: string;
  /** % of the whole server's CPU (all cores together = 100) */
  cpu: number;
  memMb: number;
}

export async function containers(): Promise<ContainerNow[]> {
  const list = await get<RawContainer[]>('/containers/json?all=1');
  const mine = list.filter((c) => c.Labels['com.docker.compose.project'] === (process.env.COMPOSE_PROJECT || 'crestclip'));
  return Promise.all(
    mine.map(async (c) => {
      const base = { name: c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12), service: c.Labels['com.docker.compose.service'] ?? '?', state: c.State, status: c.Status };
      if (c.State !== 'running') return { ...base, cpu: 0, memMb: 0 };
      try {
        const s = await get<RawStats>(`/containers/${c.Id}/stats?stream=false`);
        const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
        const sysDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0);
        const cpu = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * 100 : 0;
        const cache = s.memory_stats.stats?.inactive_file ?? s.memory_stats.stats?.cache ?? 0;
        const memMb = Math.max(0, (s.memory_stats.usage ?? 0) - cache) / 1048576;
        return { ...base, cpu: +cpu.toFixed(1), memMb: Math.round(memMb) };
      } catch {
        return { ...base, cpu: 0, memMb: 0 };
      }
    }),
  );
}

/** Group containers by what they are for (both web copies → "Website", all workers → "Workers"). */
export function groupOf(service: string): string {
  if (service.startsWith('web')) return 'Website';
  if (service.startsWith('worker')) return 'Workers (video jobs)';
  if (service === 'scheduler') return 'Scheduler (posts, Autopilot)';
  if (service === 'redis') return 'Redis (job queue)';
  if (service === 'pot') return 'YouTube token helper';
  if (service === 'caddy') return 'Caddy (HTTPS + load balancer)';
  if (service === 'dashboard' || service === 'dozzle') return 'Admin pages';
  return service;
}

// ---- CPU share over time: sampled every 30 s, so the split isn't just one moment ----
const samples: { at: number; byGroup: Record<string, number> }[] = [];
export function startSampling() {
  if (!dockerAvailable()) return;
  const take = async () => {
    try {
      const byGroup: Record<string, number> = {};
      for (const c of await containers()) byGroup[groupOf(c.service)] = (byGroup[groupOf(c.service)] ?? 0) + c.cpu;
      samples.push({ at: Date.now(), byGroup });
      while (samples.length && samples[0].at < Date.now() - 24 * 3600_000) samples.shift(); // keep a day
    } catch {
      /* Docker busy — next time */
    }
  };
  void take();
  setInterval(() => void take(), 30_000).unref();
}
/** Average CPU % per group since sampling started (up to 24 h), plus how long that covers. */
export function cpuAverages(): { byGroup: Record<string, number>; hours: number; samples: number } {
  const byGroup: Record<string, number> = {};
  for (const s of samples) for (const [g, v] of Object.entries(s.byGroup)) byGroup[g] = (byGroup[g] ?? 0) + v;
  for (const g of Object.keys(byGroup)) byGroup[g] = +(byGroup[g] / Math.max(1, samples.length)).toFixed(1);
  const hours = samples.length ? (Date.now() - samples[0].at) / 3600_000 : 0;
  return { byGroup, hours, samples: samples.length };
}

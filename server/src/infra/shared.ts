import { Redis } from 'ioredis';
import { ensureRedis } from './redis.js';

/**
 * Tiny key → value store shared by every CrestClip process (Redis), for short-lived values that must survive the
 * request landing on another app copy: OAuth "state" checks, the Google sign-in hand-off, rate-limit counters.
 * Falls back to this process's memory when Redis isn't available (local dev without Redis) — same behaviour as before.
 */

const PREFIX = 'cc:shared:';
let client: Redis | null = null;
let starting: Promise<Redis | null> | null = null;

function redis(): Promise<Redis | null> {
  if (client) return Promise.resolve(client);
  starting ??= ensureRedis()
    .then((url) => {
      if (!url) return null;
      client = new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: true, lazyConnect: false });
      client.on('error', () => {}); // the queue logs Redis trouble; don't repeat it here
      return client;
    })
    .catch(() => null)
    .finally(() => {
      if (!client) starting = null; // try again next time
    });
  return starting;
}

// ---- memory fallback ----
const mem = new Map<string, { v: string; until: number }>();
function memGet(k: string) {
  const e = mem.get(k);
  if (!e) return null;
  if (Date.now() > e.until) {
    mem.delete(k);
    return null;
  }
  return e.v;
}
function sweep() {
  if (mem.size < 2000) return;
  const t = Date.now();
  for (const [k, e] of mem) if (t > e.until) mem.delete(k);
}

/** Save a value for `ttlMs`. */
export async function putShared(key: string, value: unknown, ttlMs: number): Promise<void> {
  const v = JSON.stringify(value);
  const r = await redis();
  if (r) {
    await r.set(PREFIX + key, v, 'PX', ttlMs);
    return;
  }
  sweep();
  mem.set(key, { v, until: Date.now() + ttlMs });
}

/** Read a value once and delete it (one-time tokens). Null when missing or expired. */
export async function takeShared<T>(key: string): Promise<T | null> {
  const r = await redis();
  const v = r ? await r.getdel(PREFIX + key) : memGet(key);
  if (!r) mem.delete(key);
  return v == null ? null : (JSON.parse(v) as T);
}

/** Count one more hit in a window that starts with the first hit; returns the count so far. */
export async function hitShared(key: string, windowMs: number): Promise<number> {
  const r = await redis();
  if (r) {
    const k = PREFIX + 'hits:' + key;
    const [[, n]] = (await r.multi().incr(k).pexpire(k, windowMs, 'NX').exec()) as [[unknown, number], unknown];
    return n;
  }
  const k = 'hits:' + key;
  const cur = Number(memGet(k) ?? 0) + 1;
  const left = mem.get(k)?.until ?? Date.now() + windowMs;
  sweep();
  mem.set(k, { v: String(cur), until: left });
  return cur;
}

// ---------------- locks shared by every process ----------------
export const BUSY = Symbol('busy');
const UNLOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const RENEW = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

/**
 * Run `fn` while holding a lock that every CrestClip process respects (two workers never render the same clip or
 * download the same video's parts at once). The lock renews itself while `fn` runs and frees itself if the process
 * dies. `wait: true` waits its turn; `wait: false` returns BUSY when someone else holds it. No Redis → just runs.
 */
export async function withClusterLock<T>(name: string, fn: () => Promise<T>, opts: { wait: boolean; ttlMs?: number }): Promise<T | typeof BUSY> {
  const r = await redis();
  if (!r) return fn();
  const key = `${PREFIX}lock:${name}`;
  const ttl = opts.ttlMs ?? 60_000;
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  for (;;) {
    if ((await r.set(key, token, 'PX', ttl, 'NX')) === 'OK') break;
    if (!opts.wait) return BUSY;
    await new Promise((res) => setTimeout(res, 1000));
  }
  const renew = setInterval(() => void r.eval(RENEW, 1, key, token, String(ttl)).catch(() => {}), ttl / 3);
  try {
    return await fn();
  } finally {
    clearInterval(renew);
    await r.eval(UNLOCK, 1, key, token).catch(() => {});
  }
}

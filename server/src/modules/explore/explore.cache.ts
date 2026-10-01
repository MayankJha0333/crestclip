import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';

/**
 * Stale-while-revalidate cache, saved to disk:
 *  • fresh hit → instant
 *  • stale hit → instant (old data), refreshed in the background for the next visit
 *  • survives server restarts (data/cache/explore-v2.json), so Explore is never slow after a restart
 */
const cache = new Map<string, { at: number; data: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
// bump the file name when the item format changes
const cacheFile = path.join(config.dataDir, 'cache', 'explore-v2.json');
const MAX_STALE = 24 * 3600_000; // never show anything older than a day
try {
  const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as [string, { at: number; data: unknown }][];
  for (const [k, v] of saved) if (Date.now() - v.at < MAX_STALE) cache.set(k, v);
} catch {
  /* first run */
}
let saveTimer: NodeJS.Timeout | null = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      // keep the feeds + recent searches/peeks, newest last
      const entries = [...cache.entries()].filter(([, v]) => Date.now() - v.at < MAX_STALE).slice(-250);
      fs.writeFileSync(`${cacheFile}.tmp`, JSON.stringify(entries));
      fs.renameSync(`${cacheFile}.tmp`, cacheFile);
    } catch {
      /* best effort */
    }
  }, 1500);
  saveTimer.unref?.();
}
export function refresh<T>(key: string, fn: () => Promise<T>, keep?: (d: T) => boolean): Promise<T> {
  const cur = inflight.get(key) as Promise<T> | undefined;
  if (cur) return cur;
  const p = fn()
    .then((data) => {
      if (!keep || keep(data)) {
        cache.delete(key);
        cache.set(key, { at: Date.now(), data });
        if (cache.size > 300) cache.delete(cache.keys().next().value as string);
        persist();
      }
      return data;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, keep?: (d: T) => boolean): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data as T;
  if (hit && Date.now() - hit.at < MAX_STALE) {
    refresh(key, fn, keep).catch(() => {}); // update quietly for next time
    return hit.data as T;
  }
  return refresh(key, fn, keep);
}

/** When `key` was last stored (null if it isn't cached). */
export const cachedAt = (key: string) => cache.get(key)?.at ?? null;

/** For /api/explore/meta. */
export const cacheStats = () => ({ cached: cache.size, refreshing: [...inflight.keys()] });

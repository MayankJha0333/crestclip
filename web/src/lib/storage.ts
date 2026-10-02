/** Small, crash-proof localStorage helpers (private mode / blocked storage just means "no memory"). */
export function readLocal<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function writeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

/** Remember recent searches (most recent first, unique, max 8). */
export function pushRecentSearch(q: string) {
  const list = readLocal<string[]>('crestclip:recent-searches', []).filter((x) => x.toLowerCase() !== q.toLowerCase());
  writeLocal('crestclip:recent-searches', [q, ...list].slice(0, 8));
}

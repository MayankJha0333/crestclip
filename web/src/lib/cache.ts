import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { readLocal, writeLocal } from './storage';

/**
 * Last-known data for signed-in pages. A page draws straight away from what this browser saw last time (projects,
 * posts, autopilots…) and the fresh copy from the server replaces it a moment later — no grey skeleton while the
 * API answers. Keyed per account, so switching accounts in one browser never shows someone else's list.
 */
const PREFIX = 'crestclip:cache:';
const INDEX = `${PREFIX}keys`;
const MAX_BYTES = 400_000; // per entry; bigger ones just aren't remembered

let who = '';
/** Called by the auth layer with the signed-in account's id ('' when signed out). Clears the cache on a switch. */
export function setCacheOwner(userId: string) {
  if (userId === who) return;
  if (who && userId !== who) clearCache();
  who = userId;
}

export function clearCache() {
  try {
    for (const k of readLocal<string[]>(INDEX, [])) localStorage.removeItem(k);
    localStorage.removeItem(INDEX);
  } catch {
    /* ignore */
  }
}

const fullKey = (key: string) => `${PREFIX}${who}:${key}`;

function remember(key: string, value: unknown) {
  if (!who) return;
  try {
    const text = JSON.stringify(value);
    if (text.length > MAX_BYTES) return;
    const k = fullKey(key);
    localStorage.setItem(k, text);
    const keys = readLocal<string[]>(INDEX, []);
    if (!keys.includes(k)) writeLocal(INDEX, [...keys, k].slice(-60));
  } catch {
    /* ignore */
  }
}

/**
 * Like useState, but seeded from the last value this browser saw for `key`, and remembering every value set.
 * `null`/`undefined` values are not remembered (they mean "not loaded yet" or "gone").
 */
export function useCachedState<T>(key: string): [T | null, Dispatch<SetStateAction<T | null>>] {
  const [value, setValue] = useState<T | null>(() => (who ? readLocal<T | null>(fullKey(key), null) : null));
  const set = useCallback<Dispatch<SetStateAction<T | null>>>(
    (next) => {
      setValue((prev) => {
        const v = typeof next === 'function' ? (next as (p: T | null) => T | null)(prev) : next;
        if (v != null) remember(key, v);
        return v;
      });
    },
    [key],
  );
  return [value, set];
}


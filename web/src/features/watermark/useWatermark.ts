import { useEffect, useSyncExternalStore } from 'react';
import { api, type Watermark } from '../../lib/api';

/** One shared copy of the watermark settings, so Settings and every preview stay in step. */
let current: Watermark | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function setWatermark(w: Watermark) {
  current = w;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The person's watermark (null while loading). Fetched once per page load. */
export function useWatermark() {
  useEffect(() => {
    loading ??= api
      .watermark()
      .then(setWatermark)
      .catch(() => {
        loading = null; // try again next time something asks
      });
  }, []);
  return useSyncExternalStore(subscribe, () => current);
}

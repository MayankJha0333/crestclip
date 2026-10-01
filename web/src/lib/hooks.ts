import { useEffect, useRef } from 'react';

/** Run `fn` now and every `ms` while `enabled` (polling the API for progress). */
export function usePolling(fn: () => unknown, ms: number, enabled = true) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!enabled) return;
    latest.current();
    const t = setInterval(() => latest.current(), ms);
    return () => clearInterval(t);
  }, [ms, enabled]);
}

/** Call `fn` when a key is pressed anywhere (ignored while typing in a field unless `inFields`). */
export function useKey(key: string, fn: (e: KeyboardEvent) => void, opts: { enabled?: boolean; inFields?: boolean } = {}) {
  const latest = useRef(fn);
  latest.current = fn;
  const { enabled = true, inFields = false } = opts;
  useEffect(() => {
    if (!enabled) return;
    const on = (e: KeyboardEvent) => {
      if (e.key !== key) return;
      if (!inFields && /input|textarea|select/i.test((e.target as HTMLElement).tagName)) return;
      latest.current(e);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [key, enabled, inFields]);
}

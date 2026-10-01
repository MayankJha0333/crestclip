import { useSyncExternalStore } from 'react';

/** 'system' follows the computer's light/dark setting. index.html applies it before first paint. */
export type ThemeChoice = 'light' | 'dark' | 'system';
const KEY = 'crestclip-theme';

const read = (): ThemeChoice => {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* storage blocked — just follow the computer */
  }
  return 'system';
};

let choice: ThemeChoice = read();
const listeners = new Set<() => void>();
const media = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : null;

function apply() {
  const dark = choice === 'dark' || (choice === 'system' && Boolean(media?.matches));
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
media?.addEventListener('change', () => choice === 'system' && apply());

function setTheme(next: ThemeChoice) {
  choice = next;
  try {
    localStorage.setItem(KEY, next); // plain string — index.html reads it before React loads
  } catch {
    /* not remembered, still applied */
  }
  apply();
  listeners.forEach((l) => l());
}

export function useTheme() {
  const value = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => choice,
  );
  return [value, setTheme] as const;
}

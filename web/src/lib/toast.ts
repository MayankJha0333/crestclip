export type Toast = { id: number; text: string; tone: 'ok' | 'error' | 'info' };
type Listener = (t: Toast[]) => void;
let toasts: Toast[] = [];
const listeners = new Set<Listener>();
let next = 1;

/** Show a message for a few seconds (errors stay longer so there's time to read them). */
export function toast(text: string, tone: Toast['tone'] = 'ok') {
  if (toasts.some((x) => x.text === text && x.tone === tone)) return; // already showing
  const t = { id: next++, text, tone };
  toasts = [...toasts, t].slice(-3);
  listeners.forEach((l) => l(toasts));
  setTimeout(
    () => {
      toasts = toasts.filter((x) => x.id !== t.id);
      listeners.forEach((l) => l(toasts));
    },
    tone === 'error' ? 8000 : 3600,
  );
}
/** Listen for messages — starting with any already showing (a page can send one before the Toaster is ready). */
export function subscribeToasts(l: Listener) {
  listeners.add(l);
  l(toasts);
  return () => {
    listeners.delete(l);
  };
}

export type Toast = { id: number; text: string; tone: 'ok' | 'error' | 'info' };
type Listener = (t: Toast[]) => void;
let toasts: Toast[] = [];
const listeners = new Set<Listener>();
let next = 1;

export function toast(text: string, tone: Toast['tone'] = 'ok') {
  const t = { id: next++, text, tone };
  toasts = [...toasts, t].slice(-3);
  listeners.forEach((l) => l(toasts));
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    listeners.forEach((l) => l(toasts));
  }, 3600);
}
export function subscribeToasts(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

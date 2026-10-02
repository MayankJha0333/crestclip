import { useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { fmtPrecise, fmtTime } from '../../lib/format';

/** Shortest clip allowed (seconds). */
export const MIN_CLIP = 3;

type Range = { start: number; end: number };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * A strip of the source video around the clip. Grey dashes = someone talking; the orange window = the clip.
 * Drag either handle (or focus it and use ← →) to trim. Joined clips show each part; the handles move
 * the start of the first part and the end of the last.
 */
export function TrimTimeline({
  start,
  end,
  parts,
  lines,
  bounds,
  onChange,
}: {
  start: number;
  end: number;
  parts: Range[];
  lines: { s: number; e: number }[];
  bounds: { from: number; to: number };
  onChange: (start: number, end: number) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const latest = useRef({ start, end, onChange });
  latest.current = { start, end, onChange };
  const span = Math.max(1, bounds.to - bounds.from);
  const pct = (t: number) => `${clamp(((t - bounds.from) / span) * 100, 0, 100)}%`;

  const set = (which: 'start' | 'end', t: number) => {
    const { start: s, end: e, onChange: change } = latest.current;
    t = +t.toFixed(1);
    if (which === 'start') change(clamp(t, bounds.from, e - MIN_CLIP), e);
    else change(s, clamp(t, s + MIN_CLIP, bounds.to));
  };

  const grab = (which: 'start' | 'end') => (e: ReactPointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).focus();
    const move = (ev: PointerEvent) => {
      const r = bar.current!.getBoundingClientRect();
      set(which, bounds.from + clamp((ev.clientX - r.left) / r.width, 0, 1) * span);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const keys = (which: 'start' | 'end') => (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.5;
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -step : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? step : 0;
    if (!d) return;
    e.preventDefault();
    set(which, (which === 'start' ? latest.current.start : latest.current.end) + d);
  };

  const handle = (which: 'start' | 'end', t: number) => (
    <button
      type="button"
      role="slider"
      aria-label={which === 'start' ? 'Clip start' : 'Clip end'}
      aria-valuemin={Math.round(bounds.from)}
      aria-valuemax={Math.round(bounds.to)}
      aria-valuenow={t}
      aria-valuetext={fmtPrecise(t)}
      onPointerDown={grab(which)}
      onKeyDown={keys(which)}
      style={{ left: pct(t) }}
      className="group absolute inset-y-0 z-10 grid w-6 -translate-x-1/2 cursor-ew-resize touch-none place-items-center outline-none"
    >
      <span className="h-10 w-3 rounded-full bg-surface shadow-clay-sm ring-2 ring-tangerine transition-transform group-hover:scale-110 group-focus-visible:ring-4" />
    </button>
  );

  return (
    <div>
      <div ref={bar} className="relative h-16 rounded-2xl bg-sunken shadow-well">
        {/* speech */}
        {lines
          .filter((l) => l.e > bounds.from && l.s < bounds.to)
          .map((l, i) => (
            <span key={i} aria-hidden className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-ink/15" style={{ left: pct(l.s), width: `calc(${pct(l.e)} - ${pct(l.s)} - 2px)` }} />
          ))}
        {/* the clip */}
        {parts.map((p, i) => (
          <span
            key={i}
            aria-hidden
            className="absolute inset-y-1.5 rounded-xl bg-tangerine/20 shadow-[inset_0_0_0_2px_var(--tangerine)]"
            style={{ left: pct(p.start), width: `calc(${pct(p.end)} - ${pct(p.start)})` }}
          />
        ))}
        {handle('start', start)}
        {handle('end', end)}
      </div>
      <div className="mt-1.5 flex justify-between px-1 text-[11px] font-bold text-ink-3 tabular-nums">
        <span>{fmtTime(bounds.from)}</span>
        <span>{fmtTime(bounds.to)}</span>
      </div>
    </div>
  );
}

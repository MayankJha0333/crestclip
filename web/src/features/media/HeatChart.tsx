import { useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { TimeRange } from '../../lib/api';
import { fmtTime } from '../../lib/format';
import { Badge } from '../../components/ui';

interface Band {
  id: string;
  start: number;
  end: number;
  rank: number;
}

const MIN_PICK = 2; // seconds
const MAX_PICK = 180;

/**
 * "Most replayed" style curve: one series (engagement 0..1 across the video),
 * with the chosen clips drawn as numbered bands. Hover shows time + strength.
 *
 * Optional interactions:
 *  • onSeek      — click anywhere to jump there (Explore preview)
 *  • selections  — drag across the graph to pick parts to clip; drag a pick's edges to adjust it
 */
export function HeatChart({
  curve,
  duration,
  bands,
  kind,
  activeId,
  onPick,
  onSeek,
  playhead,
  selections,
  onSelectionsChange,
  height = 190,
}: {
  curve: number[];
  duration: number;
  bands: Band[];
  kind: 'audience' | 'energy' | 'none';
  activeId?: string | null;
  onPick?: (id: string) => void;
  onSeek?: (t: number) => void;
  playhead?: number | null;
  selections?: TimeRange[];
  onSelectionsChange?: (r: TimeRange[]) => void;
  height?: number;
}) {
  const W = 1000;
  const H = height;
  const top = 34;
  const bottom = 26;
  const plotH = H - top - bottom;
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const drag = useRef<{ mode: 'new' | 'start' | 'end'; anchor: number; idx: number; moved: boolean } | null>(null);
  const [draft, setDraft] = useState<TimeRange | null>(null);
  const selectable = Boolean(onSelectionsChange);
  const picks = selections ?? [];

  const pts = useMemo(() => curve.map((v, i) => [((i + 0.5) / curve.length) * W, top + plotH - v * plotH] as const), [curve, plotH]);
  const line = useMemo(() => {
    if (!pts.length) return '';
    let d = `M0,${pts[0][1]} L${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const mx = (x0 + x1) / 2;
      d += ` C${mx},${y0} ${mx},${y1} ${x1},${y1}`;
    }
    d += ` L${W},${pts[pts.length - 1][1]}`;
    return d;
  }, [pts]);
  const area = `${line} L${W},${top + plotH} L0,${top + plotH} Z`;
  const x = (t: number) => (t / duration) * W;

  const fracAt = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return 0;
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };
  /** which edge of which pick is under the pointer (within ~8 px) */
  const edgeAt = (clientX: number): { idx: number; edge: 'start' | 'end' } | null => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || !picks.length) return null;
    const tol = (8 / r.width) * duration;
    const t = fracAt(clientX) * duration;
    for (let i = 0; i < picks.length; i++) {
      if (Math.abs(t - picks[i].start) <= tol) return { idx: i, edge: 'start' };
      if (Math.abs(t - picks[i].end) <= tol) return { idx: i, edge: 'end' };
    }
    return null;
  };
  const [edgeHover, setEdgeHover] = useState(false);

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const t = fracAt(e.clientX) * duration;
    const edge = selectable ? edgeAt(e.clientX) : null;
    drag.current = edge ? { mode: edge.edge, anchor: t, idx: edge.idx, moved: false } : { mode: 'new', anchor: t, idx: -1, moved: false };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    const fx = fracAt(e.clientX);
    setHover(fx);
    const t = fx * duration;
    const d = drag.current;
    if (!d) {
      if (selectable) setEdgeHover(Boolean(edgeAt(e.clientX)));
      return;
    }
    const r = ref.current?.getBoundingClientRect();
    const px = r ? (Math.abs(t - d.anchor) / duration) * r.width : 0;
    if (!d.moved && px < 6) return;
    d.moved = true;
    if (d.mode === 'new') {
      if (!selectable) return;
      let s = Math.min(d.anchor, t);
      let en = Math.max(d.anchor, t);
      if (en - s > MAX_PICK) {
        if (t < d.anchor) s = en - MAX_PICK;
        else en = s + MAX_PICK;
      }
      setDraft({ start: s, end: en });
    } else {
      const next = picks.map((p) => ({ ...p }));
      const p = next[d.idx];
      if (d.mode === 'start') p.start = Math.max(0, Math.min(t, p.end - MIN_PICK, p.end));
      else p.end = Math.min(duration, Math.max(t, p.start + MIN_PICK));
      if (p.end - p.start > MAX_PICK) {
        if (d.mode === 'start') p.start = p.end - MAX_PICK;
        else p.end = p.start + MAX_PICK;
      }
      onSelectionsChange?.(next);
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const t = fracAt(e.clientX) * duration;
    if (d.mode === 'new' && d.moved && draft) {
      setDraft(null);
      if (draft.end - draft.start >= MIN_PICK) onSelectionsChange?.([...picks, { start: +draft.start.toFixed(2), end: +draft.end.toFixed(2) }]);
      return;
    }
    setDraft(null);
    if (d.moved) return; // finished resizing
    // a plain click
    const band = bands.find((b) => t >= b.start && t <= b.end);
    if (band && onPick) onPick(band.id);
    else if (onSeek) onSeek(t);
  };

  const hoverIdx = hover == null ? null : Math.min(curve.length - 1, Math.floor(hover * curve.length));
  const hoverT = hover == null ? 0 : hover * duration;
  const inBand = hover == null ? null : bands.find((b) => hoverT >= b.start && hoverT <= b.end);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const label = kind === 'audience' ? 'replay strength' : 'energy';
  const cursor = edgeHover ? 'ew-resize' : selectable ? 'crosshair' : onSeek || onPick ? 'pointer' : 'default';

  return (
    <div className="relative select-none">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        width="100%"
        height={H}
        role="img"
        aria-label={`${kind === 'audience' ? 'Most replayed' : 'Audio energy'} across the video with ${bands.length} clips marked${selectable ? '. Drag across it to pick your own parts.' : ''}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={() => !drag.current && setHover(null)}
        style={{ display: 'block', overflow: 'visible', cursor, touchAction: selectable ? 'none' : 'auto' }}
      >
        <defs>
          <linearGradient id="heatfill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#ff8a5b" stopOpacity="0.55" />
            <stop offset="1" stopColor="#ff8a5b" stopOpacity="0.08" />
          </linearGradient>
        </defs>
        {/* recessive grid */}
        {[0.5, 1].map((g) => (
          <line key={g} x1={0} x2={W} y1={top + plotH - g * plotH} y2={top + plotH - g * plotH} style={{ stroke: 'var(--line)' }} strokeDasharray="4 6" vectorEffect="non-scaling-stroke" />
        ))}
        <line x1={0} x2={W} y1={top + plotH} y2={top + plotH} style={{ stroke: 'var(--line-strong)' }} vectorEffect="non-scaling-stroke" />

        {/* clip bands */}
        {bands.map((b, i) => {
          const active = b.id === activeId || inBand?.id === b.id;
          return (
            <rect
              key={`${b.id}-${i}`}
              x={x(b.start)}
              y={top - 6}
              width={Math.max(3, x(b.end) - x(b.start))}
              height={plotH + 6}
              rx={6}
              style={{ fill: active ? 'rgba(111,224,191,.38)' : 'var(--muted-bg)' }}
            />
          );
        })}

        {kind !== 'none' && (
          <>
            <path d={area} fill="url(#heatfill)" />
            <path d={line} fill="none" stroke="#e0643a" strokeWidth={2.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </>
        )}

        {/* the user's picks (+ the one being dragged) */}
        {[...picks, ...(draft ? [draft] : [])].map((r, i) => (
          <g key={`pick-${i}`}>
            <rect
              x={x(r.start)}
              y={top - 10}
              width={Math.max(2, x(r.end) - x(r.start))}
              height={plotH + 10}
              fill="rgba(255,196,61,.30)"
              stroke="#e0a100"
              strokeWidth={1.5}
              strokeDasharray={draft && i === picks.length ? '5 4' : undefined}
              vectorEffect="non-scaling-stroke"
            />
            {/* edge handles */}
            <rect x={x(r.start) - 2.5} y={top + plotH / 2 - 16} width={5} height={32} rx={2.5} fill="#e0a100" />
            <rect x={x(r.end) - 2.5} y={top + plotH / 2 - 16} width={5} height={32} rx={2.5} fill="#e0a100" />
          </g>
        ))}

        {playhead != null && playhead >= 0 && <line x1={x(playhead)} x2={x(playhead)} y1={top - 10} y2={top + plotH} stroke="#e0643a" strokeWidth={2} vectorEffect="non-scaling-stroke" />}

        {hover != null && <line x1={hover * W} x2={hover * W} y1={top - 6} y2={top + plotH} style={{ stroke: 'var(--ink)' }} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}

        {/* time axis */}
        {ticks.map((t) => (
          <text key={t} x={t * W} y={H - 6} fontSize="12" textAnchor={t === 0 ? 'start' : t === 1 ? 'end' : 'middle'} style={{ fill: 'var(--ink-3)', fontFamily: 'var(--font-body)', fontWeight: 700 }}>
            {fmtTime(t * duration)}
          </text>
        ))}
      </svg>

      {/* band number chips as HTML so they don't stretch */}
      {bands.map((b, i) => (
        <button
          key={`${b.id}-${i}`}
          type="button"
          onClick={() => onPick?.(b.id)}
          className="absolute top-0.5 z-[2] grid size-6.5 -translate-x-1/2 place-items-center rounded-full text-xs font-black text-ink shadow-flat"
          aria-label={`Clip ${b.rank}, ${fmtTime(b.start)} to ${fmtTime(b.end)}`}
          style={{
            left: `${((b.start + b.end) / 2 / duration) * 100}%`,
            background: b.id === activeId ? 'var(--mint)' : 'var(--surface)',
          }}
        >
          {b.rank}
        </button>
      ))}

      {/* remove buttons on picks */}
      {picks.map((r, i) => (
        <button
          key={`rm-${i}`}
          type="button"
          className="absolute bottom-7.5 z-[2] inline-flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-[#ffc43d] px-2 py-0.5 text-xs font-black text-[#3a2a00] shadow-flat hover:bg-[#ffb400]"
          onClick={() => onSelectionsChange?.(picks.filter((_, j) => j !== i))}
          aria-label={`Remove pick ${i + 1}, ${fmtTime(r.start)} to ${fmtTime(r.end)}`}
          title="Remove this pick"
          style={{ left: `${((r.start + r.end) / 2 / duration) * 100}%` }}
        >
          {i + 1} <X size={12} />
        </button>
      ))}

      {hover != null && hoverIdx != null && (
        <div
          className="pointer-events-none absolute -top-2 z-[3] w-45 rounded-2xl bg-surface px-3 py-2 text-[13px] shadow-float"
          style={{ left: `clamp(0px, calc(${hover * 100}% - 90px), calc(100% - 180px))` }}
        >
          {draft ? (
            <>
              <div className="font-extrabold">
                {fmtTime(draft.start)} – {fmtTime(draft.end)}
              </div>
              <div className="text-ink-2">{Math.round(draft.end - draft.start)}s · release to pick</div>
            </>
          ) : (
            <>
              <div className="font-extrabold">{fmtTime(hoverT)}</div>
              {kind !== 'none' && (
                <div className="text-ink-2">
                  {label}: <b className="text-ink">{Math.round((curve[hoverIdx] ?? 0) * 100)}%</b>
                </div>
              )}
              {inBand && onPick ? (
                <div className="font-bold text-good-ink">Clip #{inBand.rank} · click to open</div>
              ) : edgeHover ? (
                <div className="font-bold text-warn-ink">Drag to adjust</div>
              ) : onSeek ? (
                <div className="font-bold text-accent">Click to play from here</div>
              ) : selectable ? (
                <div className="font-bold text-warn-ink">Drag to pick a part</div>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The parts picked on the graph + the actions to clip them. */
export function PickBar({ picks, onChange, children }: { picks: TimeRange[]; onChange: (r: TimeRange[]) => void; children?: React.ReactNode }) {
  if (!picks.length) return null;
  const total = picks.reduce((a, r) => a + r.end - r.start, 0);
  return (
    <div role="region" aria-label="Your picked parts" className="mt-3.5 flex animate-pop-in flex-wrap items-center justify-between gap-2.5 rounded-2xl bg-warn-bg px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <b className="mr-1 font-display">
          {picks.length} part{picks.length > 1 ? 's' : ''} · {Math.round(total)}s
        </b>
        {picks.map((r, i) => (
          <Badge key={i} tone="butter">
            {i + 1} · {fmtTime(r.start)}–{fmtTime(r.end)}
            <button type="button" aria-label={`Remove part ${i + 1}`} onClick={() => onChange(picks.filter((_, j) => j !== i))} className="grid place-items-center">
              <X size={12} />
            </button>
          </Badge>
        ))}
        <button type="button" className="text-[13px] font-extrabold text-ink-2 hover:text-ink" onClick={() => onChange([])}>
          Clear
        </button>
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

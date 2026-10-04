import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import type { Watermark, WatermarkPosition } from '../../lib/api';
import { cn } from '../../lib/cn';

/**
 * The logo drawn on a phone preview, in the same place and size the renderer puts it
 * (keep in sync with server/src/pipeline/watermark.ts): inside a 4% side and 2.5% top/bottom gap,
 * at a share (0-1) of the room left there — so 0 and 1 are the corners.
 */
export const BOX = { small: 'w-[13%]', medium: 'w-[19%]', large: 'w-[26%]' } as const;
export const SPOT = {
  'top-left': 'top-[2.5%] left-[4%]',
  'top-right': 'top-[2.5%] right-[4%]',
  'bottom-left': 'bottom-[2.5%] left-[4%]',
  'bottom-right': 'bottom-[2.5%] right-[4%]',
} as const;
export const CORNERS: Record<WatermarkPosition, { x: number; y: number }> = {
  'top-left': { x: 0, y: 0 },
  'top-right': { x: 1, y: 0 },
  'bottom-left': { x: 0, y: 1 },
  'bottom-right': { x: 1, y: 1 },
};
export const spotOf = (w: Pick<Watermark, 'position' | 'x' | 'y'>) => (w.x != null && w.y != null ? { x: w.x, y: w.y } : CORNERS[w.position]);

/** A checkerboard, so a see-through logo is visible on any theme. */
export const checker = 'bg-[repeating-conic-gradient(var(--sunken)_0_25%,var(--surface)_0_50%)] bg-[length:14px_14px]';

// translate is a share of the box itself, so left/top + translate land exactly where ffmpeg's (W-w)*x puts it
const spotStyle = (x: number, y: number): CSSProperties => ({
  left: `calc(4% + 92% * ${x})`,
  top: `calc(2.5% + 95% * ${y})`,
  transform: `translate(${-x * 100}%, ${-y * 100}%)`,
  objectPosition: `${x * 100}% ${y * 100}%`,
});

const clamp = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000;
const STEP = 0.05;

/** With `onMove`, the logo can be dragged anywhere on the frame (or nudged with the arrow keys). */
export function WatermarkMark({ watermark: w, onMove }: { watermark: Watermark | null; onMove?: (x: number, y: number) => void }) {
  const drag = useRef<{ px: number; py: number; x: number; y: number; roomW: number; roomH: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  if (!w?.enabled || !w.logoUrl) return null;
  const { x, y } = spotOf(w);

  const start = (e: PointerEvent<HTMLImageElement>) => {
    const frame = e.currentTarget.offsetParent?.getBoundingClientRect();
    if (!onMove || !frame) return;
    e.preventDefault();
    const box = e.currentTarget.getBoundingClientRect();
    drag.current = { px: e.clientX, py: e.clientY, x, y, roomW: Math.max(1, frame.width * 0.92 - box.width), roomH: Math.max(1, frame.height * 0.95 - box.height) };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const move = (e: PointerEvent<HTMLImageElement>) => {
    const d = drag.current;
    if (d) onMove?.(clamp(d.x + (e.clientX - d.px) / d.roomW), clamp(d.y + (e.clientY - d.py) / d.roomH));
  };
  const end = () => {
    drag.current = null;
    setDragging(false);
  };
  const nudge = (e: KeyboardEvent) => {
    const dx = { ArrowLeft: -STEP, ArrowRight: STEP }[e.key] ?? 0;
    const dy = { ArrowUp: -STEP, ArrowDown: STEP }[e.key] ?? 0;
    if (!dx && !dy) return;
    e.preventDefault();
    onMove?.(clamp(x + dx), clamp(y + dy));
  };

  return (
    <img
      src={w.logoUrl}
      alt={onMove ? 'Your logo — drag it, or use the arrow keys, to move it' : ''}
      aria-hidden={!onMove}
      draggable={false}
      tabIndex={onMove ? 0 : undefined}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onMove ? nudge : undefined}
      style={{ opacity: w.opacity / 100, ...spotStyle(x, y) }}
      className={cn(
        'absolute aspect-square object-contain',
        BOX[w.size],
        onMove
          ? 'z-10 cursor-grab touch-none rounded-md outline-offset-2 select-none hover:outline-2 hover:outline-white/80 hover:outline-dashed focus-visible:outline-2 focus-visible:outline-tangerine'
          : 'pointer-events-none',
        dragging ? 'cursor-grabbing outline-2 outline-white outline-dashed' : 'transition-all duration-300',
      )}
    />
  );
}

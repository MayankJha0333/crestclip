import type { Watermark } from '../../lib/api';
import { cn } from '../../lib/cn';

/**
 * The logo drawn on a phone preview, in the same place and size the renderer puts it
 * (keep in sync with server/src/pipeline/watermark.ts).
 */
export const BOX = { small: 'w-[13%]', medium: 'w-[19%]', large: 'w-[26%]' } as const;
export const SPOT = {
  'top-left': 'top-[2.5%] left-[4%]',
  'top-right': 'top-[2.5%] right-[4%]',
  'bottom-left': 'bottom-[2.5%] left-[4%]',
  'bottom-right': 'bottom-[2.5%] right-[4%]',
} as const;
const ALIGN = { 'top-left': 'object-left-top', 'top-right': 'object-right-top', 'bottom-left': 'object-left-bottom', 'bottom-right': 'object-right-bottom' } as const;

export function WatermarkMark({ watermark: w }: { watermark: Watermark | null }) {
  if (!w?.enabled || !w.logoUrl) return null;
  return (
    <img
      src={w.logoUrl}
      alt=""
      aria-hidden
      style={{ opacity: w.opacity / 100 }}
      className={cn('pointer-events-none absolute aspect-square object-contain transition-all duration-300', BOX[w.size], SPOT[w.position], ALIGN[w.position])}
    />
  );
}

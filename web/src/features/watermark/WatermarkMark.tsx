import type { Watermark } from '../../lib/api';
import { cn } from '../../lib/cn';

/**
 * The logo drawn on a phone preview, in the same place and size the renderer puts it
 * (keep in sync with server/src/pipeline/watermark.ts).
 */
export const BOX = { small: 'w-[13%]', medium: 'w-[19%]', large: 'w-[26%]' } as const;
export const SPOT = {
  'top-left': 'top-[5%] left-[5%]',
  'top-right': 'top-[5%] right-[5%]',
  'bottom-left': 'bottom-[22%] left-[5%]',
  'bottom-right': 'bottom-[22%] right-[5%]',
} as const;
export const ALIGN = { 'top-left': 'object-left-top', 'top-right': 'object-right-top', 'bottom-left': 'object-left-bottom', 'bottom-right': 'object-right-bottom' } as const;

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

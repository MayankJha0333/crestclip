import type { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { cn } from '../../lib/cn';

const TONE = {
  sky: { chip: 'bg-info-bg text-info-ink' },
  orange: { chip: 'bg-orange-bg text-orange-ink' },
  lilac: { chip: 'bg-lilac/25 text-[#5b45c9] dark:text-lilac' },
  good: { chip: 'bg-good-bg text-good-ink' },
  bad: { chip: 'bg-bad-bg text-bad-ink' },
  muted: { chip: 'bg-muted-bg text-ink-3' },
} as const;
export type StatTone = keyof typeof TONE;

/**
 * One counter at the top of a page (Schedule, Autopilot): icon, "6 Booked", a short hint. With onClick it becomes a
 * button that opens the matching list, and shows a small arrow.
 */
export function StatTile({ icon, value, label, hint, tone = 'muted', onClick }: { icon: ReactNode; value: number; label: string; hint?: string; tone?: StatTone; onClick?: () => void }) {
  const t = TONE[tone];
  const zero = value === 0;
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={cn(
        'group flex min-w-0 items-center gap-3.5 rounded-[22px] bg-surface p-4 text-left shadow-clay-sm sm:gap-4 sm:px-5',
        onClick && 'cursor-pointer transition-transform outline-none hover:-translate-y-0.5 focus-visible:ring-3 focus-visible:ring-tangerine',
      )}
    >
      <span className={cn('grid size-11 shrink-0 place-items-center rounded-2xl sm:size-12', t.chip, zero && 'opacity-70')}>{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex flex-col sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-2">
          <b className={cn('font-display text-[28px] leading-tight tracking-tight', zero ? 'text-ink-3' : tone === 'bad' ? 'text-bad' : 'text-ink')}>{value}</b>
          <span className="text-[14px] leading-tight font-extrabold text-ink-2">{label}</span>
        </span>
        {hint && <small className="mt-0.5 hidden truncate text-[12px] text-ink-3 sm:block">{hint}</small>}
      </span>
      {onClick && (
        <ArrowUpRight
          size={17}
          aria-hidden
          className="hidden shrink-0 self-start text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-ink sm:block"
        />
      )}
    </Comp>
  );
}

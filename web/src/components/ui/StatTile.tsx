import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

const TONE = {
  sky: 'bg-info-bg text-info-ink',
  orange: 'bg-orange-bg text-orange-ink',
  good: 'bg-good-bg text-good-ink',
  bad: 'bg-bad-bg text-bad-ink',
  muted: 'bg-muted-bg text-ink-3',
} as const;

/** A number with a label (flat — sits on the page or inside a card). */
export function StatTile({ icon, value, label, tone = 'muted' }: { icon: ReactNode; value: ReactNode; label: string; tone?: keyof typeof TONE }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-2xl bg-row px-4 py-3 shadow-flat">
      <span className={cn('mb-1 grid size-7 place-items-center rounded-[10px]', TONE[tone])}>{icon}</span>
      <b className={cn('font-display text-2xl leading-tight', tone === 'bad' && 'text-bad')}>{value}</b>
      <span className="truncate text-xs font-bold text-ink-3">{label}</span>
    </div>
  );
}

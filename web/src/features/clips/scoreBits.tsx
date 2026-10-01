import type { Rubric } from '../../lib/api';
import type { BadgeTone } from '../../components/ui';

const RUBRIC_LABELS: Record<keyof Rubric, string> = {
  hook: 'Hook (first 3s)',
  standalone: 'Makes sense alone',
  payoff: 'Payoff',
  emotion: 'Emotion',
  shareability: 'Shareability',
  pacing: 'Pacing',
  loop: 'Clean ending / loop',
  lengthFit: 'Length fit',
  trend: 'Trend / search',
};

export const CATEGORY_TONE: Record<string, BadgeTone> = {
  humor: 'butter',
  insight: 'sky',
  story: 'lilac',
  controversy: 'bubble',
  emotional: 'bubble',
  educational: 'mint',
  surprising: 'orange',
  relatable: 'mint',
};

export function RubricBars({ rubric }: { rubric: Rubric }) {
  return (
    <div className="flex flex-col gap-2">
      {(Object.keys(RUBRIC_LABELS) as (keyof Rubric)[]).map((k) => (
        <div key={k} className="flex items-center gap-2.5 text-[13px]">
          <span className="w-36 shrink-0 text-ink-2">{RUBRIC_LABELS[k]}</span>
          <span className="h-3 flex-1 rounded-full bg-sunken p-0.5 shadow-well">
            <span className="block h-full rounded-full" style={{ width: `${rubric[k] * 10}%`, background: rubric[k] >= 8 ? 'var(--mint)' : rubric[k] >= 6 ? 'var(--tangerine)' : 'var(--butter)' }} />
          </span>
          <span className="w-5 text-right font-extrabold">{rubric[k]}</span>
        </div>
      ))}
    </div>
  );
}

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
  // no-speech mode
  reveal: 'orange',
  satisfying: 'mint',
  action: 'bubble',
  reaction: 'butter',
};

/** Short, positive wording for a strong criterion, and the matching "could be better" wording for a weak one. */
const DRIVER: Record<keyof Rubric, { good: string; weak: string }> = {
  hook: { good: 'Opens strong', weak: 'Slow start' },
  standalone: { good: 'Makes sense alone', weak: 'Needs context' },
  payoff: { good: 'Clear payoff', weak: 'Soft payoff' },
  emotion: { good: 'Real emotion', weak: 'Flat emotion' },
  shareability: { good: 'Worth sending', weak: 'Not very shareable' },
  pacing: { good: 'Keeps moving', weak: 'Drags in places' },
  loop: { good: 'Clean ending', weak: 'Ends abruptly' },
  lengthFit: { good: 'Right length', weak: 'Length is off' },
  trend: { good: 'Searchable topic', weak: 'Niche topic' },
};
/** How much each criterion counts in the score (same weights as the server). */
const WEIGHT: Record<keyof Rubric, number> = { hook: 0.2, standalone: 0.15, payoff: 0.15, emotion: 0.15, shareability: 0.1, pacing: 0.1, loop: 0.05, lengthFit: 0.05, trend: 0.05 };

/**
 * The two or three things that drove the score (highest weighted marks, 7+), and the one that holds it back
 * (lowest weighted mark, under 7). Plain words instead of nine bars that all read alike.
 */
export function scoreDrivers(rubric: Rubric): { strong: string[]; weak: string | null } {
  const keys = Object.keys(DRIVER) as (keyof Rubric)[];
  const ranked = [...keys].sort((a, b) => rubric[b] * WEIGHT[b] - rubric[a] * WEIGHT[a]);
  const strong = ranked.filter((k) => rubric[k] >= 7).slice(0, 3).map((k) => DRIVER[k].good);
  const low = [...keys].sort((a, b) => (rubric[a] - 5) * WEIGHT[a] - (rubric[b] - 5) * WEIGHT[b])[0];
  return { strong, weak: low && rubric[low] < 7 ? DRIVER[low].weak : null };
}

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

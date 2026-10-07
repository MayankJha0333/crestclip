import { Link } from 'react-router-dom';
import { Coins, Crown, Gift, RotateCcw, ShoppingBag, Sparkles } from 'lucide-react';
import type { CreditEvent } from '../../lib/api';
import { cn } from '../../lib/cn';

/** How each kind of history line looks: its icon and the colour of its chip. */
const KIND: Record<CreditEvent['kind'], { icon: typeof Coins; chip: string; label: string }> = {
  grant: { icon: Gift, chip: 'bg-good-bg text-good-ink', label: 'Added' },
  topup: { icon: ShoppingBag, chip: 'bg-good-bg text-good-ink', label: 'Top-up' },
  adjust: { icon: Sparkles, chip: 'bg-info-bg text-info-ink', label: 'Adjusted' },
  spend: { icon: Coins, chip: 'bg-row text-ink-2', label: 'Used' },
  refund: { icon: RotateCcw, chip: 'bg-info-bg text-info-ink', label: 'Given back' },
  plan: { icon: Crown, chip: 'bg-lilac/25 text-[#5b45c9] dark:text-lilac', label: 'Plan' },
};

const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const dateTime = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * One line of the credit history: what happened, when (and for which video), and the credits it moved. Plan changes
 * move no credits, so they show a small "Plan" tag instead of a number.
 */
export function CreditEventRow({ e, timeOnly }: { e: CreditEvent; timeOnly?: boolean }) {
  const k = KIND[e.kind] ?? KIND.adjust;
  const Icon = k.icon;
  const note = e.note ?? k.label;
  // the line usually names its video already ("Podcast #42 · 4 clips"): then the line itself opens the video
  const named = Boolean(e.project && note.includes(e.project.title));
  return (
    <li className="flex items-center gap-3 py-3 text-sm">
      <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl', k.chip)} aria-hidden>
        <Icon size={16} />
      </span>
      <span className="min-w-0 flex-1">
        {named && e.project?.exists ? (
          <Link to={`/app/p/${e.project.id}`} className="block font-semibold text-ink no-underline [overflow-wrap:anywhere] hover:text-accent">
            {note}
          </Link>
        ) : (
          <span className="block font-semibold text-ink [overflow-wrap:anywhere]">{note}</span>
        )}
        <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-ink-3">
          <span>{timeOnly ? time(e.createdAt) : dateTime(e.createdAt)}</span>
          {e.project && !named && (
            <>
              <span aria-hidden>·</span>
              {e.project.exists ? (
                <Link to={`/app/p/${e.project.id}`} className="max-w-[16rem] truncate font-bold text-ink-2 no-underline hover:text-accent">
                  {e.project.title}
                </Link>
              ) : (
                <span className="max-w-[16rem] truncate">{e.project.title} (deleted)</span>
              )}
            </>
          )}
          {e.refunded && (
            <>
              <span aria-hidden>·</span>
              <span>given back</span>
            </>
          )}
        </span>
      </span>
      {e.kind === 'plan' || e.delta === 0 ? (
        <span className="shrink-0 rounded-full bg-lilac/20 px-2.5 py-1 text-xs font-extrabold text-[#5b45c9] dark:text-lilac">Plan</span>
      ) : (
        <b className={cn('shrink-0 font-display text-base tabular-nums', e.delta > 0 ? 'text-good-ink' : e.refunded ? 'text-ink-3 line-through' : 'text-ink')}>
          {e.delta > 0 ? '+' : '−'}
          {Math.abs(e.delta).toLocaleString()}
        </b>
      )}
    </li>
  );
}

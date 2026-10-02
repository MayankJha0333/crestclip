import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import type { Plan } from '../../lib/api';
import { cn } from '../../lib/cn';
import { money } from './money';

/** Small label at the top-right of a card. */
const BADGE: Partial<Record<Plan['id'], string>> = { creator: 'Most popular', pro: 'Best value' };

/**
 * The three plans side by side: name + badge, price, who it's for, the button, then every limit as a short line.
 * `action` renders each card's button (sign up, upgrade, current…).
 */
export function PlanCards({ plans, current, action }: { plans: Plan[]; current?: Plan['id']; action: (p: Plan) => ReactNode }) {
  return (
    <div className="grid items-start gap-5 md:grid-cols-3">
      {plans.map((p) => {
        const featured = p.id === 'creator';
        const mine = current === p.id;
        const badge = mine ? 'Your plan' : BADGE[p.id];
        return (
          <section
            key={p.id}
            aria-label={`${p.name} plan`}
            className={cn(
              'flex flex-col rounded-[28px] bg-surface p-6 sm:p-7',
              mine ? 'shadow-[var(--shadow-clay),0_0_0_3px_var(--mint)]' : featured ? 'shadow-[var(--shadow-clay),0_0_0_3px_var(--tangerine)] md:-mt-2' : 'shadow-clay',
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-2xl">{p.name}</h3>
              {badge && (
                <span
                  className={cn(
                    'rounded-full px-3 py-1 text-[11px] font-extrabold tracking-wider uppercase',
                    mine ? 'bg-mint text-[#0f3b2e]' : featured ? 'bg-tangerine text-white' : 'bg-sunken text-ink-2 shadow-well',
                  )}
                >
                  {badge}
                </span>
              )}
            </div>
            <p className="mt-4 flex items-baseline gap-1.5">
              <b className="font-display text-5xl tracking-tight">{money(p.price, p.currency)}</b>
              <span className="font-bold text-ink-3">/ month</span>
            </p>
            <p className="mt-3 min-h-[2.75rem] text-[15px] text-ink-2">{p.tagline}</p>
            <div className="mt-4">{action(p)}</div>
            <hr className="my-6 h-1 rounded-full border-0 bg-sunken" />
            <ul className="flex flex-col gap-3 text-[15px]">
              {p.points.map((pt, i) => (
                <li key={pt} className="flex gap-2.5">
                  <Check size={17} className="mt-0.5 shrink-0 text-good" />
                  <span className={cn(i === 0 && 'font-extrabold')}>{pt}</span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

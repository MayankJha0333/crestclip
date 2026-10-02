import { Link } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useAccount } from '../auth/auth';

/** Sidebar card: credits left this month, the plan, and the way to get more. */
export function CreditMeter() {
  const a = useAccount();
  const { balance, monthly, perClip } = a.credits;
  const pct = Math.max(0, Math.min(100, (balance / Math.max(1, monthly)) * 100));
  const low = balance < Math.max(5, monthly * 0.1);
  return (
    <Link
      to="/app/billing"
      className="block rounded-2xl bg-row p-3.5 no-underline shadow-flat transition-transform hover:-translate-y-0.5"
      aria-label={`${balance} credits left, about ${Math.floor(balance / perClip)} clips — plan and credits`}
    >
      <span className="flex items-center justify-between text-xs font-extrabold">
        <span className="text-ink-2">{a.plan.name} plan</span>
        {a.plan.id !== 'pro' && (
          <span className="inline-flex items-center gap-1 text-accent">
            <Sparkles size={12} /> Upgrade
          </span>
        )}
      </span>
      <span className="mt-1.5 flex items-baseline gap-1">
        <b className={cn('font-display text-2xl tabular-nums', low ? 'text-warn-ink' : 'text-ink')}>{balance.toLocaleString()}</b>
        <span className="text-xs text-ink-3">credits · ≈ {Math.floor(balance / perClip).toLocaleString()} clips</span>
      </span>
      <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-sunken">
        <span className={cn('block h-full rounded-full', low ? 'bg-warn' : 'bg-tangerine')} style={{ width: `${pct}%` }} />
      </span>
    </Link>
  );
}

/** Phone header: just the number. */
export function CreditPill() {
  const a = useAccount();
  return (
    <Link to="/app/billing" className="inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-2 text-sm font-extrabold text-ink no-underline shadow-clay-sm">
      <Sparkles size={14} className="text-accent" /> {a.credits.balance.toLocaleString()}
    </Link>
  );
}

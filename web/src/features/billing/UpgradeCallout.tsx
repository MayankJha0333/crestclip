import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { buttonClass } from '../../components/ui';
import { cn } from '../../lib/cn';

/** "This needs a bigger plan / more credits" with the way to get it. */
export function UpgradeCallout({ title, children, cta = 'See plans', className }: { title: ReactNode; children?: ReactNode; cta?: string; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-4 rounded-[22px] bg-orange-bg p-4', className)}>
      <span className="grid size-11 shrink-0 place-items-center rounded-2xl text-white clay-tangerine">
        <Sparkles size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <b className="block text-orange-ink">{title}</b>
        {children && <span className="block text-sm text-orange-ink/80">{children}</span>}
      </span>
      <Link to="/app/billing" className={buttonClass('primary', 'sm')}>
        {cta}
      </Link>
    </div>
  );
}

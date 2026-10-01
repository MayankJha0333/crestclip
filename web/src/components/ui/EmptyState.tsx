import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** Friendly "nothing here yet" block: what's missing, and the one thing to do about it. */
export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
  compact,
}: {
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-3 text-center', compact ? 'py-6' : 'py-12', className)}>
      <span className="grid size-16 animate-wobble place-items-center clay-butter text-[#3d2a00]" aria-hidden>
        {icon}
      </span>
      <h3 className="text-xl">{title}</h3>
      {children && <p className="max-w-md text-ink-2">{children}</p>}
      {action && <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

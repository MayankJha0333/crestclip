import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** Page-level tabs (same look as a segmented control, with optional counts). */
export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { value: T; label: ReactNode; count?: number | null; icon?: ReactNode }[];
  label: string;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={cn('inline-flex w-fit max-w-full gap-1 overflow-x-auto rounded-full bg-sunken p-1 shadow-well scrollbar-none', className)}>
      {tabs.map((t) => {
        const on = value === t.value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.value)}
            className={cn(
              'inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-4 py-2 font-bold transition-all duration-200',
              on ? 'bg-surface text-ink shadow-clay-sm dark:bg-row-hover' : 'text-ink-2 hover:text-ink',
            )}
          >
            {t.icon}
            {t.label}
            {t.count != null && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-muted-bg px-1.5 text-[11px]">{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

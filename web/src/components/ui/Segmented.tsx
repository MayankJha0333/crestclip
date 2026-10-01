import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** Pick one of a few options. A clay toggle: sunken track, raised pill for the selected option. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn('inline-flex w-fit max-w-full gap-1 overflow-x-auto rounded-full bg-sunken p-1 shadow-well scrollbar-none', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-bold transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-45',
            size === 'sm' ? 'px-3 py-1.5 text-sm' : 'px-4 py-2',
            value === o.value ? 'bg-surface text-ink shadow-clay-sm dark:bg-row-hover' : 'text-ink-2 hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

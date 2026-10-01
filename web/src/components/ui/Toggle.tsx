import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** On/off switch with its label. */
export function Toggle({ checked, onChange, children, className }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; className?: string }) {
  return (
    <label className={cn('inline-flex cursor-pointer select-none items-center gap-3 font-bold', className)}>
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span
        aria-hidden
        className={cn(
          'relative h-7.5 w-13 shrink-0 rounded-full shadow-well transition-colors peer-focus-visible:outline-3 peer-focus-visible:outline-offset-3 peer-focus-visible:outline-tangerine',
          checked ? 'bg-mint' : 'bg-sunken',
        )}
      >
        <span className={cn('absolute top-1 left-1 size-5.5 rounded-full bg-surface shadow-clay-sm transition-transform duration-300 ease-(--ease-squish)', checked && 'translate-x-5.5')} />
      </span>
      <span>{children}</span>
    </label>
  );
}

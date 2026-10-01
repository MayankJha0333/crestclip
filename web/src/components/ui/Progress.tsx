import { cn } from '../../lib/cn';

/** Shimmering clay progress bar. */
export function Progress({ value, className, label }: { value: number; className?: string; label?: string }) {
  return (
    <div
      className={cn('h-3.5 overflow-hidden rounded-full bg-sunken p-[3px] shadow-well', className)}
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <span
        className="block h-full animate-[shimmer_2.4s_linear_infinite] rounded-full bg-[linear-gradient(90deg,var(--tangerine),var(--butter),var(--tangerine))] bg-size-[200%_100%] transition-[width] duration-500"
        style={{ width: `${Math.max(3, Math.min(100, value))}%` }}
      />
    </div>
  );
}

/** Grey loading placeholder. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-shimmer rounded-2xl bg-[linear-gradient(90deg,var(--sunken)_25%,var(--row)_50%,var(--sunken)_75%)] bg-size-[200%_100%]', className)} />;
}

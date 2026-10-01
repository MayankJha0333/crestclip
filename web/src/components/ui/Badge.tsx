import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export type BadgeTone = 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'orange' | 'ink' | 'butter' | 'mint' | 'sky' | 'lilac' | 'bubble';
const TONE: Record<BadgeTone, string> = {
  neutral: 'bg-row text-ink shadow-flat',
  good: 'bg-good-bg text-good-ink',
  warn: 'bg-warn-bg text-warn-ink',
  bad: 'bg-bad-bg text-bad-ink',
  info: 'bg-info-bg text-info-ink',
  orange: 'bg-orange-bg text-orange-ink',
  ink: 'bg-ink text-on-ink',
  butter: 'bg-butter text-[#3d2a00]',
  mint: 'bg-mint text-[#0f3b2e]',
  sky: 'bg-sky text-[#103552]',
  lilac: 'bg-lilac text-[#2a1d63]',
  bubble: 'bg-bubble text-[#4a0f2a]',
};

/** Small flat label. Never raised — badges always sit inside a card. */
export function Badge({ tone = 'neutral', className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return <span className={cn('inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-extrabold [&_svg]:shrink-0', TONE[tone], className)} {...rest} />;
}

/** A pressable filter chip (flat; pressed = ink). */
export function Chip({ pressed, className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { pressed?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-bold transition-colors',
        pressed ? 'bg-ink text-on-ink' : 'bg-row text-ink shadow-flat hover:bg-row-hover hover:shadow-[0_0_0_1px_var(--line-strong)]',
        className,
      )}
      {...rest}
    />
  );
}

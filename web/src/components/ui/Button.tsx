import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { Spinner } from './Spinner';

export type ButtonVariant = 'secondary' | 'primary' | 'ink' | 'mint' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

const VARIANT: Record<ButtonVariant, string> = {
  secondary: 'btn-clay',
  primary: 'btn-clay [--b-bg:var(--tangerine)] [--b-deep:var(--tangerine-d)] [--b-hi:rgba(255,255,255,.45)] [--b-fg:#2b1407]',
  ink: 'btn-clay [--b-bg:var(--ink)] [--b-deep:rgba(0,0,0,.35)] [--b-hi:rgba(255,255,255,.15)] [--b-fg:var(--on-ink)]',
  mint: 'btn-clay [--b-bg:var(--mint)] [--b-deep:var(--mint-d)] [--b-hi:rgba(255,255,255,.45)] [--b-fg:#0f3b2e]',
  danger: 'btn-clay [--b-bg:#e2574f] [--b-deep:#a8302a] [--b-hi:rgba(255,255,255,.3)] [--b-fg:#fff]',
  ghost: 'bg-transparent text-ink-2 hover:bg-row hover:text-ink',
};
const SIZE: Record<ButtonSize, string> = {
  sm: 'h-9 px-3.5 text-sm gap-1.5',
  md: 'h-11 px-5 text-base gap-2',
  lg: 'h-14 px-7 text-lg gap-2.5',
  icon: 'size-11 shrink-0',
  'icon-sm': 'size-9 shrink-0',
};

/** Class string for anything that should look like a button (also used on <Link> and <a>). */
export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', className?: string) {
  return cn(
    'inline-flex select-none items-center justify-center whitespace-nowrap rounded-full font-display font-semibold no-underline',
    'transition-[transform,background-color,box-shadow] duration-200 ease-(--ease-squish) hover:-translate-y-0.5 active:translate-y-px active:scale-[.97]',
    'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
    VARIANT[variant],
    SIZE[size],
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** shows a spinner in place of the icon and disables the button */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', loading, disabled, className, children, type = 'button', ...rest }, ref) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading} className={buttonClass(variant, size, className)} {...rest}>
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
});

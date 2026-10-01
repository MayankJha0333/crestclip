import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

const WELL = 'w-full rounded-[18px] bg-sunken px-4 py-3 text-ink shadow-well outline-none placeholder:text-ink-3 focus-visible:outline-3 focus-visible:outline-tangerine';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(WELL, className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(WELL, 'min-h-24 resize-y', className)} {...rest} />;
});

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(WELL, 'cursor-pointer pr-9', className)} {...rest} />;
}

/** Label + control + optional hint, stacked. */
export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-2', className)}>
      <span className="font-display text-sm font-semibold text-ink-2">{label}</span>
      {children}
      {hint && <span className="text-[13px] text-ink-3">{hint}</span>}
    </label>
  );
}

/** A label for controls that aren't a single input (segmented controls, pickers). */
export function FieldLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('mb-2 block font-display text-sm font-semibold text-ink-2', className)}>{children}</span>;
}

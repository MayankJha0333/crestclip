import { cn } from '../../lib/cn';

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden className={cn('inline-block size-4.5 shrink-0 animate-spin rounded-full border-[3px] border-line-strong border-t-current', className)} />;
}

import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

type Tone = 'raised' | 'flat' | 'sunken';
const TONE: Record<Tone, string> = {
  raised: 'rounded-[28px] bg-surface shadow-clay',
  flat: 'rounded-2xl bg-row shadow-flat',
  sunken: 'rounded-[22px] bg-sunken shadow-well',
};

/**
 * Surfaces. One level of clay only: a page section is `raised`; anything inside it is `flat` or `sunken`.
 */
export function Card({ tone = 'raised', className, ...rest }: HTMLAttributes<HTMLElement> & { tone?: Tone }) {
  return <section className={cn(TONE[tone], className)} {...rest} />;
}

export function CardHeader({
  title,
  description,
  icon,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-4 flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-xl">
          {icon && <span className="text-accent">{icon}</span>}
          {title}
        </h2>
        {description && <p className="mt-1 text-sm text-ink-3">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from './Button';

export interface MenuItem {
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
}

/** "More" button with a small list of secondary actions. Keeps rows of buttons short. */
export function Menu({ items, label = 'More actions', align = 'right' }: { items: MenuItem[]; label?: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <Button size="icon-sm" aria-label={label} title={label} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal size={18} />
      </Button>
      {open && (
        <div role="menu" className={cn('absolute bottom-full z-30 mb-2 min-w-52 animate-pop-in rounded-2xl bg-surface p-1.5 shadow-float', align === 'right' ? 'right-0' : 'left-0')}>
          {items.map((it, i) => (
            <button
              key={i}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              title={it.title}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
              className={cn('flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm font-bold hover:bg-row disabled:opacity-45', it.danger ? 'text-bad' : 'text-ink')}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

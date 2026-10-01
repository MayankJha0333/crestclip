import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button } from './Button';

/**
 * A panel that slides in from the right, over the page. Use it for extra settings so opening them
 * never pushes the page layout around. Esc / clicking outside closes it; focus returns where it was.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const latest = useRef(onClose);
  latest.current = onClose;

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => panel.current?.focus(), 20);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && latest.current();
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      before?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-scrim backdrop-blur-[3px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className="flex h-full w-full max-w-[460px] animate-[sheet-in_.35s_var(--ease-squish)_both] flex-col bg-surface shadow-clay outline-none sm:m-3 sm:h-[calc(100vh-1.5rem)] sm:rounded-[28px]"
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-6 pt-5 pb-4">
          <div>
            <h2 className="text-2xl">{title}</h2>
            {description && <p className="mt-1 text-sm text-ink-3">{description}</p>}
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            <X size={18} />
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2.5 border-t border-line px-6 py-4">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

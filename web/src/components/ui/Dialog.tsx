import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from './Button';

/**
 * Modal dialog, rendered at the page level. Esc / clicking outside closes it (unless `busy`),
 * page scroll is locked and focus returns to where it was. It never grows past the screen:
 * the title and footer stay put and only the middle scrolls.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  busy,
  role = 'dialog',
  initialFocus,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  busy?: boolean;
  role?: 'dialog' | 'alertdialog';
  initialFocus?: React.RefObject<HTMLElement>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef({ onClose, busy });
  latest.current = { onClose, busy };

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => (initialFocus?.current ?? box.current)?.focus(), 20);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !latest.current.busy && latest.current.onClose();
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      before?.focus?.();
    };
  }, [open, initialFocus]);

  if (!open) return null;
  const width = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-4xl', xl: 'max-w-6xl' }[size];
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-scrim p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div
        ref={box}
        tabIndex={-1}
        role={role}
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={cn('flex max-h-[calc(100dvh-2rem)] w-full min-w-0 animate-pop-in flex-col rounded-[28px] bg-surface p-6 shadow-clay outline-none sm:p-7', width)}
      >
        <header className="mb-5 flex shrink-0 items-start justify-between gap-4">
          <h2 className="min-w-0 text-2xl">{title}</h2>
          <Button variant="ghost" size="icon-sm" onClick={onClose} disabled={busy} aria-label="Close">
            <X size={18} />
          </Button>
        </header>
        {/* padding inside the scroll area keeps clay shadows and focus rings from being cut off */}
        <div className="-mx-3 -my-2 min-h-0 flex-1 overflow-y-auto px-3 py-2">{children}</div>
        {footer && <footer className={cn('mt-6 flex shrink-0 flex-wrap items-center justify-end gap-2.5', (size === 'lg' || size === 'xl') && 'mt-4 border-t border-line pt-4')}>{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/** "Are you sure?" — focus starts on Cancel so Enter never deletes by accident. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = 'Delete',
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      busy={busy}
      size="sm"
      role="alertdialog"
      initialFocus={cancel}
      title={
        <span className="flex items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-bad-bg text-bad-ink">
            <AlertTriangle size={22} />
          </span>
          {title}
        </span>
      }
      footer={
        <>
          <Button ref={cancel} onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={busy}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[15px] text-ink-2">{children}</div>
      {error && <p className="mt-3 text-sm font-bold text-bad">{error}</p>}
    </Dialog>
  );
}

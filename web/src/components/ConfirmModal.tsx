import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Film, X } from 'lucide-react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';

/**
 * A proper "are you sure?" dialog (replaces the browser's confirm()).
 * Esc or clicking outside cancels; focus starts on Cancel so Enter never deletes by accident.
 */
export function ConfirmModal({
  open,
  title,
  children,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const lastFocus = useRef<Element | null>(null);
  // keep the latest callbacks without re-running the open/close effect on every parent render
  const latest = useRef({ onCancel, busy });
  latest.current = { onCancel, busy };

  useEffect(() => {
    if (!open) return;
    lastFocus.current = document.activeElement;
    const t = setTimeout(() => cancelRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !latest.current.busy && latest.current.onCancel();
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      (lastFocus.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="modal-backdrop confirm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="confirm clay pop-in" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body">
        <button type="button" className="btn btn-icon btn-sm confirm-x" onClick={onCancel} disabled={busy} aria-label="Close">
          <X size={16} />
        </button>
        <span className="confirm-ico" aria-hidden>
          <AlertTriangle size={26} />
        </span>
        <h2 id="confirm-title">{title}</h2>
        <div id="confirm-body" className="confirm-body">
          {children}
        </div>
        {error && <p className="confirm-error">{error}</p>}
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" className="btn" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            {busy ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Delete project?" — shows which project, what goes away, and handles the request + errors. */
export function DeleteProjectModal({
  project,
  onCancel,
  onDeleted,
}: {
  project: { id: string; title: string | null; sourceUrl: string | null; thumbUrl: string | null; clipCount?: number; clips?: unknown[] } | null;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBusy(false);
    setError(null);
  }, [project?.id]);
  const n = project?.clipCount ?? project?.clips?.length ?? 0;
  const confirm = async () => {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      await api.remove(project.id);
      toast('Project deleted');
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <ConfirmModal open={Boolean(project)} title="Delete this project?" confirmLabel="Delete project" busy={busy} error={error} onConfirm={confirm} onCancel={onCancel}>
      {project && (
        <>
          <div className="confirm-target well">
            {project.thumbUrl ? <img src={project.thumbUrl} alt="" /> : <span className="ph"><Film size={20} /></span>}
            <b>{project.title || project.sourceUrl || 'Untitled video'}</b>
          </div>
          <ul className="confirm-list">
            <li>
              {n ? `All ${n} clip${n > 1 ? 's' : ''}` : 'Its clips'}, the transcript and the downloaded video will be removed.
            </li>
            <li>Clips you already downloaded to your computer stay safe.</li>
          </ul>
          <p style={{ marginTop: 10, fontWeight: 800, color: 'var(--bad)' }}>This can’t be undone.</p>
        </>
      )}
    </ConfirmModal>
  );
}

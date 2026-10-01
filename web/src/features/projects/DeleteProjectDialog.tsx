import { useEffect, useState } from 'react';
import { Film } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { ConfirmDialog } from '../../components/ui';

type Target = { id: string; title: string | null; sourceUrl: string | null; thumbUrl: string | null; clipCount?: number; clips?: unknown[]; videoCount?: number };

/** "Delete project?" — shows which project and what goes away. */
export function DeleteProjectDialog({ project, onCancel, onDeleted }: { project: Target | null; onCancel: () => void; onDeleted: () => void }) {
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
    <ConfirmDialog open={Boolean(project)} title="Delete this project?" confirmLabel="Delete project" busy={busy} error={error} onConfirm={confirm} onCancel={onCancel}>
      {project && (
        <>
          <div className="flex items-center gap-3 rounded-2xl bg-sunken p-2.5 shadow-well">
            {project.thumbUrl ? (
              <img src={project.thumbUrl} alt="" className="aspect-video w-24 shrink-0 rounded-xl object-cover" />
            ) : (
              <span className="grid aspect-video w-24 shrink-0 place-items-center rounded-xl bg-muted-bg">
                <Film size={20} />
              </span>
            )}
            <b className="line-clamp-2 text-sm text-ink">{project.title || project.sourceUrl || 'Untitled video'}</b>
          </div>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>
              {n ? `All ${n} clip${n > 1 ? 's' : ''}` : 'Its clips'}
              {project.videoCount ? ` from ${project.videoCount} videos` : ''}, the transcript and the downloaded video will be removed.
            </li>
            <li>Clips you already downloaded to your computer stay safe.</li>
          </ul>
          <p className="font-extrabold text-bad">This can’t be undone.</p>
        </>
      )}
    </ConfirmDialog>
  );
}

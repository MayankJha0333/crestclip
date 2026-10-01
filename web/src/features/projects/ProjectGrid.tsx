import { useState } from 'react';
import { Film } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, type Project } from '../../lib/api';
import { usePolling } from '../../lib/hooks';
import { buttonClass, EmptyState, Skeleton } from '../../components/ui';
import { DeleteProjectDialog } from './DeleteProjectDialog';
import { isWorking, ProjectCard } from './ProjectCard';

/** Live list of projects (refreshes while anything is processing). */
export function useProjects() {
  const [list, setList] = useState<Project[] | null>(null);
  const load = () =>
    api
      .projects()
      .then(setList)
      .catch(() => setList([]));
  const busy = list == null || list.some(isWorking);
  usePolling(load, busy ? 3000 : 15000);
  return { list, setList, load };
}

export function ProjectGrid({ list, onChanged, limit, emptyAction = true }: { list: Project[] | null; onChanged: () => void; limit?: number; emptyAction?: boolean }) {
  const [deleting, setDeleting] = useState<Project | null>(null);
  const items = limit ? list?.slice(0, limit) : list;
  if (list == null)
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-5">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-64 rounded-[26px]" />
        ))}
      </div>
    );
  if (!items?.length)
    return (
      <EmptyState
        icon={<Film size={28} />}
        title="No projects yet"
        action={
          emptyAction ? (
            <Link to="/app" className={buttonClass('primary')}>
              Make your first clips
            </Link>
          ) : undefined
        }
      >
        Paste a video link and CrestClip turns its best moments into vertical clips.
      </EmptyState>
    );
  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-5">
        {items.map((p) => (
          <ProjectCard key={p.id} p={p} onDelete={setDeleting} />
        ))}
      </div>
      <DeleteProjectDialog
        project={deleting}
        onCancel={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null);
          onChanged();
        }}
      />
    </>
  );
}

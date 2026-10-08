import { useState } from 'react';
import { Film, Hourglass } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, type Project } from '../../lib/api';
import { usePolling } from '../../lib/hooks';
import { useCachedState } from '../../lib/cache';
import { buttonClass, EmptyState, Skeleton } from '../../components/ui';
import { deletesIn } from '../../lib/format';
import { useAccount } from '../auth/auth';
import { DeleteProjectDialog } from './DeleteProjectDialog';
import { isWorking, ProjectCard } from './ProjectCard';

/** Live list of projects (refreshes while anything is processing). */
export function useProjects() {
  const [list, setList] = useCachedState<Project[]>('projects'); // last list first, fresh one a moment later
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
      {!limit && <ExpiringSoon list={list} />}
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

/**
 * One quiet line above the projects when something is about to be deleted. The cards themselves carry the
 * "Deletes tomorrow / in 2 days" tag, so this only counts them.
 */
function ExpiringSoon({ list }: { list: Project[] }) {
  const account = useAccount();
  const n = list.filter((p) => !isWorking(p) && deletesIn(p.expiresAt)?.soon).length;
  if (!n) return null;
  return (
    <p role="status" className="mb-4 text-sm text-ink-2">
      <Hourglass size={15} className="mr-1.5 inline -translate-y-px text-warn-ink" />
      <span>
        <b className="text-warn-ink">
          {n} project{n === 1 ? '' : 's'}
        </b>{' '}
        will be deleted within 2 days — download or post what you want to keep.
      </span>
      {account.plan.id === 'free' && (
        <Link to="/app/billing" className="ml-2 font-bold whitespace-nowrap text-accent underline-offset-2 hover:underline">
          Keep projects 30 days
        </Link>
      )}
    </p>
  );
}

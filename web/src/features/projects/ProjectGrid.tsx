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
 * One calm note above the projects instead of a countdown on every card: it only appears when something is about to
 * be deleted, names those projects, and (on Free) says how to keep things longer.
 */
function ExpiringSoon({ list }: { list: Project[] }) {
  const account = useAccount();
  const soon = list
    .filter((p) => !isWorking(p))
    .map((p) => ({ p, left: deletesIn(p.expiresAt) }))
    .filter((x) => x.left?.soon)
    .sort((a, b) => (a.p.expiresAt ?? 0) - (b.p.expiresAt ?? 0));
  if (!soon.length) return null;
  const longer = account.plan.id === 'free';
  return (
    <div role="status" className="mb-5 flex items-start gap-3 rounded-[22px] bg-warn-bg px-4 py-3.5 text-sm text-warn-ink">
      <Hourglass size={18} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <b className="block">{soon.length === 1 ? '1 project is' : `${soon.length} projects are`} deleted in the next 2 days</b>
        <p className="mt-0.5">
          {soon.slice(0, 3).map(({ p, left }, i) => (
            <span key={p.id}>
              {i > 0 && ', '}
              <Link to={`/app/p/${p.id}`} className="font-bold text-warn-ink underline underline-offset-2">
                {(p.title || 'Untitled').length > 40 ? `${(p.title || '').slice(0, 38).trimEnd()}…` : p.title || 'Untitled'}
              </Link>{' '}
              ({left!.text.replace(/^Deletes /, '')})
            </span>
          ))}
          {soon.length > 3 && ` and ${soon.length - 3} more`}. Download or post the clips you want to keep.
          {longer && (
            <>
              {' '}
              <Link to="/app/billing" className="font-bold text-warn-ink underline underline-offset-2">
                Creator and Pro keep projects for 30 days.
              </Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

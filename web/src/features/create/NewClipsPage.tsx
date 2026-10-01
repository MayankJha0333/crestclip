import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, Compass } from 'lucide-react';
import { buttonClass, PageHeader } from '../../components/ui';
import { ProjectGrid, useProjects } from '../projects/ProjectGrid';
import { NewClipForm } from './NewClipForm';

/** Home of the app: start new clips, then see what you made recently. */
export function NewClipsPage() {
  const [params] = useSearchParams();
  const { list, load } = useProjects();
  return (
    <>
      <PageHeader
        title="New clips"
        description="Paste a long video — CrestClip finds the moments viewers rewatch and turns them into vertical clips with captions."
        actions={
          <Link to="/app/explore" className={buttonClass('secondary', 'sm')}>
            <Compass size={16} /> No video in mind? Explore
          </Link>
        }
      />
      <NewClipForm initialUrl={params.get('url') ?? ''} />
      {(list == null || list.length > 0) && (
        <section className="mt-12">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-2xl">Recent projects</h2>
            {list && list.length > 3 && (
              <Link to="/app/projects" className={buttonClass('ghost', 'sm')}>
                All {list.length} projects <ArrowRight size={15} />
              </Link>
            )}
          </div>
          <ProjectGrid list={list} onChanged={load} limit={3} />
        </section>
      )}
    </>
  );
}

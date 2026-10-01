import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, Compass } from 'lucide-react';
import { buttonClass } from '../../components/ui';
import { ProjectGrid, useProjects } from '../projects/ProjectGrid';
import { NewClipForm } from './NewClipForm';

/** Home of the app: start new clips, then see what you made recently. */
export function NewClipsPage() {
  const [params] = useSearchParams();
  const { list, load } = useProjects();
  return (
    <>
      <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="mb-2 text-[13px] font-black tracking-[.12em] text-accent uppercase">New clips</p>
          <h1 className="text-[clamp(30px,4vw,44px)] leading-[1.05] tracking-tight">
            What should we{' '}
            <span className="relative whitespace-nowrap">
              clip today
              <span aria-hidden className="absolute -inset-x-1 bottom-0.5 -z-10 h-[.32em] -rotate-1 rounded-full clay-butter" />
            </span>
            ?
          </h1>
          <p className="mt-2.5 max-w-2xl text-ink-2">Paste a long video. CrestClip finds the moments viewers rewatch and turns them into vertical clips with captions.</p>
        </div>
        <Link to="/app/explore" className={buttonClass('secondary', 'sm')}>
          <Compass size={16} /> No video in mind? Explore
        </Link>
      </header>
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

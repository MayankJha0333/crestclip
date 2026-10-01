import type { ReactNode } from 'react';
import { Film, Layers, Play } from 'lucide-react';
import { cn } from '../../lib/cn';

/** Top of a project: picture, title, facts, actions. */
export function ProjectHeader({
  thumbs,
  title,
  facts,
  actions,
  onPlay,
  count,
}: {
  thumbs: (string | null)[];
  title: string;
  facts: ReactNode;
  actions?: ReactNode;
  onPlay?: () => void;
  count?: number;
}) {
  const pics = thumbs.slice(0, 3);
  const art = (
    <div className={cn('relative grid aspect-video w-full shrink-0 overflow-hidden rounded-[18px] bg-media sm:w-52', pics.length > 1 && 'grid-cols-[repeat(auto-fit,minmax(0,1fr))] gap-0.5')}>
      {pics.length ? (
        pics.map((t, i) =>
          t ? (
            <img key={i} src={t} alt="" className="size-full object-cover" />
          ) : (
            <span key={i} className="grid place-items-center text-white/40">
              <Film size={20} />
            </span>
          ),
        )
      ) : (
        <span className="grid place-items-center text-white/40">
          <Film size={26} />
        </span>
      )}
      {count != null && count > 1 && (
        <span className="absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-xs font-extrabold text-ink">
          <Layers size={12} /> {count}
        </span>
      )}
      {onPlay && (
        <span className="absolute inset-0 m-auto grid size-13 place-items-center rounded-full bg-tangerine/95 text-white shadow-lift transition-transform group-hover:scale-110">
          <Play size={22} fill="currentColor" />
        </span>
      )}
    </div>
  );
  return (
    <header className="flex flex-col gap-5 rounded-[28px] bg-surface p-4 shadow-clay sm:flex-row sm:items-center sm:p-5">
      {onPlay ? (
        <button type="button" className="group shrink-0" onClick={onPlay} aria-label="Play the original video">
          {art}
        </button>
      ) : (
        art
      )}
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl sm:text-3xl">{title}</h1>
        <div className="mt-3 flex flex-wrap gap-1.5">{facts}</div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

import { Link } from 'react-router-dom';
import { AlertTriangle, Clock, Film, Hourglass, Layers, Trash2 } from 'lucide-react';
import type { Project } from '../../lib/api';
import { deletesIn, fmtTime, timeAgo } from '../../lib/format';
import { Badge, Button, Progress } from '../../components/ui';
import { ScoreRing } from '../../components/brand/ScoreRing';

export const isWorking = (p: { status: Project['status'] }) => p.status === 'processing' || p.status === 'queued';

function statusLine(p: Project) {
  if (p.status === 'done') return `${p.readyCount ?? 0} clip${p.readyCount === 1 ? '' : 's'} ready`;
  if (p.status === 'failed') return 'Didn’t finish';
  return p.stageDetail || (p.status === 'queued' ? 'Waiting to start…' : 'Working…');
}

export function ProjectCard({ p, onDelete }: { p: Project; onDelete: (p: Project) => void }) {
  const working = isWorking(p);
  const left = deletesIn(p.expiresAt);
  return (
    <article className="group relative animate-pop-in rounded-[26px] bg-surface p-3 pb-4 shadow-clay transition-transform duration-300 ease-(--ease-squish) hover:-translate-y-1">
      <Link to={`/app/p/${p.id}`} className="block text-ink no-underline" aria-label={p.title ?? 'Project'}>
        <div className="relative grid aspect-video place-items-center overflow-hidden rounded-[18px] bg-media">
          {p.thumbUrl ? <img src={p.thumbUrl} alt="" loading="lazy" className="size-full object-cover" /> : <Film size={30} className="text-white/50" />}
          <div className="absolute bottom-2 left-2 flex gap-1.5">
            {p.videoCount ? (
              <Badge>
                <Layers size={12} /> {p.videoCount} videos
              </Badge>
            ) : null}
            {p.duration ? (
              <Badge>
                <Clock size={12} /> {fmtTime(p.duration)}
              </Badge>
            ) : null}
          </div>
        </div>
        <div className="mt-3 flex items-start gap-3 px-1">
          <div className="min-w-0 flex-1">
            <h3 className="line-clamp-2 text-[17px]">{p.title || p.sourceUrl || 'Untitled'}</h3>
            <p className={`mt-1 flex items-center gap-1 text-[13px] ${p.status === 'failed' ? 'font-bold text-bad' : 'text-ink-3'}`}>
              {p.status === 'failed' && <AlertTriangle size={13} />}
              <span className="truncate" title={left ? `Kept until ${left.until}` : undefined}>
                {statusLine(p)} · {timeAgo(p.createdAt)}
              </span>
            </p>
            {/* only worth a word when it's close — the Projects page explains how long things are kept */}
            {left?.soon && !working && (
              <p
                className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-warn-bg px-2 py-0.5 text-xs font-bold text-warn-ink"
                title={`Kept until ${left.until} — download or post the clips before then`}
              >
                <Hourglass size={12} /> {left.text}
              </p>
            )}
          </div>
          {p.bestScore != null && <ScoreRing value={p.bestScore} size={44} label="Best crest score" />}
        </div>
        {working && <Progress value={p.progress} className="mx-1 mt-3" label="Progress" />}
      </Link>
      {!working && (
        <Button
          size="icon-sm"
          className="absolute top-5 right-5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={`Delete project ${p.title ?? ''}`}
          title="Delete project"
          onClick={() => onDelete(p)}
        >
          <Trash2 size={16} />
        </Button>
      )}
    </article>
  );
}

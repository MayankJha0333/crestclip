import { Check } from 'lucide-react';
import type { Project } from '../../lib/api';
import { cn } from '../../lib/cn';
import { Card, Progress } from '../../components/ui';

const STAGES = [
  { key: 'fetch', label: 'Get video' },
  { key: 'listen', label: 'Listen' },
  { key: 'transcribe', label: 'Transcribe' },
  { key: 'moments', label: 'Find peaks' },
  { key: 'render', label: 'Reframe & render' },
];

/** "Starting…" or "In line · 2 videos ahead", instead of a worker nobody can see. */
function queuedText(ahead: number | null | undefined) {
  if (ahead == null) return 'Starting soon…';
  if (ahead <= 0) return 'Starting…';
  return `In line · ${ahead === 1 ? '1 video' : `${ahead} videos`} ahead of this one`;
}

/** Where a project is in the pipeline, step by step. */
export function ProcessingCard({ p }: { p: Project }) {
  const idx = STAGES.findIndex((s) => s.key === p.stage);
  return (
    <Card className="animate-pop-in p-6">
      <ol className="grid grid-cols-5 gap-2">
        {STAGES.map((s, i) => {
          const done = i < idx;
          const now = i === idx;
          return (
            <li key={s.key} className={cn('flex flex-col items-center gap-2 text-center text-xs font-extrabold sm:text-sm', done ? 'text-good' : now ? 'text-ink' : 'text-ink-3')}>
              <span
                className={cn(
                  'grid size-10 place-items-center rounded-full font-display font-bold sm:size-11',
                  done ? 'clay-mint text-[#0f3b2e]' : now ? 'animate-float clay-tangerine text-[#2b1407]' : 'bg-sunken shadow-well',
                )}
              >
                {done ? <Check size={16} /> : i + 1}
              </span>
              {s.label}
            </li>
          );
        })}
      </ol>
      <Progress value={p.progress} className="mt-6 h-5" label="Progress" />
      <p className="mt-3 font-bold text-ink-2">
        {p.status === 'queued' ? queuedText(p.queueAhead) : p.stageDetail || 'Working…'} <span className="text-ink-3">· {Math.round(p.progress)}%</span>
      </p>
    </Card>
  );
}

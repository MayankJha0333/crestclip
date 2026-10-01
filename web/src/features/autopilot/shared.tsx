import { useEffect, useState } from 'react';
import { AlertTriangle, Bot, Loader2, Search, Youtube } from 'lucide-react';
import { api, type AutopilotSource, type SchedulerStatus } from '../../lib/api';
import { cn } from '../../lib/cn';
import { Badge } from '../../components/ui';
import { sourceText } from './helpers';

export function useScheduler() {
  const [s, setS] = useState<SchedulerStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .schedulerStatus()
        .then((v) => alive && setS(v))
        .catch(() => {});
    load();
    const t = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return s;
}

/** Autopilot runs its timers on Redis; explain plainly if that isn't up. */
export function SchedulerBanner({ status }: { status: SchedulerStatus | null }) {
  if (!status || status.state === 'ready') return null;
  const busy = status.state === 'starting' || status.state === 'installing';
  return (
    <div className={cn('mb-5 flex items-start gap-3 rounded-[22px] px-4.5 py-3.5 text-sm', busy ? 'bg-warn-bg text-warn-ink' : 'bg-bad-bg text-bad-ink')}>
      {busy ? <Loader2 size={18} className="mt-0.5 shrink-0 animate-spin" /> : <AlertTriangle size={18} className="mt-0.5 shrink-0" />}
      <div className="flex flex-col gap-1">
        <b>{busy ? (status.state === 'installing' ? 'Setting up the scheduler' : 'Starting the scheduler…') : 'The scheduler isn’t running'}</b>
        <span>{status.detail || (busy ? 'One moment…' : 'Autopilot needs Redis to run its timers.')}</span>
        {!busy && (
          <span className="opacity-80">
            Fix: install Apple’s command line tools (System Settings → General → Software Update), or add a <code className="rounded bg-muted-bg px-1.5">REDIS_URL</code> (e.g. a free Upstash database)
            to <code className="rounded bg-muted-bg px-1.5">.env</code>, then restart CrestClip.
          </span>
        )}
      </div>
    </div>
  );
}

export const StatusPill = ({ status }: { status: 'active' | 'paused' }) => (
  <Badge tone={status === 'active' ? 'good' : 'neutral'}>
    <i className={cn('size-2 rounded-full bg-current', status === 'active' && 'animate-ping-soft')} aria-hidden /> {status === 'active' ? 'Running' : 'Paused'}
  </Badge>
);

export const BotIcon = ({ big }: { big?: boolean }) => (
  <span
    className={cn(
      'grid shrink-0 place-items-center bg-[linear-gradient(145deg,#8f7cff,#5b48d9)] text-white shadow-[inset_-4px_-5px_10px_rgba(0,0,0,.18),inset_4px_5px_10px_rgba(255,255,255,.3),5px_8px_16px_rgba(91,72,217,.25)]',
      big ? 'size-14 rounded-[20px]' : 'size-10.5 rounded-[15px]',
    )}
  >
    <Bot size={big ? 26 : 20} />
  </span>
);

export function SourceChips({ sources, limit }: { sources: AutopilotSource[]; limit?: number }) {
  const shown = limit ? sources.slice(0, limit) : sources;
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((s, j) => (
        <Badge key={j}>
          {s.kind === 'youtube_channel' ? <Youtube size={12} /> : <Search size={12} />} <span className="truncate">{sourceText(s)}</span>
        </Badge>
      ))}
      {limit && sources.length > limit && <Badge>+{sources.length - limit}</Badge>}
    </div>
  );
}

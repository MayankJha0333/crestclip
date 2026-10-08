import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, BellRing, Check, Clapperboard, Flame, Link2, Sparkles, Stamp } from 'lucide-react';
import type { Project } from '../../lib/api';
import { cn } from '../../lib/cn';
import { toast } from '../../lib/toast';
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

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** "about 2 min left" from the server's running estimate — rounded, and honest when it's running over. */
function etaText(etaAt: number | null | undefined, now: number) {
  if (!etaAt) return null;
  const left = (etaAt - now) / 1000;
  if (left < -45) return 'taking a bit longer than usual';
  if (left < 25) return 'almost there';
  if (left < 75) return 'about a minute left';
  const mins = left / 60;
  const half = Math.round(mins * 2) / 2;
  return `about ${half % 1 ? `${Math.floor(half)}½` : half} min left`;
}

/** A clock that ticks once a second while the card is on screen. */
function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

const NOTIFY_KEY = (id: string) => `notify:${id}`;
export const wantsNotice = (id: string) => {
  try {
    return sessionStorage.getItem(NOTIFY_KEY(id)) === '1';
  } catch {
    return false;
  }
};

/** "Notify me when it's done": a browser notification once every clip is in — so people can go do something else. */
function NotifyButton({ projectId }: { projectId: string }) {
  const supported = typeof window !== 'undefined' && 'Notification' in window;
  const [on, setOn] = useState(() => wantsNotice(projectId) && supported && Notification.permission === 'granted');
  if (!supported) return null;
  const ask = async () => {
    if (on) {
      sessionStorage.removeItem(NOTIFY_KEY(projectId));
      setOn(false);
      return;
    }
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm !== 'granted') {
      toast('Your browser blocked notifications — this tab’s title will still change when the clips are ready', 'error');
      return;
    }
    sessionStorage.setItem(NOTIFY_KEY(projectId), '1');
    setOn(true);
    toast('You’ll get a notification when the clips are ready');
  };
  return (
    <button
      type="button"
      onClick={ask}
      aria-pressed={on}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-extrabold transition-colors',
        on ? 'bg-good-bg text-good-ink' : 'bg-sunken text-ink-2 shadow-well hover:text-ink',
      )}
    >
      {on ? <BellRing size={14} /> : <Bell size={14} />} {on ? 'Will notify you' : 'Notify me when it’s done'}
    </button>
  );
}

/** Where a project is in the pipeline, step by step — with what the AI is finding, so the wait has something to watch. */
export function ProcessingCard({ p, readyCount = 0 }: { p: Project; readyCount?: number }) {
  const idx = STAGES.findIndex((s) => s.key === p.stage);
  const running = p.status === 'processing';
  const now = useNow(running);
  const feed = (p.feed ?? []).slice(-7);
  const eta = running ? etaText(p.etaAt, now) : null;
  return (
    <Card className="animate-pop-in p-6">
      <ol className="grid grid-cols-5 gap-2">
        {STAGES.map((s, i) => {
          const done = i < idx;
          const current = i === idx;
          return (
            <li key={s.key} className={cn('flex flex-col items-center gap-2 text-center text-xs font-extrabold sm:text-sm', done ? 'text-good' : current ? 'text-ink' : 'text-ink-3')}>
              <span
                className={cn(
                  'grid size-10 place-items-center rounded-full font-display font-bold sm:size-11',
                  done ? 'clay-mint text-[#0f3b2e]' : current ? 'animate-float clay-tangerine text-[#2b1407]' : 'bg-sunken shadow-well',
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
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="font-bold text-ink-2">
          {p.status === 'queued' ? queuedText(p.queueAhead) : p.stageDetail || 'Working…'}
          {eta && <span className="text-ink-3"> · {eta}</span>}
        </p>
        {running && p.startedAt && (
          <p className="text-sm font-bold tabular-nums text-ink-3" aria-live="off">
            {clock(now - p.startedAt)} elapsed
          </p>
        )}
      </div>

      {running && (
        <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
          {/* what the AI is finding, as it happens */}
          <section aria-label="What CrestClip is finding" className="rounded-2xl bg-sunken p-4 shadow-well">
            <b className="inline-flex items-center gap-1.5 font-display text-sm">
              <Sparkles size={15} className="text-accent" /> What CrestClip is finding
            </b>
            <ol className="mt-2 flex flex-col gap-1.5 text-sm">
              {feed.length === 0 && <li className="text-ink-3">Reading the video…</li>}
              {feed.map((f, i) => (
                <li key={`${f.t}-${i}`} className={cn('flex items-start gap-2 animate-pop-in', i === feed.length - 1 ? 'font-bold text-ink' : 'text-ink-2')}>
                  <span className="mt-0.5 shrink-0 text-ink-3">
                    {f.kind === 'moment' ? <Flame size={14} className="text-accent" /> : f.kind === 'clip' ? <Clapperboard size={14} className="text-good" /> : <Check size={14} />}
                  </span>
                  <span className="min-w-0 break-words">{f.text}</span>
                </li>
              ))}
            </ol>
          </section>

          {/* things worth doing meanwhile — they all apply to these clips */}
          <aside className="flex flex-col gap-2">
            <b className="font-display text-sm">While you wait</b>
            <NotifyButton projectId={p.id} />
            <Link to="/app/settings" className="inline-flex items-center gap-1.5 rounded-full bg-sunken px-3 py-1.5 text-sm font-extrabold text-ink-2 no-underline shadow-well hover:text-ink">
              <Stamp size={14} /> Add your logo to every clip
            </Link>
            <Link to="/app/schedule" className="inline-flex items-center gap-1.5 rounded-full bg-sunken px-3 py-1.5 text-sm font-extrabold text-ink-2 no-underline shadow-well hover:text-ink">
              <Link2 size={14} /> Connect YouTube or Instagram to post
            </Link>
            <p className="text-xs font-semibold text-ink-3">
              {readyCount > 0 ? `${readyCount} clip${readyCount === 1 ? '' : 's'} ready below — watch them while the rest render.` : 'Clips appear below one by one, best first, as soon as each is ready.'}
            </p>
          </aside>
        </div>
      )}
    </Card>
  );
}

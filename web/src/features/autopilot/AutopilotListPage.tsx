import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarClock, ChevronRight, Clock, Loader2, Pause, Play, Plus, Sparkles } from 'lucide-react';
import { api, type AutopilotSummary } from '../../lib/api';
import { usePolling } from '../../lib/hooks';
import { useCachedState } from '../../lib/cache';
import { toast } from '../../lib/toast';
import { Button, buttonClass, Card, EmptyState, PageHeader, Skeleton } from '../../components/ui';
import { cn } from '../../lib/cn';
import { dayName } from './helpers';
import { BotIcon, SchedulerBanner, SourceChips, StatusPill, useScheduler } from './shared';
import { useAccount } from '../auth/auth';
import { UpgradeCallout } from '../billing/UpgradeCallout';

const HOW = [
  { t: 'Pick sources', d: 'YouTube channels, or a topic like “podcast clips” in your country' },
  { t: 'Choose your times', d: 'How many posts a day, and exactly when' },
  { t: 'Approve and relax', d: 'See every upcoming post — cancel any of them anytime' },
];

/** "13:00" → "1 PM", "09:30" → "9:30 AM" */
const shortTime = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
};

/** When the next post goes out, in the autopilot's time zone: "Today, 5:00 PM" + "in 15 h". */
function nextLabel(at: number, tz: string) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
  const time = new Date(at).toLocaleTimeString(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const day = dayName(date, tz).replace(/,.*$/, '');
  const mins = Math.max(0, Math.round((at - Date.now()) / 60_000));
  const inText = mins < 60 ? `in ${mins} min` : mins < 48 * 60 ? `in ${Math.round(mins / 60)} h` : `in ${Math.round(mins / 1440)} days`;
  return { when: `${day}, ${time}`, inText };
}

/** One number in the card's stat strip. */
const Stat = ({ value, label, hint }: { value: number; label: string; hint: string }) => (
  <div className="flex flex-col items-center gap-0.5 px-2 py-2.5" title={hint}>
    <b className={cn('font-display text-[22px] leading-none', value === 0 && 'text-ink-3')}>{value}</b>
    <small className="text-[11.5px] font-bold tracking-wide text-ink-3 uppercase">{label}</small>
  </div>
);

export function AutopilotListPage() {
  const [list, setList] = useCachedState<AutopilotSummary[]>('autopilots');
  const sched = useScheduler();
  const allowed = useAccount().plan.autopilot;
  const load = useCallback(
    () =>
      api
        .autopilots()
        .then(setList)
        .catch(() => setList([])),
    [],
  );
  usePolling(load, 10_000);

  const toggle = async (a: AutopilotSummary) => {
    try {
      await (a.status === 'active' ? api.pauseAutopilot(a.id) : api.resumeAutopilot(a.id));
      toast(a.status === 'active' ? 'Paused — upcoming posts cancelled' : 'Running again');
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <>
      <PageHeader
        title="Autopilot"
        description="Pick channels or topics and when to post. CrestClip finds new videos, clips the best moments and posts them on time."
        actions={
          list?.length && allowed ? (
            <Link to="/app/autopilot/new" className={buttonClass('primary')}>
              <Plus size={18} /> New autopilot
            </Link>
          ) : undefined
        }
      />
      <SchedulerBanner status={sched} />
      {!allowed && (
        <UpgradeCallout className="mb-6" title="Autopilot is on the Pro plan" cta="See Pro">
          Pro finds new videos on the channels and topics you pick, clips the best moments and posts them at your times — on its own.
        </UpgradeCallout>
      )}

      {list == null ? (
        <div className="grid gap-5 md:grid-cols-2">
          <Skeleton className="h-60 rounded-[28px]" />
          <Skeleton className="h-60 rounded-[28px]" />
        </div>
      ) : list.length === 0 ? (
        <Card className="p-6">
          <EmptyState
            icon={<Sparkles size={28} />}
            title="No autopilots yet"
            action={
              allowed ? (
                <Link to="/app/autopilot/new" className={buttonClass('primary')}>
                  <Sparkles size={17} /> Create your first autopilot
                </Link>
              ) : undefined
            }
          >
            Set one up in about two minutes. You stay in control — every clip waits for your OK unless you say otherwise.
          </EmptyState>
          <ol className="mx-auto grid max-w-3xl gap-3.5 pb-4 sm:grid-cols-3">
            {HOW.map((s, i) => (
              <li key={s.t} className="flex flex-col items-center gap-1 rounded-[20px] bg-row p-4 text-center shadow-flat">
                <span className="mb-1 grid size-8.5 place-items-center rounded-xl bg-orange-bg font-black text-orange-ink">{i + 1}</span>
                <b className="font-display">{s.t}</b>
                <small className="text-[12.5px] leading-snug text-ink-3">{s.d}</small>
              </li>
            ))}
          </ol>
        </Card>
      ) : (
        <div className="grid gap-5 md:grid-cols-[repeat(auto-fill,minmax(340px,1fr))]">
          {list.map((a, i) => (
            <Card
              key={a.id}
              className={cn('group/card relative flex animate-pop-in flex-col gap-4 p-5 transition-transform hover:-translate-y-0.5', a.status === 'paused' && 'opacity-85')}
              style={{ animationDelay: `${i * 60}ms` }}
            >
              {/* the whole card opens the autopilot; the buttons inside sit above this link */}
              <Link to={`/app/autopilot/${a.id}`} aria-label={`Open ${a.name}`} className="absolute inset-0 z-10 rounded-[inherit]" />
              {/* who + when */}
              <div className="flex items-start gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <BotIcon />
                  <span className="flex min-w-0 flex-col gap-1.5">
                    <b className="truncate font-display text-[19px] leading-tight">{a.name}</b>
                    <span className="flex flex-wrap items-center gap-1">
                      <small className="mr-0.5 text-[12.5px] text-ink-3">
                        {a.config.times.length} post{a.config.times.length > 1 ? 's' : ''} a day
                      </small>
                      {[...a.config.times].sort().map((t) => (
                        <span key={t} className="rounded-full bg-row px-2 py-0.5 text-[11.5px] font-bold text-ink-2">
                          {shortTime(t)}
                        </span>
                      ))}
                    </span>
                  </span>
                </div>
                <StatusPill status={a.status} />
              </div>

              <SourceChips sources={a.config.sources} limit={4} />

              {/* the next post */}
              <div className="flex items-center gap-3.5 rounded-[20px] bg-sunken p-3 shadow-well transition-colors group-hover/card:bg-row">
                {a.status === 'paused' ? (
                  <span className="flex min-h-16 items-center gap-2 px-1 text-[13.5px] text-ink-3">
                    <Pause size={15} /> Paused — nothing will post until you resume.
                  </span>
                ) : a.nextPost ? (
                  <>
                    {a.nextPost.clip?.thumbUrl ? (
                      <img src={a.nextPost.clip.thumbUrl} alt="" className="h-[72px] w-[41px] shrink-0 rounded-[10px] object-cover shadow-flat" />
                    ) : (
                      <span className="h-[72px] w-[41px] shrink-0 rounded-[10px] bg-media" />
                    )}
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      {(() => {
                        const n = nextLabel(a.nextPost.at, a.config.timezone);
                        return (
                          <small className="flex flex-wrap items-center gap-x-1.5 text-[12px] font-bold tracking-wide text-ink-3 uppercase">
                            Next post
                            <span className="font-extrabold text-accent normal-case">{n.when}</span>
                            <span className="font-semibold normal-case">· {n.inText}</span>
                          </small>
                        );
                      })()}
                      <b className="line-clamp-2 text-[14.5px] leading-snug">{a.nextPost.clip?.title ?? 'Clip'}</b>
                    </span>
                    <ChevronRight size={18} className="shrink-0 text-ink-3 transition-transform group-hover/card:translate-x-0.5" />
                  </>
                ) : (
                  <span className="flex min-h-16 items-center gap-2 px-1 text-[13.5px] text-ink-3">
                    <Clock size={15} />
                    {a.counts.clipping
                      ? 'Making clips now — the first post gets booked when one is ready.'
                      : a.counts.review
                        ? 'New clips are waiting for your OK.'
                        : 'Looking for new videos to clip…'}
                  </span>
                )}
              </div>

              {/* what's in the pipeline */}
              <div className="grid grid-cols-3 divide-x divide-line rounded-[18px] bg-row">
                <Stat value={a.counts.scheduled} label="Booked" hint="Clips set to post at an upcoming time" />
                <Stat value={a.counts.ready} label="In line" hint="Finished clips waiting for a free posting time" />
                <Stat value={a.counts.posted} label="Posted" hint="Clips this autopilot has posted" />
              </div>

              {(a.counts.clipping > 0 || a.counts.review > 0) && (
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  {a.counts.clipping > 0 && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-warn-bg px-3 py-1 font-bold text-warn-ink">
                      <Loader2 size={13} className="animate-spin" /> Clipping {a.counts.clipping} new video{a.counts.clipping > 1 ? 's' : ''}
                    </span>
                  )}
                  {a.counts.review > 0 && (
                    <Link to={`/app/autopilot/${a.id}?tab=review`} className="relative z-20 inline-flex items-center gap-1 rounded-full bg-orange-bg px-3 py-1 font-bold text-orange-ink no-underline">
                      {a.counts.review} clip{a.counts.review > 1 ? 's' : ''} to review <ChevronRight size={14} />
                    </Link>
                  )}
                </div>
              )}

              {a.lastError && (
                <p className="flex items-start gap-1.5 rounded-2xl bg-warn-bg px-3 py-2 text-xs leading-snug text-warn-ink">
                  <AlertTriangle size={13} className="mt-px shrink-0" /> {a.lastError}
                </p>
              )}

              <div className="relative z-20 mt-auto flex gap-2">
                <Link to={`/app/autopilot/${a.id}`} className={buttonClass('ink', 'sm', 'flex-1')}>
                  <CalendarClock size={15} /> Open schedule
                </Link>
                <Button size="sm" onClick={() => toggle(a)}>
                  {a.status === 'active' ? <Pause size={15} /> : <Play size={15} />} {a.status === 'active' ? 'Pause' : 'Resume'}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

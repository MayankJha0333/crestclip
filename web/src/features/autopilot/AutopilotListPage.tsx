import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarClock, Clock, Loader2, Pause, Play, Plus, Sparkles } from 'lucide-react';
import { api, type AutopilotSummary } from '../../lib/api';
import { usePolling } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { Badge, Button, buttonClass, Card, EmptyState, PageHeader, Skeleton } from '../../components/ui';
import { prettyTime } from './helpers';
import { BotIcon, SchedulerBanner, SourceChips, StatusPill, useScheduler } from './shared';
import { useAccount } from '../auth/auth';
import { UpgradeCallout } from '../billing/UpgradeCallout';

const HOW = [
  { t: 'Pick sources', d: 'YouTube channels, or a topic like “podcast clips” in your country' },
  { t: 'Choose your times', d: 'How many posts a day, and exactly when' },
  { t: 'Approve and relax', d: 'See every upcoming post — cancel any of them anytime' },
];

export function AutopilotListPage() {
  const [list, setList] = useState<AutopilotSummary[] | null>(null);
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
            <Card key={a.id} className={`flex animate-pop-in flex-col gap-3.5 p-5 ${a.status === 'paused' ? 'opacity-85' : ''}`} style={{ animationDelay: `${i * 60}ms` }}>
              <div className="flex items-start gap-2.5">
                <Link to={`/app/autopilot/${a.id}`} className="flex min-w-0 flex-1 items-center gap-3 text-ink no-underline">
                  <BotIcon />
                  <span className="flex min-w-0 flex-col">
                    <b className="truncate font-display text-[19px]">{a.name}</b>
                    <small className="truncate text-[12.5px] text-ink-3">
                      {a.config.times.length} post{a.config.times.length > 1 ? 's' : ''} a day · {a.config.times.map(prettyTime).join(' · ')}
                    </small>
                  </span>
                </Link>
                <StatusPill status={a.status} />
              </div>
              <SourceChips sources={a.config.sources} limit={4} />
              <div className="flex min-h-16 items-center gap-3 rounded-[18px] bg-sunken px-3 py-2.5 text-[13.5px] shadow-well">
                {a.status === 'paused' ? (
                  <span className="text-ink-3">Paused — nothing will post.</span>
                ) : a.nextPost ? (
                  <>
                    {a.nextPost.clip?.thumbUrl ? (
                      <img src={a.nextPost.clip.thumbUrl} alt="" className="h-13 w-7.5 shrink-0 rounded-lg object-cover" />
                    ) : (
                      <span className="h-13 w-7.5 shrink-0 rounded-lg bg-media" />
                    )}
                    <span className="flex min-w-0 flex-col">
                      <small className="text-ink-3">Next post · {new Date(a.nextPost.at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</small>
                      <b className="truncate">{a.nextPost.clip?.title ?? 'Clip'}</b>
                    </span>
                  </>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-ink-3">
                    <Clock size={13} /> {a.counts.clipping ? 'Making clips now…' : a.counts.review ? 'Waiting for your OK on new clips' : 'Looking for videos…'}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {a.counts.review > 0 && (
                  <Link to={`/app/autopilot/${a.id}?tab=review`} className="no-underline">
                    <Badge tone="orange">{a.counts.review} to review</Badge>
                  </Link>
                )}
                <Badge>{a.counts.scheduled} booked</Badge>
                <Badge>{a.counts.ready} in line</Badge>
                <Badge>{a.counts.posted} posted</Badge>
                {a.counts.clipping > 0 && (
                  <Badge tone="warn">
                    <Loader2 size={12} className="animate-spin" /> clipping
                  </Badge>
                )}
              </div>
              {a.lastError && (
                <p className="flex items-start gap-1.5 text-xs leading-snug text-warn-ink">
                  <AlertTriangle size={13} className="mt-px shrink-0" /> {a.lastError}
                </p>
              )}
              <div className="mt-auto flex gap-2">
                <Link to={`/app/autopilot/${a.id}`} className={buttonClass('secondary', 'sm')}>
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

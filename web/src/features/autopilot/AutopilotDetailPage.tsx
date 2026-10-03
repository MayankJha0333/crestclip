import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  CalendarClock,
  Check,
  CheckCircle2,
  Clapperboard,
  Clock,
  ExternalLink,
  Eye,
  Film,
  FolderOpen,
  Loader2,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Undo2,
  X,
  XCircle,
} from 'lucide-react';
import { api, type ApAlternative, type ApItem, type ApSlot, type ApVideo, type AutopilotDetail } from '../../lib/api';
import { cn } from '../../lib/cn';
import { timeAgo } from '../../lib/format';
import { usePolling } from '../../lib/hooks';
import { toast } from '../../lib/toast';
import { Badge, Button, buttonClass, Card, ConfirmDialog, Dialog, EmptyState, Skeleton, StatTile, Tabs, type BadgeTone, type StatTone } from '../../components/ui';
import { ClipVideo } from '../clips/ClipVideo';
import { PostList } from '../schedule/PostList';
import { SOCIAL } from '../schedule/postStatus';
import { compact, dayName, mins, prettyTime } from './helpers';
import { BotIcon, SchedulerBanner, SourceChips, StatusPill, useScheduler } from './shared';

type Tab = 'schedule' | 'review' | 'videos' | 'history';
type Counts = AutopilotDetail['counts'];

function SlotRow({
  s,
  busy,
  paused,
  counts,
  onSkip,
  onRestore,
  onReject,
}: {
  s: ApSlot;
  busy: boolean;
  paused: boolean;
  counts: Counts;
  onSkip: () => void;
  onRestore: () => void;
  onReject: () => void;
}) {
  const past = s.at < Date.now();
  const posted = s.posts.some((p) => p.status === 'published');
  const failed = s.posts.some((p) => p.status === 'failed');
  const uploading = s.posts.some((p) => p.status === 'uploading' || p.status === 'processing');
  const byYou = s.byYou ?? [];
  // every account of this time was already posted by hand → nothing left for Autopilot to do here
  const doneByYou = byYou.length > 0 && s.posts.length === 0;
  const liveByYou = byYou.some((p) => p.status !== 'scheduled' && p.at <= Date.now());
  const firstByYou = byYou.length ? Math.min(...byYou.map((p) => p.at)) : null;
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-3.5 rounded-2xl py-2.5 pr-3.5 pl-2.5 shadow-flat sm:flex-nowrap',
        s.skipped ? 'bg-[repeating-linear-gradient(135deg,var(--row)_0_10px,var(--sunken)_10px_20px)] opacity-60' : 'bg-row',
        past && 'opacity-75',
      )}
    >
      <span className="w-full font-display text-[15px] font-semibold sm:w-18">{prettyTime(s.time)}</span>
      {s.skipped ? (
        <div className="flex min-h-12 flex-1 flex-col justify-center">
          <b className="text-sm">Cancelled</b>
          <span className="text-[12.5px] text-ink-3">Nothing will post at this time.</span>
        </div>
      ) : s.clip ? (
        <>
          {s.clip.thumbUrl ? <img src={s.clip.thumbUrl} alt="" className="h-17 w-10 shrink-0 rounded-[10px] object-cover" /> : <span className="h-17 w-10 shrink-0 rounded-[10px] bg-media" />}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <b className="truncate">{s.clip.title}</b>
            <span className="text-xs text-ink-3">
              {s.clip.source?.channel ? `from ${s.clip.source.channel} · ` : ''}
              {s.clip.duration}s · score {s.clip.score}
              {' · '}
              <Link to={`/app/p/${s.clip.projectId}`} className="font-bold whitespace-nowrap text-ink-2 hover:text-ink">
                <FolderOpen size={11} className="inline -translate-y-px" /> Open project
              </Link>
            </span>
            {doneByYou && firstByYou != null && (
              <span className="text-[12px] font-bold text-good-ink">
                {liveByYou ? 'You posted this yourself' : 'You booked this yourself'} · {new Date(firstByYou).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })} —
                Autopilot won’t post it again
              </span>
            )}
            <span className="mt-1 flex flex-wrap gap-1.5">
              {byYou.map((p) => {
                const Icon = SOCIAL[p.platform].Icon;
                const live = p.status !== 'scheduled' && p.at <= Date.now();
                return (
                  <Badge key={p.id} tone={live ? 'good' : 'neutral'} title={live ? 'Posted by you' : 'Booked by you'}>
                    <Icon size={11} /> {p.account ?? p.platform} · by you
                    {p.remoteUrl && (
                      <a href={p.remoteUrl} target="_blank" rel="noreferrer" aria-label="Open post" className="text-inherit">
                        <ExternalLink size={11} />
                      </a>
                    )}
                  </Badge>
                );
              })}
              {s.posts.map((p) => {
                const Icon = SOCIAL[p.platform].Icon;
                const tone: BadgeTone = p.status === 'published' ? 'good' : p.status === 'failed' ? 'bad' : p.status === 'uploading' || p.status === 'processing' ? 'warn' : 'neutral';
                return (
                  <Badge key={p.id} tone={tone} title={p.error ?? p.status}>
                    <Icon size={11} /> {p.account ?? p.platform}
                    {p.status === 'published' && p.remoteUrl && (
                      <a href={p.remoteUrl} target="_blank" rel="noreferrer" aria-label="Open post" className="text-inherit">
                        <ExternalLink size={11} />
                      </a>
                    )}
                    {p.status === 'failed' && <XCircle size={11} />}
                  </Badge>
                );
              })}
            </span>
          </div>
        </>
      ) : (
        <div className="flex min-h-12 flex-1 flex-col justify-center">
          <b className="text-sm">{paused ? 'Paused' : past ? 'Nothing was ready' : 'Waiting for a clip'}</b>
          <span className="text-[12.5px] text-ink-3">
            {paused
              ? 'Resume to fill this time.'
              : counts.review
                ? `${counts.review} clip${counts.review > 1 ? 's' : ''} waiting for your OK`
                : counts.clipping
                  ? 'Clips are being made right now'
                  : 'It fills as soon as a clip is ready'}
          </span>
        </div>
      )}
      <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
        {doneByYou ? (
          <Badge tone="good">
            <Check size={12} /> {liveByYou ? 'Posted by you' : 'Booked by you'}
          </Badge>
        ) : uploading ? (
          <Badge tone="warn">
            <Loader2 size={12} className="animate-spin" /> Posting…
          </Badge>
        ) : posted ? (
          <Badge tone="good">
            <Check size={12} /> Posted
          </Badge>
        ) : failed ? (
          <Badge tone="bad">
            <XCircle size={12} /> Failed
          </Badge>
        ) : s.skipped ? (
          !past && (
            <Button size="sm" onClick={onRestore} disabled={busy}>
              <Undo2 size={14} /> Undo
            </Button>
          )
        ) : (
          !past && (
            <>
              {s.clip && s.apClipId && (
                <Button size="icon-sm" title="Don’t post this clip at all" aria-label="Don’t post this clip at all" onClick={onReject} disabled={busy}>
                  <Trash2 size={14} />
                </Button>
              )}
              <Button size="sm" onClick={onSkip} loading={busy} title="Cancel this time — the clip moves to the next free time">
                {!busy && <X size={14} />} Cancel
              </Button>
            </>
          )
        )}
      </div>
    </div>
  );
}

function ReviewGrid({
  items,
  mode,
  busy,
  counts,
  onApprove,
  onReject,
}: {
  items: ApItem[];
  mode: 'review' | 'auto';
  busy: string | null;
  counts: Counts;
  onApprove: (it: ApItem) => void;
  onReject: (it: ApItem) => void;
}) {
  if (!items.length)
    return (
      <EmptyState compact icon={<Clapperboard size={28} />} title={mode === 'review' ? 'Nothing to review' : 'No clips in line'}>
        {counts.clipping
          ? 'Clips are being made right now — they’ll appear here.'
          : counts.waiting
            ? `${counts.waiting} video${counts.waiting > 1 ? 's' : ''} waiting to be clipped.`
            : 'New clips appear here as videos are found.'}
      </EmptyState>
    );
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
      {items.map((it) => (
        <article key={it.id} className="flex flex-col overflow-hidden rounded-[22px] bg-row shadow-flat">
          <ClipVideo clip={{ status: 'ready', videoUrl: it.clip.videoUrl, thumbUrl: it.clip.thumbUrl }} className="rounded-none shadow-none" />
          <div className="flex flex-col gap-0.5 p-3">
            <b className="truncate" title={it.clip.title}>
              {it.clip.title}
            </b>
            <span className="text-xs text-ink-3">
              {it.clip.duration}s · score {it.clip.score}
              {it.clip.source?.channel ? ` · ${it.clip.source.channel}` : ''}
            </span>
            <div className="mt-2 flex gap-1.5">
              <Button size="sm" onClick={() => onReject(it)} disabled={busy === it.id} title="Don’t post">
                <X size={14} /> {mode === 'review' ? 'Skip' : 'Remove'}
              </Button>
              {mode === 'review' && (
                <Button variant="primary" size="sm" className="flex-1" onClick={() => onApprove(it)} loading={busy === it.id}>
                  {busy !== it.id && <Check size={14} />} Approve
                </Button>
              )}
              <Link to={`/app/p/${it.clip.projectId}`} className={buttonClass('secondary', 'icon-sm')} title="Open the project (edit this clip)">
                <Pencil size={14} />
              </Link>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

const VIDEO_STATUS: Record<ApVideo['status'], { label: string; tone: BadgeTone; Icon: typeof Clock }> = {
  waiting: { label: 'Waiting', tone: 'info', Icon: Clock },
  queued: { label: 'Queued', tone: 'info', Icon: Clock },
  clipping: { label: 'Clipping', tone: 'warn', Icon: Loader2 },
  done: { label: 'Clipped', tone: 'good', Icon: Check },
  skipped: { label: 'Skipped', tone: 'neutral', Icon: RotateCcw },
  failed: { label: 'Failed', tone: 'bad', Icon: XCircle },
};

function VideoList({ videos, lastScanAt }: { videos: ApVideo[]; lastScanAt: number | null }) {
  return (
    <>
      <p className="mb-3 text-[13px] text-ink-3">{lastScanAt ? `Last checked ${timeAgo(lastScanAt)} · checks every hour` : 'Checking for the first time…'}</p>
      {videos.length === 0 ? (
        <EmptyState compact icon={<Search size={28} />} title="No videos found yet">
          New uploads from your sources show up here.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-2.5">
          {videos.map((v) => {
            const st = VIDEO_STATUS[v.status];
            return (
              <div key={v.id} className="flex flex-wrap items-center gap-3.5 rounded-2xl bg-row p-2.5 pr-3.5 shadow-flat sm:flex-nowrap">
                {v.thumbnail ? (
                  <img src={v.thumbnail} alt="" referrerPolicy="no-referrer" className="aspect-video w-24 shrink-0 rounded-[10px] object-cover" />
                ) : (
                  <span className="aspect-video w-24 shrink-0 rounded-[10px] bg-media" />
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <a className="truncate font-extrabold text-ink no-underline hover:underline" href={v.url} target="_blank" rel="noreferrer">
                    {v.title || v.url}
                  </a>
                  <span className="text-xs text-ink-3">
                    {[v.channel, v.views != null ? `${compact(v.views)} views` : null, mins(v.duration), v.publishedAt ? timeAgo(v.publishedAt) : null].filter(Boolean).join(' · ')}
                  </span>
                  {v.reason && <span className="text-xs text-ink-3">{v.reason}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={st.tone}>
                    <st.Icon size={12} className={v.status === 'clipping' ? 'animate-spin' : undefined} /> {st.label}
                  </Badge>
                  {v.projectId && (
                    <Link to={`/app/p/${v.projectId}`} className={buttonClass('secondary', 'icon-sm')} title="Open project">
                      <ExternalLink size={14} />
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/** One autopilot: its upcoming schedule, clips waiting for review, videos it found, what it posted. */
export function AutopilotDetailPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [a, setA] = useState<AutopilotDetail | null>(null);
  const [tab, setTab] = useState<Tab>(() => (params.get('tab') as Tab) || 'schedule');
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const sched = useScheduler();
  const load = useCallback(
    () =>
      api
        .autopilot(id)
        .then(setA)
        .catch((e: Error) => toast(e.message, 'error')),
    [id],
  );
  usePolling(load, 6000);

  const [removing, setRemoving] = useState<ApSlot | null>(null);
  const act = async (key: string, fn: () => Promise<unknown>, msg?: string) => {
    setBusy(key);
    try {
      await fn();
      if (msg) toast(msg);
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  if (!a) return <Skeleton className="h-96 rounded-[28px]" />;
  const tz = a.config.timezone;
  const days = a.schedule.reduce<Record<string, ApSlot[]>>((m, s) => ((m[s.date] ||= []).push(s), m), {});
  const active = a.status === 'active';

  return (
    <>
      <Link to="/app/autopilot" className="mb-4 inline-flex items-center gap-1.5 text-sm font-extrabold text-ink-2 no-underline hover:text-ink">
        ← All autopilots
      </Link>
      <header className="mb-6 flex animate-pop-in flex-wrap items-start gap-4">
        <BotIcon big />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="truncate text-3xl">{a.name}</h1>
            <StatusPill status={a.status} />
          </div>
          <p className="mt-1 text-sm text-ink-2">
            {a.config.times.length} post{a.config.times.length > 1 ? 's' : ''} a day at {a.config.times.map(prettyTime).join(', ')} ({tz.replace(/_/g, ' ')}) ·{' '}
            {a.config.mode === 'review' ? 'you approve each clip' : 'fully automatic'}
          </p>
          <div className="mt-2">
            <SourceChips sources={a.config.sources} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" loading={busy === 'scan'} onClick={() => act('scan', () => api.scanAutopilot(id), 'Looking for new videos…')}>
            {busy !== 'scan' && <RefreshCw size={15} />} Find videos now
          </Button>
          <Link to={`/app/autopilot/${id}/edit`} className={buttonClass('secondary', 'sm')}>
            <Pencil size={15} /> Edit
          </Link>
          <Button
            size="sm"
            variant={active ? 'secondary' : 'primary'}
            loading={busy === 'toggle'}
            onClick={() => act('toggle', () => (active ? api.pauseAutopilot(id) : api.resumeAutopilot(id)), active ? 'Paused — upcoming posts cancelled' : 'Running again')}
          >
            {busy !== 'toggle' && (active ? <Pause size={15} /> : <Play size={15} />)} {active ? 'Pause' : 'Resume'}
          </Button>
          <Button size="icon-sm" title="Delete autopilot" aria-label="Delete autopilot" onClick={() => setDeleting(true)}>
            <Trash2 size={15} />
          </Button>
        </div>
      </header>

      <SchedulerBanner status={sched} />
      {a.lastError && (
        <p className="mb-5 flex items-start gap-2 rounded-[18px] bg-warn-bg px-4 py-3 text-[13.5px] text-warn-ink">
          <AlertTriangle size={15} className="mt-px shrink-0" /> {a.lastError}
        </p>
      )}

      {(() => {
        const auto = a.config.mode === 'auto';
        const stats: StatDef[] = [
          // "To review" only matters when clips wait for your OK
          ...(!auto || a.counts.review
            ? [def({ key: 'review', tone: 'orange', icon: <Eye size={20} />, value: a.counts.review, label: 'To review', hint: 'Clips waiting for your OK', tab: 'review' })]
            : []),
          def({ key: 'booked', tone: 'sky', icon: <CalendarClock size={20} />, value: a.counts.scheduled, label: 'Booked', hint: 'Set to post at an upcoming time', tab: 'schedule' }),
          def({ key: 'line', tone: 'lilac', icon: <Clapperboard size={20} />, value: a.counts.ready, label: 'In line', hint: 'Ready, waiting for a free time', tab: auto ? 'review' : 'schedule' }),
          def({ key: 'posted', tone: 'good', icon: <CheckCircle2 size={20} />, value: a.counts.posted, label: 'Posted', hint: 'Live on your accounts', tab: 'history' }),
        ];
        return (
          <div className={cn('mb-6 grid grid-cols-2 gap-3 sm:gap-4', stats.length === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>
            {stats.map((st) => (
              <StatTile key={st.key} tone={st.tone} icon={st.icon} value={st.value} label={st.label} hint={st.hint} onClick={() => setTab(st.tab)} />
            ))}
          </div>
        );
      })()}

      <RemoveClipDialog
        autopilotId={id}
        slot={removing}
        whenLabel={removing ? `${dayName(removing.date, tz)} · ${prettyTime(removing.time)}` : ''}
        onClose={() => setRemoving(null)}
        onDone={async (msg) => {
          setRemoving(null);
          toast(msg);
          await load();
        }}
      />
      <Tabs
        className="mb-4"
        label="Autopilot view"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'schedule', label: 'Schedule' },
          { value: 'review', label: a.config.mode === 'review' ? 'To review' : 'In line', count: a.config.mode === 'review' ? a.review.length : a.ready.length },
          { value: 'videos', label: 'Videos found', count: a.videos.length },
          { value: 'history', label: 'Posted', count: a.history.length },
        ]}
      />

      <Card className="p-5 sm:p-6">
        {tab === 'schedule' && (
          <div className="flex flex-col gap-5">
            {!active && (
              <div className="flex items-center gap-2 rounded-2xl bg-muted-bg px-3.5 py-2.5 text-[13.5px] font-bold text-ink-2">
                <Pause size={16} /> Paused — nothing below will post until you resume.
              </div>
            )}
            {Object.entries(days).map(([date, slots]) => (
              <div key={date}>
                <div className="mb-2.5 flex items-center gap-2 text-[13px] font-black tracking-wider text-ink-2 uppercase">
                  <i className="size-2.5 rounded-full bg-tangerine shadow-[0_0_0_4px_var(--orange-bg)]" aria-hidden /> {dayName(date, tz)}
                </div>
                <div className="ml-1 flex flex-col gap-2.5 border-l-2 border-dashed border-line-strong pl-4">
                  {slots.map((s) => (
                    <SlotRow
                      key={s.key}
                      s={s}
                      busy={busy === s.key}
                      paused={!active}
                      counts={a.counts}
                      onSkip={() => act(s.key, () => api.skipSlot(id, s.key), 'Cancelled — the clip moves to the next free time')}
                      onRestore={() => act(s.key, () => api.restoreSlot(id, s.key), 'Time restored')}
                      onReject={() => setRemoving(s)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        {tab === 'review' && (
          <ReviewGrid
            items={a.config.mode === 'review' ? a.review : a.ready}
            mode={a.config.mode}
            busy={busy}
            counts={a.counts}
            onApprove={(it) => act(it.id, () => api.apClip(id, it.id, 'approve'), 'Approved — added to the schedule')}
            onReject={(it) => act(it.id, () => api.apClip(id, it.id, 'reject'), 'Removed')}
          />
        )}
        {tab === 'videos' && <VideoList videos={a.videos} lastScanAt={a.lastScanAt} />}
        {tab === 'history' &&
          (a.history.length ? (
            <PostList items={a.history} onChange={load} />
          ) : (
            <EmptyState compact icon={<Film size={28} />} title="Nothing posted yet">
              Posts show up here with a link once they go live.
            </EmptyState>
          ))}
      </Card>

      <ConfirmDialog
        open={deleting}
        title="Delete this autopilot?"
        confirmLabel="Delete autopilot"
        onCancel={() => setDeleting(false)}
        onConfirm={() =>
          api
            .deleteAutopilot(id)
            .then(() => {
              toast('Autopilot deleted');
              nav('/app/autopilot');
            })
            .catch((e: Error) => toast(e.message, 'error'))
        }
      >
        <p>
          Every upcoming post from <b>{a.name}</b> is cancelled. Clips already made stay in your Projects, and anything already posted stays online.
        </p>
      </ConfirmDialog>
    </>
  );
}

type StatDef = { key: string; tone: StatTone; icon: ReactNode; value: number; label: string; hint: string; tab: Tab };
const def = (x: StatDef) => x;

/**
 * Asked when a booked clip is deleted: swap in another finished clip at the same time, or just take it off
 * (then the later clips move up one time).
 */
function RemoveClipDialog({ autopilotId, slot, whenLabel, onClose, onDone }: { autopilotId: string; slot: ApSlot | null; whenLabel: string; onClose: () => void; onDone: (msg: string) => void }) {
  const [options, setOptions] = useState<ApAlternative[] | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState<'swap' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = slot?.key ?? null;
  useEffect(() => {
    if (!key) return;
    setOptions(null);
    setPick(null);
    setError(null);
    api
      .apAlternatives(autopilotId)
      .then(setOptions)
      .catch(() => setOptions([]));
  }, [autopilotId, key]);

  const run = async (kind: 'swap' | 'remove') => {
    if (!slot) return;
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'swap') {
        const o = options?.find((x) => x.clip.id === pick);
        if (!o) return;
        await api.swapSlot(autopilotId, slot.key, o.apClipId ? { apClipId: o.apClipId } : { clipId: o.clip.id });
        onDone('Swapped — the new clip posts at the same time');
      } else {
        if (slot.apClipId) await api.apClip(autopilotId, slot.apClipId, 'reject');
        onDone('Clip removed — the later clips move up one time');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open={Boolean(slot)}
      onClose={onClose}
      busy={busy !== null}
      size="lg"
      title="Remove this clip?"
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
            Keep it
          </Button>
          <Button variant="danger" onClick={() => run('remove')} loading={busy === 'remove'} disabled={busy !== null}>
            <Trash2 size={15} /> Just remove
          </Button>
          <Button variant="primary" onClick={() => run('swap')} loading={busy === 'swap'} disabled={!pick || busy !== null}>
            <RefreshCw size={15} /> Swap clip
          </Button>
        </div>
      }
    >
      {slot?.clip && (
        <div className="flex items-center gap-3 rounded-2xl bg-sunken p-3 shadow-well">
          {slot.clip.thumbUrl ? <img src={slot.clip.thumbUrl} alt="" className="h-16 w-9 shrink-0 rounded-[9px] object-cover" /> : <span className="h-16 w-9 shrink-0 rounded-[9px] bg-media" />}
          <span className="flex min-w-0 flex-col">
            <small className="text-xs font-bold text-ink-3">Booked for {whenLabel}</small>
            <b className="line-clamp-2 text-[14.5px] leading-snug">{slot.clip.title}</b>
          </span>
        </div>
      )}

      <h3 className="mt-5 mb-1 font-display text-[17px] font-bold">Swap in another clip</h3>
      <p className="mb-3 text-[13px] text-ink-3">It posts at the same time instead. Or choose “Just remove” and the later clips move up one time.</p>
      {options == null ? (
        <div className="grid gap-2.5 sm:grid-cols-2">
          <Skeleton className="h-21 rounded-2xl" />
          <Skeleton className="h-21 rounded-2xl" />
        </div>
      ) : options.length === 0 ? (
        <p className="rounded-2xl bg-row px-4 py-3.5 text-[13.5px] text-ink-2">No other finished clips right now. New ones arrive as Autopilot clips more videos.</p>
      ) : (
        <div role="radiogroup" aria-label="Clip to swap in" className="grid max-h-[46vh] gap-2.5 overflow-y-auto p-0.5 sm:grid-cols-2">
          {options.map((o) => {
            const on = pick === o.clip.id;
            return (
              <button
                key={o.clip.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setPick(o.clip.id)}
                className={cn(
                  'flex items-center gap-3 rounded-2xl bg-row p-2.5 text-left transition-all outline-none hover:bg-row-hover focus-visible:ring-3 focus-visible:ring-tangerine',
                  on && 'bg-orange-bg ring-2 ring-tangerine',
                )}
              >
                {o.clip.thumbUrl ? <img src={o.clip.thumbUrl} alt="" className="h-16 w-9 shrink-0 rounded-[9px] object-cover" /> : <span className="h-16 w-9 shrink-0 rounded-[9px] bg-media" />}
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <b className="line-clamp-2 text-[13.5px] leading-snug">{o.clip.title}</b>
                  <span className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-3">
                    <Badge tone={o.inLine ? 'good' : 'neutral'}>{o.inLine ? 'In line' : 'Spare'}</Badge>
                    score {o.clip.score} · {o.clip.duration}s
                  </span>
                </span>
                <span aria-hidden className={cn('grid size-5 shrink-0 place-items-center rounded-full border-2', on ? 'border-tangerine bg-tangerine text-white' : 'border-line-strong')}>
                  {on && <Check size={12} strokeWidth={3} />}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {error && <p className="mt-3 rounded-xl bg-bad-bg px-3 py-2 text-[13px] text-bad-ink">{error}</p>}
    </Dialog>
  );
}

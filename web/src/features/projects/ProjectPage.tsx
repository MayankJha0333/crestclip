import { useCallback, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ChevronRight, Clapperboard, Download, ExternalLink, Film, Hourglass, Layers, ListChecks, RotateCcw, Trash2, Tv, XCircle } from 'lucide-react';
import { api, type Project } from '../../lib/api';
import { deletesIn, fmtTime, fmtViews } from '../../lib/format';
import { usePolling } from '../../lib/hooks';
import { Badge, Button, Card, EmptyState, Progress, Skeleton, Spinner, Tabs } from '../../components/ui';
import { ClipList, rankClips, type ClipSort } from './ClipList';
import { UpgradeCallout } from '../billing/UpgradeCallout';
import { DeleteProjectDialog } from './DeleteProjectDialog';
import { ProcessingCard } from './ProcessingCard';
import { ProjectHeader } from './ProjectHeader';
import { isWorking } from './ProjectCard';
import { canWatchSource, SourceTab, type SourceTabHandle } from './SourceTab';

const fmtBytes = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="mb-4 inline-flex items-center gap-1.5 text-sm font-extrabold text-ink-2 no-underline hover:text-ink">
      <ArrowLeft size={16} /> {label}
    </Link>
  );
}

export function ProjectPage() {
  const { id = '' } = useParams();
  const [p, setP] = useState<Project | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api
        .project(id)
        .then(setP)
        .catch((e: Error) => setErr(e.message)),
    [id],
  );
  const busy = !p || isWorking(p) || Boolean(p.clips?.some((c) => c.status === 'pending' || c.status === 'rendering'));
  usePolling(load, busy ? 2000 : 30000);

  if (err)
    return (
      <EmptyState icon={<Film size={28} />} title="Project not found">
        {err}
      </EmptyState>
    );
  if (!p)
    return (
      <div className="flex flex-col gap-5">
        <Skeleton className="h-40 rounded-[28px]" />
        <Skeleton className="h-96 rounded-[28px]" />
      </div>
    );
  return p.sourceType === 'group' ? <GroupProject p={p} load={load} /> : <SingleProject key={p.id} p={p} load={load} />;
}

/** One video → its clips, and (in a second tab) the original with the rewatch graph. */
function SingleProject({ p, load }: { p: Project; load: () => void }) {
  const nav = useNavigate();
  const [tab, setTab] = useState<'clips' | 'source'>('clips');
  const [sort, setSort] = useState<ClipSort>('peak');
  const [highlight, setHighlight] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const source = useRef<SourceTabHandle>(null);
  const clips = useMemo(() => p.clips ?? [], [p.clips]);
  const rank = useMemo(() => rankClips(clips), [clips]);
  const working = isWorking(p);
  const ready = clips.filter((c) => c.status === 'ready').length;
  const hasSource = canWatchSource(p) || Boolean(p.signals && p.duration);

  const openClip = (cid: string) => {
    setTab('clips');
    setHighlight(cid);
    setTimeout(() => document.getElementById(`clip-${cid}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
  };

  return (
    <>
      <BackLink to={p.parentId ? `/app/p/${p.parentId}` : '/app/projects'} label={p.parentId ? 'Back to the project (all videos)' : 'Projects'} />
      <ProjectHeader
        thumbs={[p.thumbUrl]}
        title={p.title || 'Untitled video'}
        onPlay={canWatchSource(p) ? () => (setTab('source'), setTimeout(() => source.current?.play(0), 300)) : undefined}
        facts={
          <>
            {p.channel && <Badge>{p.channel}</Badge>}
            {p.duration ? <Badge>{fmtTime(p.duration)} long</Badge> : null}
            {p.viewCount ? <Badge>{fmtViews(p.viewCount)}</Badge> : null}
            {p.download && (
              <Badge tone="good" title="CrestClip downloaded the audio plus only the parts that became clips, not the whole video">
                <Download size={12} /> {fmtBytes(p.download.downloaded)}
                {p.download.full && p.download.full > p.download.downloaded ? ` instead of ~${fmtBytes(p.download.full)}` : ' downloaded'}
              </Badge>
            )}
            {p.sourceUrl && (
              <a href={p.sourceUrl} target="_blank" rel="noreferrer" className="no-underline">
                <Badge>
                  Source <ExternalLink size={12} />
                </Badge>
              </a>
            )}
            <KeptUntil expiresAt={p.expiresAt} />
          </>
        }
        actions={
          <>
            {p.status === 'failed' && (
              <Button variant="primary" onClick={() => api.retry(p.id).then(load)}>
                <RotateCcw size={18} /> Try again
              </Button>
            )}
            {!working && (
              <Button size="icon" onClick={() => setDeleting(true)} aria-label="Delete project" title="Delete project">
                <Trash2 size={18} />
              </Button>
            )}
          </>
        }
      />
      <DeleteProjectDialog project={deleting ? p : null} onCancel={() => setDeleting(false)} onDeleted={() => nav('/app/projects')} />

      <div className="mt-5 flex flex-col gap-5">
        {working && <ProcessingCard p={p} />}
        {p.status === 'failed' &&
          (p.errorCode ? (
            <UpgradeCallout
              title={p.errorCode === 'credits' ? 'Not enough credits for this video' : 'This video is over your plan’s limit'}
              cta={p.errorCode === 'credits' ? 'Get credits' : 'Upgrade'}
            >
              {p.error} Nothing was charged.
            </UpgradeCallout>
          ) : (
            <Card tone="flat" className="bg-bad-bg p-5 text-bad-ink shadow-none">
              <b>Something went wrong</b>
              <p className="mt-1 font-semibold">{p.error}</p>
              {(p.creditsCharged ?? 0) === 0 && <p className="mt-2 text-sm">Your credits for this video were given back.</p>}
            </Card>
          ))}

        {hasSource && (
          <Tabs
            label="Project view"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'clips', label: 'Clips', count: clips.length, icon: <Clapperboard size={16} /> },
              { value: 'source', label: 'Source video', icon: <Tv size={16} /> },
            ]}
          />
        )}

        {tab === 'source' && hasSource ? (
          <SourceTab
            ref={source}
            p={p}
            rank={rank}
            onOpenClip={openClip}
            onClipsAdded={(first) => {
              setSort('time');
              load();
              if (first) openClip(first);
            }}
          />
        ) : clips.length ? (
          <>
            <p className="-mb-2 text-sm font-bold text-ink-3">
              {clips.length} clips · {ready} ready
            </p>
            <ClipList
              clips={clips}
              sort={sort}
              onSort={setSort}
              sorts={[
                { value: 'peak', label: 'Best first' },
                { value: 'ai', label: 'AI score' },
                { value: 'audience', label: 'Audience' },
                { value: 'time', label: 'Timeline' },
              ]}
              audienceKind={p.signals?.curveKind ?? 'none'}
              highlight={highlight}
              onChanged={load}
            />
          </>
        ) : (
          !working &&
          p.status !== 'failed' && (
            <EmptyState icon={<Clapperboard size={28} />} title="No clips in this video">
              Try the Source video tab and drag across the graph to pick your own parts.
            </EmptyState>
          )
        )}
      </div>
    </>
  );
}

/** Several videos → one project: all their clips together, plus each video's own progress. */
function GroupProject({ p, load }: { p: Project; load: () => void }) {
  const nav = useNavigate();
  const [tab, setTab] = useState<'clips' | 'videos'>('clips');
  const [sort, setSort] = useState<ClipSort>('peak');
  const [deleting, setDeleting] = useState(false);
  const parts = p.parts ?? [];
  const clips = p.clips ?? [];
  const working = isWorking(p);
  const anyFailed = parts.some((x) => x.status === 'failed');
  const rules = p.options.rules ?? [];
  const ready = clips.filter((c) => c.status === 'ready').length;

  return (
    <>
      <BackLink to="/app/projects" label="Projects" />
      <ProjectHeader
        thumbs={parts.map((x) => x.thumbUrl)}
        count={parts.length}
        title={p.title || `${parts.length} videos`}
        facts={
          <>
            <Badge>
              <Layers size={12} /> {parts.length} videos
            </Badge>
            {p.duration ? <Badge>{fmtTime(p.duration)} in total</Badge> : null}
            {working && <Badge tone="warn">{p.stageDetail}</Badge>}
            <KeptUntil expiresAt={p.expiresAt} />
          </>
        }
        actions={
          <>
            {anyFailed && !working && (
              <Button variant="primary" onClick={() => api.retry(p.id).then(load)}>
                <RotateCcw size={18} /> Retry failed videos
              </Button>
            )}
            {!working && (
              <Button size="icon" onClick={() => setDeleting(true)} aria-label="Delete project" title="Delete project (all videos)">
                <Trash2 size={18} />
              </Button>
            )}
          </>
        }
      />
      <DeleteProjectDialog project={deleting ? { ...p, clipCount: clips.length } : null} onCancel={() => setDeleting(false)} onDeleted={() => nav('/app/projects')} />

      {rules.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5 px-1">
          <span className="mr-1 inline-flex items-center gap-1.5 text-sm font-extrabold text-good-ink">
            <ListChecks size={15} /> Following your instructions:
          </span>
          {rules.slice(0, 8).map((r, i) => (
            <Badge key={i}>{r}</Badge>
          ))}
        </div>
      )}

      <div className="mt-5 flex flex-col gap-5">
        <Tabs
          label="Project view"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'clips', label: 'Clips', count: clips.length, icon: <Clapperboard size={16} /> },
            { value: 'videos', label: 'Videos', count: parts.length, icon: <Layers size={16} /> },
          ]}
        />

        {tab === 'videos' ? (
          <Card className="flex flex-col gap-2.5 p-4">
            {parts.map((x) => {
              const busy = isWorking(x);
              return (
                <Link key={x.id} to={`/app/p/${x.id}`} className="flex items-center gap-3 rounded-2xl bg-row p-2.5 pr-4 text-ink no-underline shadow-flat transition-transform hover:-translate-y-0.5">
                  <span className="grid size-7 shrink-0 place-items-center rounded-[10px] bg-ink text-[13px] font-black text-on-ink">{x.index}</span>
                  {x.thumbUrl ? (
                    <img src={x.thumbUrl} alt="" className="aspect-video w-24 shrink-0 rounded-[10px] object-cover" />
                  ) : (
                    <span className="grid aspect-video w-24 shrink-0 place-items-center rounded-[10px] bg-media text-white/50">
                      <Film size={18} />
                    </span>
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <b className="truncate">{x.title || x.sourceUrl || `Video ${x.index}`}</b>
                    {busy ? (
                      <>
                        <small className="truncate text-ink-3">{x.status === 'queued' ? 'Waiting for its turn…' : x.stageDetail || 'Working…'}</small>
                        <Progress value={x.progress} className="h-2 p-0.5" />
                      </>
                    ) : x.status === 'failed' ? (
                      <small className="inline-flex items-center gap-1 truncate font-bold text-bad">
                        <XCircle size={12} /> {x.error || 'Failed'}
                      </small>
                    ) : (
                      <small className="text-ink-3">
                        {x.duration ? `${fmtTime(x.duration)} · ` : ''}
                        {x.readyCount ?? 0} of {x.clipCount ?? 0} clips ready
                      </small>
                    )}
                  </span>
                  <span className="hidden items-center gap-1 text-[13px] font-extrabold whitespace-nowrap text-ink-2 sm:inline-flex">
                    Watch & pick parts <ChevronRight size={15} />
                  </span>
                </Link>
              );
            })}
          </Card>
        ) : clips.length ? (
          <>
            <p className="-mb-2 text-sm font-bold text-ink-3">
              {clips.length} clips · {ready} ready · from {parts.length} videos
            </p>
            <ClipList
              clips={clips}
              sort={sort}
              onSort={setSort}
              sorts={[
                { value: 'peak', label: 'Best first' },
                { value: 'video', label: 'By video' },
              ]}
              audienceKind="none"
              showPart
              onChanged={load}
            />
          </>
        ) : working ? (
          <Card className="flex items-center gap-4 p-6">
            <Spinner className="size-6" />
            <div>
              <b>Finding the best moments in {parts.length} videos…</b>
              <p className="text-ink-2">Clips from each video show up here as soon as they’re ready.</p>
            </div>
          </Card>
        ) : (
          <EmptyState icon={<Clapperboard size={28} />} title="No clips yet">
            Open the Videos tab to see what happened with each video.
          </EmptyState>
        )}
      </div>
    </>
  );
}

/** "Kept until 9 Oct": projects and their clips are deleted after the storage time. */
function KeptUntil({ expiresAt }: { expiresAt?: number | null }) {
  const left = deletesIn(expiresAt);
  if (!left) return null;
  return (
    <Badge tone={left.soon ? 'warn' : undefined} title={`${left.text}. Projects and their clips are deleted 7 days after they’re made — download or post your clips before then.`}>
      <Hourglass size={12} /> Kept until {left.until}
    </Badge>
  );
}

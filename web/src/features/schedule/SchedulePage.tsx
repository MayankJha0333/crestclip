import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarClock, CheckCircle2, Clapperboard, FolderOpen, History, Link2, Settings } from 'lucide-react';
import { api, type Connections, type PostItem } from '../../lib/api';
import { usePolling } from '../../lib/hooks';
import { buttonClass, Card, Chip, EmptyState, PageHeader, Skeleton, StatTile, Tabs } from '../../components/ui';
import { PostList } from './PostList';
import { dayLabel, isUpcoming, SOCIAL, type SocialPlatform } from './postStatus';

/** Everything that's going out (or went out) to YouTube and Instagram — manual posts and Autopilot alike. */
export function SchedulePage() {
  const [list, setList] = useState<PostItem[] | null>(null);
  const [conn, setConn] = useState<Connections | null>(null);
  const [tab, setTab] = useState<'upcoming' | 'history'>('upcoming');
  const [only, setOnly] = useState<'all' | SocialPlatform>('all');
  usePolling(() => {
    api
      .posts()
      .then(setList)
      .catch(() => setList([]));
    api
      .connections()
      .then(setConn)
      .catch(() => {});
  }, 5000);
  const reload = () =>
    api
      .posts()
      .then(setList)
      .catch(() => {});

  const all = useMemo(() => list ?? [], [list]);
  const upcoming = useMemo(() => all.filter(isUpcoming).sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0)), [all]);
  const history = useMemo(() => all.filter((p) => !isUpcoming(p)).sort((a, b) => b.updatedAt - a.updatedAt), [all]);
  const posted = history.filter((p) => p.status === 'published').length;
  const failed = all.filter((p) => p.status === 'failed').length;
  const linked = conn?.accounts.length ?? 0;
  const source = tab === 'upcoming' ? upcoming : history;
  const shown = source.filter((p) => only === 'all' || p.platform === only);

  const days = useMemo(() => {
    const m = new Map<string, PostItem[]>();
    for (const p of shown) m.set(dayLabel(p.scheduledAt ?? p.createdAt), [...(m.get(dayLabel(p.scheduledAt ?? p.createdAt)) ?? []), p]);
    return [...m.entries()];
  }, [shown]);

  return (
    <>
      <PageHeader
        title="Schedule"
        description="Every post going out to YouTube and Instagram — from clips you post yourself and from Autopilot."
        actions={
          <Link to="/app/settings" className={buttonClass('secondary', 'sm')}>
            <Settings size={15} /> Connected accounts
          </Link>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile icon={<Link2 size={15} />} tone="sky" value={linked} label="Accounts connected" />
        <StatTile icon={<CalendarClock size={15} />} tone="orange" value={upcoming.length} label="Scheduled" />
        <StatTile icon={<CheckCircle2 size={15} />} tone="good" value={posted} label="Posted" />
        <StatTile icon={<AlertTriangle size={15} />} tone={failed ? 'bad' : 'muted'} value={failed} label="Need attention" />
      </div>

      <Card className="p-5 sm:p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <Tabs
            label="Which posts"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'upcoming', label: 'Upcoming', count: upcoming.length, icon: <CalendarClock size={15} /> },
              { value: 'history', label: 'History', count: history.length, icon: <History size={15} /> },
            ]}
          />
          <div className="flex gap-2" aria-label="Filter by platform">
            {(['all', 'youtube', 'instagram'] as const).map((k) => {
              const Icon = k === 'all' ? null : SOCIAL[k].Icon;
              return (
                <Chip key={k} pressed={only === k} onClick={() => setOnly(k)}>
                  {Icon && <Icon size={14} />} {k === 'all' ? 'All' : SOCIAL[k].name}
                </Chip>
              );
            })}
          </div>
        </div>

        {list == null ? (
          <div className="flex flex-col gap-2.5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <EmptyState
            compact
            icon={tab === 'upcoming' ? <CalendarClock size={28} /> : <Clapperboard size={28} />}
            title={only !== 'all' && source.length ? 'Nothing here for this platform' : tab === 'upcoming' ? 'Nothing scheduled yet' : 'No posts yet'}
            action={
              !linked ? (
                <Link to="/app/settings" className={buttonClass('primary', 'sm')}>
                  <Link2 size={15} /> Connect YouTube or Instagram
                </Link>
              ) : (
                <Link to="/app/projects" className={buttonClass('secondary', 'sm')}>
                  <FolderOpen size={15} /> Open projects
                </Link>
              )
            }
          >
            {!linked
              ? 'Connect an account first, then press Post on any clip.'
              : tab === 'upcoming'
                ? 'Open a project, press Post on a clip and pick “Schedule”.'
                : 'Clips you post show up here with a link to the live video.'}
          </EmptyState>
        ) : tab === 'upcoming' ? (
          <div className="flex flex-col gap-5">
            {days.map(([day, posts]) => (
              <div key={day}>
                <div className="mb-2.5 flex items-center gap-2 text-[13px] font-black tracking-wider text-ink-2 uppercase">
                  <i className="size-2.5 rounded-full bg-tangerine shadow-[0_0_0_4px_var(--orange-bg)]" aria-hidden /> {day}
                </div>
                <div className="ml-1 border-l-2 border-dashed border-line-strong pl-4">
                  <PostList items={posts} onChange={reload} showTime />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <PostList items={shown} onChange={reload} />
        )}
      </Card>
    </>
  );
}

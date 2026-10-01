import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  Clapperboard,
  Copy,
  ExternalLink,
  FolderOpen,
  History,
  Instagram,
  Link2,
  Loader2,
  LogOut,
  MousePointerClick,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  UserPlus,
  X,
  XCircle,
  Youtube,
} from 'lucide-react';
import { api, timeAgo, type Account, type Connections, type PostItem } from '../lib/api';
import { ConfirmModal } from '../components/ConfirmModal';
import { toast } from '../lib/toast';

type Platform = 'youtube' | 'instagram';

const PLATFORM = {
  youtube: {
    name: 'YouTube',
    what: 'Shorts',
    Icon: Youtube,
    tint: 'yt',
    provider: 'Google',
    blurb: 'Post Shorts straight to your channel.',
    perks: ['Title, description and privacy per post', 'Scheduled with YouTube’s own clock — goes out even if PeakClip is off'],
    note: (
      <>
        Until your Google app passes YouTube’s free API audit, uploads stay <b>private</b>. Fine for testing — request the audit before launch.
      </>
    ),
  },
  instagram: {
    name: 'Instagram',
    what: 'Reels',
    Icon: Instagram,
    tint: 'ig',
    provider: 'Instagram',
    blurb: 'Post Reels with your caption and hashtags.',
    perks: ['Caption, hashtags and cover from your clip', 'Scheduled by PeakClip — keep it running at post time'],
    note: (
      <>
        Needs an Instagram <b>Business or Creator</b> account (Instagram app → Settings → Account type).
      </>
    ),
  },
} as const;

export function fmtWhen(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400_000);
  const day =
    d.toDateString() === today.toDateString() ? 'Today' : d.toDateString() === tomorrow.toDateString() ? 'Tomorrow' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `${day}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

/** What a post's status means, in words */
export function postLabel(p: { platform: Platform; status: string; scheduledAt: number | null }) {
  const future = p.scheduledAt && p.scheduledAt > Date.now();
  if (p.status === 'published' && future && p.platform === 'youtube') return { text: `Scheduled on YouTube · ${fmtWhen(p.scheduledAt!)}`, tone: 'sched' };
  if (p.status === 'published') return { text: 'Posted', tone: 'ok' };
  if (p.status === 'scheduled') return future ? { text: `Scheduled · ${fmtWhen(p.scheduledAt!)}`, tone: 'sched' } : { text: 'Starting…', tone: 'busy' };
  if (p.status === 'uploading' || p.status === 'processing') return { text: 'Uploading…', tone: 'busy' };
  if (p.status === 'canceled') return { text: 'Canceled', tone: 'muted' };
  return { text: 'Failed', tone: 'bad' };
}

const isUpcoming = (p: PostItem) =>
  Boolean(p.scheduledAt && p.scheduledAt > Date.now() && (p.status === 'scheduled' || (p.platform === 'youtube' && p.status === 'published')));

const dayLabel = (ms: number) => {
  const d = new Date(ms);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
};

export function AccountsPage() {
  const [data, setData] = useState<Connections | null>(null);
  const [list, setList] = useState<PostItem[] | null>(null);
  const [params, setParams] = useSearchParams();
  const [removing, setRemoving] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'upcoming' | 'history'>('upcoming');
  const [only, setOnly] = useState<'all' | Platform>('all');

  const load = useCallback(() => {
    api.connections().then(setData).catch(() => {});
    api.posts().then(setList).catch(() => setList([]));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  // result of the OAuth round-trip
  useEffect(() => {
    const ok = params.get('connected');
    const err = params.get('error');
    if (ok) toast(`${PLATFORM[ok as Platform]?.name ?? ok} connected${params.get('name') ? ` — ${params.get('name')}` : ''}`);
    if (err) toast(err, 'error');
    if (ok || err) setParams({}, { replace: true });
  }, [params, setParams]);

  const all = list ?? [];
  const upcoming = useMemo(() => all.filter(isUpcoming).sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0)), [all]);
  const history = useMemo(() => all.filter((p) => !isUpcoming(p)).sort((a, b) => b.updatedAt - a.updatedAt), [all]);
  const posted = all.filter((p) => p.status === 'published' && !isUpcoming(p)).length;
  const failed = all.filter((p) => p.status === 'failed').length;
  const linked = (['youtube', 'instagram'] as const).filter((pf) => data?.accounts.some((a) => a.platform === pf)).length;

  const shown = (tab === 'upcoming' ? upcoming : history).filter((p) => only === 'all' || p.platform === only);

  return (
    <div className="page pub">
      <header className="pub-head pop-in">
        <div>
          <span className="pub-kicker">
            <Send size={14} /> Publishing
          </span>
          <h1>Post your clips where people watch</h1>
          <p className="muted">Connect each account once. Then press Post on any clip — now or at a time you pick.</p>
        </div>
        <div className="pub-stats">
          <Stat icon={<Link2 size={16} />} tone="sky" value={`${linked}/2`} label="Platforms linked" />
          <Stat icon={<CalendarClock size={16} />} tone="tangerine" value={upcoming.length} label="Scheduled" />
          <Stat icon={<CheckCircle2 size={16} />} tone="mint" value={posted} label="Posted" />
          <Stat icon={<AlertTriangle size={16} />} tone={failed ? 'bad' : 'muted'} value={failed} label="Need attention" />
        </div>
      </header>

      <div className="pub-grid">
        {(['youtube', 'instagram'] as const).map((pf, i) => (
          <PlatformCard
            key={pf}
            pf={pf}
            delay={i * 80}
            accounts={data?.accounts.filter((a) => a.platform === pf) ?? []}
            setup={data?.platforms[pf]}
            needsHttps={pf === 'instagram' && Boolean(data?.platforms.instagram.needsHttps)}
            loading={!data}
            onRemove={setRemoving}
          />
        ))}
      </div>

      <section className="clay pub-posts pop-in" style={{ animationDelay: '160ms' }}>
        <div className="pub-posts-head">
          <h2>Your posts</h2>
          <div className="seg" role="tablist" aria-label="Which posts">
            <button role="tab" aria-pressed={tab === 'upcoming'} aria-selected={tab === 'upcoming'} onClick={() => setTab('upcoming')}>
              <CalendarClock size={15} /> Upcoming <span className="pub-count">{upcoming.length}</span>
            </button>
            <button role="tab" aria-pressed={tab === 'history'} aria-selected={tab === 'history'} onClick={() => setTab('history')}>
              <History size={15} /> History <span className="pub-count">{history.length}</span>
            </button>
          </div>
          <div className="pub-filter" aria-label="Filter by platform">
            {(['all', 'youtube', 'instagram'] as const).map((k) => {
              const Icon = k === 'all' ? null : PLATFORM[k].Icon;
              return (
                <button key={k} type="button" className="chip" aria-pressed={only === k} onClick={() => setOnly(k)}>
                  {Icon && <Icon size={14} />} {k === 'all' ? 'All' : PLATFORM[k].name}
                </button>
              );
            })}
          </div>
        </div>

        {list == null ? (
          <div className="pub-skel">
            {[0, 1, 2].map((i) => (
              <span key={i} className="pub-skel-row" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <EmptyPosts tab={tab} anyLinked={linked > 0} filtered={only !== 'all' && (tab === 'upcoming' ? upcoming : history).length > 0} />
        ) : tab === 'upcoming' ? (
          <Timeline items={shown} onChange={load} />
        ) : (
          <PostList items={shown} onChange={load} />
        )}
      </section>

      <ConfirmModal
        open={Boolean(removing)}
        title={`Disconnect ${removing ? PLATFORM[removing.platform].name : ''}?`}
        confirmLabel="Disconnect"
        busy={busy}
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          setBusy(true);
          try {
            await api.disconnect(removing.id);
            toast('Disconnected');
            setRemoving(null);
            load();
          } catch (e) {
            toast((e as Error).message, 'error');
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          PeakClip will forget <b>{removing?.name}</b> and drop its post history here. Posts waiting in PeakClip won’t go out. Anything already on {removing ? PLATFORM[removing.platform].name : ''} (including YouTube’s own schedule) stays there.
        </p>
      </ConfirmModal>
    </div>
  );
}

function Stat({ icon, value, label, tone }: { icon: ReactNode; value: ReactNode; label: string; tone: string }) {
  return (
    <div className={`pub-stat ${tone}`}>
      <span className="pub-stat-ico">{icon}</span>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function PlatformCard({
  pf,
  accounts,
  setup,
  needsHttps,
  loading,
  delay,
  onRemove,
}: {
  pf: Platform;
  accounts: Account[];
  setup: { configured: boolean; redirectUri: string } | undefined;
  needsHttps: boolean;
  loading: boolean;
  delay: number;
  onRemove: (a: Account) => void;
}) {
  const P = PLATFORM[pf];
  const connected = accounts.length > 0;
  const status = loading ? null : connected ? { t: `${accounts.length} connected`, c: 'on' } : setup?.configured ? { t: 'Not connected', c: 'off' } : { t: 'Setup needed', c: 'warn' };

  return (
    <section className={`clay pub-card ${P.tint} ${connected ? 'is-on' : ''} pop-in`} style={{ animationDelay: `${delay}ms` }}>
      <span className="pub-card-glow" aria-hidden />
      <div className="pub-card-top">
        <span className={`acct-logo ${P.tint}`}>
          <P.Icon size={26} />
        </span>
        <div className="grow">
          <h2>{P.name}</h2>
          <p>{P.blurb}</p>
        </div>
        {status && (
          <span className={`pub-state ${status.c}`}>
            <i aria-hidden /> {status.t}
          </span>
        )}
      </div>

      <ul className="pub-perks">
        {P.perks.map((t) => (
          <li key={t}>
            <Check size={14} /> {t}
          </li>
        ))}
      </ul>

      {connected ? (
        <div className="pub-accounts">
          {accounts.map((a) => (
            <div key={a.id} className="pub-acct">
              <span className="pub-avatar">
                {a.avatar ? <img src={a.avatar} alt="" referrerPolicy="no-referrer" /> : <span>{(a.name ?? '?')[0]}</span>}
                <span className={`pub-avatar-badge ${P.tint}`}>
                  <P.Icon size={10} />
                </span>
              </span>
              <div className="grow" style={{ minWidth: 0 }}>
                <b className="clamp1">{a.name}</b>
                <span className="faint">
                  {a.handle ? `${a.handle} · ` : ''}connected {timeAgo(a.connectedAt)}
                </span>
              </div>
              <button className="btn btn-sm pub-disconnect" onClick={() => onRemove(a)} title={`Disconnect ${a.name ?? ''}`}>
                <LogOut size={14} /> <span>Disconnect</span>
              </button>
            </div>
          ))}
          {setup?.configured && (
            <a className="pub-add" href={api.connectUrl(pf)}>
              <UserPlus size={15} /> Add another {P.name} account
            </a>
          )}
        </div>
      ) : setup?.configured ? (
        <div className="pub-connect">
          <ol className="pub-flow">
            <li>
              <span>
                <MousePointerClick size={15} />
              </span>
              Click Connect
            </li>
            <li>
              <span>
                <ShieldCheck size={15} />
              </span>
              Allow on {P.provider}
            </li>
            <li>
              <span>
                <Sparkles size={15} />
              </span>
              Post any clip
            </li>
          </ol>
          <a className="btn btn-primary pub-cta" href={api.connectUrl(pf)}>
            <Link2 size={16} /> Connect {P.name}
          </a>
          <p className="pub-safe">
            <ShieldCheck size={13} /> PeakClip only asks to upload {P.what} — never your password. Disconnect any time.
          </p>
        </div>
      ) : loading ? (
        <span className="pub-skel-row" style={{ marginTop: 18 }} />
      ) : (
        <SetupSteps platform={pf} redirectUri={setup?.redirectUri ?? ''} needsHttps={needsHttps} />
      )}

      <p className="pub-note">
        <AlertTriangle size={13} />
        <span>{P.note}</span>
      </p>
    </section>
  );
}

function EmptyPosts({ tab, anyLinked, filtered }: { tab: 'upcoming' | 'history'; anyLinked: boolean; filtered: boolean }) {
  const title = filtered ? 'Nothing here for this platform' : tab === 'upcoming' ? 'Nothing scheduled yet' : 'No posts yet';
  const text = filtered
    ? 'Try “All” to see posts for every platform.'
    : !anyLinked
      ? 'Connect YouTube or Instagram above, then press Post on any clip.'
      : tab === 'upcoming'
        ? 'Open a project, press Post on a clip and pick “Schedule”.'
        : 'Clips you post will show up here with a link to the live video.';
  return (
    <div className="pub-empty">
      <span className="empty-blob pub-empty-blob">{tab === 'upcoming' ? <CalendarClock size={28} /> : <Clapperboard size={28} />}</span>
      <div>
        <b>{title}</b>
        <p className="muted">{text}</p>
      </div>
      {!filtered && anyLinked && (
        <Link className="btn btn-sm" to="/app/projects">
          <FolderOpen size={15} /> Open projects
        </Link>
      )}
    </div>
  );
}

/** Upcoming posts grouped by day, like a little calendar */
function Timeline({ items, onChange }: { items: PostItem[]; onChange: () => void }) {
  const groups = useMemo(() => {
    const m = new Map<string, PostItem[]>();
    for (const p of items) {
      const k = dayLabel(p.scheduledAt ?? p.createdAt);
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return [...m.entries()];
  }, [items]);
  return (
    <div className="pub-timeline">
      {groups.map(([day, posts]) => (
        <div key={day} className="pub-day">
          <div className="pub-day-label">
            <i aria-hidden /> {day}
          </div>
          <PostList items={posts} onChange={onChange} showTime />
        </div>
      ))}
    </div>
  );
}

export function PostList({ items, onChange, showTime }: { items: PostItem[]; onChange: () => void; showTime?: boolean }) {
  return (
    <div className="post-list">
      {items.map((p) => {
        const L = postLabel(p);
        const P = PLATFORM[p.platform];
        const when = showTime && p.scheduledAt ? new Date(p.scheduledAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : null;
        return (
          <div key={p.id} className={`post-row tone-${L.tone}`}>
            {when && <span className="post-time">{when}</span>}
            <span className="post-thumb-wrap">
              {p.clip?.thumbUrl ? <img className="post-thumb" src={p.clip.thumbUrl} alt="" /> : <span className="post-thumb" />}
              <span className={`post-thumb-badge ${P.tint}`}>
                <P.Icon size={11} />
              </span>
            </span>
            <div className="grow" style={{ minWidth: 0 }}>
              <b className="clamp1">{p.title || p.clip?.title || 'Clip'}</b>
              <span className="faint post-meta">
                {p.account?.handle ?? p.account?.name ?? P.name}
                {!showTime && <> · {timeAgo(p.updatedAt)}</>}
                {p.clip && (
                  <>
                    {' · '}
                    <Link to={`/app/p/${p.clip.projectId}`} className="linkish">
                      open project
                    </Link>
                  </>
                )}
              </span>
              {p.error && <span className={`post-err ${p.status === 'failed' ? 'bad' : ''}`}>{p.error}</span>}
            </div>
            <div className="post-actions">
              <span className={`post-status ${L.tone}`}>
                {L.tone === 'busy' ? <Loader2 size={13} className="spin-icon" /> : L.tone === 'ok' ? <Check size={13} /> : L.tone === 'bad' ? <XCircle size={13} /> : <CalendarClock size={13} />}
                {showTime && L.tone === 'sched' ? (p.platform === 'youtube' && p.status === 'published' ? 'On YouTube’s schedule' : 'Scheduled') : L.text}
              </span>
              {p.remoteUrl && (
                <a className="btn btn-icon btn-sm" href={p.remoteUrl} target="_blank" rel="noreferrer" title={`Open on ${P.name}`}>
                  <ExternalLink size={14} />
                </a>
              )}
              {p.status === 'failed' && (
                <button className="btn btn-sm" onClick={() => api.retryPost(p.id).then(onChange).catch((e) => toast(e.message, 'error'))}>
                  <RotateCcw size={14} /> Retry
                </button>
              )}
              {p.status === 'scheduled' && p.scheduledAt && p.scheduledAt > Date.now() && (
                <button className="btn btn-icon btn-sm" title="Cancel this post" onClick={() => api.cancelPost(p.id).then(onChange).catch((e) => toast(e.message, 'error'))}>
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SetupSteps({ platform, redirectUri, needsHttps }: { platform: Platform; redirectUri: string; needsHttps: boolean }) {
  const [open, setOpen] = useState(true);
  const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast('Copied'));
  const steps =
    platform === 'youtube'
      ? [
          <>
            In <a className="linkish" href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noreferrer">Google Cloud</a> (same project as Gemini), turn on <b>YouTube Data API v3</b>.
          </>,
          <>
            Set up the <a className="linkish" href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noreferrer">OAuth consent screen</a> (External) and add your Google account as a <b>test user</b>.
          </>,
          <>
            Create an <a className="linkish" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">OAuth client ID</a> → type <b>Web application</b> → add this redirect URI:
          </>,
          <>
            Put the keys in <code>.env</code>: <code>YOUTUBE_CLIENT_ID=…</code> and <code>YOUTUBE_CLIENT_SECRET=…</code>, then restart PeakClip.
          </>,
        ]
      : [
          <>
            Make sure the Instagram account is a <b>Business or Creator</b> account (Instagram app → Settings → Account type).
          </>,
          <>
            In <a className="linkish" href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer">Meta for Developers</a>, create an app → add <b>Instagram</b> → “API setup with Instagram login”, and add your account as a tester.
          </>,
          <>
            Under <b>Business login settings</b>, add this redirect URL
            {needsHttps
              ? ' (Instagram needs https — use your live domain, then set PUBLIC_URL in .env to it)'
              : redirectUri.startsWith('https://localhost')
                ? ' (local https — the first time, your browser warns “not private”: click Advanced → Proceed)'
                : ''}
            :
          </>,
          <>
            Put the keys in <code>.env</code>: <code>INSTAGRAM_APP_ID=…</code> and <code>INSTAGRAM_APP_SECRET=…</code>, then restart PeakClip.
          </>,
        ];
  return (
    <div className="setup-steps well">
      <button type="button" className="linkish" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        One-time setup (about 10 min) <ChevronDown size={14} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
      </button>
      {open && (
        <ol>
          {steps.map((s, i) => (
            <li key={i}>
              {s}
              {i === 2 && (
                <div className="uri-row">
                  <code>{redirectUri}</code>
                  <button type="button" className="btn btn-icon btn-sm" onClick={() => copy(redirectUri)} aria-label="Copy redirect URI">
                    <Copy size={13} />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

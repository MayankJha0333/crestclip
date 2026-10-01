import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CalendarClock,
  Check,
  CheckCircle2,
  Clapperboard,
  Clock,
  ExternalLink,
  Eye,
  Film,
  Globe,
  Hash,
  Instagram,
  Loader2,
  Minus,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Undo2,
  X,
  XCircle,
  Youtube,
} from 'lucide-react';
import {
  api,
  timeAgo,
  type Account,
  type ApItem,
  type ApSlot,
  type ApVideo,
  type AutopilotConfig,
  type AutopilotDetail,
  type AutopilotInput,
  type AutopilotSource,
  type AutopilotSummary,
  type CaptionStyle,
  type Motion,
  type Platform,
  type SchedulerStatus,
} from '../lib/api';
import { CaptionPicker, PLATFORM_OPTIONS, Seg, Toggle } from '../components/bits';
import { MotionPicker } from '../components/MusicPicker';
import { ConfirmModal } from '../components/ConfirmModal';
import { PostList } from './Accounts';
import { toast } from '../lib/toast';

// ---------------- helpers ----------------
const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};
const allZones = (): string[] => {
  try {
    return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Asia/Kolkata', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo', 'Australia/Sydney'];
  }
};
/** "13:00" → "1:00 PM" */
const prettyTime = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const todayIn = (tz: string, plusDays = 0) => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(new Date(Date.now() + plusDays * 86400_000));
};
const dayName = (date: string, tz: string) => {
  if (date === todayIn(tz)) return 'Today';
  if (date === todayIn(tz, 1)) return 'Tomorrow';
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
};
const compact = (n: number | null | undefined) => (n == null ? '—' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n));
const mins = (s: number | null) => (s == null ? '' : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : `${Math.round(s / 60)} min`);

/** Spread `n` posting times nicely over the day. */
function defaultTimes(n: number): string[] {
  const presets: Record<number, string[]> = {
    1: ['18:00'],
    2: ['13:00', '19:00'],
    3: ['12:00', '17:00', '21:00'],
    4: ['09:00', '13:00', '17:00', '21:00'],
    5: ['09:00', '12:00', '15:00', '18:00', '21:00'],
  };
  if (presets[n]) return presets[n];
  const start = 8 * 60;
  const end = 23 * 60;
  return Array.from({ length: n }, (_, i) => {
    const m = Math.round(start + ((end - start) * i) / (n - 1));
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor((m % 60) / 15) * 15).padStart(2, '0')}`;
  });
}

const REGIONS: { code: string; label: string }[] = [
  { code: '', label: 'Anywhere' },
  { code: 'IN', label: 'India' },
  { code: 'US', label: 'United States' },
  { code: 'GB', label: 'United Kingdom' },
  { code: 'CA', label: 'Canada' },
  { code: 'AU', label: 'Australia' },
  { code: 'AE', label: 'UAE' },
  { code: 'SG', label: 'Singapore' },
  { code: 'DE', label: 'Germany' },
  { code: 'FR', label: 'France' },
  { code: 'BR', label: 'Brazil' },
  { code: 'JP', label: 'Japan' },
  { code: 'ID', label: 'Indonesia' },
  { code: 'PH', label: 'Philippines' },
];
const regionLabel = (c?: string | null) => REGIONS.find((r) => r.code === (c ?? ''))?.label ?? c ?? 'Anywhere';

const DEFAULT_CAPTION = '{title}\n\n{hashtags}\n\n🎥 Credit: {channel}';

function sourceText(s: AutopilotSource) {
  return s.kind === 'youtube_channel' ? s.label || s.value : `“${s.value}”${s.region ? ` · ${regionLabel(s.region)}` : ''}`;
}

function SchedulerBanner({ status }: { status: SchedulerStatus | null }) {
  if (!status || status.state === 'ready') return null;
  const busy = status.state === 'starting' || status.state === 'installing';
  return (
    <div className={`ap-banner ${busy ? 'busy' : 'bad'}`}>
      {busy ? <Loader2 size={18} className="spin-icon" /> : <AlertTriangle size={18} />}
      <div>
        <b>{busy ? (status.state === 'installing' ? 'Setting up the scheduler' : 'Starting the scheduler…') : 'The scheduler isn’t running'}</b>
        <span>{status.detail || (busy ? 'One moment…' : 'Autopilot needs Redis to run its timers.')}</span>
        {!busy && (
          <span className="faint">
            Fix: install Apple’s command line tools (System Settings → General → Software Update), or add a <code>REDIS_URL</code> (e.g. a free Upstash database) to <code>.env</code>, then restart CrestClip.
          </span>
        )}
      </div>
    </div>
  );
}

function useScheduler() {
  const [s, setS] = useState<SchedulerStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.schedulerStatus().then((v) => alive && setS(v)).catch(() => {});
    load();
    const t = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return s;
}

const StatusPill = ({ status }: { status: 'active' | 'paused' }) => (
  <span className={`ap-pill ${status}`}>
    <i aria-hidden /> {status === 'active' ? 'Running' : 'Paused'}
  </span>
);

// =====================================================================
// LIST
// =====================================================================
export function AutopilotList() {
  const [list, setList] = useState<AutopilotSummary[] | null>(null);
  const sched = useScheduler();
  const load = useCallback(() => api.autopilots().then(setList).catch(() => setList([])), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

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
    <div className="page ap">
      <header className="pub-head pop-in">
        <div>
          <span className="pub-kicker">
            <Bot size={14} /> Autopilot
          </span>
          <h1>Clips that post themselves</h1>
          <p className="muted">Pick channels or topics, choose how many posts a day and when. CrestClip finds new videos, clips the best moments and posts them on time.</p>
        </div>
        <Link to="/app/autopilot/new" className="btn btn-primary">
          <Plus size={18} /> New autopilot
        </Link>
      </header>

      <SchedulerBanner status={sched} />

      {list == null ? (
        <div className="pub-skel">
          {[0, 1].map((i) => (
            <span key={i} className="pub-skel-row" style={{ height: 150 }} />
          ))}
        </div>
      ) : list.length === 0 ? (
        <section className="clay ap-empty pop-in">
          <span className="empty-blob pub-empty-blob">
            <Bot size={30} />
          </span>
          <h2>No autopilots yet</h2>
          <p className="muted">Set one up in about two minutes. You stay in control — every clip waits for your OK unless you say otherwise.</p>
          <ol className="ap-how">
            <li>
              <span>1</span>
              <b>Pick sources</b>
              <small>YouTube channels or a topic like “podcast clips” in your country</small>
            </li>
            <li>
              <span>2</span>
              <b>Choose your times</b>
              <small>How many posts a day, and exactly when</small>
            </li>
            <li>
              <span>3</span>
              <b>Approve and relax</b>
              <small>See every upcoming post — cancel any of them anytime</small>
            </li>
          </ol>
          <Link to="/app/autopilot/new" className="btn btn-primary">
            <Sparkles size={17} /> Create your first autopilot
          </Link>
        </section>
      ) : (
        <div className="ap-grid">
          {list.map((a, i) => (
            <article key={a.id} className={`clay ap-card ${a.status} pop-in`} style={{ animationDelay: `${i * 60}ms` }}>
              <div className="ap-card-top">
                <Link to={`/app/autopilot/${a.id}`} className="ap-card-title">
                  <span className="ap-icon">
                    <Bot size={20} />
                  </span>
                  <span>
                    <b className="clamp1">{a.name}</b>
                    <small className="faint">
                      {a.config.times.length} post{a.config.times.length > 1 ? 's' : ''} a day · {a.config.times.map(prettyTime).join(' · ')}
                    </small>
                  </span>
                </Link>
                <StatusPill status={a.status} />
              </div>
              <div className="ap-sources">
                {a.config.sources.slice(0, 4).map((s, j) => (
                  <span key={j} className="ap-src">
                    {s.kind === 'youtube_channel' ? <Youtube size={13} /> : <Search size={13} />} {sourceText(s)}
                  </span>
                ))}
                {a.config.sources.length > 4 && <span className="ap-src">+{a.config.sources.length - 4}</span>}
              </div>
              <div className="ap-next">
                {a.status === 'paused' ? (
                  <span className="faint">Paused — nothing will post.</span>
                ) : a.nextPost ? (
                  <>
                    {a.nextPost.clip?.thumbUrl ? <img src={a.nextPost.clip.thumbUrl} alt="" /> : <span className="ap-thumb-ph" />}
                    <span>
                      <small className="faint">Next post · {new Date(a.nextPost.at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</small>
                      <b className="clamp1">{a.nextPost.clip?.title ?? 'Clip'}</b>
                    </span>
                  </>
                ) : (
                  <span className="faint">
                    <Clock size={13} /> {a.counts.clipping ? 'Making clips now…' : a.counts.review ? 'Waiting for your OK on new clips' : 'Looking for videos…'}
                  </span>
                )}
              </div>
              <div className="ap-counts">
                {a.counts.review > 0 && (
                  <Link to={`/app/autopilot/${a.id}?tab=review`} className="ap-count warn">
                    {a.counts.review} to review
                  </Link>
                )}
                <span className="ap-count">{a.counts.scheduled} booked</span>
                <span className="ap-count">{a.counts.ready} in line</span>
                <span className="ap-count">{a.counts.posted} posted</span>
                {a.counts.clipping > 0 && (
                  <span className="ap-count busy">
                    <Loader2 size={12} className="spin-icon" /> clipping
                  </span>
                )}
              </div>
              {a.lastError && (
                <p className="ap-err">
                  <AlertTriangle size={13} /> <span>{a.lastError}</span>
                </p>
              )}
              <div className="ap-card-actions">
                <Link to={`/app/autopilot/${a.id}`} className="btn btn-sm">
                  <CalendarClock size={15} /> Schedule
                </Link>
                <button className="btn btn-sm" onClick={() => toggle(a)}>
                  {a.status === 'active' ? <Pause size={15} /> : <Play size={15} />} {a.status === 'active' ? 'Pause' : 'Resume'}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

// =====================================================================
// EDITOR
// =====================================================================
const EMPTY: AutopilotInput = {
  name: '',
  sources: [],
  filters: { minViews: 10_000, minMinutes: 5, maxMinutes: 180, maxAgeDays: 14, waitHours: 24 },
  options: { platform: 'reels', captionStyle: 'pop', motion: 'subtle', music: 'auto', length: 'auto', layout: 'auto', showHook: true },
  clipsPerVideo: 2,
  times: defaultTimes(3),
  timezone: browserZone(),
  targets: [],
  mode: 'review',
  caption: DEFAULT_CAPTION,
  rightsConfirmed: false,
};

function Section({ n, title, hint, children }: { n: number; title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="clay ap-sec pop-in" style={{ animationDelay: `${n * 40}ms` }}>
      <header>
        <span className="ap-step">{n}</span>
        <div>
          <h2>{title}</h2>
          {hint && <p className="faint">{hint}</p>}
        </div>
      </header>
      {children}
    </section>
  );
}

export function AutopilotEditor() {
  const { id } = useParams();
  const nav = useNavigate();
  const [f, setF] = useState<AutopilotInput>(EMPTY);
  const [loaded, setLoaded] = useState(!id);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [srcKind, setSrcKind] = useState<'youtube_channel' | 'youtube_topic'>('youtube_channel');
  const [srcText, setSrcText] = useState('');
  const [srcRegion, setSrcRegion] = useState('');
  const [adding, setAdding] = useState(false);
  const zones = useMemo(allZones, []);
  const capRef = useRef<HTMLTextAreaElement>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const srcKey = (s: AutopilotSource) => `${s.kind}|${s.channelId ?? s.value}|${s.region ?? ''}`;
  useEffect(() => {
    for (const s of f.sources) {
      const k = srcKey(s);
      if (previews[k]) continue;
      setPreviews((p) => ({ ...p, [k]: 'checking' }));
      api
        .previewSource({ ...s, maxAgeDays: f.filters.maxAgeDays })
        .then((r) =>
          setPreviews((p) => ({
            ...p,
            [k]: r.count ? `${r.count} recent video${r.count > 1 ? 's' : ''}${r.newest ? ` · newest ${timeAgo(r.newest)}` : ''}` : 'No recent videos found',
          })),
        )
        .catch((e) => setPreviews((p) => ({ ...p, [k]: `Couldn’t check: ${(e as Error).message}` })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.sources]);

  useEffect(() => {
    api.connections().then((c) => setAccounts(c.accounts)).catch(() => setAccounts([]));
    if (id)
      api
        .autopilot(id)
        .then((a) => {
          setF({ ...a.config, name: a.name, rightsConfirmed: true });
          setLoaded(true);
        })
        .catch((e) => toast(e.message, 'error'));
  }, [id]);

  // new autopilot: pre-pick every connected account
  useEffect(() => {
    if (!id && accounts && f.targets.length === 0 && accounts.length) setF((x) => ({ ...x, targets: accounts.map((a) => ({ connectionId: a.id })) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts]);

  const set = <K extends keyof AutopilotInput>(k: K, v: AutopilotInput[K]) => setF((x) => ({ ...x, [k]: v }));
  const setFilter = (k: keyof AutopilotConfig['filters'], v: number) => setF((x) => ({ ...x, filters: { ...x.filters, [k]: v } }));
  const setOpt = (k: string, v: unknown) => setF((x) => ({ ...x, options: { ...x.options, [k]: v } }));

  const setCount = (n: number) => {
    const count = Math.max(1, Math.min(12, n));
    setF((x) => {
      if (count === x.times.length) return x;
      const next = count < x.times.length ? x.times.slice(0, count) : [...x.times, ...defaultTimes(count).filter((t) => !x.times.includes(t))].slice(0, count);
      while (next.length < count) next.push('20:00');
      return { ...x, times: next };
    });
  };
  const setTime = (i: number, t: string) => setF((x) => ({ ...x, times: x.times.map((v, j) => (j === i ? t : v)) }));

  const addSource = async () => {
    const value = srcText.trim();
    if (!value) return;
    if (srcKind === 'youtube_topic') {
      set('sources', [...f.sources, { kind: 'youtube_topic', value, region: srcRegion || null, label: value }]);
      setSrcText('');
      return;
    }
    setAdding(true);
    try {
      const r = await api.resolveChannel(value);
      if (f.sources.some((s) => s.channelId === r.channelId)) toast('That channel is already added');
      else set('sources', [...f.sources, { kind: 'youtube_channel', value, channelId: r.channelId, label: r.label }]);
      setSrcText('');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setAdding(false);
    }
  };

  const insertVar = (v: string) => {
    const el = capRef.current;
    const at = el?.selectionStart ?? f.caption.length;
    const next = f.caption.slice(0, at) + `{${v}}` + f.caption.slice(el?.selectionEnd ?? at);
    set('caption', next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + v.length + 2, at + v.length + 2);
    });
  };

  const dupTimes = new Set(f.times.filter((t, i) => f.times.indexOf(t) !== i));
  const problems = [
    !f.name.trim() && 'Give it a name',
    !f.sources.length && 'Add at least one source',
    !f.targets.length && 'Pick an account to post to',
    dupTimes.size > 0 && 'Two posts have the same time',
    !f.rightsConfirmed && 'Confirm you have the rights',
  ].filter(Boolean) as string[];

  const save = async () => {
    if (problems.length) return toast(problems[0], 'error');
    setSaving(true);
    try {
      const body = { ...f, times: [...f.times].sort() };
      const a = id ? await api.updateAutopilot(id, body) : await api.createAutopilot(body);
      toast(id ? 'Saved — schedule updated' : 'Autopilot is running');
      nav(`/app/autopilot/${a.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!loaded)
    return (
      <div className="page">
        <span className="pub-skel-row" style={{ height: 300 }} />
      </div>
    );

  const sortedPreview = [...f.times].sort();
  return (
    <div className="page ap ap-editor">
      <Link to={id ? `/app/autopilot/${id}` : '/app/autopilot'} className="linkish" style={{ marginBottom: 12 }}>
        <ArrowLeft size={16} /> Back
      </Link>
      <header className="pub-head" style={{ marginBottom: 18 }}>
        <div>
          <span className="pub-kicker">
            <Bot size={14} /> {id ? 'Edit autopilot' : 'New autopilot'}
          </span>
          <h1>{id ? f.name || 'Edit autopilot' : 'Set up an autopilot'}</h1>
        </div>
      </header>

      <div className="ap-form">
        <Section n={1} title="Name it">
          <input className="field" value={f.name} maxLength={80} placeholder="e.g. Podcast clips · India" onChange={(e) => set('name', e.target.value)} />
        </Section>

        <Section n={2} title="Where should videos come from?" hint="New uploads from these channels, or popular videos for a topic.">
          <div className="seg" role="group" aria-label="Source type" style={{ marginBottom: 12 }}>
            <button type="button" aria-pressed={srcKind === 'youtube_channel'} onClick={() => setSrcKind('youtube_channel')}>
              <Youtube size={15} /> YouTube channel
            </button>
            <button type="button" aria-pressed={srcKind === 'youtube_topic'} onClick={() => setSrcKind('youtube_topic')}>
              <Hash size={15} /> Topic
            </button>
            <button type="button" disabled title="Coming soon">
              Twitch · soon
            </button>
          </div>
          <div className="ap-add-src">
            <input
              className="field"
              value={srcText}
              placeholder={srcKind === 'youtube_channel' ? 'Channel link or @handle, e.g. @lexfridman' : 'Topic, e.g. podcast funny moments'}
              onChange={(e) => setSrcText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addSource())}
            />
            {srcKind === 'youtube_topic' && (
              <select className="field ap-region" value={srcRegion} onChange={(e) => setSrcRegion(e.target.value)} aria-label="Country">
                {REGIONS.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.label}
                  </option>
                ))}
              </select>
            )}
            <button type="button" className="btn" onClick={addSource} disabled={adding || !srcText.trim()}>
              {adding ? <Loader2 size={16} className="spin-icon" /> : <Plus size={16} />} Add
            </button>
          </div>
          {f.sources.length > 0 ? (
            <div className="ap-src-list">
              {f.sources.map((s, i) => (
                <span key={i} className="ap-src big">
                  {s.kind === 'youtube_channel' ? <Youtube size={15} /> : s.region ? <Globe size={15} /> : <Search size={15} />}
                  <span className="ap-src-text">
                    {sourceText(s)}
                    {previews[srcKey(s)] && <small>{previews[srcKey(s)] === 'checking' ? 'Checking…' : previews[srcKey(s)]}</small>}
                  </span>
                  <button type="button" aria-label="Remove" onClick={() => set('sources', f.sources.filter((_, j) => j !== i))}>
                    <X size={13} />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="faint" style={{ fontSize: 13, marginTop: 10 }}>
              Nothing added yet.
            </p>
          )}
        </Section>

        <Section n={3} title="Which videos are worth clipping?" hint="Skips weak videos before any AI credits are spent.">
          <div className="ap-filters">
            <label>
              <span>At least</span>
              <select className="field" value={f.filters.minViews} onChange={(e) => setFilter('minViews', Number(e.target.value))}>
                {[0, 1000, 10_000, 50_000, 100_000, 500_000, 1_000_000].map((v) => (
                  <option key={v} value={v}>
                    {v ? `${compact(v)} views` : 'Any views'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Length</span>
              <span className="ap-range">
                <input className="field" type="number" min={1} max={600} value={f.filters.minMinutes} onChange={(e) => setFilter('minMinutes', Number(e.target.value) || 1)} />
                <i>to</i>
                <input className="field" type="number" min={2} max={900} value={f.filters.maxMinutes} onChange={(e) => setFilter('maxMinutes', Number(e.target.value) || 2)} />
                <i>min</i>
              </span>
            </label>
            <label>
              <span>Uploaded in the last</span>
              <Seg
                label="Max age"
                value={String(f.filters.maxAgeDays)}
                onChange={(v) => setFilter('maxAgeDays', Number(v))}
                options={['3', '7', '14', '30'].map((d) => ({ value: d, label: `${d} days` }))}
              />
            </label>
            <label>
              <span>Wait after upload</span>
              <Seg
                label="Wait"
                value={String(f.filters.waitHours)}
                onChange={(v) => setFilter('waitHours', Number(v))}
                options={[
                  { value: '0', label: 'No wait' },
                  { value: '12', label: '12 h' },
                  { value: '24', label: '24 h' },
                  { value: '48', label: '48 h' },
                ]}
              />
            </label>
          </div>
          <p className="ap-tip">
            <Sparkles size={14} /> Waiting 24 h lets YouTube build its “most rewatched” graph, so CrestClip can pick the moments people actually replay.
          </p>
        </Section>

        <Section n={4} title="Clip style">
          <div className="ap-style">
            <div>
              <span className="label">Made for</span>
              <Seg label="Platform" value={(f.options.platform ?? 'reels') as Platform} onChange={(v) => setOpt('platform', v)} options={PLATFORM_OPTIONS} />
            </div>
            <div>
              <span className="label">Clips per video</span>
              <Seg label="Clips per video" value={String(f.clipsPerVideo)} onChange={(v) => set('clipsPerVideo', Number(v))} options={['1', '2', '3'].map((n) => ({ value: n, label: n }))} />
            </div>
            <div>
              <span className="label">Background music</span>
              <Seg
                label="Music"
                value={f.options.music === 'none' ? 'none' : 'auto'}
                onChange={(v) => setOpt('music', v)}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'none', label: 'Off' },
                ]}
              />
            </div>
          </div>
          <span className="label" style={{ marginTop: 18 }}>
            Captions
          </span>
          <CaptionPicker value={(f.options.captionStyle ?? 'pop') as CaptionStyle} onChange={(v) => setOpt('captionStyle', v)} />
          <span className="label" style={{ marginTop: 18 }}>
            Edit motion
          </span>
          <MotionPicker value={(f.options.motion ?? 'subtle') as Motion} onChange={(v) => setOpt('motion', v)} />
        </Section>

        <Section n={5} title="When should it post?" hint="Pick how many posts a day and the exact times. You can cancel any single post later.">
          <div className="ap-when">
            <div className="ap-count-pick">
              <span className="label">Posts per day</span>
              <div className="ap-stepper">
                <button type="button" className="btn btn-icon" onClick={() => setCount(f.times.length - 1)} disabled={f.times.length <= 1} aria-label="Fewer">
                  <Minus size={16} />
                </button>
                <b>{f.times.length}</b>
                <button type="button" className="btn btn-icon" onClick={() => setCount(f.times.length + 1)} disabled={f.times.length >= 12} aria-label="More">
                  <Plus size={16} />
                </button>
              </div>
              {f.times.length > 6 && <small className="ap-warn">More than 6 a day can look spammy to Instagram.</small>}
            </div>
            <div className="ap-times">
              {f.times.map((t, i) => (
                <label key={i} className={`ap-time ${dupTimes.has(t) ? 'dup' : ''}`}>
                  <input type="time" value={t} step={300} onChange={(e) => setTime(i, e.target.value || t)} aria-label={`Post ${i + 1} time`} />
                  {f.times.length > 1 && (
                    <button type="button" aria-label="Remove this time" onClick={() => setF((x) => ({ ...x, times: x.times.filter((_, j) => j !== i) }))}>
                      <X size={13} />
                    </button>
                  )}
                </label>
              ))}
            </div>
            <label className="ap-zone">
              <span className="label">Time zone</span>
              <select className="field" value={f.timezone} onChange={(e) => set('timezone', e.target.value)}>
                {!zones.includes(f.timezone) && <option value={f.timezone}>{f.timezone}</option>}
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="ap-day-preview" aria-label="Your day">
            <div className="ap-day-bar">
              {sortedPreview.map((t, i) => {
                const [h, m] = t.split(':').map(Number);
                return (
                  <span key={i} className="ap-day-dot" style={{ left: `${((h * 60 + m) / 1440) * 100}%` }} title={prettyTime(t)}>
                    <i />
                    <small>{prettyTime(t)}</small>
                  </span>
                );
              })}
            </div>
            <div className="ap-day-scale">
              <span>12 AM</span>
              <span>6 AM</span>
              <span>12 PM</span>
              <span>6 PM</span>
              <span>12 AM</span>
            </div>
          </div>

          <span className="label" style={{ marginTop: 18 }}>
            Post to
          </span>
          {accounts == null ? (
            <span className="pub-skel-row" style={{ height: 52 }} />
          ) : accounts.length === 0 ? (
            <div className="ap-noacct">
              <AlertTriangle size={16} />
              <span>No accounts connected yet.</span>
              <Link to="/app/accounts" className="btn btn-sm">
                Connect YouTube or Instagram
              </Link>
            </div>
          ) : (
            <div className="ap-accts">
              {accounts.map((a) => {
                const on = f.targets.some((t) => t.connectionId === a.id);
                const Icon = a.platform === 'youtube' ? Youtube : Instagram;
                return (
                  <button
                    key={a.id}
                    type="button"
                    className={`ap-acct ${on ? 'on' : ''}`}
                    aria-pressed={on}
                    onClick={() => set('targets', on ? f.targets.filter((t) => t.connectionId !== a.id) : [...f.targets, { connectionId: a.id }])}
                  >
                    <span className={`pub-avatar-badge ${a.platform === 'youtube' ? 'yt' : 'ig'}`} style={{ position: 'static' }}>
                      <Icon size={11} />
                    </span>
                    <b className="clamp1">{a.handle ?? a.name}</b>
                    {on && <Check size={15} />}
                  </button>
                );
              })}
            </div>
          )}
        </Section>

        <Section n={6} title="Before anything posts…">
          <div className="ap-modes">
            <button type="button" className={`ap-mode ${f.mode === 'review' ? 'on' : ''}`} onClick={() => set('mode', 'review')} aria-pressed={f.mode === 'review'}>
              <Eye size={20} />
              <b>I review each clip</b>
              <small>New clips wait for your OK. Recommended to start.</small>
            </button>
            <button type="button" className={`ap-mode ${f.mode === 'auto' ? 'on' : ''}`} onClick={() => set('mode', 'auto')} aria-pressed={f.mode === 'auto'}>
              <Bot size={20} />
              <b>Post automatically</b>
              <small>The best clips go straight into your schedule.</small>
            </button>
          </div>
        </Section>

        <Section n={7} title="Caption" hint="Filled in for every post. Tap a tag to insert it.">
          <div className="ap-vars">
            {['title', 'hook', 'hashtags', 'channel', 'link'].map((v) => (
              <button key={v} type="button" className="chip" onClick={() => insertVar(v)}>
                {`{${v}}`}
              </button>
            ))}
          </div>
          <textarea ref={capRef} className="field" rows={5} value={f.caption} maxLength={2200} onChange={(e) => set('caption', e.target.value)} />
          <p className="faint" style={{ fontSize: 12, marginTop: 6 }}>
            Keep <b>{'{channel}'}</b> in — crediting the creator is good practice and helps avoid takedowns.
          </p>
        </Section>

        <section className="clay ap-rights pop-in">
          <Toggle checked={f.rightsConfirmed} onChange={(v) => set('rightsConfirmed', v)}>
            <span>
              <ShieldCheck size={15} /> I have the rights to clip and repost videos from these sources (my own channels, channels that gave permission, or clipping campaigns).
            </span>
          </Toggle>
          <p className="faint">Reposting other people’s videos without permission can get your account flagged or removed.</p>
        </section>
      </div>

      <div className="ap-savebar">
        <span className="faint">{problems[0] ?? `${f.times.length} post${f.times.length > 1 ? 's' : ''} a day · ${sortedPreview.map(prettyTime).join(', ')} · ${f.mode === 'review' ? 'you approve each clip' : 'fully automatic'}`}</span>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? <Loader2 size={17} className="spin-icon" /> : <Check size={17} />} {id ? 'Save changes' : 'Start autopilot'}
        </button>
      </div>
    </div>
  );
}

// =====================================================================
// DETAIL
// =====================================================================
type Tab = 'schedule' | 'review' | 'videos' | 'history';

export function AutopilotDetailPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [a, setA] = useState<AutopilotDetail | null>(null);
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(window.location.search).get('tab') as Tab) || 'schedule');
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const sched = useScheduler();

  const load = useCallback(() => api.autopilot(id).then(setA).catch((e) => toast(e.message, 'error')), [id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [load]);

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

  if (!a)
    return (
      <div className="page">
        <span className="pub-skel-row" style={{ height: 320 }} />
      </div>
    );

  const tz = a.config.timezone;
  const days = a.schedule.reduce<Record<string, ApSlot[]>>((m, s) => ((m[s.date] ||= []).push(s), m), {});

  return (
    <div className="page ap">
      <Link to="/app/autopilot" className="linkish" style={{ marginBottom: 12 }}>
        <ArrowLeft size={16} /> All autopilots
      </Link>
      <header className="ap-detail-head pop-in">
        <span className="ap-icon big">
          <Bot size={26} />
        </span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <h1 className="clamp1">{a.name}</h1>
            <StatusPill status={a.status} />
          </div>
          <p className="muted">
            {a.config.times.length} post{a.config.times.length > 1 ? 's' : ''} a day at {a.config.times.map(prettyTime).join(', ')} ({tz.replace(/_/g, ' ')}) ·{' '}
            {a.config.mode === 'review' ? 'you approve each clip' : 'fully automatic'}
          </p>
          <div className="ap-sources" style={{ marginTop: 8 }}>
            {a.config.sources.map((s, j) => (
              <span key={j} className="ap-src">
                {s.kind === 'youtube_channel' ? <Youtube size={13} /> : <Search size={13} />} {sourceText(s)}
              </span>
            ))}
          </div>
        </div>
        <div className="ap-head-actions">
          <button className="btn btn-sm" disabled={busy === 'scan'} onClick={() => act('scan', () => api.scanAutopilot(id), 'Looking for new videos…')}>
            {busy === 'scan' ? <Loader2 size={15} className="spin-icon" /> : <RefreshCw size={15} />} Find videos now
          </button>
          <Link to={`/app/autopilot/${id}/edit`} className="btn btn-sm">
            <Pencil size={15} /> Edit
          </Link>
          <button
            className={`btn btn-sm ${a.status === 'active' ? '' : 'btn-primary'}`}
            disabled={busy === 'toggle'}
            onClick={() =>
              act('toggle', () => (a.status === 'active' ? api.pauseAutopilot(id) : api.resumeAutopilot(id)), a.status === 'active' ? 'Paused — upcoming posts cancelled' : 'Running again')
            }
          >
            {a.status === 'active' ? <Pause size={15} /> : <Play size={15} />} {a.status === 'active' ? 'Pause' : 'Resume'}
          </button>
          <button className="btn btn-icon btn-sm" title="Delete autopilot" onClick={() => setDeleting(true)}>
            <Trash2 size={15} />
          </button>
        </div>
      </header>

      <SchedulerBanner status={sched} />
      {a.lastError && (
        <p className="ap-err big">
          <AlertTriangle size={15} /> <span>{a.lastError}</span>
        </p>
      )}

      <div className="pub-stats ap-stats">
        <Stat tone="tangerine" icon={<Eye size={16} />} value={a.counts.review} label="To review" />
        <Stat tone="sky" icon={<CalendarClock size={16} />} value={a.counts.scheduled} label="Booked" />
        <Stat tone="muted" icon={<Clapperboard size={16} />} value={a.counts.ready} label="In line" />
        <Stat tone="mint" icon={<CheckCircle2 size={16} />} value={a.counts.posted} label="Posted" />
      </div>

      <div className="seg ap-tabs" role="tablist">
        {(
          [
            ['schedule', 'Schedule', null],
            ['review', a.config.mode === 'review' ? 'To review' : 'In line', a.config.mode === 'review' ? a.review.length : a.ready.length],
            ['videos', 'Videos found', a.videos.length],
            ['history', 'History', a.history.length],
          ] as [Tab, string, number | null][]
        ).map(([k, label, n]) => (
          <button key={k} role="tab" aria-pressed={tab === k} aria-selected={tab === k} onClick={() => setTab(k)}>
            {label}
            {n != null && <span className="pub-count">{n}</span>}
          </button>
        ))}
      </div>

      <section className="clay ap-panel">
        {tab === 'schedule' && (
          <div className="pub-timeline">
            {a.status === 'paused' && (
              <div className="ap-note">
                <Pause size={16} /> Paused — nothing below will post until you resume.
              </div>
            )}
            {Object.entries(days).map(([date, slots]) => (
              <div key={date} className="pub-day">
                <div className="pub-day-label">
                  <i aria-hidden /> {dayName(date, tz)}
                </div>
                <div className="post-list">
                  {slots.map((s) => (
                    <SlotRow
                      key={s.key}
                      s={s}
                      busy={busy === s.key}
                      paused={a.status === 'paused'}
                      counts={a.counts}
                      onSkip={() => act(s.key, () => api.skipSlot(id, s.key), 'Cancelled — the clip moves to the next free time')}
                      onRestore={() => act(s.key, () => api.restoreSlot(id, s.key), 'Time restored')}
                      onReject={() => s.apClipId && act(s.key, () => api.apClip(id, s.apClipId!, 'reject'), 'Clip removed from the schedule')}
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
            onApprove={(it) => act(it.id, () => api.apClip(id, it.id, 'approve'), 'Approved — added to the schedule')}
            onReject={(it) => act(it.id, () => api.apClip(id, it.id, 'reject'), 'Removed')}
            counts={a.counts}
          />
        )}

        {tab === 'videos' && <VideoList videos={a.videos} lastScanAt={a.lastScanAt} />}

        {tab === 'history' &&
          (a.history.length ? (
            <PostList items={a.history} onChange={load} />
          ) : (
            <div className="pub-empty">
              <span className="empty-blob pub-empty-blob">
                <Film size={26} />
              </span>
              <div>
                <b>Nothing posted yet</b>
                <p className="muted">Posts show up here with a link once they go live.</p>
              </div>
            </div>
          ))}
      </section>

      <ConfirmModal
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
            .catch((e) => toast(e.message, 'error'))
        }
      >
        <p>
          Every upcoming post from <b>{a.name}</b> is cancelled. Clips already made stay in your Projects, and anything already posted stays online.
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
  counts: AutopilotDetail['counts'];
  onSkip: () => void;
  onRestore: () => void;
  onReject: () => void;
}) {
  const past = s.at < Date.now();
  const anyPosted = s.posts.some((p) => p.status === 'published');
  const anyFailed = s.posts.some((p) => p.status === 'failed');
  const uploading = s.posts.some((p) => p.status === 'uploading' || p.status === 'processing');
  return (
    <div className={`post-row ap-slot ${s.skipped ? 'skipped' : ''} ${past ? 'past' : ''}`}>
      <span className="post-time">{prettyTime(s.time)}</span>
      {s.skipped ? (
        <div className="grow ap-slot-empty">
          <b>Cancelled</b>
          <span className="faint">Nothing will post at this time.</span>
        </div>
      ) : s.clip ? (
        <>
          <span className="post-thumb-wrap">
            {s.clip.thumbUrl ? <img className="post-thumb" src={s.clip.thumbUrl} alt="" /> : <span className="post-thumb" />}
          </span>
          <div className="grow" style={{ minWidth: 0 }}>
            <b className="clamp1">{s.clip.title}</b>
            <span className="faint post-meta">
              {s.clip.source?.channel ? `from ${s.clip.source.channel} · ` : ''}
              {s.clip.duration}s · score {s.clip.score}
            </span>
            <span className="ap-targets">
              {s.posts.map((p) => {
                const Icon = p.platform === 'youtube' ? Youtube : Instagram;
                return (
                  <span key={p.id} className={`ap-target ${p.status}`} title={p.error ?? p.status}>
                    <Icon size={12} /> {p.account ?? p.platform}
                    {p.status === 'published' && p.remoteUrl && (
                      <a href={p.remoteUrl} target="_blank" rel="noreferrer" aria-label="Open post">
                        <ExternalLink size={11} />
                      </a>
                    )}
                    {p.status === 'failed' && <XCircle size={11} />}
                  </span>
                );
              })}
            </span>
          </div>
        </>
      ) : (
        <div className="grow ap-slot-empty">
          <b>{paused ? 'Paused' : past ? 'Nothing was ready' : 'Waiting for a clip'}</b>
          <span className="faint">
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
      <div className="post-actions">
        {uploading ? (
          <span className="post-status busy">
            <Loader2 size={13} className="spin-icon" /> Posting…
          </span>
        ) : anyPosted ? (
          <span className="post-status ok">
            <Check size={13} /> Posted
          </span>
        ) : anyFailed ? (
          <span className="post-status bad">
            <XCircle size={13} /> Failed
          </span>
        ) : s.skipped ? (
          !past && (
            <button className="btn btn-sm" onClick={onRestore} disabled={busy}>
              <Undo2 size={14} /> Undo
            </button>
          )
        ) : (
          !past && (
            <>
              {s.clip && s.apClipId && (
                <button className="btn btn-icon btn-sm" title="Don’t post this clip at all" onClick={onReject} disabled={busy}>
                  <Trash2 size={14} />
                </button>
              )}
              <button className="btn btn-sm" onClick={onSkip} disabled={busy} title="Cancel this time — the clip moves to the next free time">
                {busy ? <Loader2 size={14} className="spin-icon" /> : <X size={14} />} Cancel
              </button>
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
  counts: AutopilotDetail['counts'];
  onApprove: (it: ApItem) => void;
  onReject: (it: ApItem) => void;
}) {
  if (!items.length)
    return (
      <div className="pub-empty">
        <span className="empty-blob pub-empty-blob">
          <Clapperboard size={26} />
        </span>
        <div>
          <b>{mode === 'review' ? 'Nothing to review' : 'No clips in line'}</b>
          <p className="muted">
            {counts.clipping ? 'Clips are being made right now — they’ll appear here.' : counts.waiting ? `${counts.waiting} video${counts.waiting > 1 ? 's' : ''} waiting to be clipped.` : 'New clips appear here as videos are found.'}
          </p>
        </div>
      </div>
    );
  return (
    <div className="ap-review">
      {items.map((it) => (
        <article key={it.id} className="ap-rv">
          <div className="ap-rv-video">
            {it.clip.videoUrl ? <video src={it.clip.videoUrl} poster={it.clip.thumbUrl ?? undefined} controls playsInline preload="none" /> : <span className="post-thumb" />}
          </div>
          <div className="ap-rv-body">
            <b className="clamp1" title={it.clip.title}>
              {it.clip.title}
            </b>
            <span className="faint">
              {it.clip.duration}s · score {it.clip.score}
              {it.clip.source?.channel ? ` · ${it.clip.source.channel}` : ''}
            </span>
            <div className="ap-rv-actions">
              <button className="btn btn-sm" onClick={() => onReject(it)} disabled={busy === it.id} title="Don’t post">
                <X size={14} /> {mode === 'review' ? 'Skip' : 'Remove'}
              </button>
              {mode === 'review' && (
                <button className="btn btn-sm btn-primary" onClick={() => onApprove(it)} disabled={busy === it.id}>
                  {busy === it.id ? <Loader2 size={14} className="spin-icon" /> : <Check size={14} />} Approve
                </button>
              )}
              <Link to={`/app/p/${it.clip.projectId}`} className="btn btn-icon btn-sm" title="Open the project (edit this clip)">
                <Pencil size={14} />
              </Link>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

const VIDEO_STATUS: Record<ApVideo['status'], { label: string; tone: string }> = {
  waiting: { label: 'Waiting', tone: 'sched' },
  queued: { label: 'Queued', tone: 'sched' },
  clipping: { label: 'Clipping', tone: 'busy' },
  done: { label: 'Clipped', tone: 'ok' },
  skipped: { label: 'Skipped', tone: 'muted' },
  failed: { label: 'Failed', tone: 'bad' },
};

function VideoList({ videos, lastScanAt }: { videos: ApVideo[]; lastScanAt: number | null }) {
  return (
    <>
      <p className="faint" style={{ fontSize: 13, marginBottom: 12 }}>
        {lastScanAt ? `Last checked ${timeAgo(lastScanAt)} · checks every hour` : 'Checking for the first time…'}
      </p>
      {videos.length === 0 ? (
        <div className="pub-empty">
          <span className="empty-blob pub-empty-blob">
            <Search size={26} />
          </span>
          <div>
            <b>No videos found yet</b>
            <p className="muted">New uploads from your sources show up here.</p>
          </div>
        </div>
      ) : (
        <div className="post-list">
          {videos.map((v) => {
            const st = VIDEO_STATUS[v.status];
            return (
              <div key={v.id} className="post-row ap-video">
                {v.thumbnail ? <img className="ap-video-thumb" src={v.thumbnail} alt="" referrerPolicy="no-referrer" /> : <span className="ap-video-thumb" />}
                <div className="grow" style={{ minWidth: 0 }}>
                  <a className="clamp1 ap-video-title" href={v.url} target="_blank" rel="noreferrer">
                    {v.title || v.url}
                  </a>
                  <span className="faint post-meta">
                    {[v.channel, v.views != null ? `${compact(v.views)} views` : null, mins(v.duration), v.publishedAt ? timeAgo(v.publishedAt) : null].filter(Boolean).join(' · ')}
                  </span>
                  {v.reason && <span className="post-meta faint">{v.reason}</span>}
                </div>
                <div className="post-actions">
                  <span className={`post-status ${st.tone}`}>
                    {st.tone === 'busy' ? <Loader2 size={13} className="spin-icon" /> : st.tone === 'ok' ? <Check size={13} /> : st.tone === 'bad' ? <XCircle size={13} /> : st.tone === 'muted' ? <RotateCcw size={13} /> : <Clock size={13} />}
                    {st.label}
                  </span>
                  {v.projectId && (
                    <Link to={`/app/p/${v.projectId}`} className="btn btn-icon btn-sm" title="Open project">
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

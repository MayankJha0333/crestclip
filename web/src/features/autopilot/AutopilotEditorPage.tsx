import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Bot, Check, Eye, Globe, Hash, Minus, Plus, Search, ShieldCheck, Sparkles, X, Youtube } from 'lucide-react';
import { useAccount } from '../auth/auth';
import { UpgradeCallout } from '../billing/UpgradeCallout';
import { api, type Account, type AutopilotConfig, type AutopilotInput, type AutopilotSource, type CaptionStyle, type Motion } from '../../lib/api';
import { cn } from '../../lib/cn';
import { timeAgo } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Button, buttonClass, Card, Chip, Field, FieldLabel, Input, PageHeader, Segmented, Select, Skeleton, Textarea, Toggle } from '../../components/ui';
import { CaptionPicker } from '../clip-settings/CaptionPicker';
import { MotionPicker } from '../clip-settings/MotionPicker';
import { SOCIAL } from '../schedule/postStatus';
import { allZones, compact, defaultTimes, EMPTY_AUTOPILOT, prettyTime, REGIONS, sourceText } from './helpers';

function Step({ n, title, hint, children }: { n: number; title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <Card className="animate-pop-in p-5 sm:p-6" style={{ animationDelay: `${n * 40}ms` }}>
      <header className="mb-4 flex items-start gap-3.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-[11px] bg-ink text-sm font-black text-on-ink">{n}</span>
        <div>
          <h2 className="text-xl leading-tight">{title}</h2>
          {hint && <p className="mt-1 text-[13.5px] text-ink-3">{hint}</p>}
        </div>
      </header>
      {children}
    </Card>
  );
}

/** Create or edit an autopilot — one form, numbered steps, a sticky save bar that says what's missing. */
export function AutopilotEditorPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [f, setF] = useState<AutopilotInput>(EMPTY_AUTOPILOT);
  const [loaded, setLoaded] = useState(!id);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [srcKind, setSrcKind] = useState<'youtube_channel' | 'youtube_topic'>('youtube_channel');
  const [srcText, setSrcText] = useState('');
  const [srcRegion, setSrcRegion] = useState('');
  const [adding, setAdding] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const zones = useMemo(allZones, []);
  const allowed = useAccount().plan.autopilot;
  const capRef = useRef<HTMLTextAreaElement>(null);
  const srcKey = (s: AutopilotSource) => `${s.kind}|${s.channelId ?? s.value}|${s.region ?? ''}`;

  // check each source once: how many recent videos does it have?
  useEffect(() => {
    for (const s of f.sources) {
      const k = srcKey(s);
      if (previews[k]) continue;
      setPreviews((p) => ({ ...p, [k]: 'checking' }));
      api
        .previewSource({ ...s, maxAgeDays: f.filters.maxAgeDays })
        .then((r) => setPreviews((p) => ({ ...p, [k]: r.count ? `${r.count} recent video${r.count > 1 ? 's' : ''}${r.newest ? ` · newest ${timeAgo(r.newest)}` : ''}` : 'No recent videos found' })))
        .catch((e: Error) => setPreviews((p) => ({ ...p, [k]: `Couldn’t check: ${e.message}` })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.sources]);

  useEffect(() => {
    api
      .connections()
      .then((c) => setAccounts(c.accounts))
      .catch(() => setAccounts([]));
    if (id)
      api
        .autopilot(id)
        .then((a) => {
          setF({ ...a.config, name: a.name, rightsConfirmed: true });
          setLoaded(true);
        })
        .catch((e: Error) => toast(e.message, 'error'));
  }, [id]);

  // new autopilot: pre-pick every connected account
  useEffect(() => {
    if (!id && accounts?.length && f.targets.length === 0) setF((x) => ({ ...x, targets: accounts.map((a) => ({ connectionId: a.id })) }));
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

  const addSource = async () => {
    const value = srcText.trim();
    if (!value) return;
    if (srcKind === 'youtube_topic') {
      set('sources', [...f.sources, { kind: 'youtube_topic', value, region: srcRegion || null, label: value }]);
      return setSrcText('');
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
    set('caption', f.caption.slice(0, at) + `{${v}}` + f.caption.slice(el?.selectionEnd ?? at));
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

  if (!allowed && !id)
    return (
      <>
        <PageHeader back={{ to: '/app/autopilot', label: 'Back' }} title="New autopilot" />
        <UpgradeCallout title="Autopilot is on the Pro plan" cta="See Pro">
          Upgrade to Pro to set up an autopilot.
        </UpgradeCallout>
      </>
    );
  if (!loaded) return <Skeleton className="h-96 rounded-[28px]" />;
  const sorted = [...f.times].sort();

  return (
    <div className="pb-28">
      <PageHeader
        back={{ to: id ? `/app/autopilot/${id}` : '/app/autopilot', label: 'Back' }}
        title={id ? f.name || 'Edit autopilot' : 'New autopilot'}
        description={id ? undefined : 'Seven quick steps. You can change any of it later.'}
      />

      <div className="flex max-w-4xl flex-col gap-5">
        <Step n={1} title="Name it">
          <Input value={f.name} maxLength={80} placeholder="e.g. Podcast clips · India" onChange={(e) => set('name', e.target.value)} />
        </Step>

        <Step n={2} title="Where should videos come from?" hint="New uploads from these channels, or popular videos for a topic.">
          <Segmented
            className="mb-3"
            label="Source type"
            size="sm"
            value={srcKind}
            onChange={setSrcKind}
            options={[
              {
                value: 'youtube_channel',
                label: (
                  <>
                    <Youtube size={15} /> YouTube channel
                  </>
                ),
              },
              {
                value: 'youtube_topic',
                label: (
                  <>
                    <Hash size={15} /> Topic
                  </>
                ),
              },
            ]}
          />
          <div className="flex flex-wrap gap-2.5">
            <Input
              className="min-w-56 flex-1"
              value={srcText}
              placeholder={srcKind === 'youtube_channel' ? 'Channel link or @handle, e.g. @lexfridman' : 'Topic, e.g. podcast funny moments'}
              onChange={(e) => setSrcText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addSource())}
            />
            {srcKind === 'youtube_topic' && (
              <Select className="w-44" value={srcRegion} onChange={(e) => setSrcRegion(e.target.value)} aria-label="Country">
                {REGIONS.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.label}
                  </option>
                ))}
              </Select>
            )}
            <Button onClick={addSource} loading={adding} disabled={!srcText.trim()}>
              {!adding && <Plus size={16} />} Add
            </Button>
          </div>
          {f.sources.length > 0 ? (
            <div className="mt-3.5 flex flex-wrap gap-2">
              {f.sources.map((s, i) => {
                const p = previews[srcKey(s)];
                return (
                  <span key={i} className="inline-flex max-w-full items-center gap-2 rounded-2xl bg-row py-2 pr-2 pl-3 text-[13.5px] font-bold shadow-flat">
                    {s.kind === 'youtube_channel' ? <Youtube size={15} /> : s.region ? <Globe size={15} /> : <Search size={15} />}
                    <span className="flex min-w-0 flex-col leading-tight">
                      <span className="truncate">{sourceText(s)}</span>
                      {p && <small className="text-[11px] text-ink-3">{p === 'checking' ? 'Checking…' : p}</small>}
                    </span>
                    <button
                      type="button"
                      aria-label="Remove"
                      className="grid size-5.5 shrink-0 place-items-center rounded-full bg-muted-bg hover:bg-bad-bg hover:text-bad"
                      onClick={() =>
                        set(
                          'sources',
                          f.sources.filter((_, j) => j !== i),
                        )
                      }
                    >
                      <X size={13} />
                    </button>
                  </span>
                );
              })}
            </div>
          ) : (
            <p className="mt-2.5 text-[13px] text-ink-3">Nothing added yet.</p>
          )}
        </Step>

        <Step n={3} title="Which videos are worth clipping?" hint="Skips weak videos before any AI credits are spent.">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="At least">
              <Select value={f.filters.minViews} onChange={(e) => setFilter('minViews', Number(e.target.value))}>
                {[0, 1000, 10_000, 50_000, 100_000, 500_000, 1_000_000].map((v) => (
                  <option key={v} value={v}>
                    {v ? `${compact(v)} views` : 'Any views'}
                  </option>
                ))}
              </Select>
            </Field>
            <div>
              <FieldLabel>Length</FieldLabel>
              <span className="flex items-center gap-2">
                <Input
                  className="w-24"
                  type="number"
                  min={1}
                  max={600}
                  value={f.filters.minMinutes}
                  onChange={(e) => setFilter('minMinutes', Number(e.target.value) || 1)}
                  aria-label="Minimum minutes"
                />
                <i className="font-bold text-ink-3 not-italic">to</i>
                <Input
                  className="w-24"
                  type="number"
                  min={2}
                  max={900}
                  value={f.filters.maxMinutes}
                  onChange={(e) => setFilter('maxMinutes', Number(e.target.value) || 2)}
                  aria-label="Maximum minutes"
                />
                <i className="font-bold text-ink-3 not-italic">min</i>
              </span>
            </div>
            <div>
              <FieldLabel>Uploaded in the last</FieldLabel>
              <Segmented
                label="Max age"
                size="sm"
                value={String(f.filters.maxAgeDays)}
                onChange={(v) => setFilter('maxAgeDays', Number(v))}
                options={['3', '7', '14', '30'].map((d) => ({ value: d, label: `${d} days` }))}
              />
            </div>
            <div>
              <FieldLabel>Wait after upload</FieldLabel>
              <Segmented
                label="Wait"
                size="sm"
                value={String(f.filters.waitHours)}
                onChange={(v) => setFilter('waitHours', Number(v))}
                options={[
                  { value: '0', label: 'No wait' },
                  { value: '12', label: '12 h' },
                  { value: '24', label: '24 h' },
                  { value: '48', label: '48 h' },
                ]}
              />
            </div>
          </div>
          <p className="mt-4 flex items-start gap-2 rounded-2xl bg-info-bg px-3.5 py-2.5 text-[13px] leading-snug text-info-ink">
            <Sparkles size={14} className="mt-0.5 shrink-0" /> Waiting 24 h lets YouTube build its “most rewatched” graph, so CrestClip can pick the moments people actually replay.
          </p>
        </Step>

        <Step n={4} title="Clip style">
          <div className="flex flex-wrap gap-6">
            <div>
              <FieldLabel>Clips per video</FieldLabel>
              <Segmented
                label="Clips per video"
                size="sm"
                value={String(f.clipsPerVideo)}
                onChange={(v) => set('clipsPerVideo', Number(v))}
                options={['1', '2', '3'].map((n) => ({ value: n, label: n }))}
              />
            </div>
            <div>
              <FieldLabel>Background music</FieldLabel>
              <Segmented
                label="Music"
                size="sm"
                value={f.options.music === 'none' ? 'none' : 'auto'}
                onChange={(v) => setOpt('music', v)}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'none', label: 'Off' },
                ]}
              />
            </div>
          </div>
          <FieldLabel className="mt-5">Captions</FieldLabel>
          <CaptionPicker value={(f.options.captionStyle ?? 'pop') as CaptionStyle} onChange={(v) => setOpt('captionStyle', v)} />
          <FieldLabel className="mt-5">Edit motion</FieldLabel>
          <MotionPicker value={(f.options.motion ?? 'subtle') as Motion} onChange={(v) => setOpt('motion', v)} />
        </Step>

        <Step n={5} title="When should it post?" hint="How many posts a day and the exact times. You can cancel any single post later.">
          <div className="grid items-start gap-5 md:grid-cols-[auto_1fr]">
            <div>
              <FieldLabel>Posts per day</FieldLabel>
              <div className="inline-flex items-center gap-3 rounded-full bg-sunken p-1.5 shadow-well">
                <Button size="icon-sm" onClick={() => setCount(f.times.length - 1)} disabled={f.times.length <= 1} aria-label="Fewer">
                  <Minus size={16} />
                </Button>
                <b className="min-w-7 text-center font-display text-2xl">{f.times.length}</b>
                <Button size="icon-sm" onClick={() => setCount(f.times.length + 1)} disabled={f.times.length >= 12} aria-label="More">
                  <Plus size={16} />
                </Button>
              </div>
              {f.times.length > 6 && <small className="mt-2 block max-w-44 text-xs leading-snug text-warn-ink">More than 6 a day can look spammy to Instagram.</small>}
            </div>
            <div>
              <FieldLabel>Times</FieldLabel>
              <div className="flex flex-wrap gap-2.5">
                {f.times.map((t, i) => (
                  <label key={i} className={cn('inline-flex items-center gap-2 rounded-2xl bg-row py-2 pr-2.5 pl-3.5 text-accent shadow-flat', dupTimes.has(t) && 'shadow-[0_0_0_2px_var(--bad)]')}>
                    <input
                      type="time"
                      value={t}
                      step={300}
                      onChange={(e) => setF((x) => ({ ...x, times: x.times.map((v, j) => (j === i ? e.target.value || t : v)) }))}
                      aria-label={`Post ${i + 1} time`}
                      className="bg-transparent text-[15px] font-extrabold text-ink outline-none"
                    />
                    {f.times.length > 1 && (
                      <button
                        type="button"
                        aria-label="Remove this time"
                        className="grid size-5.5 place-items-center rounded-full bg-muted-bg text-ink-3"
                        onClick={() => setF((x) => ({ ...x, times: x.times.filter((_, j) => j !== i) }))}
                      >
                        <X size={13} />
                      </button>
                    )}
                  </label>
                ))}
              </div>
            </div>
            <Field label="Time zone" className="max-w-sm md:col-span-2">
              <Select value={f.timezone} onChange={(e) => set('timezone', e.target.value)}>
                {!zones.includes(f.timezone) && <option value={f.timezone}>{f.timezone}</option>}
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div aria-label="Your day" className="mt-6 rounded-[20px] bg-sunken px-4.5 pt-8 pb-2.5 shadow-well">
            <div className="relative h-2.5 rounded-full bg-[linear-gradient(90deg,#2b2140_0%,#6b5ca8_22%,#ffd8a8_45%,#ffe9b8_55%,#ff9f6e_75%,#2b2140_100%)] opacity-85">
              {sorted.map((t, i) => {
                const [h, m] = t.split(':').map(Number);
                return (
                  <span key={i} className="absolute top-1/2 flex -translate-1/2 flex-col items-center" style={{ left: `${((h * 60 + m) / 1440) * 100}%` }} title={prettyTime(t)}>
                    <i className="size-4.5 rounded-full border-3 border-surface bg-tangerine shadow-lift" />
                    <small className="absolute bottom-5.5 rounded-md bg-surface px-1.5 text-[11px] font-extrabold whitespace-nowrap text-ink">{prettyTime(t)}</small>
                  </span>
                );
              })}
            </div>
            <div className="mt-2.5 flex justify-between text-[11px] font-bold text-ink-3">
              <span>12 AM</span>
              <span>6 AM</span>
              <span>12 PM</span>
              <span>6 PM</span>
              <span>12 AM</span>
            </div>
          </div>

          <FieldLabel className="mt-5">Post to</FieldLabel>
          {accounts == null ? (
            <Skeleton className="h-13" />
          ) : accounts.length === 0 ? (
            <div className="flex flex-wrap items-center gap-2.5 rounded-2xl bg-warn-bg px-3.5 py-3 text-sm text-warn-ink">
              <AlertTriangle size={16} /> No accounts connected yet.
              <Link to="/app/settings" className={buttonClass('secondary', 'sm')}>
                Connect YouTube or Instagram
              </Link>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2.5">
              {accounts.map((a) => {
                const on = f.targets.some((t) => t.connectionId === a.id);
                const P = SOCIAL[a.platform];
                return (
                  <button
                    key={a.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => set('targets', on ? f.targets.filter((t) => t.connectionId !== a.id) : [...f.targets, { connectionId: a.id }])}
                    className={cn('inline-flex max-w-64 items-center gap-2 rounded-2xl border-2 px-3.5 py-2.5', on ? 'border-mint-d bg-good-bg' : 'border-transparent bg-row shadow-flat')}
                  >
                    <span className={cn('grid size-5.5 place-items-center rounded-full text-white', P.color)}>
                      <P.Icon size={11} />
                    </span>
                    <b className="truncate">{a.handle ?? a.name}</b>
                    {on && <Check size={15} className="text-mint-d" />}
                  </button>
                );
              })}
            </div>
          )}
        </Step>

        <Step n={6} title="Before anything posts…">
          <div className="grid gap-3 md:grid-cols-2">
            {(
              [
                ['review', Eye, 'I review each clip', 'New clips wait for your OK. Recommended to start.'],
                ['auto', Bot, 'Post automatically', 'The best clips go straight into your schedule.'],
              ] as const
            ).map(([m, Icon, t, d]) => (
              <button
                key={m}
                type="button"
                aria-pressed={f.mode === m}
                onClick={() => set('mode', m)}
                className={cn(
                  'flex flex-col items-start gap-1 rounded-[20px] border-2 px-4.5 py-4 text-left',
                  f.mode === m ? 'border-tangerine bg-orange-bg' : 'border-transparent bg-row shadow-flat',
                )}
              >
                <Icon size={20} className={f.mode === m ? 'text-accent' : 'text-ink-3'} />
                <b>{t}</b>
                <small className="text-[12.5px] text-ink-3">{d}</small>
              </button>
            ))}
          </div>
        </Step>

        <Step n={7} title="Caption" hint="Filled in for every post. Tap a tag to insert it.">
          <div className="mb-2.5 flex flex-wrap gap-1.5">
            {['title', 'hook', 'hashtags', 'channel', 'link'].map((v) => (
              <Chip key={v} className="font-mono text-[12.5px]" onClick={() => insertVar(v)}>
                {`{${v}}`}
              </Chip>
            ))}
          </div>
          <Textarea ref={capRef} rows={5} value={f.caption} maxLength={2200} onChange={(e) => set('caption', e.target.value)} />
          <p className="mt-1.5 text-xs text-ink-3">
            Keep <b>{'{channel}'}</b> in — crediting the creator is good practice and helps avoid takedowns.
          </p>
        </Step>

        <Card className="flex flex-col gap-2 p-5">
          <Toggle checked={f.rightsConfirmed} onChange={(v) => set('rightsConfirmed', v)} className="items-start text-sm leading-snug">
            <span>
              <ShieldCheck size={15} className="inline -translate-y-px text-mint-d" /> I have the rights to clip and repost videos from these sources (my own channels, channels that gave permission,
              or clipping campaigns).
            </span>
          </Toggle>
          <p className="text-[12.5px] text-ink-3 sm:pl-16">Reposting other people’s videos without permission can get your account flagged or removed.</p>
        </Card>
      </div>

      <div className="fixed inset-x-4 bottom-24 z-20 mx-auto flex max-w-4xl items-center justify-between gap-3.5 rounded-[24px] bg-glass py-3 pr-3.5 pl-5 shadow-float backdrop-blur-md lg:bottom-5 lg:left-[calc(15rem+3.5rem)]">
        <span className={cn('min-w-0 truncate text-[13px]', problems.length ? 'font-bold text-warn-ink' : 'text-ink-3')}>
          {problems[0] ?? `${f.times.length} post${f.times.length > 1 ? 's' : ''} a day · ${sorted.map(prettyTime).join(', ')} · ${f.mode === 'review' ? 'you approve each clip' : 'fully automatic'}`}
        </span>
        <Button variant="primary" onClick={save} loading={saving}>
          {!saving && <Check size={17} />} {id ? 'Save changes' : 'Start autopilot'}
        </Button>
      </div>
    </div>
  );
}

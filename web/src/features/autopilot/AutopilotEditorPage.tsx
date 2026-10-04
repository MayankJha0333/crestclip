import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bot,
  CalendarClock,
  Check,
  Eye,
  Filter,
  Globe,
  Hash,
  Minus,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  ShieldCheck,
  Sparkles,
  X,
  Youtube,
  type LucideIcon,
} from 'lucide-react';
import { useAccount } from '../auth/auth';
import { UpgradeCallout } from '../billing/UpgradeCallout';
import { api, type Account, type AutopilotConfig, type AutopilotInput, type AutopilotSource, type AutopilotSummary, type CaptionStyle, type Motion } from '../../lib/api';
import { cn } from '../../lib/cn';
import { timeAgo } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Button, buttonClass, Card, Chip, Dialog, Field, FieldLabel, Input, PageHeader, Segmented, Select, Skeleton, Textarea, Toggle } from '../../components/ui';
import { CaptionPicker } from '../clip-settings/CaptionPicker';
import { MotionPicker } from '../clip-settings/MotionPicker';
import { SOCIAL } from '../schedule/postStatus';
import { allZones, compact, defaultTimes, EMPTY_AUTOPILOT, prettyTime, REGIONS, sourceText } from './helpers';
import { LANGUAGES } from './languages';
import { track } from '../../lib/analytics';

const STEPS: { key: string; label: string; title: string; hint: string; Icon: LucideIcon }[] = [
  { key: 'videos', label: 'Videos', title: 'Where should clips come from?', hint: 'Name it, then pick the channels or topics it watches.', Icon: Youtube },
  { key: 'filters', label: 'Filters', title: 'Which videos are worth clipping?', hint: 'Skips weak videos before any AI credits are spent.', Icon: Filter },
  { key: 'style', label: 'Style', title: 'How should the clips look?', hint: 'Captions, motion and music for every clip.', Icon: Palette },
  { key: 'schedule', label: 'Schedule', title: 'When and where should it post?', hint: 'Posts a day, the exact times, and your accounts. You can cancel any single post later.', Icon: CalendarClock },
  { key: 'live', label: 'Go live', title: 'Last check', hint: 'How clips get approved, the caption, and a quick look at everything.', Icon: Rocket },
];
type StepStatus = 'done' | 'error' | 'todo';

/** The progress row at the top: tap a step to jump to it (forward only once the steps before it are filled in). */
function StepperNav({
  steps,
  current,
  status,
  canGo,
  onGo,
  navRef,
}: {
  steps: typeof STEPS;
  current: number;
  status: StepStatus[];
  canGo: (i: number) => boolean;
  onGo: (i: number) => void;
  navRef: RefObject<HTMLElement>;
}) {
  return (
    <nav ref={navRef} aria-label="Steps" className="mb-5 scroll-mt-4 rounded-[24px] bg-surface px-3 py-3 shadow-clay-sm sm:px-4">
      <ol className="flex items-center">
        {steps.map((s, i) => {
          const on = i === current;
          const st = status[i];
          return (
            <li key={s.key} className={cn('flex min-w-0 items-center', i < steps.length - 1 && 'flex-1')}>
              <button
                type="button"
                onClick={() => onGo(i)}
                disabled={!on && !canGo(i)}
                aria-current={on ? 'step' : undefined}
                aria-label={`Step ${i + 1}: ${s.label}${st === 'done' ? ' (done)' : st === 'error' ? ' (needs attention)' : ''}`}
                className="group flex shrink-0 items-center gap-2.5 rounded-full p-1 outline-none focus-visible:ring-3 focus-visible:ring-tangerine disabled:cursor-not-allowed disabled:opacity-60 lg:pr-3"
              >
                <span
                  className={cn(
                    'relative grid size-9 place-items-center rounded-full transition-all duration-300',
                    on
                      ? 'scale-110 bg-tangerine text-white shadow-[0_0_0_5px_var(--orange-bg)]'
                      : st === 'done'
                        ? 'bg-mint-d text-white group-hover:scale-105'
                        : st === 'error'
                          ? 'bg-bad-bg text-bad group-hover:scale-105'
                          : 'bg-sunken text-ink-3 shadow-well group-enabled:group-hover:text-ink',
                  )}
                >
                  {!on && st === 'done' ? <Check size={17} strokeWidth={3} /> : !on && st === 'error' ? <AlertTriangle size={16} /> : <s.Icon size={16} />}
                </span>
                <span className="hidden flex-col text-left leading-tight lg:flex">
                  <small className="text-[10.5px] font-black tracking-wider text-ink-3 uppercase">Step {i + 1}</small>
                  <b className={cn('text-[14px] whitespace-nowrap', on ? 'text-ink' : 'text-ink-2')}>{s.label}</b>
                </span>
              </button>
              {i < steps.length - 1 && (
                <span aria-hidden className="mx-1.5 h-1 min-w-3 flex-1 overflow-hidden rounded-full bg-sunken shadow-well sm:mx-2.5">
                  <i
                    className={cn(
                      'block h-full rounded-full bg-mint-d transition-[width] duration-500 ease-out',
                      status[i] === 'done' && i < current ? 'w-full' : i < current ? 'w-full bg-tangerine' : 'w-0',
                    )}
                  />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The top of the current step's card. */
function StepHeader({ index, step }: { index: number; step: (typeof STEPS)[number] }) {
  return (
    <header className="mb-6 flex items-start gap-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-[14px] bg-orange-bg text-orange-ink shadow-clay-sm sm:size-12 sm:rounded-[16px]">
        <step.Icon size={22} />
      </span>
      <div className="min-w-0">
        <small className="text-[11px] font-black tracking-wider text-ink-3 uppercase">
          Step {index + 1} of {STEPS.length} · {step.label}
        </small>
        <h2 className="text-[22px] leading-tight sm:text-2xl">{step.title}</h2>
        <p className="mt-1 text-[13.5px] text-ink-3">{step.hint}</p>
      </div>
    </header>
  );
}

/** One block inside a step, with a thin line between blocks. */
function Section({ title, hint, children }: { title?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-line pt-5 first:border-t-0 first:pt-0">
      {title && <h3 className={cn('font-display text-[17px] font-bold', !hint && 'mb-3')}>{title}</h3>}
      {hint && <p className="mt-0.5 mb-3 text-[13px] text-ink-3">{hint}</p>}
      {children}
    </section>
  );
}

/** Everything chosen so far, one line per step, each with a jump back. */
function Summary({ f, accounts, onEdit }: { f: AutopilotInput; accounts: Account[] | null; onEdit: (step: number) => void }) {
  const lang = (f.filters.languages ?? []).map((c) => LANGUAGES.find((l) => l.code === c)?.label ?? c);
  const names = f.targets.map((t) => {
    const a = accounts?.find((x) => x.id === t.connectionId);
    return a ? (a.handle ?? a.name) : null;
  });
  const src = f.sources.map(sourceText);
  const rows: [number, string, ReactNode][] = [
    [
      0,
      'Videos',
      <>
        <b>{f.name || 'No name yet'}</b> · {src.length ? `${src.slice(0, 3).join(', ')}${src.length > 3 ? ` +${src.length - 3} more` : ''}` : 'no sources yet'}
      </>,
    ],
    [
      1,
      'Filters',
      `${f.filters.minViews ? `${compact(f.filters.minViews)}+ views` : 'Any views'} · ${f.filters.minMinutes}–${f.filters.maxMinutes} min · last ${f.filters.maxAgeDays} days · ${f.filters.waitHours ? `wait ${f.filters.waitHours} h` : 'no wait'}${lang.length ? ` · ${lang.join(', ')}` : ''}`,
    ],
    [
      2,
      'Style',
      `${f.clipsPerVideo} clip${f.clipsPerVideo > 1 ? 's' : ''} per video · ${String(f.options.captionStyle ?? 'pop')} captions · ${String(f.options.motion ?? 'subtle')} motion · music ${f.options.music === 'none' ? 'off' : 'auto'}`,
    ],
    [3, 'Schedule', `${f.times.length} a day · ${[...f.times].sort().map(prettyTime).join(', ')} · ${names.filter(Boolean).join(', ') || 'no account picked'}`],
  ];
  return (
    <div className="flex flex-col divide-y divide-line overflow-hidden rounded-[20px] bg-row">
      {rows.map(([i, label, text]) => (
        <div key={label} className="flex items-center gap-3 px-4 py-3">
          <span className="w-18 shrink-0 text-[11px] font-black tracking-wider text-ink-3 uppercase">{label}</span>
          <span className="min-w-0 flex-1 text-[13.5px] text-ink-2 first-letter:uppercase">{text}</span>
          <Button size="sm" variant="ghost" onClick={() => onEdit(i)}>
            <Pencil size={13} /> Edit
          </Button>
        </div>
      ))}
    </div>
  );
}

/** Create or edit an autopilot — one form, numbered steps, a sticky save bar that says what's missing. */
export function AutopilotEditorPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [f, setF] = useState<AutopilotInput>(EMPTY_AUTOPILOT);
  const [loaded, setLoaded] = useState(!id);
  const [booked, setBooked] = useState(0); // posts already booked (edit only)
  const [savedPlan, setSavedPlan] = useState(''); // times/zone/accounts/caption as last saved
  const [askReplan, setAskReplan] = useState(false);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [srcKind, setSrcKind] = useState<'youtube_channel' | 'youtube_topic'>('youtube_channel');
  const [srcText, setSrcText] = useState('');
  const [srcRegion, setSrcRegion] = useState('');
  const [srcSort, setSrcSort] = useState<'trending' | 'views' | 'date'>('trending');
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
          setBooked(a.counts.scheduled);
          setSavedPlan(planKey(a.config));
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
  const langs = f.filters.languages ?? [];
  const setLangs = (v: string[]) => setF((x) => ({ ...x, filters: { ...x.filters, languages: v } }));
  const [showAllLangs, setShowAllLangs] = useState(false);
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
      set('sources', [...f.sources, { kind: 'youtube_topic', value, region: srcRegion || null, label: value, sort: srcSort }]);
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
  // the person's other running autopilots — to warn when two would post to one account at nearly the same time
  const [others, setOthers] = useState<AutopilotSummary[]>([]);
  useEffect(() => {
    api
      .autopilots()
      .then((l) => setOthers(l.filter((a) => a.id !== id && a.status === 'active')))
      .catch(() => {});
  }, [id]);
  const clashes = others.flatMap((o) => {
    if (o.config.timezone !== f.timezone) return [];
    const shared = o.config.targets.filter((t) => f.targets.some((x) => x.connectionId === t.connectionId));
    if (!shared.length) return [];
    const near = o.config.times.filter((u) => f.times.some((t) => gapMinutes(t, u) < 30));
    if (!near.length) return [];
    const names = shared.map((t) => accounts?.find((a) => a.id === t.connectionId)).map((a) => (a ? (a.handle ?? a.name) : 'the same account'));
    return [{ id: o.id, name: o.name, accounts: [...new Set(names)], times: [...near].sort() }];
  });
  const problems = [
    !f.name.trim() && 'Give it a name',
    !f.sources.length && 'Add at least one source',
    !f.targets.length && 'Pick an account to post to',
    dupTimes.size > 0 && 'Two posts have the same time',
    !f.rightsConfirmed && 'Confirm you have the rights',
  ].filter(Boolean) as string[];

  // ---- stepper: which step, which were seen, what's missing per step
  const stepProblems: string[][] = [
    [!f.name.trim() && 'Give it a name', !f.sources.length && 'Add at least one source'],
    [],
    [],
    [!f.targets.length && 'Pick an account to post to', dupTimes.size > 0 && 'Two posts have the same time'],
    [!f.rightsConfirmed && 'Confirm you have the rights'],
  ].map((x) => x.filter(Boolean) as string[]);
  const [params, setParams] = useSearchParams();
  const step = Math.min(STEPS.length - 1, Math.max(0, Number(params.get('step') ?? 1) - 1 || 0));
  const [dir, setDir] = useState(1);
  const [seen, setSeen] = useState(() => (id ? STEPS.length - 1 : step)); // furthest step reached (edit: all)
  const [tried, setTried] = useState<Set<number>>(new Set()); // steps where Next/Save was pressed with something missing
  const navRef = useRef<HTMLElement>(null);
  const last = step === STEPS.length - 1;
  const canGo = (i: number) => Boolean(id) || i <= seen || stepProblems.slice(0, i).every((x) => !x.length);
  const go = (i: number) => {
    if (i === step || !canGo(i)) return;
    setDir(i > step ? 1 : -1);
    setSeen((x) => Math.max(x, i));
    setParams(
      (q) => {
        const n = new URLSearchParams(q);
        n.set('step', String(i + 1));
        return n;
      },
      { replace: true },
    );
    requestAnimationFrame(() => {
      const top = navRef.current?.getBoundingClientRect().top ?? 0;
      if (top < 0) navRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };
  const next = () => {
    if (stepProblems[step].length) {
      // the bottom bar now says what's missing (and the step's dot turns red)
      return setTried((t) => new Set(t).add(step));
    }
    go(step + 1);
  };
  const status = STEPS.map((_, i): StepStatus => (stepProblems[i].length ? (tried.has(i) || (i < step && i <= seen) ? 'error' : 'todo') : i <= seen ? 'done' : 'todo'));
  // the bottom bar warns only about this step (or, on the last step, anything still missing)
  const shown = last ? problems : tried.has(step) ? stepProblems[step] : [];

  /** Ask what to do with booked posts before saving an edit (only when some are booked). */
  const trySave = () => {
    if (problems.length) {
      const bad = stepProblems.findIndex((x) => x.length);
      setTried(new Set(stepProblems.map((x, i) => (x.length ? i : -1)).filter((i) => i >= 0)));
      if (bad >= 0 && bad !== step) go(bad);
      return toast(problems[0], 'error');
    }
    if (id && booked > 0) return setAskReplan(true);
    void save();
  };
  const save = async (replan?: boolean) => {
    if (problems.length) return toast(problems[0], 'error');
    setAskReplan(false);
    setSaving(true);
    try {
      const body = { ...f, times: [...f.times].sort() };
      const a = id ? await api.updateAutopilot(id, replan === undefined ? body : { ...body, replan }) : await api.createAutopilot(body);
      if (!id) track('create_autopilot');
      toast(!id ? 'Autopilot is running' : replan ? 'Saved — booked posts are being re-planned with the new settings' : 'Saved');
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

  const planChanged = savedPlan !== planKey(f);
  return (
    <div className="pb-6">
      <PageHeader
        back={{ to: id ? `/app/autopilot/${id}` : '/app/autopilot', label: 'Back' }}
        title={id ? f.name || 'Edit autopilot' : 'New autopilot'}
        description={id ? undefined : 'Five quick steps. You can change any of it later.'}
      />

      <StepperNav steps={STEPS} current={step} status={status} canGo={canGo} onGo={go} navRef={navRef} />

      <div key={step} className={cn(dir >= 0 ? 'animate-step-next' : 'animate-step-back')}>
        <Card className="p-5 sm:p-7">
          <StepHeader index={step} step={STEPS[step]} />
          <div className="flex flex-col gap-6">
            {step === 0 && (
              <>
                <Section title="Name">
                  <Input value={f.name} maxLength={80} placeholder="e.g. Podcast clips · India" onChange={(e) => set('name', e.target.value)} />
                </Section>
                <Section title="Sources" hint="New uploads from these channels, or popular videos for a topic.">
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
                    <SourceSearch
                      kind={srcKind}
                      text={srcText}
                      region={srcRegion}
                      days={f.filters.maxAgeDays}
                      onText={setSrcText}
                      onEnter={addSource}
                      onPickChannel={(c) => {
                        if (f.sources.some((x) => x.channelId === c.channelId)) return toast('That channel is already added');
                        set('sources', [...f.sources, { kind: 'youtube_channel', value: c.url, channelId: c.channelId, label: c.name }]);
                        setSrcText('');
                      }}
                      onPickTopic={(t) => {
                        if (f.sources.some((x) => x.kind === 'youtube_topic' && x.value.toLowerCase() === t.toLowerCase() && (x.region ?? '') === srcRegion && (x.sort ?? 'views') === srcSort))
                          return toast('That topic is already added');
                        set('sources', [...f.sources, { kind: 'youtube_topic', value: t, region: srcRegion || null, label: t, sort: srcSort }]);
                        setSrcText('');
                      }}
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
                  {srcKind === 'youtube_topic' && (
                    <div className="mt-3 flex flex-wrap items-center gap-2.5">
                      <span className="text-[13px] font-bold text-ink-2">Pick videos that are</span>
                      <Segmented
                        label="Pick videos by"
                        size="sm"
                        value={srcSort}
                        onChange={setSrcSort}
                        options={[
                          { value: 'trending', label: '🔥 Trending' },
                          { value: 'views', label: 'Most viewed' },
                          { value: 'date', label: 'Newest' },
                        ]}
                      />
                      <small className="text-[12px] text-ink-3">
                        {srcSort === 'trending' ? 'Fresh videos gaining views fastest right now' : srcSort === 'views' ? 'The most watched videos in your time window' : 'The latest uploads first'}
                      </small>
                    </div>
                  )}
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
                </Section>
              </>
            )}
            {step === 1 && (
              <>
                <Section title="Size and age">
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
                </Section>
                <Section>
                  {/* spoken language: optional; empty = any language */}
                  <div>
                    <FieldLabel>Spoken language</FieldLabel>
                    <p className="-mt-1 mb-2.5 text-[12.5px] text-ink-3">Only clip videos in these languages. CrestClip checks each video before spending credits.</p>
                    <div role="group" aria-label="Spoken language" className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        aria-pressed={!langs.length}
                        onClick={() => setLangs([])}
                        className={cn('rounded-full px-3 py-1.5 text-[13px] font-bold transition-colors', !langs.length ? 'bg-ink text-on-ink' : 'bg-row text-ink-2 hover:bg-row-hover')}
                      >
                        Any language
                      </button>
                      {(showAllLangs ? LANGUAGES : LANGUAGES.filter((l, i) => i < 8 || langs.includes(l.code))).map((l) => {
                        const on = langs.includes(l.code);
                        return (
                          <button
                            key={l.code}
                            type="button"
                            aria-pressed={on}
                            onClick={() => setLangs(on ? langs.filter((x) => x !== l.code) : [...langs, l.code])}
                            className={cn(
                              'inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[13px] font-bold transition-colors',
                              on ? 'bg-orange-bg text-orange-ink ring-2 ring-tangerine' : 'bg-row text-ink-2 hover:bg-row-hover',
                            )}
                          >
                            {on && <Check size={13} strokeWidth={3} />} {l.label}
                          </button>
                        );
                      })}
                      {!showAllLangs && (
                        <button type="button" onClick={() => setShowAllLangs(true)} className="rounded-full px-3 py-1.5 text-[13px] font-bold text-accent hover:bg-row">
                          More…
                        </button>
                      )}
                    </div>
                  </div>
                </Section>
                <Section>
                  <div className="grid gap-4 md:grid-cols-2">
                    <TagInput
                      label="Skip videos whose title has"
                      hint="e.g. trailer, reaction, highlights"
                      placeholder="Type a word, press Enter"
                      values={f.filters.excludeWords ?? []}
                      onChange={(v) => setF((x) => ({ ...x, filters: { ...x.filters, excludeWords: v } }))}
                    />
                    <TagInput
                      suggestChannels
                      label="Never use these channels"
                      hint="Handy for topic searches — type the channel name"
                      placeholder="Channel name, press Enter"
                      values={f.filters.blockChannels ?? []}
                      onChange={(v) => setF((x) => ({ ...x, filters: { ...x.filters, blockChannels: v } }))}
                    />
                  </div>
                </Section>
              </>
            )}
            {step === 2 && (
              <>
                <Section>
                  <div className="flex flex-wrap gap-6">
                    <div>
                      <FieldLabel>Clips per video</FieldLabel>
                      <Segmented
                        label="Clips per video"
                        size="sm"
                        value={String(f.clipsPerVideo)}
                        onChange={(v) => set('clipsPerVideo', Number(v))}
                        options={['1', '2', '3', '4', '5'].map((n) => ({ value: n, label: n }))}
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
                </Section>
              </>
            )}
            {step === 3 && (
              <>
                <Section title="Times">
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
                          <label
                            key={i}
                            className={cn('inline-flex items-center gap-2 rounded-2xl bg-row py-2 pr-2.5 pl-3.5 text-accent shadow-flat', dupTimes.has(t) && 'shadow-[0_0_0_2px_var(--bad)]')}
                          >
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
                    {clashes.length > 0 && (
                      <div className="flex items-start gap-2 rounded-2xl bg-warn-bg px-3.5 py-2.5 text-[13px] leading-snug text-warn-ink md:col-span-2">
                        <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                        <span>
                          {clashes.map((c) => (
                            <span key={c.id} className="block">
                              Your autopilot <b>{c.name}</b> also posts to {c.accounts.join(', ')} at {c.times.map(prettyTime).join(', ')}.
                            </span>
                          ))}
                          Posts less than 30 min apart on one account take views from each other. Move a time a little.
                        </span>
                      </div>
                    )}
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
                </Section>
                <Section title="Post to" hint="Every post goes to each account you pick.">
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
                </Section>
              </>
            )}
            {step === 4 && (
              <>
                <Section title="Before anything posts…">
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
                </Section>
                <Section title="Caption" hint="Filled in for every post. Tap a tag to insert it.">
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
                </Section>
                <Section title="At a glance" hint="Tap Edit to jump back to any step.">
                  <Summary f={f} accounts={accounts} onEdit={go} />
                </Section>
                <Section>
                  <div className="flex flex-col gap-2 rounded-[20px] bg-row p-4">
                    <Toggle checked={f.rightsConfirmed} onChange={(v) => set('rightsConfirmed', v)} className="items-start text-sm leading-snug">
                      <span>
                        <ShieldCheck size={15} className="inline -translate-y-px text-mint-d" /> I have the rights to clip and repost videos from these sources (my own channels, channels that gave
                        permission, or clipping campaigns).
                      </span>
                    </Toggle>
                    <p className="text-[12.5px] text-ink-3 sm:pl-16">Reposting other people’s videos without permission can get your account flagged or removed.</p>
                  </div>
                </Section>
              </>
            )}
          </div>
        </Card>
      </div>

      <div className="sticky bottom-24 z-20 mt-5 flex items-center justify-between gap-2.5 rounded-[24px] bg-glass py-3 pr-3.5 pl-3.5 shadow-float backdrop-blur-md sm:gap-3.5 sm:pl-5 lg:bottom-5">
        {step > 0 ? (
          <Button variant="ghost" onClick={() => go(step - 1)} aria-label="Back">
            <ArrowLeft size={17} /> <span className="hidden sm:inline">Back</span>
          </Button>
        ) : (
          <span className="hidden sm:block" />
        )}
        <span className={cn('min-w-0 flex-1 truncate text-[13px]', shown.length ? 'font-bold text-warn-ink' : 'text-ink-3')}>
          {shown[0] ?? (
            <>
              <b className="text-ink-2">
                Step {step + 1} of {STEPS.length}
              </b>
              <span className="hidden sm:inline"> · {STEPS[step].label}</span>
            </>
          )}
        </span>
        {id && !last && (
          <Button variant="secondary" onClick={trySave} loading={saving} className="hidden sm:inline-flex">
            Save
          </Button>
        )}
        {last ? (
          <Button variant="primary" onClick={trySave} loading={saving}>
            {!saving && <Check size={17} />} {id ? 'Save changes' : 'Start autopilot'}
          </Button>
        ) : (
          <Button variant="primary" onClick={next}>
            <span className="hidden sm:inline">Next: {STEPS[step + 1].label}</span>
            <span className="sm:hidden">Next</span> <ArrowRight size={17} />
          </Button>
        )}
      </div>
      <Dialog
        open={askReplan}
        onClose={() => setAskReplan(false)}
        title="Apply the changes to booked posts?"
        footer={
          <Button variant="ghost" onClick={() => setAskReplan(false)}>
            Back to editing
          </Button>
        }
      >
        <p className="mb-4 text-[14px] text-ink-2">
          {booked} post{booked > 1 ? 's are' : ' is'} already booked with the old settings.
        </p>
        <div className="flex flex-col gap-2.5">
          <button
            type="button"
            onClick={() => save(true)}
            className="flex items-start gap-3 rounded-2xl bg-row p-4 text-left transition-colors hover:bg-row-hover focus-visible:ring-3 focus-visible:ring-tangerine"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-orange-bg text-orange-ink">
              <RefreshCw size={17} />
            </span>
            <span className="flex flex-col gap-0.5">
              <b className="font-display text-[15.5px]">
                Re-plan all booked posts {planChanged && <span className="ml-1 rounded-full bg-good-bg px-2 py-0.5 text-[11px] text-good-ink">Recommended</span>}
              </b>
              <span className="text-[13px] text-ink-3">Booked clips go back in line and are booked again with your new times, accounts and caption. Nothing is lost.</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => save(false)}
            className="flex items-start gap-3 rounded-2xl bg-row p-4 text-left transition-colors hover:bg-row-hover focus-visible:ring-3 focus-visible:ring-tangerine"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted-bg text-ink-2">
              <Check size={17} />
            </span>
            <span className="flex flex-col gap-0.5">
              <b className="font-display text-[15.5px]">Keep booked posts as they are</b>
              <span className="text-[13px] text-ink-3">They post as planned. The new settings apply from the next clip that gets booked.</span>
            </span>
          </button>
        </div>
      </Dialog>
    </div>
  );
}

/** Minutes between two "HH:MM" times of day (going round midnight). */
const gapMinutes = (a: string, b: string) => {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const d = Math.abs(m(a) - m(b));
  return Math.min(d, 1440 - d);
};

/** What decides when and where posts go — if this changed, re-planning booked posts is the natural choice. */
const planKey = (c: Pick<AutopilotConfig, 'times' | 'timezone' | 'targets' | 'caption'>) =>
  JSON.stringify([[...c.times].sort(), c.timezone, c.targets.map((t) => [t.connectionId, t.privacy ?? '']), c.caption]);

/** A small "type and press Enter" list of words, shown as removable chips. */
function TagInput({
  label,
  hint,
  placeholder,
  values,
  onChange,
  suggestChannels,
}: {
  label: string;
  hint: string;
  placeholder: string;
  values: string[];
  onChange: (v: string[]) => void;
  /** show YouTube channels while typing; picking one adds its name */
  suggestChannels?: boolean;
}) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const { hits, loading } = useChannelSearch(text, Boolean(suggestChannels));
  const show = Boolean(suggestChannels) && open && text.trim().length >= 2 && (loading || hits.length > 0);
  const addName = (name: string) => {
    if (!values.some((v) => v.toLowerCase() === name.toLowerCase())) onChange([...values, name.slice(0, 80)].slice(0, 30));
    setText('');
    setOpen(false);
  };
  const add = () => {
    const parts = text
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const next = [...values];
    for (const p of parts) if (!next.some((v) => v.toLowerCase() === p.toLowerCase())) next.push(p.slice(0, 80));
    onChange(next.slice(0, 30));
    setText('');
  };
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <p className="-mt-1 mb-2 text-[12.5px] text-ink-3">{hint}</p>
      <div ref={wrap} className="flex gap-2">
        <Input
          className="min-w-0 flex-1"
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (show && e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(hits.length - 1, a + 1));
            } else if (show && e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Escape') setOpen(false);
            else if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              if (show && hits[active]) addName(hits[active].name);
              else add();
            }
          }}
          onBlur={() =>
            setTimeout(() => {
              setOpen(false);
            }, 150)
          }
          aria-label={label}
        />
      </div>
      {show && (
        <Floating anchor={wrap}>
          {loading && !hits.length && <p className="px-3 py-3 text-[13px] text-ink-3">Searching YouTube…</p>}
          {hits.map((c, i) => (
            <ChannelOption key={c.channelId} c={c} active={i === active} onHover={() => setActive(i)} onPick={() => addName(c.name)} />
          ))}
        </Floating>
      )}
      {values.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {values.map((v) => (
            <span key={v} className="inline-flex items-center gap-1 rounded-full bg-row py-1 pr-1 pl-3 text-[13px] font-bold shadow-flat">
              {v}
              <button
                type="button"
                aria-label={`Remove ${v}`}
                onClick={() => onChange(values.filter((x) => x !== v))}
                className="grid size-5 place-items-center rounded-full hover:bg-bad-bg hover:text-bad"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

type ChannelHit = Awaited<ReturnType<typeof api.suggestChannels>>[number];
type TopicNumbers = Awaited<ReturnType<typeof api.topicStats>>;

/**
 * The source box with suggestions while typing: YouTube channels (logo, @handle, subscribers) or topics people
 * search for (with how many fresh videos it has and the views they get). Arrow keys + Enter work too.
 */
function SourceSearch({
  kind,
  text,
  region,
  days,
  onText,
  onEnter,
  onPickChannel,
  onPickTopic,
}: {
  kind: 'youtube_channel' | 'youtube_topic';
  text: string;
  region: string;
  days: number;
  onText: (v: string) => void;
  onEnter: () => void;
  onPickChannel: (c: ChannelHit) => void;
  onPickTopic: (t: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [channels, setChannels] = useState<ChannelHit[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [stats, setStats] = useState<Record<string, TopicNumbers | 'loading' | 'error'>>({});
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const q = text.trim();
  // a pasted link / UC id is resolved on "Add" — no need to search for it
  const isLink = kind === 'youtube_channel' && (/youtube\.com|youtu\.be|^UC[\w-]{22}$/.test(q) || q.includes('/'));
  const ideas = kind === 'youtube_topic' && q.length < 2;
  const shownTopics = ideas ? TOPIC_IDEAS : topics;

  useEffect(() => {
    setActive(0);
    if (q.length < 2 || isLink) {
      setChannels([]);
      setTopics([]);
      return;
    }
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      const job = kind === 'youtube_channel' ? api.suggestChannels(q).then((r) => live && setChannels(r)) : api.suggestTopics(q, region).then((r) => live && setTopics(r));
      job.catch(() => {}).finally(() => live && setLoading(false));
    }, 280);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, kind, region, isLink]);

  // numbers for the first few topic ideas (cached on the server, so cheap)
  useEffect(() => {
    if (kind !== 'youtube_topic') return;
    for (const t of shownTopics.slice(0, 5)) {
      const k = `${region}|${days}|${t}`;
      if (stats[k]) continue;
      setStats((s) => ({ ...s, [k]: 'loading' }));
      api
        .topicStats(t, region, days)
        .then((r) => setStats((s) => ({ ...s, [k]: r })))
        .catch(() => setStats((s) => ({ ...s, [k]: 'error' })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topics, region, days, kind, ideas]);

  const list = kind === 'youtube_channel' ? channels : shownTopics;
  const show = open && !isLink && (ideas || (q.length >= 2 && (loading || list.length > 0)));
  const pick = (i: number) => {
    if (kind === 'youtube_channel' && channels[i]) onPickChannel(channels[i]);
    else if (kind === 'youtube_topic' && shownTopics[i]) onPickTopic(shownTopics[i]);
    setOpen(false);
  };

  return (
    <div ref={wrap} className="relative min-w-56 flex-1">
      <Input
        className="w-full"
        value={text}
        role="combobox"
        aria-expanded={show}
        aria-autocomplete="list"
        placeholder={kind === 'youtube_channel' ? 'Search a channel, or paste its link / @handle' : 'Topic, e.g. podcast funny moments'}
        onChange={(e) => {
          onText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (show && e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(list.length - 1, a + 1));
          } else if (show && e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === 'Escape') setOpen(false);
          else if (e.key === 'Enter') {
            e.preventDefault();
            if (show && list.length) pick(active);
            else onEnter();
          }
        }}
      />
      {show && (
        <Floating anchor={wrap}>
          {ideas && <p className="px-3 pt-2 pb-1 text-[11.5px] font-black tracking-wider text-ink-3 uppercase">Ideas — or type your own</p>}
          {loading && !list.length && <p className="px-3 py-3 text-[13px] text-ink-3">Searching YouTube…</p>}
          {kind === 'youtube_channel'
            ? channels.map((c, i) => <ChannelOption key={c.channelId} c={c} active={i === active} onHover={() => setActive(i)} onPick={() => pick(i)} />)
            : shownTopics.map((t, i) => {
                const st = stats[`${region}|${days}|${t}`];
                const hot = st && typeof st === 'object' && (st.medianViews ?? 0) >= 100_000;
                return (
                  <button
                    key={t}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(i)}
                    className={cn('flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left', i === active && 'bg-row')}
                  >
                    <Search size={15} className="shrink-0 text-ink-3" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <b className="truncate text-[14px]">{t}</b>
                      <small className="text-[12px] text-ink-3">
                        {!st || i >= 5
                          ? '\u00a0'
                          : st === 'loading'
                            ? 'Checking YouTube…'
                            : st === 'error'
                              ? 'Couldn’t check right now'
                              : st.videos
                                ? `${st.videos} fresh video${st.videos > 1 ? 's' : ''} · typically ${compact(st.medianViews)} views${st.topViews ? ` · top ${compact(st.topViews)}` : ''}`
                                : `No long videos in the last ${days} days`}
                      </small>
                    </span>
                    {hot && <span className="rounded-full bg-orange-bg px-2 py-0.5 text-[11px] font-black text-orange-ink">🔥 Popular</span>}
                  </button>
                );
              })}
        </Floating>
      )}
    </div>
  );
}

/** Starting points shown when the topic box is empty (clip-friendly niches). */
const TOPIC_IDEAS = ['podcast', 'interview', 'motivational speech', 'business podcast', 'comedy podcast', 'stream highlights', 'tech review', 'sports talk show'];

/**
 * A dropdown drawn above the whole page (a portal), lined up under its input — so it never slides under the next
 * card or gets cut off. Opens upward when there isn't room below.
 */
function Floating({ anchor, children }: { anchor: RefObject<HTMLElement>; children: ReactNode }) {
  const [box, setBox] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const up = below < 260 && above > below;
      const width = Math.min(Math.max(r.width, 320), window.innerWidth - 24);
      const left = Math.max(12, Math.min(r.left, window.innerWidth - width - 12));
      setBox(up ? { left, width, bottom: window.innerHeight - r.top + 8, maxHeight: Math.min(380, above) } : { left, width, top: r.bottom + 8, maxHeight: Math.min(380, below) });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchor]);
  if (!box) return null;
  return createPortal(
    <div
      role="listbox"
      style={{ position: 'fixed', left: box.left, width: box.width, top: box.top, bottom: box.bottom, maxHeight: box.maxHeight }}
      className="z-[70] overflow-y-auto overscroll-contain rounded-[20px] bg-surface p-1.5 shadow-clay"
    >
      {children}
    </div>,
    document.body,
  );
}

/** One YouTube channel in a suggestion list. */
function ChannelOption({ c, active, onHover, onPick }: { c: ChannelHit; active: boolean; onHover: () => void; onPick: () => void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={onHover}
      onClick={onPick}
      className={cn('flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left', active && 'bg-row')}
    >
      {c.avatar ? (
        <img src={c.avatar} alt="" referrerPolicy="no-referrer" className="size-10 shrink-0 rounded-full object-cover" />
      ) : (
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-lilac/30 font-bold text-ink">{c.name[0]}</span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <b className="truncate text-[14px]">{c.name}</b>
        <small className="truncate text-[12px] text-ink-3">{[c.handle, c.subscribers != null ? `${compact(c.subscribers)} subscribers` : null].filter(Boolean).join(' · ')}</small>
      </span>
    </button>
  );
}

/** Channel suggestions while typing (debounced), for any box that takes a channel name. */
function useChannelSearch(q: string, enabled: boolean) {
  const [hits, setHits] = useState<ChannelHit[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const query = q.trim();
    if (!enabled || query.length < 2) {
      setHits([]);
      return;
    }
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      api
        .suggestChannels(query)
        .then((r) => live && setHits(r))
        .catch(() => live && setHits([]))
        .finally(() => live && setLoading(false));
    }, 280);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, enabled]);
  return { hits, loading };
}

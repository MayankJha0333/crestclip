import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, ChevronLeft, Flame, History, RefreshCw, Search, Sparkles, Twitch, X, Youtube } from 'lucide-react';
import { api, savedOptions, type DiscoverSection, type ExploreChannel, type ExploreItem, type ExploreSource } from '../../lib/api';
import { cn } from '../../lib/cn';
import { fmtCount } from '../../lib/format';
import { useKey } from '../../lib/hooks';
import { pushRecentSearch, readLocal, writeLocal } from '../../lib/storage';
import { toast } from '../../lib/toast';
import { Badge, Button, Card, Chip, EmptyState, PageHeader, Segmented, Select, Skeleton } from '../../components/ui';
import { ChannelCard, Rail, SkeletonCard, VideoCard } from './ExploreCards';
import { parseLink } from './parseLink';
import { PeekDrawer } from './PeekDrawer';
import { track } from '../../lib/analytics';

const YT_TYPES = [
  { value: 'videos', label: 'Videos' },
  { value: 'shorts', label: 'Shorts' },
  { value: 'channels', label: 'Channels' },
  { value: 'live', label: 'Live' },
];
const TW_TYPES = [
  { value: 'channels', label: 'Channels' },
  { value: 'vods', label: 'Past streams' },
  { value: 'clips', label: 'Clips' },
];
const FALLBACK_CATS = [
  { id: 'all', label: 'For you' },
  { id: 'podcasts', label: 'Podcasts' },
  { id: 'interviews', label: 'Interviews' },
  { id: 'comedy', label: 'Comedy' },
  { id: 'business', label: 'Business' },
  { id: 'tech', label: 'Tech & AI' },
  { id: 'gaming', label: 'Gaming' },
  { id: 'sports', label: 'Sports' },
  { id: 'motivation', label: 'Motivation' },
  { id: 'education', label: 'Learning' },
];
const LABELS: Record<string, Record<string, string>> = {
  sort: { views: 'Most viewed', date: 'Newest' },
  duration: { short: 'Under 4 min', medium: '4–20 min', long: 'Over 20 min' },
  uploaded: { today: 'Today', week: 'This week', month: 'This month', year: 'This year' },
};

function FeedSection({ title, subtitle, action, children, loading }: { title: string; subtitle: string; action?: ReactNode; children: ReactNode; loading?: boolean }) {
  return (
    <section>
      <div className="mb-2 flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-end">
        {loading ? (
          <div className="w-2/5">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="mt-2 h-3 w-11/12" />
          </div>
        ) : (
          <div>
            <h2 className="text-[22px]">{title}</h2>
            <p className="text-sm text-ink-3">{subtitle}</p>
          </div>
        )}
        {action}
      </div>
      {children}
    </section>
  );
}

/** Find a video worth clipping: browse a feed, search, or open a channel — then preview and clip. */
export function ExplorePage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const source = (params.get('source') === 'twitch' ? 'twitch' : 'youtube') as ExploreSource;
  const q = params.get('q') ?? '';
  const type = params.get('type') ?? (source === 'twitch' ? 'channels' : 'videos');
  const sort = params.get('sort') ?? 'relevance';
  const duration = params.get('duration') ?? 'any';
  const uploaded = params.get('uploaded') ?? 'any';
  const channelUrl = params.get('channel');
  const tab = params.get('tab') ?? (channelUrl && /twitch\.tv/.test(channelUrl) ? 'vods' : 'videos');
  const cat = params.get('cat') ?? 'all';
  const mode: 'channel' | 'search' | 'discover' = channelUrl ? 'channel' : q ? 'search' : 'discover';

  const [draft, setDraft] = useState(q);
  const [focused, setFocused] = useState(false);
  const [items, setItems] = useState<ExploreItem[] | null>(null);
  const [sections, setSections] = useState<DiscoverSection[] | null>(null);
  const [channel, setChannel] = useState<ExploreChannel | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [twitchApi, setTwitchApi] = useState<boolean | null>(null);
  const [limit, setLimit] = useState(24);
  const [moreLoading, setMoreLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [cats, setCats] = useState(FALLBACK_CATS);
  const [twitchFeatured, setTwitchFeatured] = useState<string[]>(['kaicenat', 'xqc', 'shroud', 'pokimane', 'hasanabi', 'tarik']);
  const [peek, setPeek] = useState<{ list: ExploreItem[]; index: number } | null>(null);
  const [clipping, setClipping] = useState<string | null>(null);
  const [recentSearches, setRecentSearches] = useState<string[]>(() => readLocal('crestclip:recent-searches', []));
  const [recentPeeks, setRecentPeeks] = useState<ExploreItem[]>(() => readLocal('crestclip:recent-peeks', []));
  const [showGuide, setShowGuide] = useState(() => !readLocal('crestclip:explore-guide-done', false));
  const inputRef = useRef<HTMLInputElement>(null);

  const set = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) v == null || v === '' ? next.delete(k) : next.set(k, v);
      setParams(next);
    },
    [params, setParams],
  );

  useEffect(() => setDraft(q), [q]);
  useEffect(() => setLimit(24), [q, source, type, sort, duration, uploaded, channelUrl, tab]);
  useEffect(() => {
    api
      .exploreCategories()
      .then((c) => {
        if (c.youtube?.length) setCats(c.youtube);
        if (c.twitch?.length) setTwitchFeatured(c.twitch);
      })
      .catch(() => {});
  }, []);
  // "/" jumps to search, like YouTube
  useKey(
    '/',
    (e) => {
      e.preventDefault();
      inputRef.current?.focus();
    },
    { enabled: !peek },
  );

  // ---------------- data ----------------
  useEffect(() => {
    let cancelled = false;
    setErr(null);
    const first = limit === 24;
    if (first) setLoading(true);
    else setMoreLoading(true);
    const done = () => {
      if (!cancelled) {
        setLoading(false);
        setMoreLoading(false);
      }
    };
    const fail = (e: Error) => !cancelled && setErr(e.message);
    if (mode === 'channel' && channelUrl) {
      if (first) setItems(null);
      api
        .exploreChannel(channelUrl, tab)
        .then((r) => {
          if (cancelled) return;
          setChannel(r.channel);
          setItems(r.items);
        })
        .catch(fail)
        .finally(done);
    } else if (mode === 'search') {
      setChannel(null);
      if (first) setItems(null);
      api
        .exploreSearch({ q, source, type, sort, duration, uploaded, limit: String(limit) })
        .then((r) => {
          if (cancelled) return;
          setItems(r.items);
          setTwitchApi(r.twitchApi);
        })
        .catch(fail)
        .finally(done);
    } else {
      setChannel(null);
      setItems(null);
      setSections(null);
      api
        .exploreDiscover(source, source === 'twitch' ? 'all' : cat)
        .then((r) => !cancelled && setSections(r.sections))
        .catch(fail)
        .finally(done);
    }
    return () => {
      cancelled = true;
    };
  }, [mode, q, source, type, sort, duration, uploaded, channelUrl, tab, cat, limit, reload]);

  // ---------------- actions ----------------
  const openPeek = (list: ExploreItem[], index: number) => {
    const it = list[index];
    const clean = list.filter((x) => x.kind !== 'channel');
    const i = clean.indexOf(it);
    setPeek(i >= 0 ? { list: clean, index: i } : { list: [it], index: 0 });
  };
  const search = (text: string) => {
    const t = text.trim();
    if (!t) return;
    setFocused(false);
    inputRef.current?.blur();
    const link = parseLink(t);
    if (link?.kind === 'channel') return set({ channel: link.url, tab: null, q: null, source: /twitch/.test(link.url) ? 'twitch' : 'youtube' });
    if (link) return openPeek([{ kind: link.kind, source: link.source, id: link.id, url: link.url, title: 'Loading video…' }], 0);
    pushRecentSearch(t);
    setRecentSearches(readLocal('crestclip:recent-searches', []));
    set({ q: t, channel: null, tab: null, cat: null });
  };
  const rememberPeek = useCallback((it: ExploreItem) => {
    if (it.title === 'Loading video…') return;
    const next = [it, ...readLocal<ExploreItem[]>('crestclip:recent-peeks', []).filter((x) => x.url !== it.url)].slice(0, 12);
    writeLocal('crestclip:recent-peeks', next);
    setRecentPeeks(next);
  }, []);
  const quickClip = async (it: ExploreItem) => {
    setClipping(it.url);
    try {
      const p = await api.createFromUrl(it.url, savedOptions());
      track('create_clips', { source: 'explore', videos: 1 });
      toast('Clipping started — CrestClip is finding the peaks');
      nav(`/app/p/${p.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
      setClipping(null);
    }
  };
  const openChannel = (url: string | null | undefined) => url && set({ channel: url, tab: null, q: null, source: /twitch/.test(url) ? 'twitch' : 'youtube' });

  const activeFilters = useMemo(
    () =>
      source === 'youtube' && mode === 'search' ? (['sort', 'duration', 'uploaded'] as const).map((k) => ({ k, v: { sort, duration, uploaded }[k] })).filter((f) => Boolean(LABELS[f.k][f.v])) : [],
    [source, mode, sort, duration, uploaded],
  );
  const vertical = (mode === 'search' && (type === 'shorts' || (source === 'twitch' && type === 'clips'))) || (mode === 'channel' && (tab === 'shorts' || tab === 'clips'));
  const suggestions = recentSearches.filter((s) => !draft || s.toLowerCase().includes(draft.toLowerCase())).slice(0, 6);
  const gridCols = vertical
    ? 'grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(170px,1fr))]'
    : items?.every((i) => i.kind === 'channel')
      ? 'grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]'
      : 'grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(250px,1fr))]';

  const renderCard = (it: ExploreItem, i: number, list: ExploreItem[]) =>
    it.kind === 'channel' ? (
      <ChannelCard key={it.url + i} item={it} onOpen={() => openChannel(it.url)} onLive={() => openPeek([it], 0)} />
    ) : (
      <VideoCard key={it.url + i} item={it} index={i} onOpen={() => openPeek(list, i)} onChannel={() => openChannel(it.channelUrl)} onQuickClip={() => quickClip(it)} busy={clipping === it.url} />
    );

  return (
    <>
      <PageHeader
        title="Explore"
        description="Find a video worth clipping — preview where viewers rewatch, then clip it in one click."
        actions={
          <Segmented
            label="Source"
            value={source}
            onChange={(v) => set({ source: v, type: null, channel: null, tab: null, q: null, cat: null, sort: null, duration: null, uploaded: null })}
            options={[
              {
                value: 'youtube',
                label: (
                  <>
                    <Youtube size={17} className={source === 'youtube' ? 'text-[#c4302b]' : ''} /> YouTube
                  </>
                ),
              },
              {
                value: 'twitch',
                label: (
                  <>
                    <Twitch size={17} className={source === 'twitch' ? 'text-[#7a4ce0]' : ''} /> Twitch
                  </>
                ),
              },
            ]}
          />
        }
      />

      <Card className="relative p-4 sm:p-5">
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            search(draft);
          }}
          className={cn(
            'relative flex flex-wrap items-center gap-3 rounded-[26px] bg-sunken py-2 pr-2 pl-5 shadow-well transition-shadow sm:flex-nowrap sm:rounded-full',
            focused && 'shadow-[var(--shadow-well),0_0_0_3px_rgba(255,138,91,.35)]',
          )}
        >
          <Search size={21} className="shrink-0 text-ink-3" />
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 150)}
            aria-label="Search videos or paste a link"
            placeholder={
              source === 'youtube'
                ? 'Search YouTube — or paste a video / channel link'
                : twitchApi
                  ? 'Search Twitch channels — or paste a link'
                  : 'Twitch channel name (e.g. shroud) — or paste a twitch.tv link'
            }
            className="min-w-0 flex-1 basis-[calc(100%-40px)] bg-transparent py-3 text-[17px] font-semibold text-ink outline-none placeholder:text-ink-3 sm:basis-auto"
          />
          {draft && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                setDraft('');
                inputRef.current?.focus();
              }}
              aria-label="Clear search"
            >
              <X size={16} />
            </Button>
          )}
          <kbd className="hidden rounded-lg bg-row px-2 py-0.5 font-mono text-xs font-extrabold text-ink-3 shadow-flat sm:inline" title="Press / to search">
            /
          </kbd>
          <Button type="submit" variant="primary" className="w-full sm:w-auto">
            Search
          </Button>
          {focused && suggestions.length > 0 && (
            <div
              role="listbox"
              aria-label="Recent searches"
              className="absolute top-[calc(100%+8px)] right-3 left-3 z-[25] flex animate-pop-in flex-col gap-0.5 rounded-[22px] bg-surface p-2.5 shadow-float"
            >
              <span className="flex items-center gap-1.5 px-2.5 pt-1 pb-1.5 text-xs font-extrabold tracking-wider text-ink-3 uppercase">
                <History size={14} /> Recent searches
              </span>
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left font-bold text-ink-2 hover:bg-row hover:text-ink"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setDraft(s);
                    search(s);
                  }}
                >
                  <Search size={14} /> {s}
                </button>
              ))}
            </div>
          )}
        </form>

        {showGuide && mode === 'discover' && (
          <div className="mt-4 grid animate-pop-in items-center gap-3.5 rounded-[22px] bg-row p-3.5 shadow-flat lg:grid-cols-[repeat(3,1fr)_auto]">
            {[
              { n: 1, t: 'Pick a video', d: 'Browse the feed or search — long podcasts and streams work best', c: 'clay-sky' },
              { n: 2, t: 'Preview the peaks', d: 'See where viewers rewatch before you spend AI credits', c: 'clay-butter' },
              { n: 3, t: 'Clip it', d: 'Get vertical clips with captions, a hook and a score', c: 'clay-mint' },
            ].map((s) => (
              <div key={s.n} className="flex items-start gap-3">
                <span className={cn('grid size-8.5 shrink-0 place-items-center rounded-[13px] font-display font-bold text-[#2b2140]', s.c)}>{s.n}</span>
                <div>
                  <b className="font-display text-[15px]">{s.t}</b>
                  <p className="text-[13px] leading-snug text-ink-3">{s.d}</p>
                </div>
              </div>
            ))}
            <Button
              size="sm"
              onClick={() => {
                writeLocal('crestclip:explore-guide-done', true);
                setShowGuide(false);
              }}
            >
              Got it
            </Button>
          </div>
        )}
      </Card>

      {/* categories / filters */}
      {mode !== 'channel' && (
        <div className="sticky top-14 z-[15] -mx-4 mt-3 bg-[linear-gradient(var(--page)_80%,transparent)] px-4 py-2.5 lg:top-0">
          {mode === 'discover' ? (
            <div role="tablist" aria-label={source === 'youtube' ? 'Categories' : 'Popular channels'} className="flex snap-x gap-2.5 overflow-x-auto px-1 pt-1.5 pb-2.5 scrollbar-none">
              {source === 'youtube'
                ? cats.map((c) => (
                    <Chip key={c.id} role="tab" aria-selected={cat === c.id} pressed={cat === c.id} onClick={() => set({ cat: c.id === 'all' ? null : c.id })}>
                      {c.id === 'all' && <Sparkles size={13} />}
                      {c.label}
                    </Chip>
                  ))
                : twitchFeatured.map((c) => (
                    <Chip key={c} onClick={() => openChannel(`https://www.twitch.tv/${c}`)}>
                      <Twitch size={13} /> {c}
                    </Chip>
                  ))}
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 py-1.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <Button size="sm" onClick={() => set({ q: null, type: null, sort: null, duration: null, uploaded: null })} title="Back to the feed">
                  <ChevronLeft size={16} /> Feed
                </Button>
                <Segmented label="Result type" size="sm" value={type} onChange={(v) => set({ type: v })} options={source === 'youtube' ? YT_TYPES : TW_TYPES} />
              </div>
              {source === 'youtube' && type !== 'channels' && (
                <div className="flex flex-wrap gap-2">
                  <Select
                    className="w-auto rounded-full py-2 text-sm font-bold"
                    value={sort}
                    onChange={(e) => set({ sort: e.target.value === 'relevance' ? null : e.target.value })}
                    aria-label="Sort by"
                  >
                    <option value="relevance">Most relevant</option>
                    <option value="views">Most viewed</option>
                    <option value="date">Newest</option>
                  </Select>
                  {type === 'videos' && (
                    <Select
                      className="w-auto rounded-full py-2 text-sm font-bold"
                      value={duration}
                      onChange={(e) => set({ duration: e.target.value === 'any' ? null : e.target.value })}
                      aria-label="Length"
                    >
                      <option value="any">Any length</option>
                      <option value="short">Under 4 min</option>
                      <option value="medium">4–20 min</option>
                      <option value="long">Over 20 min (best for clipping)</option>
                    </Select>
                  )}
                  {type !== 'live' && (
                    <Select
                      className="w-auto rounded-full py-2 text-sm font-bold"
                      value={uploaded}
                      onChange={(e) => set({ uploaded: e.target.value === 'any' ? null : e.target.value })}
                      aria-label="Upload date"
                    >
                      <option value="any">Any time</option>
                      <option value="today">Today</option>
                      <option value="week">This week</option>
                      <option value="month">This month</option>
                      <option value="year">This year</option>
                    </Select>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* channel header */}
      {mode === 'channel' && channelUrl && (
        <Card className="mt-6 animate-pop-in overflow-hidden">
          {channel?.banner && <div className="h-28 bg-cover bg-center" style={{ backgroundImage: `url(${channel.banner})` }} />}
          <div className="flex flex-wrap items-center gap-4 p-5">
            <Button size="icon" onClick={() => set({ channel: null, tab: null })} aria-label="Back">
              <ChevronLeft size={20} />
            </Button>
            <span className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-full bg-row text-ink-2 shadow-flat">
              {channel?.avatar ? <img src={channel.avatar} alt="" className="size-full object-cover" /> : /twitch/.test(channelUrl) ? <Twitch size={26} /> : <Youtube size={26} />}
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-2xl">{channel?.title ?? 'Loading channel…'}</h2>
              <p className="text-sm text-ink-3">
                {channel?.subscribers != null ? `${fmtCount(channel.subscribers)} subscribers · ` : ''}
                <a href={channel?.url ?? channelUrl} target="_blank" rel="noreferrer" className="text-ink-2">
                  {(channel?.url ?? channelUrl).replace(/^https?:\/\/(www\.)?/, '')}
                </a>
              </p>
            </div>
            <Segmented
              label="Channel tab"
              size="sm"
              value={tab}
              onChange={(v) => set({ tab: v })}
              options={
                /twitch\.tv/.test(channelUrl)
                  ? [
                      { value: 'vods', label: 'Past streams' },
                      { value: 'clips', label: 'Clips' },
                    ]
                  : [
                      { value: 'videos', label: 'Videos' },
                      { value: 'shorts', label: 'Shorts' },
                      { value: 'streams', label: 'Live & past streams' },
                    ]
              }
            />
          </div>
        </Card>
      )}

      {err && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3.5 rounded-[22px] bg-bad-bg p-5">
          <div>
            <b className="text-bad-ink">{mode === 'discover' ? 'Couldn’t load the feed' : 'Search didn’t work'}</b>
            <p className="font-semibold text-bad-ink">{err}</p>
          </div>
          <Button onClick={() => setReload((r) => r + 1)}>
            <RefreshCw size={16} /> Try again
          </Button>
        </div>
      )}

      {/* discover feed */}
      {mode === 'discover' && !err && (
        <div className="mt-3 flex flex-col gap-8">
          {recentPeeks.some((x) => x.source === source) && (
            <FeedSection
              title="Pick up where you left off"
              subtitle="Videos you previewed recently"
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    writeLocal('crestclip:recent-peeks', []);
                    setRecentPeeks([]);
                  }}
                >
                  Clear
                </Button>
              }
            >
              <Rail>{recentPeeks.filter((x) => x.source === source).map((it, i, list) => renderCard(it, i, list))}</Rail>
            </FeedSection>
          )}
          {loading &&
            [0, 1, 2].map((s) => (
              <FeedSection key={s} title="" subtitle="" loading>
                <Rail vertical={s === 2}>
                  {Array.from({ length: s === 2 ? 7 : 5 }).map((_, i) => (
                    <SkeletonCard key={i} vertical={s === 2} />
                  ))}
                </Rail>
              </FeedSection>
            ))}
          {sections?.map((sec) => {
            const vert = sec.items.every((x) => x.kind === 'short' || x.kind === 'clip');
            const see = sec.see;
            return (
              <FeedSection
                key={sec.id}
                title={sec.title}
                subtitle={sec.subtitle}
                action={
                  see && (
                    <Button
                      size="sm"
                      onClick={() =>
                        set({
                          q: see.q,
                          type: see.type === 'videos' ? null : see.type,
                          duration: see.duration === 'any' ? null : see.duration,
                          sort: see.sort === 'relevance' ? null : see.sort,
                          uploaded: see.uploaded === 'any' ? null : see.uploaded,
                          cat: null,
                        })
                      }
                    >
                      See all <ArrowRight size={15} />
                    </Button>
                  )
                }
              >
                <Rail vertical={vert}>{sec.items.map((it, i) => renderCard(it, i, sec.items))}</Rail>
              </FeedSection>
            );
          })}
          {sections && sections.length === 0 && !loading && (
            <EmptyState icon={<Search size={28} />} title="The feed is empty right now">
              YouTube didn’t return anything. Try a search above, or reload.
            </EmptyState>
          )}
          {source === 'youtube' && sections && sections.length > 0 && (
            <p className="flex flex-wrap items-center justify-center gap-2 text-center text-[13px] text-ink-3">
              <Badge tone="warn">
                <Flame size={12} /> Replay data
              </Badge>
              = YouTube likely shows where viewers rewatch → better clips
            </p>
          )}
        </div>
      )}

      {/* search / channel results */}
      {mode !== 'discover' && loading && (
        <div className={cn('mt-6 grid gap-4', gridCols)} aria-busy="true">
          {Array.from({ length: vertical ? 12 : 8 }).map((_, i) => (
            <SkeletonCard key={i} vertical={vertical} />
          ))}
        </div>
      )}
      {mode !== 'discover' && items && !loading && (
        <>
          {items.length > 0 && (
            <div className="mx-1 mt-5 mb-3.5 flex flex-wrap items-center gap-2">
              <span className="font-bold text-ink-3">
                {items.length} {mode === 'channel' ? 'videos' : `results for “${q}”`}
              </span>
              {activeFilters.map((f) => (
                <Chip key={f.k} pressed onClick={() => set({ [f.k]: null })} title="Remove this filter">
                  {LABELS[f.k][f.v]} <X size={12} />
                </Chip>
              ))}
              {activeFilters.length > 1 && (
                <Button variant="ghost" size="sm" onClick={() => set({ sort: null, duration: null, uploaded: null })}>
                  Clear all
                </Button>
              )}
            </div>
          )}
          {items.length === 0 ? (
            <EmptyState
              icon={<Search size={28} />}
              title="Nothing found"
              action={
                <>
                  {activeFilters.length > 0 && <Chip onClick={() => set({ sort: null, duration: null, uploaded: null })}>Remove filters</Chip>}
                  {type !== 'videos' && source === 'youtube' && mode === 'search' && <Chip onClick={() => set({ type: null })}>Search videos instead</Chip>}
                  {source === 'twitch' && type === 'channels' && <Chip onClick={() => set({ type: 'vods' })}>Look for past streams of “{q}”</Chip>}
                  <Chip onClick={() => set({ q: null, type: null, channel: null, tab: null })}>Back to the feed</Chip>
                </>
              }
            >
              Try fewer words, or loosen things up.
            </EmptyState>
          ) : (
            <div className={cn('grid gap-4', gridCols)}>{items.map((it, i) => renderCard(it, i, items))}</div>
          )}
          {items.length >= limit && limit < 48 && (
            <div className="mt-6 flex justify-center">
              <Button onClick={() => setLimit(48)} loading={moreLoading}>
                {moreLoading ? 'Loading more…' : 'Show more results'}
              </Button>
            </div>
          )}
        </>
      )}

      {peek && (
        <PeekDrawer
          items={peek.list}
          index={peek.index}
          onIndex={(i) => setPeek((p) => (p ? { ...p, index: i } : p))}
          onClose={() => setPeek(null)}
          onSeen={rememberPeek}
          onChannel={(url) => {
            setPeek(null);
            openChannel(url);
          }}
        />
      )}
    </>
  );
}

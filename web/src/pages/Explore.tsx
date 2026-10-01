import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, ChevronLeft, Compass, History, RefreshCw, Search, Sparkles, Twitch, X, Youtube } from 'lucide-react';
import { api, DEFAULT_OPTIONS, fmtCount, type DiscoverSection, type ExploreChannel, type ExploreItem, type ExploreSource, type ProjectOptions } from '../lib/api';
import { PeekDrawer } from '../components/PeekDrawer';
import { Seg } from '../components/bits';
import { ChannelCard, ClipBadgeLegend, Rail, SkeletonCard, VideoCard } from '../components/ExploreCards';
import { pushRecentSearch, readLocal, writeLocal } from '../lib/local';
import { toast } from '../lib/toast';

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

type LinkHit = { kind: 'video' | 'short' | 'vod' | 'clip'; source: ExploreSource; id: string; url: string } | { kind: 'channel'; url: string };

/** Recognise a pasted video / channel link so it opens directly instead of being searched as text. */
function parseLink(text: string): LinkHit | null {
  const t = text.trim();
  let m = t.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|live\/|embed\/)|youtu\.be\/)([\w-]{11})/);
  if (m) return { kind: 'video', source: 'youtube', id: m[1], url: `https://www.youtube.com/watch?v=${m[1]}` };
  m = t.match(/youtube\.com\/shorts\/([\w-]{11})/);
  if (m) return { kind: 'short', source: 'youtube', id: m[1], url: `https://www.youtube.com/shorts/${m[1]}` };
  m = t.match(/twitch\.tv\/videos\/(\d+)/);
  if (m) return { kind: 'vod', source: 'twitch', id: m[1], url: `https://www.twitch.tv/videos/${m[1]}` };
  m = t.match(/(?:clips\.twitch\.tv\/|twitch\.tv\/\w+\/clip\/)([\w-]+)/);
  if (m) return { kind: 'clip', source: 'twitch', id: m[1], url: t.startsWith('http') ? t : `https://${t}` };
  if (/youtube\.com\/(@|channel\/|c\/|user\/)/i.test(t) || /twitch\.tv\/[a-z0-9_]+\/?$/i.test(t)) return { kind: 'channel', url: t.startsWith('http') ? t : `https://${t}` };
  return null;
}

const savedOptions = (): ProjectOptions => ({ ...DEFAULT_OPTIONS, ...readLocal<Partial<ProjectOptions>>('peakclip:opts', {}) });

export function Explore() {
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
  const [recentSearches, setRecentSearches] = useState<string[]>(() => readLocal('peakclip:recent-searches', []));
  const [recentPeeks, setRecentPeeks] = useState<ExploreItem[]>(() => readLocal('peakclip:recent-peeks', []));
  const [showGuide, setShowGuide] = useState(() => !readLocal('peakclip:explore-guide-done', false));
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key === '/' && !peek && !/input|textarea|select/i.test(el.tagName)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [peek]);

  // ---------------- data loading ----------------
  useEffect(() => {
    let cancelled = false;
    setErr(null);
    const done = () => {
      if (!cancelled) {
        setLoading(false);
        setMoreLoading(false);
      }
    };
    const first = limit === 24;
    if (first) setLoading(true);
    else setMoreLoading(true);
    if (mode === 'channel' && channelUrl) {
      if (first) setItems(null);
      api
        .exploreChannel(channelUrl, tab)
        .then((r) => {
          if (!cancelled) {
            setChannel(r.channel);
            setItems(r.items);
          }
        })
        .catch((e) => !cancelled && setErr(e.message))
        .finally(done);
    } else if (mode === 'search') {
      setChannel(null);
      if (first) setItems(null);
      api
        .exploreSearch({ q, source, type, sort, duration, uploaded, limit: String(limit) })
        .then((r) => {
          if (!cancelled) {
            setItems(r.items);
            setTwitchApi(r.twitchApi);
          }
        })
        .catch((e) => !cancelled && setErr(e.message))
        .finally(done);
    } else {
      setChannel(null);
      setItems(null);
      setSections(null);
      api
        .exploreDiscover(source, source === 'twitch' ? 'all' : cat)
        .then((r) => !cancelled && setSections(r.sections))
        .catch((e) => !cancelled && setErr(e.message))
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
    setRecentSearches(readLocal('peakclip:recent-searches', []));
    set({ q: t, channel: null, tab: null, cat: null });
  };

  const rememberPeek = useCallback((it: ExploreItem) => {
    if (it.title === 'Loading video…') return;
    const list = readLocal<ExploreItem[]>('peakclip:recent-peeks', []).filter((x) => x.url !== it.url);
    const next = [it, ...list].slice(0, 12);
    writeLocal('peakclip:recent-peeks', next);
    setRecentPeeks(next);
  }, []);

  const quickClip = async (it: ExploreItem) => {
    setClipping(it.url);
    try {
      const p = await api.createFromUrl(it.url, savedOptions());
      toast('Clipping started — PeakClip is finding the peaks');
      nav(`/app/p/${p.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
      setClipping(null);
    }
  };

  const openChannel = (url: string | null | undefined) => {
    if (url) set({ channel: url, tab: null, q: null, source: /twitch/.test(url) ? 'twitch' : 'youtube' });
  };
  const dismissGuide = () => {
    writeLocal('peakclip:explore-guide-done', true);
    setShowGuide(false);
  };

  const activeFilters = useMemo(
    () =>
      source === 'youtube' && mode === 'search'
        ? (['sort', 'duration', 'uploaded'] as const)
            .map((k) => ({ k, v: { sort, duration, uploaded }[k] }))
            .filter((f) => Boolean(LABELS[f.k][f.v]))
        : [],
    [source, mode, sort, duration, uploaded],
  );
  const vertical = (mode === 'search' && (type === 'shorts' || (source === 'twitch' && type === 'clips'))) || (mode === 'channel' && (tab === 'shorts' || tab === 'clips'));
  const suggestions = recentSearches.filter((s) => !draft || s.toLowerCase().includes(draft.toLowerCase())).slice(0, 6);

  const renderCard = (it: ExploreItem, i: number, list: ExploreItem[]) =>
    it.kind === 'channel' ? (
      <ChannelCard key={it.url + i} item={it} onOpen={() => openChannel(it.url)} onLive={() => openPeek([it], 0)} />
    ) : (
      <VideoCard
        key={it.url + i}
        item={it}
        index={i}
        onOpen={() => openPeek(list, i)}
        onChannel={() => openChannel(it.channelUrl)}
        onQuickClip={() => quickClip(it)}
        busy={clipping === it.url}
      />
    );

  return (
    <div className="page explore">
      {/* ---------------- header ---------------- */}
      <section className="explore-hero clay">
        <div className="blob tint-butter" style={{ width: 80, height: 80, right: -26, bottom: -30, animation: 'wobble 9s ease-in-out infinite' }} aria-hidden />
        <div className="row wrap" style={{ justifyContent: 'space-between', gap: 16 }}>
          <div>
            <h1 className="row" style={{ fontSize: 32, gap: 10 }}>
              <Compass size={28} color="var(--tangerine-d)" /> Explore
            </h1>
            <p className="muted">Find a video worth clipping — peek at where viewers rewatch, then clip it in one click.</p>
          </div>
          <div className="seg source-seg" role="group" aria-label="Source">
            <button type="button" aria-pressed={source === 'youtube'} onClick={() => set({ source: 'youtube', type: null, channel: null, tab: null, q: null, cat: null })}>
              <Youtube size={18} /> YouTube
            </button>
            <button
              type="button"
              aria-pressed={source === 'twitch'}
              onClick={() => set({ source: 'twitch', type: null, channel: null, tab: null, q: null, sort: null, duration: null, uploaded: null, cat: null })}
            >
              <Twitch size={18} /> Twitch
            </button>
          </div>
        </div>

        <form
          className={`explore-search well ${focused ? 'is-focused' : ''}`}
          onSubmit={(e) => {
            e.preventDefault();
            search(draft);
          }}
          role="search"
        >
          <Search size={22} className="faint" />
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
          />
          {draft && (
            <button
              type="button"
              className="btn btn-icon btn-sm clear-btn"
              onClick={() => {
                setDraft('');
                inputRef.current?.focus();
              }}
              aria-label="Clear search"
            >
              <X size={16} />
            </button>
          )}
          <kbd className="kbd" aria-hidden title="Press / to search">
            /
          </kbd>
          <button className="btn btn-primary" type="submit">
            Search
          </button>
          {focused && suggestions.length > 0 && (
            <div className="suggest clay pop-in" role="listbox" aria-label="Recent searches">
              <span className="suggest-head">
                <History size={14} /> Recent searches
              </span>
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="suggest-item"
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
          <div className="guide pop-in">
            {[
              { n: 1, t: 'Pick a video', d: 'Browse the feed or search — long podcasts & streams work best', tint: 'tint-sky' },
              { n: 2, t: 'Peek at the peaks', d: 'See where viewers rewatch before you spend a credit', tint: 'tint-butter' },
              { n: 3, t: 'Clip it', d: 'Get vertical clips with captions, a hook and a score', tint: 'tint-mint' },
            ].map((s) => (
              <div key={s.n} className="guide-step">
                <span className={`guide-n ${s.tint}`}>{s.n}</span>
                <div>
                  <b>{s.t}</b>
                  <p className="faint">{s.d}</p>
                </div>
              </div>
            ))}
            <button type="button" className="btn btn-sm" onClick={dismissGuide}>
              Got it
            </button>
          </div>
        )}
      </section>

      {/* ---------------- sticky toolbar ---------------- */}
      {mode !== 'channel' && (
        <div className="explore-toolbar">
          {mode === 'discover' ? (
            <div className="chip-row" role="tablist" aria-label={source === 'youtube' ? 'Categories' : 'Popular channels'}>
              {source === 'youtube'
                ? cats.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="tab"
                      className="chip"
                      aria-pressed={cat === c.id}
                      aria-selected={cat === c.id}
                      onClick={() => set({ cat: c.id === 'all' ? null : c.id })}
                    >
                      {c.id === 'all' && <Sparkles size={13} style={{ marginRight: 6, verticalAlign: -2 }} />}
                      {c.label}
                    </button>
                  ))
                : twitchFeatured.map((c) => (
                    <button key={c} type="button" className="chip" onClick={() => openChannel(`https://www.twitch.tv/${c}`)}>
                      <Twitch size={13} style={{ marginRight: 6, verticalAlign: -2 }} />
                      {c}
                    </button>
                  ))}
            </div>
          ) : (
            <div className="row wrap" style={{ gap: 12, justifyContent: 'space-between', width: '100%' }}>
              <div className="row wrap" style={{ gap: 10 }}>
                <button type="button" className="btn btn-sm" onClick={() => set({ q: null, type: null, sort: null, duration: null, uploaded: null })} title="Back to the feed">
                  <ChevronLeft size={16} /> Feed
                </button>
                <Seg label="Result type" value={type} onChange={(v) => set({ type: v })} options={source === 'youtube' ? YT_TYPES : TW_TYPES} />
              </div>
              {source === 'youtube' && type !== 'channels' && (
                <div className="row wrap" style={{ gap: 8 }}>
                  <select className="field pill-select" value={sort} onChange={(e) => set({ sort: e.target.value === 'relevance' ? null : e.target.value })} aria-label="Sort by">
                    <option value="relevance">Most relevant</option>
                    <option value="views">Most viewed</option>
                    <option value="date">Newest</option>
                  </select>
                  {type === 'videos' && (
                    <select className="field pill-select" value={duration} onChange={(e) => set({ duration: e.target.value === 'any' ? null : e.target.value })} aria-label="Length">
                      <option value="any">Any length</option>
                      <option value="short">Under 4 min</option>
                      <option value="medium">4–20 min</option>
                      <option value="long">Over 20 min (best for clipping)</option>
                    </select>
                  )}
                  {type !== 'live' && (
                    <select className="field pill-select" value={uploaded} onChange={(e) => set({ uploaded: e.target.value === 'any' ? null : e.target.value })} aria-label="Upload date">
                      <option value="any">Any time</option>
                      <option value="today">Today</option>
                      <option value="week">This week</option>
                      <option value="month">This month</option>
                      <option value="year">This year</option>
                    </select>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ---------------- channel header ---------------- */}
      {mode === 'channel' && channelUrl && (
        <section className="channel-head clay pop-in">
          {channel?.banner && <div className="channel-banner" style={{ backgroundImage: `url(${channel.banner})` }} />}
          <div className="row wrap" style={{ gap: 16, padding: 20 }}>
            <button className="btn btn-icon" onClick={() => set({ channel: null, tab: null })} aria-label="Back">
              <ChevronLeft size={20} />
            </button>
            <span className="avatar clay-sm">
              {channel?.avatar ? <img src={channel.avatar} alt="" /> : /twitch/.test(channelUrl) ? <Twitch size={26} /> : <Youtube size={26} />}
            </span>
            <div className="grow">
              <h2 style={{ fontSize: 26 }}>{channel?.title ?? 'Loading channel…'}</h2>
              <p className="faint" style={{ fontSize: 14 }}>
                {channel?.subscribers != null ? `${fmtCount(channel.subscribers)} subscribers · ` : ''}
                <a href={channel?.url ?? channelUrl} target="_blank" rel="noreferrer">
                  {(channel?.url ?? channelUrl).replace(/^https?:\/\/(www\.)?/, '')}
                </a>
              </p>
            </div>
            <Seg
              label="Channel tab"
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
        </section>
      )}

      {/* ---------------- errors ---------------- */}
      {err && (
        <div className="clay error-card row wrap" style={{ gap: 14, justifyContent: 'space-between' }}>
          <div>
            <b>{mode === 'discover' ? 'Couldn’t load the feed' : 'Search didn’t work'}</b>
            <p>{err}</p>
            <p className="faint" style={{ fontSize: 13, marginTop: 6, color: 'var(--ink-3)' }}>
              Usually fixed by updating the downloader: <code>brew upgrade yt-dlp</code>
            </p>
          </div>
          <button className="btn" onClick={() => setReload((r) => r + 1)}>
            <RefreshCw size={16} /> Try again
          </button>
        </div>
      )}

      {/* ---------------- discover feed ---------------- */}
      {mode === 'discover' && !err && (
        <div className="feed">
          {recentPeeks.some((x) => x.source === source) && (
            <FeedSection
              title="Pick up where you left off"
              subtitle="Videos you peeked at recently"
              action={
                <button
                  type="button"
                  className="linkish"
                  onClick={() => {
                    writeLocal('peakclip:recent-peeks', []);
                    setRecentPeeks([]);
                  }}
                >
                  Clear
                </button>
              }
            >
              <Rail>
                {recentPeeks
                  .filter((x) => x.source === source)
                  .map((it, i, list) => (
                    <div className={`rail-item ${it.kind === 'short' || it.kind === 'clip' ? 'is-vertical' : ''}`} key={it.url}>
                      {renderCard(it, i, list)}
                    </div>
                  ))}
              </Rail>
            </FeedSection>
          )}

          {loading &&
            [0, 1, 2].map((s) => (
              <FeedSection key={s} title="" subtitle="" loading>
                <Rail vertical={s === 2}>
                  {Array.from({ length: s === 2 ? 7 : 5 }).map((_, i) => (
                    <div className={`rail-item ${s === 2 ? 'is-vertical' : ''}`} key={i}>
                      <SkeletonCard vertical={s === 2} />
                    </div>
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
                  see ? (
                    <button
                      type="button"
                      className="btn btn-sm"
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
                    </button>
                  ) : null
                }
              >
                <Rail vertical={vert}>
                  {sec.items.map((it, i) => (
                    <div className={`rail-item ${vert ? 'is-vertical' : ''} ${it.kind === 'channel' ? 'is-channel' : ''}`} key={it.url + i}>
                      {renderCard(it, i, sec.items)}
                    </div>
                  ))}
                </Rail>
              </FeedSection>
            );
          })}
          {sections && sections.length === 0 && !loading && (
            <div className="clay empty">
              <div>
                <b>The feed is empty right now</b>
                <p className="muted">YouTube didn’t return anything. Try a search above, or reload.</p>
              </div>
            </div>
          )}
          {source === 'youtube' && sections && sections.length > 0 && (
            <p className="faint" style={{ fontSize: 13, textAlign: 'center', marginTop: 8 }}>
              <ClipBadgeLegend />
            </p>
          )}
        </div>
      )}

      {/* ---------------- search / channel results ---------------- */}
      {mode !== 'discover' && loading && (
        <div className={`result-grid ${vertical ? 'shorts' : ''}`} aria-busy="true" style={{ marginTop: 24 }}>
          {Array.from({ length: vertical ? 12 : 8 }).map((_, i) => (
            <SkeletonCard key={i} vertical={vertical} />
          ))}
        </div>
      )}

      {mode !== 'discover' && items && !loading && (
        <>
          {items.length > 0 && (
            <div className="results-head">
              <span className="faint" style={{ fontWeight: 700 }}>
                {items.length} {mode === 'channel' ? 'videos' : `results for “${q}”`}
              </span>
              {activeFilters.map((f) => (
                <button key={f.k} type="button" className="filter-chip" onClick={() => set({ [f.k]: null })} title="Remove this filter">
                  {LABELS[f.k][f.v]} <X size={12} />
                </button>
              ))}
              {activeFilters.length > 1 && (
                <button type="button" className="linkish" style={{ fontSize: 13 }} onClick={() => set({ sort: null, duration: null, uploaded: null })}>
                  Clear all
                </button>
              )}
            </div>
          )}

          {items.length === 0 ? (
            <div className="clay empty-results">
              <b style={{ fontFamily: 'var(--font-display)', fontSize: 20 }}>Nothing found</b>
              <p className="muted">Try fewer words, or loosen things up:</p>
              <div className="row wrap" style={{ gap: 8, justifyContent: 'center', marginTop: 10 }}>
                {activeFilters.length > 0 && (
                  <button className="chip" onClick={() => set({ sort: null, duration: null, uploaded: null })}>
                    Remove filters
                  </button>
                )}
                {type !== 'videos' && source === 'youtube' && mode === 'search' && (
                  <button className="chip" onClick={() => set({ type: null })}>
                    Search videos instead
                  </button>
                )}
                {source === 'twitch' && type === 'channels' && (
                  <button className="chip" onClick={() => set({ type: 'vods' })}>
                    Look for past streams of “{q}”
                  </button>
                )}
                <button className="chip" onClick={() => set({ q: null, type: null, channel: null, tab: null })}>
                  Back to the feed
                </button>
              </div>
            </div>
          ) : (
            <div className={`result-grid ${vertical ? 'shorts' : ''} ${items.every((i) => i.kind === 'channel') ? 'channels' : ''}`}>
              {items.map((it, i) => renderCard(it, i, items))}
            </div>
          )}

          {items.length >= limit && limit < 48 && (
            <div className="row" style={{ justifyContent: 'center', marginTop: 26 }}>
              <button className="btn" onClick={() => setLimit(48)} disabled={moreLoading}>
                {moreLoading ? <span className="spinner" /> : null} {moreLoading ? 'Loading more…' : 'Show more results'}
              </button>
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
    </div>
  );
}

function FeedSection({
  title,
  subtitle,
  action,
  children,
  loading,
}: {
  title: string;
  subtitle: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <section className="feed-section">
      <div className="feed-head">
        {loading ? (
          <div style={{ width: '40%' }}>
            <div className="skeleton" style={{ height: 20, width: '70%' }} />
            <div className="skeleton" style={{ height: 12, width: '90%', marginTop: 8 }} />
          </div>
        ) : (
          <div>
            <h2 className="feed-title">{title}</h2>
            <p className="faint" style={{ fontSize: 14 }}>
              {subtitle}
            </p>
          </div>
        )}
        {action}
      </div>
      {children}
    </section>
  );
}

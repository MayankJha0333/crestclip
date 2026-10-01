import { buildSignals } from '../../pipeline/signals.js';
import { ytdlpJson } from '../../pipeline/ytdlp.js';
import { ytWatchWeb, youtubeId } from '../../pipeline/ytweb.js';
import type { HeatPoint, Signals } from '../../types.js';
import { cached, cachedAt, cacheStats, refresh } from './explore.cache.js';
import type { ChannelQuery, SearchQuery } from './explore.schemas.js';
import type { ExploreItem } from './explore.types.js';
import { bestThumb, num, str, type Raw } from './providers/fields.js';
import { twitchApi, twitchChannel, twitchSearch } from './providers/twitch.js';
import { fastStats, youtubeChannel, youtubeSearch } from './providers/youtube.js';

/** Explore — find source videos to clip (YouTube + Twitch), with a disk-backed cache so it stays fast. */

export async function search(q: SearchQuery) {
  const items = await cached(`s:${JSON.stringify(q)}`, 10 * 60_000, async () => {
    if (q.source === 'twitch') {
      if (q.type === 'vods' || q.type === 'clips') {
        return (await twitchChannel({ id: q.q, tab: q.type, sort: q.sort === 'views' ? 'views' : 'time', range: 'month', limit: q.limit })).items;
      }
      return twitchSearch(q.q, q.limit);
    }
    return youtubeSearch(q);
  });
  return { items, twitchApi: twitchApi() };
}

export function channel(q: ChannelQuery) {
  const isTwitch = /twitch\.tv/i.test(q.url);
  return cached(`c:${JSON.stringify(q)}`, 10 * 60_000, () =>
    isTwitch
      ? twitchChannel({ id: q.url, tab: q.tab === 'clips' || q.tab === 'highlights' ? q.tab : 'vods', sort: q.sort, range: q.range, limit: q.limit })
      : youtubeChannel({ id: q.url, tab: q.tab ?? 'videos', limit: q.limit }),
  );
}

export const preview = (url: string) => cached(`p:${url}`, 30 * 60_000, () => peek(url));

export const meta = () => ({ twitchApi: twitchApi(), fastSearch: fastStats, ...cacheStats() });

// ---------------- peek ----------------
/** The "Most replayed" curve and its top 5 hotspots, when the video has a rewatch graph. */
function rewatchCurve(duration: number, heatmap: HeatPoint[] | null, chapters: Signals['chapters']): { curve: number[] | null; hotspots: Signals['hotspots'] } {
  if (!heatmap || !duration) return { curve: null, hotspots: [] };
  const sig = buildSignals({ duration, heatmap, chapters, comments: [], rmsPerSecond: null, useAudience: true });
  return { curve: sig.curve, hotspots: sig.hotspots.slice(0, 5) };
}

/** Details + "Most replayed" curve for one video link. */
async function peek(url: string) {
  // Fast path for YouTube: read the watch page directly (~1 s instead of 15–30 s with yt-dlp)
  const ytId = youtubeId(url);
  if (ytId) {
    try {
      const v = await ytWatchWeb(ytId);
      return {
        title: v.title,
        channel: v.channel,
        channelUrl: v.channelUrl,
        duration: v.duration,
        views: v.views,
        likes: v.likes,
        uploadDate: v.uploadDate,
        thumbnail: v.thumbnail,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        isYouTube: true,
        isLive: v.isLive,
        description: v.description,
        chapters: v.chapters,
        ...rewatchCurve(v.duration, v.heatmap, v.chapters),
      };
    } catch (e) {
      console.warn('[explore] fast YouTube preview failed, using yt-dlp:', (e as Error).message);
    }
  }
  const j = await ytdlpJson<Raw>(['--skip-download', '--no-playlist', url], 90_000);
  const duration = num(j.duration) ?? 0;
  const heatmap = Array.isArray(j.heatmap) && j.heatmap.length ? (j.heatmap as HeatPoint[]) : null;
  const chapters = Array.isArray(j.chapters)
    ? (j.chapters as Raw[]).map((c) => ({ start_time: num(c.start_time) ?? 0, end_time: num(c.end_time) ?? 0, title: str(c.title) ?? '' }))
    : [];
  const extractor = String(j.extractor_key ?? j.extractor ?? '');
  return {
    title: str(j.title) ?? 'Untitled',
    channel: str(j.channel) ?? str(j.uploader) ?? '',
    channelUrl: str(j.channel_url) ?? str(j.uploader_url),
    duration,
    views: num(j.view_count),
    likes: num(j.like_count),
    uploadDate: str(j.upload_date),
    thumbnail: bestThumb(j),
    url: str(j.webpage_url) ?? url,
    isYouTube: /youtube/i.test(extractor),
    isLive: j.is_live === true || j.live_status === 'is_live',
    description: (str(j.description) ?? '').slice(0, 1200),
    chapters,
    ...rewatchCurve(duration, heatmap, chapters),
  };
}

// ---------------- Discover feed (sample content so Explore is never empty) ----------------
interface SectionDef {
  id: string;
  title: string;
  subtitle: string;
  q: string;
  type: 'videos' | 'shorts';
  duration?: 'any' | 'short' | 'medium' | 'long';
  sort?: 'relevance' | 'views' | 'date';
  uploaded?: 'any' | 'today' | 'week' | 'month' | 'year';
}

const topic = (id: string, label: string, q: string): SectionDef[] => [
  { id: `${id}-popular`, title: `Popular ${label}`, subtitle: 'Long, well-watched videos — the most moments to clip', q, type: 'videos', duration: 'long', sort: 'views', uploaded: 'year' },
  { id: `${id}-fresh`, title: `Fresh this week`, subtitle: 'New uploads getting views right now — clip them while they trend', q, type: 'videos', duration: 'any', sort: 'views', uploaded: 'week' },
  { id: `${id}-shorts`, title: `${label[0].toUpperCase()}${label.slice(1)} Shorts that work`, subtitle: 'Study the hooks and captions of clips that already went viral', q: `${q} clips`, type: 'shorts', sort: 'relevance' },
];

const DISCOVER: Record<string, { label: string; sections: SectionDef[] }> = {
  all: {
    label: 'For you',
    sections: [
      { id: 'pods', title: 'Podcasts people keep replaying', subtitle: 'Full episodes over 20 min — the best raw material for clips', q: 'podcast', type: 'videos', duration: 'long', sort: 'views', uploaded: 'month' },
      { id: 'interviews', title: 'Interviews blowing up this week', subtitle: 'Fresh and popular — clip them while the topic is hot', q: 'interview', type: 'videos', duration: 'long', sort: 'views', uploaded: 'week' },
      { id: 'shorts', title: 'What winning clips look like', subtitle: 'Top Shorts cut from long videos — the kind CrestClip makes for you', q: 'podcast clips', type: 'shorts', sort: 'relevance' },
      { id: 'talks', title: 'Talks with big moments', subtitle: 'Keynotes and speeches with quotable lines', q: 'best speech keynote', type: 'videos', duration: 'medium', sort: 'views', uploaded: 'year' },
    ],
  },
  podcasts: { label: 'Podcasts', sections: topic('podcasts', 'podcasts', 'podcast') },
  interviews: { label: 'Interviews', sections: topic('interviews', 'interviews', 'celebrity interview') },
  comedy: { label: 'Comedy', sections: topic('comedy', 'comedy', 'stand up comedy') },
  business: { label: 'Business', sections: topic('business', 'business', 'startup founder interview') },
  tech: { label: 'Tech & AI', sections: topic('tech', 'tech', 'AI tech podcast') },
  gaming: { label: 'Gaming', sections: topic('gaming', 'gaming', 'gaming highlights') },
  sports: { label: 'Sports', sections: topic('sports', 'sports', 'sports podcast') },
  motivation: { label: 'Motivation', sections: topic('motivation', 'motivation', 'motivational speech') },
  education: { label: 'Learning', sections: topic('education', 'learning', 'lecture explained') },
};

const TWITCH_FEATURED = ['kaicenat', 'xqc', 'shroud', 'pokimane', 'hasanabi', 'tarik', 'summit1g', 'caseoh_'];

async function discover(source: 'youtube' | 'twitch', category: string) {
  if (source === 'twitch') {
    const pick = TWITCH_FEATURED.slice(0, 4);
    const lists = await Promise.allSettled(
      pick.map((c) => twitchChannel({ id: c, tab: 'clips', sort: 'views', range: 'week', limit: 6 }).then((r) => r.items)),
    );
    const clips = lists
      .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
      .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
      .slice(0, 12);
    const vods = await Promise.allSettled(
      pick.slice(0, 3).map((c) => twitchChannel({ id: c, tab: 'vods', sort: 'time', range: 'week', limit: 3 }).then((r) => r.items)),
    );
    const streams = vods.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).slice(0, 8);
    const channels: ExploreItem[] = TWITCH_FEATURED.map((c) => ({
      kind: 'channel', source: 'twitch', id: c, url: `https://www.twitch.tv/${c}`, title: c, channel: c, channelId: c, channelUrl: `https://www.twitch.tv/${c}`,
      thumbnail: null, duration: null, views: null, subscribers: null, uploaded: null, isLive: false, description: 'Past streams & clips',
    }));
    return {
      sections: [
        { id: 'tw-clips', title: 'Top Twitch clips this week', subtitle: 'The moments chat went crazy for — short, proven, re-cuttable', items: clips, see: null },
        { id: 'tw-vods', title: 'Recent full streams', subtitle: 'Hours of footage — CrestClip finds the highlights for you', items: streams, see: null },
        { id: 'tw-channels', title: 'Popular channels', subtitle: 'Open one to browse its past streams and clips', items: channels, see: null },
      ].filter((s) => s.items.length),
    };
  }
  const def = DISCOVER[category] ?? DISCOVER.all;
  const results = await Promise.allSettled(
    def.sections.map((s) =>
      youtubeSearch({ q: s.q, type: s.type, duration: s.duration ?? 'any', sort: s.sort ?? 'relevance', uploaded: s.uploaded ?? 'any', limit: s.type === 'shorts' ? 12 : 8 }),
    ),
  );
  return {
    sections: def.sections
      .map((s, i) => ({
        id: s.id,
        title: s.title,
        subtitle: s.subtitle,
        // live streams can't be clipped yet — keep the feed to things you can act on
        items: results[i].status === 'fulfilled' ? (results[i] as PromiseFulfilledResult<ExploreItem[]>).value.filter((x) => !x.isLive && x.kind !== 'live') : [],
        see: { q: s.q, type: s.type, duration: s.duration ?? 'any', sort: s.sort ?? 'relevance', uploaded: s.uploaded ?? 'any' },
      }))
      .filter((s) => s.items.length),
  };
}

/** Don't cache a total failure (a feed with no sections). */
const hasSections = (d: { sections: unknown[] }) => d.sections.length > 0;

export function categories() {
  return {
    youtube: Object.entries(DISCOVER).map(([id, c]) => ({ id, label: c.label })),
    twitch: TWITCH_FEATURED,
  };
}

/** The Discover feed for a source + category (unknown categories show "For you"). */
export function discoverFeed(source: 'youtube' | 'twitch', category: unknown) {
  const cat = typeof category === 'string' && DISCOVER[category] ? category : 'all';
  return cached(`d:${source}:${cat}`, 30 * 60_000, () => discover(source, cat), hasSections);
}

/** Warm the default feeds in the background so the first visit to Explore is instant. */
export function warmExplore() {
  const warm = async () => {
    // "For you" first (the default view), then every category, one at a time so YouTube isn't hammered
    for (const cat of ['all', ...Object.keys(DISCOVER).filter((c) => c !== 'all')]) {
      const at = cachedAt(`d:youtube:${cat}`);
      if (at && Date.now() - at < 25 * 60_000) continue;
      await refresh(`d:youtube:${cat}`, () => discover('youtube', cat), hasSections).catch(() => {});
    }
    const tw = cachedAt('d:twitch:all');
    if (!tw || Date.now() - tw > 25 * 60_000) await refresh('d:twitch:all', () => discover('twitch', 'all'), hasSections).catch(() => {});
  };
  setTimeout(warm, 3000);
  setInterval(warm, 30 * 60_000).unref();
}

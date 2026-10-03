import { ytSearchWeb, ytWatchWeb, type WebVideo } from '../../pipeline/ytweb.js';
import { ytSearchParam } from '../explore/providers/youtube.js';

/**
 * Where Autopilot finds videos.
 *  • YouTube channel → the channel's public RSS feed (its 15 newest uploads; free, no API key, no quota)
 *  • YouTube topic   → a normal YouTube search, optionally for one country (e.g. "podcast clips" in India)
 */

export interface FoundVideo {
  videoId: string;
  url: string;
  title: string;
  channel: string | null;
  thumbnail: string | null;
  views: number | null;
  duration: number | null; // seconds, when known
  publishedAt: number | null; // epoch ms, when known
  isLive?: boolean;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const HEADERS = { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', cookie: 'SOCS=CAI; CONSENT=YES+1' };

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

/** "https://youtube.com/@mkbhd", "@mkbhd", "UC…", ".../channel/UC…", ".../c/Name" → the channel's id + name. */
export async function resolveChannel(input: string): Promise<{ channelId: string; label: string; url: string }> {
  const raw = input.trim();
  if (!raw) throw new Error('Paste a YouTube channel link or @handle.');
  const direct = raw.match(/(UC[\w-]{22})/)?.[1];
  let url: string;
  if (direct && /^UC[\w-]{22}$/.test(raw)) url = `https://www.youtube.com/channel/${direct}`;
  else if (/^@[\w.-]+$/.test(raw)) url = `https://www.youtube.com/${raw}`;
  else if (/youtube\.com|youtu\.be/.test(raw)) {
    url = raw.startsWith('http') ? raw : `https://${raw}`;
    // only real YouTube addresses (not any link that merely mentions youtube.com)
    let host = '';
    try {
      host = new URL(url).hostname.replace(/^(www|m)\./, '');
    } catch {
      /* not a link */
    }
    if (host !== 'youtube.com' && host !== 'youtu.be') throw new Error('Paste a YouTube channel link or @handle.');
  } else url = `https://www.youtube.com/@${raw.replace(/^@/, '')}`;
  if (/youtube\.com\/(watch|shorts)/.test(url)) throw new Error('That’s a video link — paste the channel’s link (it looks like youtube.com/@name).');

  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) throw new Error('YouTube says that channel doesn’t exist. Check the link or @handle.');
  if (!res.ok) throw new Error(`YouTube answered ${res.status}`);
  const html = await res.text();
  const channelId =
    html.match(/"externalId":"(UC[\w-]{22})"/)?.[1] ??
    html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1] ??
    html.match(/"channelId":"(UC[\w-]{22})"/)?.[1] ??
    direct;
  if (!channelId) throw new Error('Couldn’t find that channel on YouTube.');
  const label = decode(html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] ?? '') || decode(html.match(/"channelMetadataRenderer":\{"title":"([^"]+)"/)?.[1] ?? '') || raw;
  return { channelId, label, url: `https://www.youtube.com/channel/${channelId}` };
}

/** The channel's newest uploads from its RSS feed (no API key, no quota). */
export async function channelVideos(channelId: string): Promise<FoundVideo[]> {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { headers: HEADERS, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`YouTube feed answered ${res.status}`);
  const xml = await res.text();
  const author = decode(xml.match(/<author>\s*<name>([^<]+)<\/name>/)?.[1] ?? '') || null;
  const out: FoundVideo[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const videoId = e.match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/)?.[1];
    if (!videoId) continue;
    const link = e.match(/<link rel="alternate" href="([^"]+)"/)?.[1] ?? '';
    out.push({
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: decode(e.match(/<title>([^<]*)<\/title>/)?.[1] ?? ''),
      channel: author,
      thumbnail: e.match(/<media:thumbnail url="([^"]+)"/)?.[1] ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      views: Number(e.match(/<media:statistics views="(\d+)"/)?.[1] ?? NaN) || null,
      duration: /\/shorts\//.test(link) ? 30 : null, // the feed doesn't say; Shorts links give it away
      publishedAt: Date.parse(e.match(/<published>([^<]+)<\/published>/)?.[1] ?? '') || null,
    });
  }
  return out;
}

/**
 * Videos for a topic search within the age limit, optionally for one country.
 *  • views    — most viewed first (YouTube's own view sort)
 *  • date     — newest first
 *  • trending — fresh videos gaining views fastest (views per hour since upload), YouTube has no public trending
 */
export async function topicVideos(query: string, region: string | null, maxAgeDays: number, language?: string | null, sort: 'trending' | 'views' | 'date' = 'views'): Promise<FoundVideo[]> {
  const days = sort === 'trending' ? Math.min(maxAgeDays, 7) : maxAgeDays;
  const uploaded = days <= 1 ? 'today' : days <= 7 ? 'week' : days <= 31 ? 'month' : 'year';
  const sp = ytSearchParam({ type: 'videos', duration: '', sort: sort === 'trending' ? '' : sort, uploaded });
  // one chosen language → ask YouTube to lean results toward it
  const items = await ytSearchWeb(query, sp, 10_000, region, language || 'en');
  const list: FoundVideo[] = items
    .filter((i) => i.kind === 'video' && !i.isLive)
    .map((i) => ({
      videoId: i.id,
      url: i.url,
      title: i.title,
      channel: i.channel,
      thumbnail: i.thumbnail,
      views: i.views,
      duration: i.duration,
      publishedAt: i.uploaded ? Date.parse(i.uploaded) || null : null,
    }));
  if (sort !== 'trending') return list;
  const perHour = (v: FoundVideo) => (v.views ?? 0) / Math.max(1, (Date.now() - (v.publishedAt ?? Date.now() - 7 * 86400_000)) / 3600_000);
  return list.sort((a, b) => perHour(b) - perHour(a));
}

/** Fresh numbers right before clipping: length, views, live or not, and whether the rewatch graph exists yet. */
export async function videoDetails(videoId: string): Promise<WebVideo> {
  return ytWatchWeb(videoId, 12_000);
}

export function uploadDateMs(v: WebVideo): number | null {
  const d = v.uploadDate;
  if (!d || !/^\d{8}$/.test(d)) return null;
  return Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
}

// ---------------- suggestions while typing (editor) ----------------

/** Small in-memory cache so typing doesn't hit YouTube for every key press. */
const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) for (const k of [...cache.keys()].slice(0, 100)) cache.delete(k);
  return value;
}

export interface ChannelHit {
  channelId: string;
  name: string;
  handle: string | null;
  url: string;
  avatar: string | null;
  subscribers: number | null;
}

/** YouTube channels matching what's typed (name or @handle), with logo and subscriber count. */
export async function searchChannels(q: string): Promise<ChannelHit[]> {
  const query = q.trim().replace(/^@/, '');
  if (query.length < 2) return [];
  return cached(`ch|${query.toLowerCase()}`, 10 * 60_000, async () => {
    const items = await ytSearchWeb(query, ytSearchParam({ type: 'channels', duration: '', sort: '', uploaded: '' }), 8000);
    return items
      .filter((i) => i.kind === 'channel' && i.channelId)
      .slice(0, 8)
      .map((i) => ({
        channelId: i.channelId!,
        name: i.title,
        handle: i.url.match(/\/(@[\w.-]+)/)?.[1] ?? null,
        url: i.url,
        avatar: i.thumbnail,
        subscribers: i.subscribers,
      }));
  });
}

/** What people search on YouTube starting with these words (YouTube's own autocomplete). */
export async function suggestTopics(q: string, region: string | null): Promise<string[]> {
  const query = q.trim();
  if (query.length < 2) return [];
  return cached(`tp|${region ?? ''}|${query.toLowerCase()}`, 30 * 60_000, async () => {
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=en${region ? `&gl=${encodeURIComponent(region)}` : ''}&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`YouTube answered ${res.status}`);
    const data = (await res.json()) as [string, string[]];
    const list = Array.isArray(data?.[1]) ? data[1].map(String) : [];
    return [...new Set([query, ...list])].slice(0, 8);
  });
}

export interface TopicStats {
  videos: number; // long videos found for it in the time window
  medianViews: number | null;
  topViews: number | null;
}

/** How busy a topic is right now: how many fresh long videos, and how many views they typically get. */
export async function topicStats(q: string, region: string | null, maxAgeDays: number): Promise<TopicStats> {
  return cached(`ts|${region ?? ''}|${maxAgeDays}|${q.trim().toLowerCase()}`, 30 * 60_000, async () => {
    const found = (await topicVideos(q, region, maxAgeDays)).filter((v) => v.duration == null || v.duration > 180);
    const views = found
      .map((v) => v.views ?? 0)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
    return {
      videos: found.length,
      medianViews: views.length ? views[Math.floor(views.length / 2)] : null,
      topViews: views.length ? views[views.length - 1] : null,
    };
  });
}

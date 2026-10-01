import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from './config.js';
import fs from 'node:fs';
import path from 'node:path';
import { ytdlpJson } from './pipeline/ytdlp.js';
import { ytSearchWeb, ytWatchWeb, youtubeId } from './pipeline/ytweb.js';
import { buildSignals } from './pipeline/signals.js';
import type { HeatPoint, Signals } from './types.js';

/**
 * Explore — find source videos to clip.
 * YouTube: search videos / Shorts / channels with filters (no API key needed, uses yt-dlp's flat extraction).
 * Twitch: a channel's past broadcasts, highlights and top clips (yt-dlp), plus channel search when
 *         TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are set (official Helix API).
 */

export type ItemKind = 'video' | 'short' | 'channel' | 'vod' | 'clip' | 'live';
export interface ExploreItem {
  kind: ItemKind;
  source: 'youtube' | 'twitch';
  id: string;
  url: string;
  title: string;
  channel: string | null;
  channelId: string | null;
  channelUrl: string | null;
  thumbnail: string | null;
  duration: number | null;
  views: number | null;
  subscribers: number | null;
  uploaded: string | null; // ISO date when known
  isLive: boolean;
  description: string | null;
  game?: string | null;
}

export interface ExploreChannel {
  source: 'youtube' | 'twitch';
  title: string;
  url: string;
  subscribers: number | null;
  avatar: string | null;
  banner: string | null;
  description: string | null;
}

// ---------------- cache ----------------
/**
 * Stale-while-revalidate cache, saved to disk:
 *  • fresh hit → instant
 *  • stale hit → instant (old data), refreshed in the background for the next visit
 *  • survives server restarts (data/cache/explore.json), so Explore is never slow after a restart
 */
const cache = new Map<string, { at: number; data: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
// bump the file name when the item format changes
const cacheFile = path.join(config.dataDir, 'cache', 'explore-v2.json');
const MAX_STALE = 24 * 3600_000; // never show anything older than a day
try {
  const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as [string, { at: number; data: unknown }][];
  for (const [k, v] of saved) if (Date.now() - v.at < MAX_STALE) cache.set(k, v);
} catch {
  /* first run */
}
let saveTimer: NodeJS.Timeout | null = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      // keep the feeds + recent searches/peeks, newest last
      const entries = [...cache.entries()].filter(([, v]) => Date.now() - v.at < MAX_STALE).slice(-250);
      fs.writeFileSync(`${cacheFile}.tmp`, JSON.stringify(entries));
      fs.renameSync(`${cacheFile}.tmp`, cacheFile);
    } catch {
      /* best effort */
    }
  }, 1500);
  saveTimer.unref?.();
}
function refresh<T>(key: string, fn: () => Promise<T>, keep?: (d: T) => boolean): Promise<T> {
  const cur = inflight.get(key) as Promise<T> | undefined;
  if (cur) return cur;
  const p = fn()
    .then((data) => {
      if (!keep || keep(data)) {
        cache.delete(key);
        cache.set(key, { at: Date.now(), data });
        if (cache.size > 300) cache.delete(cache.keys().next().value as string);
        persist();
      }
      return data;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, keep?: (d: T) => boolean): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data as T;
  if (hit && Date.now() - hit.at < MAX_STALE) {
    refresh(key, fn, keep).catch(() => {}); // update quietly for next time
    return hit.data as T;
  }
  return refresh(key, fn, keep);
}

// ---------------- YouTube ----------------
/**
 * YouTube's search filter "sp" parameter is a small protobuf:
 *   1: sort (1 rating, 2 upload date, 3 view count)
 *   2: filters { 1: upload date (1 hour … 5 year), 2: type (1 video, 2 channel, 9 shorts), 3: duration (1 <4m, 2 >20m, 3 4–20m) }
 */
export function ytSearchParam(o: { type: string; duration: string; sort: string; uploaded: string }) {
  const f: number[] = [];
  const uploaded = { hour: 1, today: 2, week: 3, month: 4, year: 5 }[o.uploaded];
  const type = { videos: 1, live: 1, channels: 2, shorts: 9 }[o.type];
  const duration = o.type === 'videos' ? { short: 1, long: 2, medium: 3 }[o.duration] : undefined;
  if (uploaded && o.type !== 'channels') f.push(0x08, uploaded);
  if (type) f.push(0x10, type);
  if (duration) f.push(0x18, duration);
  if (o.type === 'live') f.push(0x40, 1); // feature: live now
  const top: number[] = [];
  const sort = { rating: 1, date: 2, views: 3 }[o.sort];
  if (sort && o.type !== 'channels') top.push(0x08, sort);
  if (f.length) top.push(0x12, f.length, ...f);
  return top.length ? Buffer.from(top).toString('base64') : '';
}

type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function bestThumb(e: Raw, fallback?: string | null): string | null {
  const thumbs = Array.isArray(e.thumbnails) ? (e.thumbnails as Raw[]) : [];
  const sorted = thumbs.filter((t) => str(t.url)).sort((a, b) => (num(b.width) ?? 0) - (num(a.width) ?? 0));
  let url = str(sorted[0]?.url) ?? str(e.thumbnail) ?? fallback ?? null;
  if (url?.startsWith('//')) url = 'https:' + url;
  return url;
}

function isoDate(e: Raw): string | null {
  const ts = num(e.timestamp) ?? num(e.release_timestamp);
  if (ts) return new Date(ts * 1000).toISOString();
  const d = str(e.upload_date);
  return d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
}

function ytItem(e: Raw, forceKind?: ItemKind): ExploreItem | null {
  const url = str(e.url) ?? str(e.webpage_url);
  const id = str(e.id);
  if (!url || !id) return null;
  const isChannel = e.ie_key === 'YoutubeTab' || /\/(channel|c|user)\/|\/@/.test(url);
  if (isChannel) {
    if (/[?&]list=/.test(url)) return null; // playlists — skip
    return {
      kind: 'channel',
      source: 'youtube',
      id,
      url,
      title: str(e.title) ?? str(e.channel) ?? 'Channel',
      channel: str(e.channel) ?? str(e.title),
      channelId: str(e.channel_id) ?? id,
      channelUrl: url,
      thumbnail: bestThumb(e),
      duration: null,
      views: null,
      subscribers: num(e.channel_follower_count),
      uploaded: null,
      isLive: false,
      description: str(e.description),
    };
  }
  const short = forceKind === 'short' || /\/shorts\//.test(url);
  const live = e.live_status === 'is_live';
  return {
    kind: live ? 'live' : short ? 'short' : 'video',
    source: 'youtube',
    id,
    url: url.startsWith('http') ? url : `https://www.youtube.com/watch?v=${id}`,
    title: str(e.title) ?? 'Untitled',
    channel: str(e.channel) ?? str(e.uploader),
    channelId: str(e.channel_id),
    channelUrl: str(e.channel_url) ?? str(e.uploader_url),
    // Prefer the (signed) thumbnail URLs YouTube returned with the result; built URLs are a fallback.
    thumbnail: bestThumb(e) ?? (short ? `https://i.ytimg.com/vi/${id}/oar2.jpg` : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`),
    duration: num(e.duration),
    views: num(e.view_count),
    subscribers: null,
    uploaded: isoDate(e),
    isLive: live,
    description: str(e.description),
  };
}

async function youtubeSearch(q: { q: string; type: string; duration: string; sort: string; uploaded: string; limit: number }): Promise<ExploreItem[]> {
  if (q.type === 'shorts') {
    // YouTube's own "Shorts" filter returns a layout yt-dlp can't always read — fall back to short videos tagged #shorts.
    const direct = await youtubeSearchRaw(q);
    if (direct.length) return direct;
    const loose = await youtubeSearchRaw({ ...q, q: `${q.q} #shorts`, type: 'videos', duration: 'short', limit: q.limit * 2 });
    return loose
      .filter((i) => i.kind === 'short' || (i.duration != null && i.duration <= 180))
      .slice(0, q.limit)
      .map((i) => ({ ...i, kind: 'short' as const, url: `https://www.youtube.com/shorts/${i.id}` }));
  }
  return youtubeSearchRaw(q);
}

const fastStats = { ok: 0, fail: 0, lastMs: 0, lastError: '' };

async function youtubeSearchRaw(q: { q: string; type: string; duration: string; sort: string; uploaded: string; limit: number }) {
  const sp = ytSearchParam(q);
  let items: ExploreItem[] | null = null;
  const t0 = Date.now();
  // Fast path: read YouTube's results page directly (~1 s). Slow path: yt-dlp (starts a program, several seconds).
  try {
    const web = await ytSearchWeb(q.q, sp);
    if (web.length) items = web.map((w) => ({ ...w, source: 'youtube' as const, kind: q.type === 'shorts' && w.kind === 'video' ? ('short' as const) : w.kind }));
    fastStats.ok++;
    fastStats.lastMs = Date.now() - t0;
  } catch (e) {
    fastStats.fail++;
    fastStats.lastError = (e as Error).message;
    console.warn('[explore] fast YouTube search failed, using yt-dlp:', (e as Error).message);
  }
  if (!items) {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q.q)}${sp ? `&sp=${encodeURIComponent(sp)}` : ''}`;
    const j = await ytdlpJson<Raw>(['--flat-playlist', '--playlist-end', String(q.limit), url], 90_000);
    const entries = (Array.isArray(j.entries) ? (j.entries as Raw[]) : []).map((e) => ytItem(e, q.type === 'shorts' ? 'short' : undefined));
    items = entries.filter((x): x is ExploreItem => Boolean(x));
  }
  if (q.type === 'channels') items = items.filter((i) => i.kind === 'channel');
  else if (q.type === 'shorts') items = items.filter((i) => i.kind === 'short');
  else if (q.type === 'live') items = items.filter((i) => i.kind !== 'channel').map((i) => ({ ...i, kind: 'live' as const, isLive: true }));
  else items = items.filter((i) => i.kind !== 'channel');
  return items.slice(0, q.limit);
}

function ytChannelBase(input: string) {
  const s = input.trim();
  if (/^https?:\/\//.test(s)) return s.replace(/\/(videos|shorts|streams|featured|live)\/?(\?.*)?$/, '').replace(/\/$/, '');
  if (s.startsWith('@')) return `https://www.youtube.com/${s}`;
  if (/^UC[\w-]{20,}$/.test(s)) return `https://www.youtube.com/channel/${s}`;
  return `https://www.youtube.com/@${s.replace(/\s+/g, '')}`;
}

async function youtubeChannel(p: { id: string; tab: string; limit: number }) {
  const base = ytChannelBase(p.id);
  const tab = { videos: 'videos', shorts: 'shorts', live: 'streams', streams: 'streams' }[p.tab] ?? 'videos';
  const j = await ytdlpJson<Raw>(['--flat-playlist', '--playlist-end', String(p.limit), `${base}/${tab}`], 90_000);
  const items = (Array.isArray(j.entries) ? (j.entries as Raw[]) : [])
    .map((e) => ytItem({ ...e, channel: e.channel ?? j.channel, channel_id: e.channel_id ?? j.channel_id, channel_url: e.channel_url ?? j.channel_url }, tab === 'shorts' ? 'short' : undefined))
    .filter((x): x is ExploreItem => Boolean(x) && x!.kind !== 'channel');
  const thumbs = Array.isArray(j.thumbnails) ? (j.thumbnails as Raw[]) : [];
  const avatar = thumbs.find((t) => String(t.id ?? '').includes('avatar')) ?? thumbs.find((t) => num(t.width) && num(t.width) === num(t.height));
  const banner = thumbs.find((t) => String(t.id ?? '').includes('banner'));
  return {
    channel: {
      source: 'youtube' as const,
      title: str(j.channel) ?? str(j.uploader) ?? str(j.title)?.replace(/ - (Videos|Shorts|Live)$/, '') ?? p.id,
      url: str(j.channel_url) ?? base,
      avatar: avatar ? str(avatar.url) : null,
      banner: banner ? str(banner.url) : null,
      subscribers: num(j.channel_follower_count),
      description: str(j.description),
    } as ExploreChannel,
    items,
  };
}

// ---------------- Twitch ----------------
function twitchLogin(input: string) {
  const s = input.trim();
  const m = s.match(/twitch\.tv\/([A-Za-z0-9_]{2,25})/);
  return (m ? m[1] : s.replace(/^@/, '')).toLowerCase();
}

function twItem(e: Raw, kind: 'vod' | 'clip', login: string): ExploreItem | null {
  const url = str(e.url) ?? str(e.webpage_url);
  const id = str(e.id);
  if (!url || !id) return null;
  return {
    kind,
    source: 'twitch',
    id,
    url,
    title: str(e.title) ?? (kind === 'clip' ? 'Twitch clip' : 'Twitch broadcast'),
    channel: str(e.uploader) ?? str(e.channel) ?? login,
    channelId: str(e.uploader_id) ?? login,
    channelUrl: `https://www.twitch.tv/${login}`,
    thumbnail: bestThumb(e),
    duration: num(e.duration),
    views: num(e.view_count),
    subscribers: null,
    uploaded: isoDate(e),
    isLive: false,
    description: null,
  };
}

async function twitchChannel(p: { id: string; tab: string; sort: string; range: string; limit: number }) {
  const login = twitchLogin(p.id);
  if (config.twitchClientId && config.twitchClientSecret) return twitchHelixChannel(login, p);
  let url: string;
  if (p.tab === 'clips') url = `https://www.twitch.tv/${login}/clips?filter=clips&range=${{ day: '24hr', week: '7d', month: '30d', all: 'all' }[p.range] ?? '7d'}`;
  else url = `https://www.twitch.tv/${login}/videos?filter=${p.tab === 'highlights' ? 'highlights' : 'archives'}&sort=${p.sort === 'views' ? 'views' : 'time'}`;
  const j = await ytdlpJson<Raw>(['--flat-playlist', '--playlist-end', String(p.limit), url], 90_000);
  const items = (Array.isArray(j.entries) ? (j.entries as Raw[]) : [])
    .map((e) => twItem(e, p.tab === 'clips' ? 'clip' : 'vod', login))
    .filter((x): x is ExploreItem => Boolean(x));
  return {
    channel: { source: 'twitch', title: login, url: `https://www.twitch.tv/${login}`, avatar: null, banner: null, subscribers: null, description: null } as ExploreChannel,
    items,
  };
}

// Optional official Twitch API (Helix) — enables channel search and richer data.
let helixToken: { token: string; exp: number } | null = null;
async function helix<T>(pathAndQuery: string): Promise<T> {
  if (!helixToken || Date.now() > helixToken.exp) {
    const r = await fetch(
      `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(config.twitchClientId)}&client_secret=${encodeURIComponent(config.twitchClientSecret)}&grant_type=client_credentials`,
      { method: 'POST' },
    );
    if (!r.ok) throw new Error(`Twitch login failed (${r.status}). Check TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET.`);
    const t = (await r.json()) as { access_token: string; expires_in: number };
    helixToken = { token: t.access_token, exp: Date.now() + (t.expires_in - 120) * 1000 };
  }
  const r = await fetch(`https://api.twitch.tv/helix/${pathAndQuery}`, {
    headers: { 'Client-Id': config.twitchClientId, Authorization: `Bearer ${helixToken.token}` },
  });
  if (!r.ok) throw new Error(`Twitch API error ${r.status}`);
  return (await r.json()) as T;
}

const twThumb = (u: string | null, w = 640, h = 360) => (u ? u.replace('%{width}', String(w)).replace('%{height}', String(h)).replace('{width}', String(w)).replace('{height}', String(h)) : null);
const twDuration = (d: string) => {
  const m = d.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : null;
};

async function twitchSearch(q: string, limit: number): Promise<ExploreItem[]> {
  if (!config.twitchClientId || !config.twitchClientSecret) {
    // Without API keys we can't search Twitch — treat the query as a channel name.
    const login = twitchLogin(q);
    if (!/^[a-z0-9_]{2,25}$/.test(login)) return [];
    return [
      {
        kind: 'channel', source: 'twitch', id: login, url: `https://www.twitch.tv/${login}`, title: login, channel: login, channelId: login,
        channelUrl: `https://www.twitch.tv/${login}`, thumbnail: null, duration: null, views: null, subscribers: null, uploaded: null, isLive: false,
        description: 'Open to see past broadcasts and top clips',
      },
    ];
  }
  const r = await helix<{ data: Raw[] }>(`search/channels?query=${encodeURIComponent(q)}&first=${Math.min(limit, 40)}`);
  return r.data.map((c) => ({
    kind: 'channel' as const,
    source: 'twitch' as const,
    id: String(c.broadcaster_login),
    url: `https://www.twitch.tv/${c.broadcaster_login}`,
    title: String(c.display_name ?? c.broadcaster_login),
    channel: String(c.display_name ?? c.broadcaster_login),
    channelId: String(c.id),
    channelUrl: `https://www.twitch.tv/${c.broadcaster_login}`,
    thumbnail: str(c.thumbnail_url),
    duration: null,
    views: null,
    subscribers: null,
    uploaded: null,
    isLive: Boolean(c.is_live),
    description: str(c.title),
    game: str(c.game_name),
  }));
}

async function twitchHelixChannel(login: string, p: { tab: string; sort: string; range: string; limit: number }) {
  const u = await helix<{ data: Raw[] }>(`users?login=${encodeURIComponent(login)}`);
  const user = u.data[0];
  if (!user) throw new Error(`No Twitch channel called "${login}".`);
  const channel: ExploreChannel = {
    source: 'twitch',
    title: String(user.display_name ?? login),
    url: `https://www.twitch.tv/${login}`,
    avatar: str(user.profile_image_url),
    banner: str(user.offline_image_url),
    subscribers: null,
    description: str(user.description),
  };
  let items: ExploreItem[];
  if (p.tab === 'clips') {
    const days = { day: 1, week: 7, month: 30, all: 3650 }[p.range] ?? 7;
    const started = new Date(Date.now() - days * 86400_000).toISOString();
    const c = await helix<{ data: Raw[] }>(`clips?broadcaster_id=${user.id}&first=${Math.min(p.limit, 100)}&started_at=${started}`);
    items = c.data.map((x) => ({
      kind: 'clip' as const, source: 'twitch' as const, id: String(x.id), url: String(x.url), title: String(x.title), channel: channel.title, channelId: String(user.id),
      channelUrl: channel.url, thumbnail: str(x.thumbnail_url), duration: num(x.duration), views: num(x.view_count), subscribers: null,
      uploaded: str(x.created_at), isLive: false, description: null,
    }));
  } else {
    const v = await helix<{ data: Raw[] }>(
      `videos?user_id=${user.id}&first=${Math.min(p.limit, 100)}&type=${p.tab === 'highlights' ? 'highlight' : 'archive'}&sort=${p.sort === 'views' ? 'views' : 'time'}`,
    );
    items = v.data.map((x) => ({
      kind: 'vod' as const, source: 'twitch' as const, id: String(x.id), url: String(x.url), title: String(x.title), channel: channel.title, channelId: String(user.id),
      channelUrl: channel.url, thumbnail: twThumb(str(x.thumbnail_url)), duration: twDuration(String(x.duration ?? '')), views: num(x.view_count), subscribers: null,
      uploaded: str(x.created_at), isLive: false, description: null,
    }));
  }
  return { channel, items };
}

// ---------------- peek (details + "Most replayed" curve) ----------------
async function peek(url: string) {
  // Fast path for YouTube: read the watch page directly (~1 s instead of 15–30 s with yt-dlp)
  const ytId = youtubeId(url);
  if (ytId) {
    try {
      const v = await ytWatchWeb(ytId);
      let curve: number[] | null = null;
      let hotspots: Signals['hotspots'] = [];
      if (v.heatmap && v.duration) {
        const sig = buildSignals({ duration: v.duration, heatmap: v.heatmap, chapters: v.chapters, comments: [], rmsPerSecond: null, useAudience: true });
        curve = sig.curve;
        hotspots = sig.hotspots.slice(0, 5);
      }
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
        curve,
        hotspots,
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
  let curve: number[] | null = null;
  let hotspots: Signals['hotspots'] = [];
  if (heatmap && duration) {
    const sig = buildSignals({ duration, heatmap, chapters, comments: [], rmsPerSecond: null, useAudience: true });
    curve = sig.curve;
    hotspots = sig.hotspots.slice(0, 5);
  }
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
    curve,
    hotspots,
  };
}

// ---------------- routes ----------------
const searchQ = z.object({
  source: z.enum(['youtube', 'twitch']).default('youtube'),
  q: z.string().trim().min(1).max(200),
  type: z.enum(['videos', 'shorts', 'channels', 'live', 'vods', 'clips']).default('videos'),
  duration: z.enum(['any', 'short', 'medium', 'long']).default('any'),
  sort: z.enum(['relevance', 'views', 'date', 'rating']).default('relevance'),
  uploaded: z.enum(['any', 'hour', 'today', 'week', 'month', 'year']).default('any'),
  limit: z.coerce.number().int().min(4).max(50).default(24),
});
const channelQ = z.object({
  url: z.string().trim().min(1).max(400),
  tab: z.enum(['videos', 'shorts', 'streams', 'live', 'vods', 'highlights', 'clips']).optional(),
  sort: z.enum(['time', 'views']).default('time'),
  range: z.enum(['day', 'week', 'month', 'all']).default('month'),
  limit: z.coerce.number().int().min(4).max(60).default(30),
});

const fail = (res: Response, e: unknown) => {
  const msg = (e as Error).message || 'Something went wrong';
  res.status(/not installed|Could not start/.test(msg) ? 503 : 502).json({ error: msg });
};
const twitchApi = () => Boolean(config.twitchClientId && config.twitchClientSecret);

export const exploreRouter = Router();

exploreRouter.get('/search', async (req: Request, res: Response) => {
  const p = searchQ.safeParse(req.query);
  if (!p.success) return res.status(400).json({ error: 'Type something to search for.' });
  const q = p.data;
  try {
    const items = await cached(`s:${JSON.stringify(q)}`, 10 * 60_000, async () => {
      if (q.source === 'twitch') {
        if (q.type === 'vods' || q.type === 'clips') {
          return (await twitchChannel({ id: q.q, tab: q.type, sort: q.sort === 'views' ? 'views' : 'time', range: 'month', limit: q.limit })).items;
        }
        return twitchSearch(q.q, q.limit);
      }
      return youtubeSearch(q);
    });
    res.json({ items, twitchApi: twitchApi() });
  } catch (e) {
    fail(res, e);
  }
});

exploreRouter.get('/channel', async (req: Request, res: Response) => {
  const p = channelQ.safeParse(req.query);
  if (!p.success) return res.status(400).json({ error: 'Missing channel.' });
  const q = p.data;
  const isTwitch = /twitch\.tv/i.test(q.url);
  try {
    const data = await cached(`c:${JSON.stringify(q)}`, 10 * 60_000, () =>
      isTwitch
        ? twitchChannel({ id: q.url, tab: q.tab === 'clips' || q.tab === 'highlights' ? q.tab : 'vods', sort: q.sort, range: q.range, limit: q.limit })
        : youtubeChannel({ id: q.url, tab: q.tab ?? 'videos', limit: q.limit }),
    );
    res.json(data);
  } catch (e) {
    fail(res, e);
  }
});

exploreRouter.get('/peek', async (req: Request, res: Response) => {
  const url = z.string().url().safeParse(req.query.url);
  if (!url.success) return res.status(400).json({ error: 'Bad link' });
  try {
    res.json(await cached(`p:${url.data}`, 30 * 60_000, () => peek(url.data)));
  } catch (e) {
    fail(res, e);
  }
});

exploreRouter.get('/meta', (_req, res) => res.json({ twitchApi: twitchApi(), fastSearch: fastStats, cached: cache.size, refreshing: [...inflight.keys()] }));

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

export const DISCOVER: Record<string, { label: string; sections: SectionDef[] }> = {
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

export const TWITCH_FEATURED = ['kaicenat', 'xqc', 'shroud', 'pokimane', 'hasanabi', 'tarik', 'summit1g', 'caseoh_'];

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

exploreRouter.get('/categories', (_req, res) => {
  res.json({
    youtube: Object.entries(DISCOVER).map(([id, c]) => ({ id, label: c.label })),
    twitch: TWITCH_FEATURED,
  });
});

exploreRouter.get('/discover', async (req: Request, res: Response) => {
  const source = req.query.source === 'twitch' ? 'twitch' : 'youtube';
  const category = typeof req.query.category === 'string' && DISCOVER[req.query.category] ? req.query.category : 'all';
  try {
    // don't cache a total failure
    const data = await cached(`d:${source}:${category}`, 30 * 60_000, () => discover(source, category), (d) => d.sections.length > 0);
    res.json(data);
  } catch (e) {
    fail(res, e);
  }
});

/** Warm the default feeds in the background so the first visit to Explore is instant. */
export function warmExplore() {
  const keep = (d: { sections: unknown[] }) => d.sections.length > 0;
  const warm = async () => {
    // "For you" first (the default view), then every category, one at a time so YouTube isn't hammered
    for (const cat of ['all', ...Object.keys(DISCOVER).filter((c) => c !== 'all')]) {
      const hit = cache.get(`d:youtube:${cat}`);
      if (hit && Date.now() - hit.at < 25 * 60_000) continue;
      await refresh(`d:youtube:${cat}`, () => discover('youtube', cat), keep).catch(() => {});
    }
    const tw = cache.get('d:twitch:all');
    if (!tw || Date.now() - tw.at > 25 * 60_000) await refresh('d:twitch:all', () => discover('twitch', 'all'), keep).catch(() => {});
  };
  setTimeout(warm, 3000);
  setInterval(warm, 30 * 60_000).unref();
}

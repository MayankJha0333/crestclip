import { ytdlpJson } from '../../../pipeline/ytdlp.js';
import { ytSearchWeb } from '../../../pipeline/ytweb.js';
import type { ExploreChannel, ExploreItem, ItemKind } from '../explore.types.js';
import { bestThumb, isoDate, num, str, type Raw } from './fields.js';

/** YouTube for Explore: search videos / Shorts / channels with filters, and list a channel's uploads (no API key needed). */

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

export async function youtubeSearch(q: { q: string; type: string; duration: string; sort: string; uploaded: string; limit: number }): Promise<ExploreItem[]> {
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

async function youtubeSearchRaw(q: { q: string; type: string; duration: string; sort: string; uploaded: string; limit: number }) {
  const sp = ytSearchParam(q);
  let items: ExploreItem[] | null = null;
  // Fast path: read YouTube's results page directly (~1 s). Slow path: yt-dlp (starts a program, several seconds).
  try {
    const web = await ytSearchWeb(q.q, sp);
    if (web.length) items = web.map((w) => ({ ...w, source: 'youtube' as const, kind: q.type === 'shorts' && w.kind === 'video' ? ('short' as const) : w.kind }));
  } catch (e) {
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

export async function youtubeChannel(p: { id: string; tab: string; limit: number }) {
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

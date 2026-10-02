import { config } from '../../../config.js';
import { ytdlpJson } from '../../../pipeline/ytdlp.js';
import type { ExploreChannel, ExploreItem } from '../explore.types.js';
import { bestThumb, isoDate, num, str, type Raw } from './fields.js';

/**
 * Twitch for Explore: a channel's past broadcasts, highlights and top clips (yt-dlp), plus channel search when
 * TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are set (official Helix API).
 */

/** True when the official Twitch API keys are set. */
export const twitchApi = () => Boolean(config.twitchClientId && config.twitchClientSecret);

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

export async function twitchChannel(p: { id: string; tab: string; sort: string; range: string; limit: number }) {
  const login = twitchLogin(p.id);
  if (twitchApi()) return twitchHelixChannel(login, p);
  let url: string;
  if (p.tab === 'clips') url = `https://www.twitch.tv/${login}/clips?filter=clips&range=${{ day: '24hr', week: '7d', month: '30d', all: 'all' }[p.range] ?? '7d'}`;
  else url = `https://www.twitch.tv/${login}/videos?filter=${p.tab === 'highlights' ? 'highlights' : 'archives'}&sort=${p.sort === 'views' ? 'views' : 'time'}`;
  const j = await ytdlpJson<Raw>(['--flat-playlist', '--playlist-end', String(p.limit), url], 90_000);
  const items = (Array.isArray(j.entries) ? (j.entries as Raw[]) : []).map((e) => twItem(e, p.tab === 'clips' ? 'clip' : 'vod', login)).filter((x): x is ExploreItem => Boolean(x));
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

export async function twitchSearch(q: string, limit: number): Promise<ExploreItem[]> {
  if (!twitchApi()) {
    // Without API keys we can't search Twitch — treat the query as a channel name.
    const login = twitchLogin(q);
    if (!/^[a-z0-9_]{2,25}$/.test(login)) return [];
    return [
      {
        kind: 'channel',
        source: 'twitch',
        id: login,
        url: `https://www.twitch.tv/${login}`,
        title: login,
        channel: login,
        channelId: login,
        channelUrl: `https://www.twitch.tv/${login}`,
        thumbnail: null,
        duration: null,
        views: null,
        subscribers: null,
        uploaded: null,
        isLive: false,
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
      kind: 'clip' as const,
      source: 'twitch' as const,
      id: String(x.id),
      url: String(x.url),
      title: String(x.title),
      channel: channel.title,
      channelId: String(user.id),
      channelUrl: channel.url,
      thumbnail: str(x.thumbnail_url),
      duration: num(x.duration),
      views: num(x.view_count),
      subscribers: null,
      uploaded: str(x.created_at),
      isLive: false,
      description: null,
    }));
  } else {
    const v = await helix<{ data: Raw[] }>(
      `videos?user_id=${user.id}&first=${Math.min(p.limit, 100)}&type=${p.tab === 'highlights' ? 'highlight' : 'archive'}&sort=${p.sort === 'views' ? 'views' : 'time'}`,
    );
    items = v.data.map((x) => ({
      kind: 'vod' as const,
      source: 'twitch' as const,
      id: String(x.id),
      url: String(x.url),
      title: String(x.title),
      channel: channel.title,
      channelId: String(user.id),
      channelUrl: channel.url,
      thumbnail: twThumb(str(x.thumbnail_url)),
      duration: twDuration(String(x.duration ?? '')),
      views: num(x.view_count),
      subscribers: null,
      uploaded: str(x.created_at),
      isLive: false,
      description: null,
    }));
  }
  return { channel, items };
}

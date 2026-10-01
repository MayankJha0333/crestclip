/**
 * Fast YouTube search: one HTTP request to the normal results page, then read the `ytInitialData`
 * JSON that YouTube embeds in it. ~0.5–1.5 s, versus several seconds for starting a yt-dlp process.
 * If YouTube changes its page and nothing can be read, callers fall back to yt-dlp.
 */

export interface WebItem {
  kind: 'video' | 'short' | 'channel' | 'live';
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
  uploaded: string | null;
  isLive: boolean;
  description: string | null;
}

type J = Record<string, unknown>;
const obj = (v: unknown): J | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const get = (v: unknown, ...path: (string | number)[]): unknown => {
  let cur: unknown = v;
  for (const k of path) {
    if (cur == null) return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
};
/** YouTube text: {simpleText} | {runs:[{text}]} | {content} | string */
const text = (v: unknown): string | null => {
  if (typeof v === 'string') return v || null;
  const o = obj(v);
  if (!o) return null;
  if (typeof o.simpleText === 'string') return o.simpleText;
  if (typeof o.content === 'string') return o.content;
  if (typeof o.text === 'string') return o.text; // a single run
  const runs = arr(o.runs).map((r) => (obj(r)?.text as string) ?? '').join('');
  return runs || null;
};

/** "1,234,567 views" · "1.2M views" · "3.4K watching" · "No views" → number */
export function parseCount(s: string | null): number | null {
  if (!s) return null;
  if (/^no /i.test(s)) return 0;
  const m = s.replace(/,/g, '').match(/([\d.]+)\s*([KMB]?)/i);
  if (!m) return null;
  const mult = { '': 1, K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase() as '' | 'K' | 'M' | 'B'] ?? 1;
  return Math.round(Number(m[1]) * mult);
}

/** "1:02:03" → 3723 */
export function parseDuration(s: string | null): number | null {
  if (!s || !/^\d+(:\d{1,2}){1,2}$/.test(s.trim())) return null;
  return s
    .trim()
    .split(':')
    .map(Number)
    .reduce((a, b) => a * 60 + b, 0);
}

/** "3 weeks ago" / "Streamed 2 days ago" → approximate ISO date */
export function parseAgo(s: string | null): string | null {
  if (!s) return null;
  // long ("3 weeks ago") or compact ("8y ago", "2mo ago", "5d ago") forms
  const m = s.match(/(\d+)\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?|mo|min|s|m|h|d|w|y)\b/i);
  if (!m) return null;
  const u = m[2].toLowerCase();
  const unit = u.startsWith('mo')
    ? 2629800
    : u.startsWith('min') || u === 'm'
      ? 60
      : u.startsWith('s')
        ? 1
        : u.startsWith('h')
          ? 3600
          : u.startsWith('d')
            ? 86400
            : u.startsWith('w')
              ? 604800
              : 31557600;
  return new Date(Date.now() - Number(m[1]) * unit * 1000).toISOString();
}

const thumbOf = (v: unknown): string | null => {
  const list = arr(get(v, 'thumbnails')).length ? arr(get(v, 'thumbnails')) : arr(get(v, 'sources'));
  const best = list
    .map((t) => obj(t))
    .filter((t): t is J => Boolean(t && typeof t.url === 'string'))
    .sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0))[0];
  let url = (best?.url as string) ?? null;
  if (url?.startsWith('//')) url = 'https:' + url;
  return url;
};

function fromVideoRenderer(v: J): WebItem | null {
  const id = v.videoId as string;
  if (!id) return null;
  const owner = arr(get(v, 'ownerText', 'runs'))[0] ?? arr(get(v, 'longBylineText', 'runs'))[0];
  const browse = obj(get(owner, 'navigationEndpoint', 'browseEndpoint'));
  const href = (get(v, 'navigationEndpoint', 'commandMetadata', 'webCommandMetadata', 'url') as string) ?? '';
  const overlays = JSON.stringify(v.thumbnailOverlays ?? []);
  const badges = JSON.stringify(v.badges ?? []);
  const live = /LIVE_NOW|"style":"LIVE"/.test(badges + overlays);
  const short = href.startsWith('/shorts/') || /"style":"SHORTS"/.test(overlays);
  const viewsText = text(v.viewCountText) ?? text(v.shortViewCountText);
  const snippet = text(get(v, 'detailedMetadataSnippets', 0, 'snippetText')) ?? text(v.descriptionSnippet);
  return {
    kind: live ? 'live' : short ? 'short' : 'video',
    id,
    url: short ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
    title: text(v.title) ?? 'Untitled',
    channel: text(owner),
    channelId: (browse?.browseId as string) ?? null,
    channelUrl: browse?.canonicalBaseUrl ? `https://www.youtube.com${browse.canonicalBaseUrl}` : browse?.browseId ? `https://www.youtube.com/channel/${browse.browseId}` : null,
    thumbnail: thumbOf(v.thumbnail),
    duration: parseDuration(text(v.lengthText)),
    views: live ? null : parseCount(viewsText),
    subscribers: null,
    uploaded: parseAgo(text(v.publishedTimeText)),
    isLive: live,
    description: snippet,
  };
}

function fromChannelRenderer(c: J): WebItem | null {
  const id = c.channelId as string;
  if (!id) return null;
  const base = get(c, 'navigationEndpoint', 'browseEndpoint', 'canonicalBaseUrl') as string | undefined;
  // YouTube moved the subscriber count between fields over time — take whichever mentions subscribers
  const subs = [text(c.subscriberCountText), text(c.videoCountText)].find((s) => s && /subscriber/i.test(s)) ?? null;
  const title = text(c.title) ?? 'Channel';
  const url = base ? `https://www.youtube.com${base}` : `https://www.youtube.com/channel/${id}`;
  return {
    kind: 'channel',
    id,
    url,
    title,
    channel: title,
    channelId: id,
    channelUrl: url,
    thumbnail: thumbOf(c.thumbnail),
    duration: null,
    views: null,
    subscribers: parseCount(subs),
    uploaded: null,
    isLive: false,
    description: text(c.descriptionSnippet),
  };
}

function fromShort(s: J): WebItem | null {
  // reelItemRenderer (older) or shortsLockupViewModel (newer)
  const id = (s.videoId as string) ?? (get(s, 'onTap', 'innertubeCommand', 'reelWatchEndpoint', 'videoId') as string);
  if (!id) return null;
  const title = text(s.headline) ?? text(get(s, 'overlayMetadata', 'primaryText')) ?? (get(s, 'accessibilityText') as string) ?? 'Short';
  const views = text(s.viewCountText) ?? text(get(s, 'overlayMetadata', 'secondaryText'));
  return {
    kind: 'short',
    id,
    url: `https://www.youtube.com/shorts/${id}`,
    title: title.replace(/,\s*[\d.,]+[KMB]?\s*views.*$/i, ''),
    channel: null,
    channelId: null,
    channelUrl: null,
    thumbnail: thumbOf(s.thumbnail) ?? thumbOf(get(s, 'thumbnail', 'sources') ? s.thumbnail : null) ?? `https://i.ytimg.com/vi/${id}/oar2.jpg`,
    duration: null,
    views: parseCount(views),
    subscribers: null,
    uploaded: null,
    isLive: false,
    description: null,
  };
}

function fromLockup(l: J): WebItem | null {
  // newer generic "lockupViewModel" (videos in some layouts)
  if (l.contentType && !/VIDEO/.test(String(l.contentType))) return null;
  const id = l.contentId as string;
  if (!id) return null;
  const meta = obj(get(l, 'metadata', 'lockupMetadataViewModel'));
  const rows = arr(get(meta, 'metadata', 'contentMetadataViewModel', 'metadataRows'));
  const parts = rows.flatMap((r) => arr(get(r, 'metadataParts')).map((p) => text(get(p, 'text')) ?? ''));
  const views = parts.find((p) => /view|watching/i.test(p)) ?? null;
  const ago = parts.find((p) => /ago/i.test(p)) ?? null;
  const badge = JSON.stringify(get(l, 'contentImage') ?? {});
  const dur = badge.match(/"text":"(\d+(?::\d{1,2}){1,2})"/)?.[1] ?? null;
  return {
    kind: /LIVE/.test(badge) ? 'live' : 'video',
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: text(get(meta, 'title')) ?? 'Untitled',
    channel: parts.find((p) => p && !/view|ago|watching/i.test(p)) ?? null,
    channelId: null,
    channelUrl: null,
    thumbnail: thumbOf(get(l, 'contentImage', 'thumbnailViewModel', 'image')) ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    duration: parseDuration(dur),
    views: parseCount(views),
    subscribers: null,
    uploaded: parseAgo(ago),
    isLive: /LIVE/.test(badge),
    description: null,
  };
}

/** Walk the whole page data and pick out every result, in page order. */
export function itemsFromInitialData(data: unknown): WebItem[] {
  const out: WebItem[] = [];
  const seen = new Set<string>();
  const add = (it: WebItem | null) => {
    if (!it || seen.has(`${it.kind === 'channel' ? 'c' : 'v'}:${it.id}`)) return;
    seen.add(`${it.kind === 'channel' ? 'c' : 'v'}:${it.id}`);
    out.push(it);
  };
  const walk = (v: unknown, depth: number) => {
    if (depth > 40 || v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as J;
    for (const [k, val] of Object.entries(o)) {
      const vo = obj(val);
      if (k === 'videoRenderer' && vo) add(fromVideoRenderer(vo));
      else if (k === 'channelRenderer' && vo) add(fromChannelRenderer(vo));
      else if ((k === 'reelItemRenderer' || k === 'shortsLockupViewModel') && vo) add(fromShort(vo));
      else if (k === 'lockupViewModel' && vo) add(fromLockup(vo));
      else if (k === 'playlistRenderer' || k === 'radioRenderer' || k === 'adSlotRenderer' || k === 'promotedSparklesWebRenderer') continue;
      else walk(val, depth + 1);
    }
  };
  walk(data, 0);
  return out;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** One results page (≈20 items). Throws if YouTube's page couldn't be read. */
export async function ytSearchWeb(query: string, sp: string, timeoutMs = 9000): Promise<WebItem[]> {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${sp ? `&sp=${encodeURIComponent(sp)}` : ''}&hl=en`;
  const res = await fetch(url, {
    headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', cookie: 'SOCS=CAI; CONSENT=YES+1' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`YouTube answered ${res.status}`);
  const html = await res.text();
  const m = html.match(/var ytInitialData\s*=\s*(\{.*?\});\s*<\/script>/s) ?? html.match(/window\["ytInitialData"\]\s*=\s*(\{.*?\});/s);
  if (!m) throw new Error('Could not read the YouTube results page');
  return itemsFromInitialData(JSON.parse(m[1]));
}


// ---------------- watch page (for the "Most replayed" graph) ----------------
export interface WebVideo {
  id: string;
  title: string;
  channel: string;
  channelUrl: string | null;
  duration: number;
  views: number | null;
  likes: number | null;
  uploadDate: string | null; // YYYYMMDD (same as yt-dlp)
  thumbnail: string | null;
  isLive: boolean;
  description: string;
  heatmap: { start_time: number; end_time: number; value: number }[] | null;
  chapters: { start_time: number; end_time: number; title: string }[];
}

export function youtubeId(url: string): string | null {
  const m = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

function grabJson(html: string, name: string): unknown | null {
  const re = new RegExp(`(?:var\\s+${name}|window\\["${name}"\\])\\s*=\\s*(\\{.*?\\});\\s*(?:var\\s|</script>|window\\[)`, 's');
  const m = html.match(re);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** Find every object stored under `key` anywhere in the tree. */
function findAll(v: unknown, key: string, out: J[] = [], depth = 0): J[] {
  if (depth > 60 || v == null || typeof v !== 'object') return out;
  if (Array.isArray(v)) {
    for (const x of v) findAll(x, key, out, depth + 1);
    return out;
  }
  for (const [k, val] of Object.entries(v as J)) {
    if (k === key && obj(val)) out.push(val as J);
    else findAll(val, key, out, depth + 1);
  }
  return out;
}

/**
 * Everything the preview needs — title, stats, chapters and the "Most replayed" heatmap — from ONE request
 * to the normal watch page (~1 s). yt-dlp gets the heatmap from the same place but also solves the player's
 * scripts, which is what made it take 15–30 s.
 */
export async function ytWatchWeb(id: string, timeoutMs = 10_000): Promise<WebVideo> {
  const res = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en&bpctr=9999999999&has_verified=1`, {
    headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', cookie: 'SOCS=CAI; CONSENT=YES+1' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`YouTube answered ${res.status}`);
  const html = await res.text();
  const player = grabJson(html, 'ytInitialPlayerResponse');
  const data = grabJson(html, 'ytInitialData');
  const vd = obj(get(player, 'videoDetails'));
  if (!vd || !vd.videoId) throw new Error('Could not read the YouTube watch page');
  const micro = obj(get(player, 'microformat', 'playerMicroformatRenderer')) ?? {};
  const duration = Number(vd.lengthSeconds) || 0;

  // heatmap: macroMarkersListEntity with markerType MARKER_TYPE_HEATMAP
  let heatmap: WebVideo['heatmap'] = null;
  for (const ent of findAll(data, 'macroMarkersListEntity')) {
    const list = obj(ent.markersList);
    if (!list || !/HEATMAP/.test(String(list.markerType))) continue;
    const pts = arr(list.markers)
      .map((m) => obj(m))
      .filter((m): m is J => Boolean(m))
      .map((m) => {
        const s = Number(m.startMillis) / 1000;
        return { start_time: s, end_time: s + Number(m.durationMillis) / 1000, value: Number(m.intensityScoreNormalized) };
      })
      .filter((p) => Number.isFinite(p.start_time) && Number.isFinite(p.value));
    if (pts.length) heatmap = pts;
    break;
  }

  // chapters
  const seen = new Set<number>();
  const starts = findAll(data, 'chapterRenderer')
    .map((c) => ({ start_time: Number(c.timeRangeStartMillis) / 1000, title: text(c.title) ?? '' }))
    .filter((c) => Number.isFinite(c.start_time) && !seen.has(c.start_time) && seen.add(c.start_time))
    .sort((a, b) => a.start_time - b.start_time);
  const chapters = starts.map((c, i) => ({ ...c, end_time: starts[i + 1]?.start_time ?? duration }));

  // likes: "like this video along with 2,123,456 other people"
  const likeText = html.match(/along with ([\d,]+) other people/);
  const likes = likeText ? Number(likeText[1].replace(/,/g, '')) + 1 : null;

  const date = String(micro.uploadDate ?? micro.publishDate ?? '').slice(0, 10);
  const owner = String(micro.ownerProfileUrl ?? '').replace(/^http:/, 'https:');
  return {
    id: String(vd.videoId),
    title: String(vd.title ?? 'Untitled'),
    channel: String(vd.author ?? ''),
    channelUrl: owner || (vd.channelId ? `https://www.youtube.com/channel/${vd.channelId}` : null),
    duration,
    views: vd.viewCount != null ? Number(vd.viewCount) : null,
    likes,
    uploadDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.replace(/-/g, '') : null,
    thumbnail: thumbOf(vd.thumbnail),
    isLive: vd.isLive === true || get(micro, 'liveBroadcastDetails', 'isLiveNow') === true,
    description: String(vd.shortDescription ?? '').slice(0, 1200),
    heatmap,
    chapters,
  };
}

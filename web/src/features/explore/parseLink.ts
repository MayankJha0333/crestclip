import type { ExploreSource } from '../../lib/api';

export type LinkHit = { kind: 'video' | 'short' | 'vod' | 'clip'; source: ExploreSource; id: string; url: string } | { kind: 'channel'; url: string };

/** Recognise a pasted video / channel link so it opens directly instead of being searched as text. */
export function parseLink(text: string): LinkHit | null {
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

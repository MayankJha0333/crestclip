/** Small readers for loosely typed JSON fields. */

/** JSON from yt-dlp or a platform API. */
export type Raw = Record<string, unknown>;
export const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
export const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function bestThumb(e: Raw, fallback?: string | null): string | null {
  const thumbs = Array.isArray(e.thumbnails) ? (e.thumbnails as Raw[]) : [];
  const sorted = thumbs.filter((t) => str(t.url)).sort((a, b) => (num(b.width) ?? 0) - (num(a.width) ?? 0));
  let url = str(sorted[0]?.url) ?? str(e.thumbnail) ?? fallback ?? null;
  if (url?.startsWith('//')) url = 'https:' + url;
  return url;
}

export function isoDate(e: Raw): string | null {
  const ts = num(e.timestamp) ?? num(e.release_timestamp);
  if (ts) return new Date(ts * 1000).toISOString();
  const d = str(e.upload_date);
  return d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
}

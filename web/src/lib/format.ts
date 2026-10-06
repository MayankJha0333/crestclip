/** Small display formatters shared across pages. */
export function fmtTime(sec: number | null | undefined) {
  if (sec == null || !Number.isFinite(sec)) return '–';
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export function fmtPrecise(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function fmtViews(n: number | null | undefined) {
  if (n == null) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B views`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M views`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K views`;
  return `${n} views`;
}

export function fmtCount(n: number | null | undefined, unit = '') {
  if (n == null) return '';
  const v = n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K` : `${n}`;
  return unit ? `${v} ${unit}` : v;
}

export function fmtDate(yyyymmdd: string | null | undefined) {
  if (!yyyymmdd) return '';
  const d = /^\d{8}$/.test(yyyymmdd) ? new Date(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`) : new Date(yyyymmdd);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function timeAgo(ms: number) {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}

/**
 * Storage time left. Reads as a promise ("Kept until 11 Oct") while there's time, and as a warning only in the
 * last two days ("Deletes tomorrow"). `soon` = two days or less.
 */
export function deletesIn(expiresAt: number | null | undefined): { text: string; until: string; soon: boolean } | null {
  if (!expiresAt) return null;
  const days = Math.ceil((expiresAt - Date.now()) / 86400_000);
  const until = new Date(expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const soon = days <= 2;
  return { text: days <= 0 ? 'Deletes today' : days === 1 ? 'Deletes tomorrow' : soon ? `Deletes in ${days} days` : `Kept until ${until}`, until, soon };
}

/**
 * A failure nothing will change by running the video again: the plan's limits, a file with no picture, not a video.
 * Network and AI hiccups are the ones worth a retry.
 */
export const retryable = (error: string | null | undefined, errorCode?: string | null) =>
  !errorCode && !/no video track|isn[’']t a video|not a video|min long\. The limit|plan clips videos up to|over your plan|no talking, and the picture|couldn[’']t be read/i.test(error ?? '');

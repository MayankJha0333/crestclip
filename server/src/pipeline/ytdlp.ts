import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { run, ProcError } from '../lib/proc.js';
import { ensureYtdlp, ytdlpPath, ytStatus } from '../infra/tools.js';
import type { HeatPoint } from '../types.js';

export interface SourceInfo {
  id: string;
  title: string;
  channel: string;
  description: string;
  duration: number;
  viewCount: number | null;
  webpageUrl: string;
  extractor: string;
  isYouTube: boolean;
  heatmap: HeatPoint[] | null;
  chapters: { start_time: number; end_time: number; title: string }[];
  thumbnail: string | null;
  uploadDate: string | null; // YYYYMMDD
  likeCount: number | null;
  channelUrl: string | null;
  liveStatus: string | null;
  width: number | null;
  height: number | null;
  /** Rough size of a full 1080p download (video + audio), in bytes. */
  fullSizeEstimate: number | null;
}

export interface Comment {
  text: string;
  like_count?: number;
}

let extraArgsOk: boolean | null = null;

// ---------------- PO-token helper (YTDLP_POT_URL) ----------------

/** Is the PO-token helper answering? Checked at most once a minute. */
let potChecked = 0;
let potOk: boolean | null = null;
export async function potHelperStatus(): Promise<{ url: string; ok: boolean | null }> {
  if (!config.ytdlpPotUrl) return { url: '', ok: null };
  if (Date.now() - potChecked > 60_000) {
    potChecked = Date.now();
    try {
      const r = await fetch(`${config.ytdlpPotUrl}/ping`, { signal: AbortSignal.timeout(3000) });
      potOk = r.ok;
    } catch {
      potOk = false;
    }
  }
  return { url: config.ytdlpPotUrl, ok: potOk };
}

function baseArgs(): string[] {
  const a = ['--no-playlist', '--no-warnings', '--ignore-config'];
  if (config.ytdlpCookies) a.push('--cookies', config.ytdlpCookies);
  // the plugin's default is 127.0.0.1:4416; only a different address needs saying
  if (config.ytdlpPotUrl && config.ytdlpPotUrl !== 'http://127.0.0.1:4416') a.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${config.ytdlpPotUrl}`);
  if (extraArgsOk !== false) a.push(...config.ytdlpExtraArgs);
  // Use CrestClip's own ffmpeg for merging/cutting, so no system ffmpeg is needed.
  if (path.isAbsolute(config.ffmpeg)) a.push('--ffmpeg-location', config.ffmpeg);
  return a;
}

/** Signs that YouTube changed something and a newer yt-dlp is needed. */
const STALE = /page needs to be reloaded|Unable to extract|nsig|signature|Requested format is not available|HTTP Error 403|Precondition check failed|Failed to extract any player response/i;
let lastForcedUpdate = 0;

/**
 * Run yt-dlp with self-healing:
 *  - waits for the first-time install if needed,
 *  - drops our extra args once if an old custom yt-dlp doesn't know them,
 *  - if YouTube broke the download, updates yt-dlp right away and retries once.
 */
async function ytdlp(args: string[], opts: Parameters<typeof run>[2] = {}, healed = false): Promise<{ stdout: string; stderr: string }> {
  if (ytStatus.state === 'installing' || ytStatus.state === 'missing') await ensureYtdlp();
  try {
    const r = await run(ytdlpPath(), [...baseArgs(), ...args], opts);
    if (config.ytdlpExtraArgs.length) extraArgsOk = true;
    return r;
  } catch (e) {
    const err = e as ProcError;
    const text = `${err.message}\n${err.stderr}`;
    if (extraArgsOk === null && config.ytdlpExtraArgs.length && /no such option|unrecognized arguments/i.test(text)) {
      extraArgsOk = false;
      return ytdlp(args, opts, healed);
    }
    if (!healed && STALE.test(text) && Date.now() - lastForcedUpdate > 10 * 60_000) {
      lastForcedUpdate = Date.now();
      console.log('  [tools] YouTube changed something — updating yt-dlp and retrying');
      await ensureYtdlp(true);
      return ytdlp(args, opts, true);
    }
    throw friendlyYtdlpError(err);
  }
}

function friendlyYtdlpError(e: ProcError): Error {
  const s = `${e.message}\n${e.stderr}`;
  if (/Could not start/.test(s)) return new Error(ytStatus.detail || 'The video downloader isn’t ready yet — CrestClip is setting it up. Try again in a minute, or upload the file instead.');
  if (/Sign in to confirm|not a bot/i.test(s)) {
    void potHelperStatus().then(({ ok }) =>
      console.warn(`  [yt-dlp] YouTube bot check — PO-token helper ${ok === null ? 'off' : ok ? 'reachable' : 'NOT reachable (is the `pot` container running?)'}${config.ytdlpCookies ? ', cookies set' : ', no YTDLP_COOKIES'}`),
    );
  }
  if (/Sign in to confirm|not a bot/i.test(s)) return new Error('YouTube asked for a sign-in check. Add a cookies file (YTDLP_COOKIES in .env) or upload the video file instead.');
  if (/Private video|members-only|This video is private/i.test(s)) return new Error('This video is private or members-only.');
  if (/Unsupported URL/i.test(s)) return new Error('That link is not supported. Try a YouTube, TikTok, Twitch, Vimeo, X or direct video link.');
  if (/age/i.test(s) && /restrict/i.test(s)) return new Error('This video is age-restricted. Add a cookies file (YTDLP_COOKIES) to download it.');
  return new Error(`Could not fetch the video: ${e.message.slice(0, 300)}`);
}

/** Estimated size of the full download we'd otherwise do (best ≤1080p video + best audio). */
function estimateFullSize(j: Record<string, unknown>): number | null {
  const fmts = Array.isArray(j.formats) ? (j.formats as Record<string, unknown>[]) : [];
  const size = (f: Record<string, unknown>) => Number(f.filesize ?? f.filesize_approx) || 0;
  const vidsAll = fmts.filter((f) => f.vcodec && f.vcodec !== 'none' && Number(f.height) <= 1080 && size(f));
  // mirror VIDEO_FORMAT: H.264 (avc1) first, then anything ≤1080p
  const avc = vidsAll.filter((f) => String(f.vcodec).startsWith('avc1'));
  const vids = avc.length ? avc : vidsAll;
  const audAll = fmts.filter((f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none' && size(f));
  const m4a = audAll.filter((f) => f.ext === 'm4a');
  const auds = m4a.length ? m4a : audAll;
  const best = (list: Record<string, unknown>[]) => list.sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0) || size(b) - size(a))[0];
  const v = best(vids);
  const a = auds.sort((x, y) => size(y) - size(x))[0];
  const total = (v ? size(v) : 0) + (v && v.acodec && v.acodec !== 'none' ? 0 : a ? size(a) : 0);
  return total || Number(j.filesize_approx) || null;
}

/** Read a link without downloading. `saveTo` keeps the raw JSON so later downloads can skip re-reading the page. */
export async function fetchInfo(url: string, saveTo?: string): Promise<SourceInfo> {
  const { stdout } = await ytdlp(['-J', '--skip-download', url], { timeoutMs: 120_000 });
  if (saveTo) fs.writeFileSync(saveTo, stdout);
  const j = JSON.parse(stdout);
  const heat = Array.isArray(j.heatmap) && j.heatmap.length ? (j.heatmap as HeatPoint[]) : null;
  const chapters = Array.isArray(j.chapters)
    ? j.chapters.map((c: { start_time: number; end_time: number; title: string }) => ({
        start_time: Number(c.start_time) || 0,
        end_time: Number(c.end_time) || 0,
        title: String(c.title ?? ''),
      }))
    : [];
  return {
    id: String(j.id ?? ''),
    title: String(j.title ?? 'Untitled video'),
    channel: String(j.channel ?? j.uploader ?? ''),
    description: String(j.description ?? '').slice(0, 4000),
    duration: Number(j.duration) || 0,
    viewCount: j.view_count != null ? Number(j.view_count) : null,
    webpageUrl: String(j.webpage_url ?? url),
    extractor: String(j.extractor_key ?? j.extractor ?? ''),
    isYouTube: /youtube/i.test(String(j.extractor_key ?? j.extractor ?? '')),
    heatmap: heat,
    chapters,
    thumbnail: j.thumbnail ? String(j.thumbnail) : null,
    uploadDate: j.upload_date ? String(j.upload_date) : null,
    likeCount: j.like_count != null ? Number(j.like_count) : null,
    channelUrl: j.channel_url ?? j.uploader_url ?? null,
    liveStatus: j.live_status ?? null,
    width: Number(j.width) || null,
    height: Number(j.height) || null,
    fullSizeEstimate: estimateFullSize(j),
  };
}

/** Top comments (only used to find timestamps people mention, e.g. "12:34 was insane"). Best effort. */
export async function fetchComments(url: string, max = 400): Promise<Comment[]> {
  try {
    const { stdout } = await ytdlp(['-J', '--skip-download', '--write-comments', '--extractor-args', `youtube:comment_sort=top;max_comments=${max},all,0`, url], { timeoutMs: 150_000 });
    const j = JSON.parse(stdout);
    return Array.isArray(j.comments) ? j.comments.map((c: Comment) => ({ text: String(c.text ?? ''), like_count: c.like_count ?? 0 })) : [];
  } catch {
    return [];
  }
}

// YouTube sometimes answers 403 for one player client but not another; try a few before giving up.
const YT_CLIENT_FALLBACKS = [null, 'youtube:player_client=tv,web_safari', 'youtube:player_client=mweb,android_vr'];
const RETRYABLE = /403|Forbidden|Requested format is not available|fragment|HTTP error|Server returned|Invalid data found|expired/i;
const VIDEO_FORMAT = 'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b';

/**
 * Download with fallbacks: first reuse the saved page info (skips re-reading YouTube — much faster),
 * then read the link fresh, then try other YouTube player clients if YouTube blocks one.
 */
async function downloadWithFallbacks(opts: { url: string; infoJson?: string | null; args: string[]; timeoutMs: number; onLine?: (line: string) => void; cleanup: () => void }) {
  const fresh = opts.infoJson && fs.existsSync(opts.infoJson) && Date.now() - fs.statSync(opts.infoJson).mtimeMs < 4 * 3600_000;
  const attempts: (string[] | null)[] = [...(fresh ? [['--load-info-json', opts.infoJson as string]] : []), ...YT_CLIENT_FALLBACKS.map((c) => [...(c ? ['--extractor-args', c] : []), opts.url])];
  let lastErr: unknown = null;
  for (const [i, src] of attempts.entries()) {
    try {
      await ytdlp([...opts.args, '--newline', ...(src ?? [])], { timeoutMs: opts.timeoutMs, onLine: opts.onLine ? (l) => opts.onLine!(l) : undefined });
      return;
    } catch (e) {
      lastErr = e;
      opts.cleanup();
      const isInfoAttempt = fresh && i === 0;
      if (!isInfoAttempt && !RETRYABLE.test(String((e as Error).message))) break;
    }
  }
  const msg = String((lastErr as Error)?.message ?? lastErr);
  throw new Error(/403|Forbidden/.test(msg) ? 'YouTube blocked this download right now. CrestClip already updated its downloader — try again in a few minutes, or upload the file instead.' : msg);
}

const progressLine = (onProgress: (pct: number, detail: string) => void) => (line: string) => {
  const m = line.match(/\[download\]\s+([\d.]+)% of\s+~?\s*([\d.]+\w+)(?:.*?at\s+([\d.]+\w+\/s))?/);
  if (m) onProgress(Number(m[1]), `${m[1]}% of ${m[2]}${m[3] ? ` · ${m[3]}` : ''}`);
};
const removePartials = (dir: string, prefix: string) => () => {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) if (f.startsWith(prefix) && /\.(part|ytdl|temp)$|\.f\d+\.|\.part-/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
};
const findOut = (dir: string, prefix: string) => fs.readdirSync(dir).find((f) => f.startsWith(prefix) && !/\.(part|ytdl|temp|json)$/.test(f) && !/\.f\d+\./.test(f));

/** Full video download (used for short videos, or when downloading parts isn't possible). */
export async function download(url: string, dir: string, onProgress: (pct: number, detail: string) => void, infoJson?: string | null): Promise<string> {
  await downloadWithFallbacks({
    url,
    infoJson,
    args: ['-f', VIDEO_FORMAT, '--merge-output-format', 'mp4', '-o', path.join(dir, 'source.%(ext)s')],
    timeoutMs: 3 * 60 * 60 * 1000,
    onLine: progressLine(onProgress),
    cleanup: removePartials(dir, 'source.'),
  });
  const file = findOut(dir, 'source.');
  if (!file) throw new Error('Download finished but no video file was found.');
  return path.join(dir, file);
}

/** Audio only — tiny compared to the video, and all CrestClip needs to transcribe and find the moments. */
export async function downloadAudio(url: string, dir: string, onProgress: (pct: number, detail: string) => void, infoJson?: string | null): Promise<string> {
  await downloadWithFallbacks({
    url,
    infoJson,
    args: ['-f', 'ba[ext=m4a]/ba/b[height<=480]/b', '-o', path.join(dir, 'source-audio.%(ext)s')],
    timeoutMs: 60 * 60 * 1000,
    onLine: progressLine(onProgress),
    cleanup: removePartials(dir, 'source-audio.'),
  });
  const file = findOut(dir, 'source-audio.');
  if (!file) throw new Error('Download finished but no audio file was found.');
  return path.join(dir, file);
}

export interface Section {
  start: number;
  end: number;
  file: string;
}

/**
 * Download only these time ranges of the video, cut frame-accurately (so file time 0 == `start` exactly).
 * One yt-dlp run for all ranges. Each range becomes its own small file.
 */
export async function downloadSections(
  url: string,
  dir: string,
  ranges: { start: number; end: number }[],
  onProgress: (done: number, total: number, detail: string) => void,
  infoJson?: string | null,
): Promise<Section[]> {
  fs.mkdirSync(dir, { recursive: true });
  const want = ranges.map((r) => ({ start: Math.max(0, Math.floor(r.start)), end: Math.ceil(r.end) })).filter((r) => r.end > r.start);
  if (!want.length) return [];
  const name = (r: { start: number; end: number }) => `sec_${r.start}-${r.end}.`;
  let idx = 0;
  let curDur = 1;
  await downloadWithFallbacks({
    url,
    infoJson,
    args: [
      '-f',
      VIDEO_FORMAT,
      '--merge-output-format',
      'mp4',
      ...want.flatMap((r) => ['--download-sections', `*${r.start}-${r.end}`]),
      '--force-keyframes-at-cuts',
      // cut exactly (re-encode) at high quality — the final render re-encodes anyway
      '--downloader-args',
      'ffmpeg_o:-c:v libx264 -preset veryfast -crf 19 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart -f mp4',
      '-o',
      path.join(dir, 'sec_%(section_start)d-%(section_end)d.%(ext)s'),
    ],
    timeoutMs: 60 * 60 * 1000,
    onLine: (line) => {
      const dest = line.match(/Destination: .*sec_(\d+)-(\d+)\./);
      if (dest) {
        idx = Math.max(idx, want.findIndex((r) => r.start === Number(dest[1])) + 1);
        curDur = Number(dest[2]) - Number(dest[1]) || 1;
        onProgress(idx - 1, want.length, `part ${idx} of ${want.length}`);
      }
      const t = line.match(/time=(\d+):(\d+):([\d.]+)/);
      if (t && idx) {
        const secs = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
        onProgress(idx - 1 + Math.min(1, secs / curDur), want.length, `part ${idx} of ${want.length}`);
      }
    },
    cleanup: () => {
      // keep finished parts; remove half-written ones
      for (const f of fs.readdirSync(dir)) if (/\.(part|ytdl|temp)$|\.part-|\.f\d+\./.test(f)) fs.rmSync(path.join(dir, f), { force: true });
    },
  });
  const files = fs.readdirSync(dir);
  const out: Section[] = [];
  for (const r of want) {
    const f = files.find((x) => x.startsWith(name(r)) && !/\.(part|ytdl|temp)$/.test(x));
    if (f) out.push({ ...r, file: path.join(dir, f) });
  }
  if (out.length < want.length) throw new Error(`Only ${out.length} of ${want.length} video parts could be downloaded.`);
  return out;
}

export interface TimedWord {
  w: string;
  s: number;
  e: number;
}

/**
 * When each word is said, from the site's own speech recognition (YouTube's automatic captions, original language):
 * timed to within ~0.1 s, where Gemini's transcript timestamps are often a second or more off. Null when the video has
 * none. The text is not used — only the timing.
 */
export async function fetchWordTimings(url: string, dir: string, infoJson: string): Promise<TimedWord[] | null> {
  let auto: Record<string, { ext?: string; url?: string }[]> = {};
  let lang: string | null = null;
  try {
    const j = JSON.parse(fs.readFileSync(infoJson, 'utf8'));
    auto = j.automatic_captions ?? {};
    lang = j.language ?? null;
  } catch {
    return null;
  }
  // the track in the spoken language ("en-orig"); the others are machine translations of it
  const track = Object.keys(auto).find((k) => k.endsWith('-orig')) ?? (lang && auto[lang] ? lang : null);
  if (!track) return null;
  type Json3 = { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string; tOffsetMs?: number }[] }[] };
  let data: Json3 | null = null;
  // the link in the saved page info is enough (a fraction of a second); yt-dlp only if that fails (expired, blocked)
  const link = auto[track]?.find((f) => f.ext === 'json3')?.url;
  if (link) data = await fetch(link, { signal: AbortSignal.timeout(30_000) }).then((r) => (r.ok ? (r.json() as Promise<Json3>) : null)).catch(() => null);
  if (!data?.events) {
    fs.mkdirSync(dir, { recursive: true });
    const fresh = Date.now() - fs.statSync(infoJson).mtimeMs < 4 * 3600_000;
    await ytdlp(['--skip-download', '--write-auto-subs', '--sub-langs', track, '--sub-format', 'json3', '-o', path.join(dir, 'asr'), ...(fresh ? ['--load-info-json', infoJson] : [url])], { timeoutMs: 120_000 });
    const file = fs.readdirSync(dir).find((f) => f.startsWith('asr.') && f.endsWith('.json3'));
    if (!file) return null;
    data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Json3;
    fs.rmSync(path.join(dir, file), { force: true });
  }
  const events = data.events ?? [];
  const words: TimedWord[] = [];
  for (const ev of events) {
    const end = ((ev.tStartMs ?? 0) + (ev.dDurationMs ?? 0)) / 1000;
    for (const sg of ev.segs ?? []) {
      const w = (sg.utf8 ?? '').trim();
      if (!w || /^\[.*\]$/.test(w)) continue; // [Music], [Applause]
      words.push({ w, s: ((ev.tStartMs ?? 0) + (sg.tOffsetMs ?? 0)) / 1000, e: end });
    }
  }
  words.sort((a, b) => a.s - b.s);
  // only starts are given: a word lasts until the next one starts (at most 0.8 s, so it doesn't run through a pause)
  for (let i = 0; i < words.length; i++) words[i].e = Math.max(words[i].s + 0.05, Math.min(words[i].e, words[i + 1]?.s ?? Infinity, words[i].s + 0.8));
  return words.length ? words : null;
}

/** Run yt-dlp and parse its JSON output (used by Explore for search / channel listings). */
export async function ytdlpJson<T = Record<string, unknown>>(args: string[], timeoutMs = 60_000): Promise<T> {
  const { stdout } = await ytdlp(['-J', ...args], { timeoutMs });
  return JSON.parse(stdout) as T;
}

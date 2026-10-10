import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { run, ProcError } from '../lib/proc.js';
import { ensureYtdlp, ytdlpPath, ytStatus } from '../infra/tools.js';
import { reserveProxyBytes } from '../db/proxy-ledger.js';
import { audioFormatSelectors, sourceLanguageFromInfo } from './audio-track.js';
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

// ---------------- proxy: rotating residential addresses (YTDLP_PROXY) ----------------

/** YouTube blocking this address, or the proxy itself failing: worth retrying from a fresh address. */
const BLOCKED = /Sign in to confirm|not a bot|HTTP Error 403|HTTP Error 429|Too Many Requests|Tunnel connection failed|ProxyError|407 Proxy|Unable to connect to proxy|Connection reset|Read timed out|timed out|stalled: no progress/i;
/** How often each video's address was swapped, so its later steps (download, captions) reuse the one that worked. */
const rotation = new Map<string, number>();
/** Videos YouTube blocked when fetched directly: all their later steps go through the proxy (same exit address). */
const viaProxy = new Set<string>();
const infoUrl = new Map<string, string>();
const sizeEstimate = new Map<string, number>();
const proxyReserved = new Map<string, number>();
const MIB = 1024 * 1024;

/** Which video a run is about: its link, or the link inside the saved page info it reuses. Search/explore runs share one key. */
function videoKey(args: string[]): string {
  const i = args.indexOf('--load-info-json');
  if (i >= 0) {
    const file = args[i + 1];
    if (!infoUrl.has(file)) {
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { webpage_url?: string };
        infoUrl.set(file, String(j.webpage_url ?? file));
      } catch {
        infoUrl.set(file, file);
      }
    }
    return infoUrl.get(file)!;
  }
  return args.find((a) => /^https?:\/\//.test(a)) ?? 'search';
}

/** The proxy for this video right now: same exit address for all its steps until a block forces a new one. */
function proxyFor(key: string): string | null {
  const list = config.ytdlpProxies;
  if (!list.length) return null;
  const turn = rotation.get(key) ?? 0;
  const hash = crypto.createHash('sha1').update(key).digest('hex');
  const pick = list[(parseInt(hash.slice(0, 8), 16) + turn) % list.length];
  // {session}: exactly 8 letters/digits (IPRoyal requires that length, every other provider accepts it)
  // {port}: providers that keep one address per port (DataImpulse: 10000-20000) — a different port per video and per retry
  const port = 10000 + ((parseInt(hash.slice(8, 14), 16) + turn * 7919) % 10001);
  return pick.replaceAll('{session}', `${hash.slice(0, 7)}${(turn % 36).toString(36)}`).replaceAll('{port}', String(port));
}

/** The proxy a video's own requests (not through yt-dlp) must use: the one its yt-dlp steps use, or none. */
export function proxyForVideo(url: string): string | null {
  return config.ytdlpProxies.length && (config.ytdlpProxyMode === 'always' || viaProxy.has(url)) ? proxyFor(url) : null;
}

/** Never show the proxy's username/password in logs or to people. */
export const redactProxy = (s: string) => s.replace(/(\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1***:***@');

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
  // ffmpeg for merging/cutting — one that can open web addresses (see config.ytdlpFfmpeg)
  if (path.isAbsolute(config.ytdlpFfmpeg)) a.push('--ffmpeg-location', config.ytdlpFfmpeg);
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
async function ytdlp(args: string[], opts: Parameters<typeof run>[2] & { noHeal?: boolean } = {}, healed = false, rotated = 0): Promise<{ stdout: string; stderr: string }> {
  if (ytStatus.state === 'installing' || ytStatus.state === 'missing') await ensureYtdlp();
  const key = config.ytdlpProxies.length ? videoKey(args) : '';
  const proxy = key && (config.ytdlpProxyMode === 'always' || viaProxy.has(key)) ? proxyFor(key) : null;
  if (proxy) {
    const wanted = Math.max(MIB, sizeEstimate.get(key) ?? (args.includes('-J') ? MIB : 10 * MIB));
    if (wanted > (proxyReserved.get(key) ?? 0)) {
      const reserved = await reserveProxyBytes(key, wanted, Math.max(0, config.ytdlpProxyDailyMb) * MIB);
      if (!reserved.allowed) throw new Error(`The server's daily proxy budget is used up (${Math.round(reserved.usedBytes / MIB)} MB of ${config.ytdlpProxyDailyMb} MB). Try again tomorrow or upload the video file.`);
      proxyReserved.set(key, wanted);
    }
  }
  try {
    const r = await run(ytdlpPath(), [...baseArgs(), ...(proxy ? ['--proxy', proxy] : []), ...args], opts);
    if (config.ytdlpExtraArgs.length) extraArgsOk = true;
    return r;
  } catch (e) {
    const err = e as ProcError;
    const text = `${err.message}\n${err.stderr}`;
    if (extraArgsOk === null && config.ytdlpExtraArgs.length && /no such option|unrecognized arguments/i.test(text)) {
      extraArgsOk = false;
      return ytdlp(args, opts, healed, rotated);
    }
    if (key && !proxy && BLOCKED.test(text)) {
      // blocked going direct: this video goes through the proxy from now on
      if (viaProxy.size > 5000) viaProxy.clear();
      viaProxy.add(key);
      console.log('  [yt-dlp] blocked going direct — switching this video to the proxy');
      return ytdlp(args, opts, healed, rotated);
    }
    // a new address only exists with several gateways or a {session} id — a single fixed proxy (e.g. a home connection) can’t rotate
    const canRotate = config.ytdlpProxies.length > 1 || config.ytdlpProxies.some((p) => p.includes('{session}') || p.includes('{port}'));
    if (proxy && canRotate && rotated < config.ytdlpProxyRetries && BLOCKED.test(text)) {
      if (rotation.size > 5000) rotation.clear();
      rotation.set(key, (rotation.get(key) ?? 0) + 1);
      console.log(`  [yt-dlp] blocked or proxy error — retrying from a new address (${rotated + 1}/${config.ytdlpProxyRetries})`);
      return ytdlp(args, opts, healed, rotated + 1);
    }
    if (!healed && !opts.noHeal && STALE.test(text) && Date.now() - lastForcedUpdate > 10 * 60_000) {
      lastForcedUpdate = Date.now();
      console.log('  [tools] YouTube changed something — updating yt-dlp and retrying');
      await ensureYtdlp(true);
      return ytdlp(args, opts, true, rotated);
    }
    // the last lines of what yt-dlp/ffmpeg said — the friendly error shown in the app keeps only a sentence of it
    const tail = redactProxy(`${err.stderr ?? ''}`).trim().split('\n').filter((l) => l.trim()).slice(-12).join('\n  ');
    if (tail) console.warn(`  [yt-dlp] failed (${videoKey(args) || 'no video key'}):\n  ${tail}`);
    throw friendlyYtdlpError(err);
  }
}

function friendlyYtdlpError(e: ProcError): Error {
  const s = `${e.message}\n${e.stderr}`;
  if (/Could not start/.test(s)) return new Error(ytStatus.detail || 'The video downloader isn’t ready yet — CrestClip is setting it up. Try again in a minute, or upload the file instead.');
  if (/Sign in to confirm|not a bot/i.test(s)) {
    void potHelperStatus().then(({ ok }) =>
      console.warn(
        `  [yt-dlp] YouTube bot check${config.ytdlpProxies.length ? ' (even through YTDLP_PROXY)' : ''} — PO-token helper ${ok === null ? 'off' : ok ? 'reachable' : 'NOT reachable (is the `pot` container running?)'}${config.ytdlpCookies ? ', cookies set' : ', no YTDLP_COOKIES'}${config.ytdlpProxies.length ? '' : ', no YTDLP_PROXY'}`,
      ),
    );
    return new Error('YouTube is blocking downloads of this link right now. Try again in a few minutes, or upload the video file instead.');
  }
  if (/Private video|members-only|This video is private/i.test(s)) return new Error('This video is private or members-only.');
  if (/Unsupported URL/i.test(s)) return new Error('That link is not supported. Try a YouTube, TikTok, Twitch, Vimeo, X or direct video link.');
  if (/age/i.test(s) && /restrict/i.test(s)) return new Error('This video is age-restricted, so it can’t be downloaded from the link. Upload the video file instead.');
  return new Error(`Could not fetch the video: ${redactProxy(e.message).slice(0, 300)}`);
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
/**
 * Read a video's info (`-J`). YouTube's default (web) player often answers a cloud server with a sign-in check,
 * so after that the clients that need no sign-in (tv) or take a PO token (mweb) are tried, like the downloads do.
 */
async function infoJson(url: string): Promise<string> {
  let lastErr: unknown;
  for (const client of YT_CLIENT_FALLBACKS) {
    try {
      const { stdout } = await ytdlp([...(client ? ['--extractor-args', client] : []), '-J', '--skip-download', url], { timeoutMs: 120_000 });
      if (client) console.log(`  [yt-dlp] video info read with ${client}`);
      return stdout;
    } catch (e) {
      lastErr = e;
      const text = `${(e as Error).message}\n${(e as { stderr?: string }).stderr ?? ''}`;
      if (!/Sign in to confirm|not a bot|HTTP Error 403/i.test(text) || !/youtu\.?be/i.test(url)) throw e;
      console.log(`  [yt-dlp] sign-in check reading info${client ? ` with ${client}` : ''} — trying the next player client`);
    }
  }
  throw lastErr;
}

/**
 * Read the video's page again with the player clients that need no sign-in (what the downloads fall back to), and
 * save it over the old page info: its stream links then work where the first ones were refused.
 */
export async function refreshInfo(url: string, saveTo: string): Promise<boolean> {
  try {
    const { stdout } = await ytdlp(['--extractor-args', YT_CLIENT_FALLBACKS[1]!, '-J', '--skip-download', url], { timeoutMs: 120_000 });
    fs.writeFileSync(saveTo, stdout);
    console.log(`  [yt-dlp] page info read again with ${YT_CLIENT_FALLBACKS[1]}`);
    return true;
  } catch (e) {
    console.warn('  [yt-dlp] reading the page info again failed:', (e as Error).message.slice(0, 200));
    return false;
  }
}

export async function fetchInfo(url: string, saveTo?: string): Promise<SourceInfo> {
  const stdout = await infoJson(url);
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
  const fullSizeEstimate = estimateFullSize(j);
  if (fullSizeEstimate) {
    sizeEstimate.set(url, fullSizeEstimate);
    if (j.webpage_url) sizeEstimate.set(String(j.webpage_url), fullSizeEstimate);
  }
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
    fullSizeEstimate,
  };
}

/** Top comments (only used to find timestamps people mention, e.g. "12:34 was insane"). Best effort. */
export async function fetchComments(url: string, max = 200): Promise<Comment[]> {
  try {
    const { stdout } = await ytdlp(['-J', '--skip-download', '--write-comments', '--extractor-args', `youtube:comment_sort=top;max_comments=${max},all,0`, url], { timeoutMs: 150_000 });
    const j = JSON.parse(stdout);
    return Array.isArray(j.comments) ? j.comments.map((c: Comment) => ({ text: String(c.text ?? ''), like_count: c.like_count ?? 0 })) : [];
  } catch {
    return [];
  }
}

// YouTube sometimes answers 403 for one player client but not another; try a few before giving up.
/** A download that prints nothing for this long is stuck (dead proxy address, frozen connection): stop it and retry. */
const STALL_MS = 3 * 60_000;
const YT_CLIENT_FALLBACKS = [null, 'youtube:player_client=tv,web_safari', 'youtube:player_client=mweb,android_vr'];
const RETRYABLE = /403|Forbidden|Requested format is not available|fragment|HTTP error|Server returned|Invalid data found|expired/i;

function sourceAudioLanguage(infoJson?: string | null): string | null {
  if (!infoJson) return null;
  try {
    return sourceLanguageFromInfo(JSON.parse(fs.readFileSync(infoJson, 'utf8')));
  } catch {
    return null;
  }
}

function videoFormat(infoJson?: string | null): string {
  const audio = audioFormatSelectors(sourceAudioLanguage(infoJson));
  const video = ['bv*[height<=1080][vcodec^=avc1]', 'bv*[height<=1080]'];
  return [...video.flatMap((v) => audio.map((a) => `${v}+${a}`)), 'b[height<=1080]', 'b'].join('/');
}

/**
 * Download with fallbacks: first reuse the saved page info (skips re-reading YouTube — much faster),
 * then read the link fresh, then try other YouTube player clients if YouTube blocks one.
 */
// Which way of fetching a video worked last time (the saved page info, or a player client), so the next part of the
// same video — twelve clips ask one after another — starts with it instead of failing through the list again.
const knownGood = new Map<string, number>();
const probing = new Map<string, Promise<void>>();
async function downloadWithFallbacks(opts: { url: string; infoJson?: string | null; args: string[]; timeoutMs: number; idleTimeoutMs?: number; onLine?: (line: string) => void; cleanup: () => void }) {
  const fresh = opts.infoJson && fs.existsSync(opts.infoJson) && Date.now() - fs.statSync(opts.infoJson).mtimeMs < 4 * 3600_000;
  const attempts: (string[] | null)[] = [...(fresh ? [['--load-info-json', opts.infoJson as string]] : []), ...YT_CLIENT_FALLBACKS.map((c) => [...(c ? ['--extractor-args', c] : []), opts.url])];
  // several parts of one video start together: the first one finds the way that works, the others wait for it
  // (a few seconds) instead of all failing through the same list at once
  const other = knownGood.has(opts.url) ? null : probing.get(opts.url);
  if (other) await other.catch(() => {});
  let settle: () => void = () => {};
  if (!knownGood.has(opts.url) && !probing.has(opts.url)) {
    const probe = new Promise<void>((res) => (settle = res));
    probing.set(opts.url, probe);
    void probe.finally(() => probing.get(opts.url) === probe && probing.delete(opts.url));
  }
  const good = knownGood.get(opts.url);
  const order = good != null && good < attempts.length ? [good, ...attempts.keys()].filter((x, k, all) => all.indexOf(x) === k) : [...attempts.keys()];
  let lastErr: unknown = null;
  for (const i of order) {
    const src = attempts[i];
    const isInfoAttempt = Boolean(fresh) && i === 0;
    try {
      let flowing = false;
      await ytdlp([...opts.args, '--newline', ...(src ?? [])], {
        timeoutMs: opts.timeoutMs,
        idleTimeoutMs: opts.idleTimeoutMs ?? STALL_MS,
        onLine: (l) => {
          // bytes are arriving: this is the way in — the other parts waiting on the probe can start right away
          if (!flowing && /time=\d|\[download\]\s+\d/.test(l)) {
            flowing = true;
            if (knownGood.size > 2000) knownGood.clear();
            knownGood.set(opts.url, i);
            settle();
          }
          opts.onLine?.(l);
        },
        // the saved page info can simply be stale (its links refused): that's no reason to update yt-dlp
        noHeal: isInfoAttempt,
      });
      if (knownGood.size > 2000) knownGood.clear();
      knownGood.set(opts.url, i);
      settle();
      return;
    } catch (e) {
      lastErr = e;
      opts.cleanup();
      if (knownGood.get(opts.url) === i) knownGood.delete(opts.url);
      if (!isInfoAttempt && !RETRYABLE.test(String((e as Error).message))) break;
    }
  }
  settle();
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
    args: ['-f', videoFormat(infoJson), '-N', '8', '--merge-output-format', 'mp4', '-o', path.join(dir, 'source.%(ext)s')],
    // one stuck download used to hold the only job slot for hours, so nothing else started
    timeoutMs: 90 * 60 * 1000,
    onLine: progressLine(onProgress),
    cleanup: removePartials(dir, 'source.'),
  });
  const file = findOut(dir, 'source.');
  if (!file) throw new Error('Download finished but no video file was found.');
  return path.join(dir, file);
}

/** Audio only — tiny compared to the video, and all CrestClip needs to transcribe and find the moments. */
export async function downloadAudio(url: string, dir: string, onProgress: (pct: number, detail: string) => void, infoJson?: string | null): Promise<string> {
  const audioFormat = [...audioFormatSelectors(sourceAudioLanguage(infoJson)), 'b[height<=480]', 'b'].join('/');
  await downloadWithFallbacks({
    url,
    infoJson,
    // -N 8: sites that serve the sound as many short files (Twitch) download eight of them at a time
    args: ['-f', audioFormat, '-N', '8', '-o', path.join(dir, 'source-audio.%(ext)s')],
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
      videoFormat(infoJson),
      '--merge-output-format',
      'mp4',
      ...want.flatMap((r) => ['--download-sections', `*${r.start}-${r.end}`]),
      // The part is copied as it comes (no re-encode: that used to cost a full 1080p encode per clip before the real
      // one). ffmpeg starts at the keyframe before `start` and marks the file so that its time 0 is `start` exactly —
      // checked frame by frame — so the clip cut from it lands where the transcript says.
      '--downloader-args',
      'ffmpeg_o:-movflags +faststart -f mp4',
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
  /** a sound label rather than a word: [Laughter], [Applause], [Music]… */
  tag?: boolean;
}

/**
 * When each word is said, from the site's own speech recognition (YouTube's automatic captions, original language):
 * timed to within ~0.1 s, where Gemini's transcript timestamps are often a second or more off. Null when the video has
 * none. The text is not used — only the timing.
 */
export async function fetchWordTimings(url: string, dir: string, infoJson: string): Promise<TimedWord[] | null> {
  const all = await cachedWordTimings(url, dir, infoJson);
  const words = all?.filter((w) => !w.tag) ?? null;
  return words?.length ? words : null;
}

/** The sound labels in the captions — [Laughter], [Applause], [Cheering]… — and when they happen. */
export async function captionReactions(url: string, dir: string, infoJson: string): Promise<{ t: number; label: string }[]> {
  const all = await cachedWordTimings(url, dir, infoJson).catch(() => null);
  return (all ?? []).filter((w) => w.tag).map((w) => ({ t: w.s, label: w.w.replace(/^\[|\]$/g, '').toLowerCase() }));
}

/** Fetched once per video (every clip asks again when its captions are made); sound labels kept, marked `tag`. */
async function cachedWordTimings(url: string, dir: string, infoJson: string): Promise<TimedWord[] | null> {
  const cache = path.join(dir, 'words.json');
  try {
    const c = JSON.parse(fs.readFileSync(cache, 'utf8')) as TimedWord[] | null;
    if (c === null || (Array.isArray(c) && c.length)) return c;
  } catch {
    /* not fetched yet */
  }
  const words = await readWordTimings(url, dir, infoJson);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cache, JSON.stringify(words));
  } catch {
    /* the cache is only a shortcut */
  }
  return words;
}

async function readWordTimings(url: string, dir: string, infoJson: string): Promise<TimedWord[] | null> {
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
      if (!w) continue;
      const tag = /^\[.*\]$/.test(w); // [Music], [Laughter], [Applause]: kept as labels, never as words
      words.push({ w, s: ((ev.tStartMs ?? 0) + (sg.tOffsetMs ?? 0)) / 1000, e: end, ...(tag ? { tag } : {}) });
    }
  }
  words.sort((a, b) => a.s - b.s);
  // only starts are given: a word lasts until the next one starts (at most 0.8 s, so it doesn't run through a pause)
  for (let i = 0; i < words.length; i++) words[i].e = Math.max(words[i].s + 0.05, Math.min(words[i].e, words[i + 1]?.s ?? Infinity, words[i].s + 0.8));
  return words.some((w) => !w.tag) ? words : null;
}

/** Run yt-dlp and parse its JSON output (used by Explore for search / channel listings). */
export async function ytdlpJson<T = Record<string, unknown>>(args: string[], timeoutMs = 60_000): Promise<T> {
  const { stdout } = await ytdlp(['-J', ...args], { timeoutMs });
  return JSON.parse(stdout) as T;
}

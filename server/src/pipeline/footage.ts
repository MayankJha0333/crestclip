import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { projects, type ProjectRow } from '../db/index.js';
import { probe } from './media.js';
import { pool } from '../lib/proc.js';
import { download, downloadSections, proxyForVideo, refreshInfo, type Section } from './ytdlp.js';
import { fetchPartFast } from './fastparts.js';
import { withClusterLock } from '../infra/shared.js';

/**
 * "Footage" = where the pixels for a clip come from.
 *
 *  • full mode:    the whole video was downloaded once (uploads, short links).
 *  • section mode: only the audio of the whole video was downloaded. The video is fetched
 *                  just for the parts that become clips (plus a little padding), on demand.
 *                  A 2-hour podcast → ~100 MB of audio + a few small clips instead of ~3 GB.
 */

interface FootageIndex {
  mode: 'sections';
  url: string;
  sections: Section[];
  downloadedBytes: number;
  fullSizeEstimate: number | null;
}

interface Footage {
  src: string;
  offset: number; // global time of file time 0
  width: number;
  height: number;
  hasAudio: boolean;
}

const indexPath = (dir: string) => path.join(dir, 'footage.json');
export const infoJsonPath = (dir: string) => path.join(dir, 'work', 'info.json');

export function readFootage(dir: string): FootageIndex | null {
  try {
    const f = JSON.parse(fs.readFileSync(indexPath(dir), 'utf8')) as FootageIndex;
    f.sections = f.sections.filter((s) => fs.existsSync(s.file));
    return f;
  } catch {
    return null;
  }
}
function writeFootage(dir: string, f: FootageIndex) {
  fs.writeFileSync(indexPath(dir), JSON.stringify(f, null, 1));
}

export function startSectionMode(dir: string, url: string, fullSizeEstimate: number | null) {
  writeFootage(dir, { mode: 'sections', url, sections: [], downloadedBytes: 0, fullSizeEstimate });
}
export function endSectionMode(dir: string) {
  fs.rmSync(indexPath(dir), { force: true });
}

const covers = (s: Section, start: number, end: number) => s.start <= start + 0.01 && s.end >= end - 0.01;

/** Merge padded clip ranges that touch, so nearby clips share one download. */
function planRanges(ranges: { start: number; end: number }[], duration: number) {
  const pad = config.sectionPad;
  const padded = ranges.map((r) => ({ start: Math.max(0, r.start - pad), end: Math.min(duration || Infinity, r.end + pad) })).sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const r of padded) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 5) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

// the index file (footage.json) is written by one process at a time; downloads themselves run side by side
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  // in this process, then across every worker (they share the project's folder and footage.json)
  const next = prev.catch(() => {}).then(() => withClusterLock(`footage:${key}`, fn, { wait: true, ttlMs: 120_000 }) as Promise<T>);
  locks.set(key, next);
  next.finally(() => locks.get(key) === next && locks.delete(key)).catch(() => {});
  return next;
}

/** Add downloaded parts to the index (skipping any another worker added meanwhile). */
function recordSections(p: ProjectRow, dir: string, got: Section[]) {
  return withLock(p.id, async () => {
    const cur = readFootage(dir);
    if (!cur) return; // switched to the whole video meanwhile
    for (const s of got) {
      if (cur.sections.some((x) => x.file === s.file)) continue;
      // trust the real length of the file over the requested range (e.g. near the end of the video)
      const real = await probe(s.file).catch(() => null);
      if (real?.duration) s.end = Math.min(s.end, s.start + real.duration);
      cur.sections.push(s);
      cur.downloadedBytes += fs.statSync(s.file).size;
    }
    writeFootage(dir, cur);
  });
}

// the page info is read again once per video when its stream links are refused (every part that hit it waits for that one read)
const refreshing = new Map<string, Promise<boolean>>();
function refreshedInfo(projectId: string, url: string, info: string): Promise<boolean> {
  let job = refreshing.get(projectId);
  if (!job) {
    job = refreshInfo(url, info).finally(() => setTimeout(() => refreshing.get(projectId) === job && refreshing.delete(projectId), 60_000));
    refreshing.set(projectId, job);
  }
  return job;
}

// one download per part, however many clips (or workers) ask for it
const fetching = new Map<string, Promise<void>>();
function fetchRange(p: ProjectRow, dir: string, r: { start: number; end: number }, onProgress: (frac: number) => void): Promise<void> {
  const key = `${p.id}:${r.start}-${r.end}`;
  const cur = fetching.get(key);
  if (cur) return cur;
  const job = withClusterLock(
    `footage:${key}`,
    async () => {
      const idx = readFootage(dir);
      if (!idx || idx.sections.some((s) => covers(s, r.start, r.end))) return; // another worker got it (or the whole video)
      const secDir = path.join(dir, 'sections');
      fs.mkdirSync(secDir, { recursive: true });
      // by byte range first (seconds); yt-dlp's cut (about playback speed) when the video can't be fetched that way
      const want = { start: Math.max(0, Math.floor(r.start)), end: Math.ceil(r.end) };
      const file = path.join(secDir, `sec_${want.start}-${want.end}.mp4`);
      const info = infoJsonPath(dir);
      let fast = fs.existsSync(info) ? await fetchPartFast(info, want, file, { proxy: proxyForVideo(idx.url), onProgress }) : 'unsupported';
      if (fast === 'refused' && (await refreshedInfo(p.id, idx.url, info))) fast = await fetchPartFast(info, want, file, { proxy: proxyForVideo(idx.url), onProgress });
      const got = fast === 'ok' ? [{ ...want, file }] : await downloadSections(idx.url, secDir, [r], (d) => onProgress(d), info);
      await recordSections(p, dir, got);
    },
    { wait: true, ttlMs: 120_000 },
  ).then(() => {});
  fetching.set(key, job);
  job.finally(() => fetching.get(key) === job && fetching.delete(key)).catch(() => {});
  return job;
}

/**
 * Download the video parts for these ranges that aren't on disk yet — several at once: YouTube serves each part at
 * about playback speed, so eight at a time finish in an eighth of the time. Each part is on its own, so a clip's
 * render can start the moment its part lands (see process.ts) rather than when every part has.
 */
export async function prefetchFootage(
  p: ProjectRow,
  dir: string,
  ranges: { start: number; end: number }[],
  onProgress: (done: number, total: number, detail: string) => void = () => {},
  /** exact: the ranges are already padded download ranges (from downloadPlan) — fetch them as they are */
  opts: { exact?: boolean } = {},
): Promise<void> {
  const idx = readFootage(dir);
  if (!idx) return;
  const missing = ranges.filter((r) => !idx.sections.some((s) => covers(s, r.start, r.end)));
  if (!missing.length) return;
  const plan = opts.exact ? missing : planRanges(missing, p.duration ?? 0);
  const done = new Array(plan.length).fill(0);
  const report = () => {
    const sum = done.reduce((a, b) => a + b, 0);
    onProgress(sum, plan.length, `part ${Math.min(plan.length, Math.floor(sum) + 1)} of ${plan.length}`);
  };
  try {
    await pool(plan, config.sectionDownloads, (r, i) =>
      fetchRange(p, dir, r, (d) => ((done[i] = Math.max(done[i], d)), report())).then(() => {
        done[i] = 1;
        report();
      }),
    );
  } catch (e) {
    // Some sites don't allow downloading just a part. Fall back to the whole video once, then everything uses it.
    await withLock(p.id, async () => {
      if (!readFootage(dir)) return; // another worker already switched
      console.warn(`[project ${p.id}] part download failed (${(e as Error).message.slice(0, 200)}) — downloading the whole video instead`);
      const full = await download(idx.url, dir, (pct, d) => onProgress(pct / 100, 1, `whole video · ${d}`), infoJsonPath(dir));
      const pr = await probe(full);
      await projects.update(p.id, { mediaPath: full, width: pr.width, height: pr.height });
      endSectionMode(dir);
    });
  }
}

/** The padded, merged download ranges for these clip parts (what prefetchFootage would fetch). */
export const downloadPlan = (ranges: { start: number; end: number }[], duration: number) => planRanges(ranges, duration);

/** The file (and time offset) to cut [start, end] from. Downloads the part if needed. */
export async function footageFor(p: ProjectRow, dir: string, start: number, end: number): Promise<Footage> {
  const idx = readFootage(dir);
  if (!idx) {
    if (!p.mediaPath || !p.width || !p.height) throw new Error('The source video is missing.');
    const pr = await probe(p.mediaPath);
    return { src: p.mediaPath, offset: 0, width: p.width, height: p.height, hasAudio: pr.hasAudio };
  }
  let sec = idx.sections.find((s) => covers(s, start, end));
  if (!sec) {
    await prefetchFootage(p, dir, [{ start, end }]);
    const after = readFootage(dir);
    if (!after) return footageFor((await projects.get(p.id)) ?? p, dir, start, end); // switched to the whole video
    sec = after.sections.find((s) => covers(s, start, end));
  }
  if (!sec) throw new Error('Could not download this part of the video.');
  const pr = await probe(sec.file);
  return { src: sec.file, offset: sec.start, width: pr.width, height: pr.height, hasAudio: pr.hasAudio };
}

/** For the UI: how much we downloaded vs. what a full download would have been. */
export function footageSavings(dir: string): { downloaded: number; full: number | null } | null {
  const idx = readFootage(dir);
  if (!idx) return null;
  let audio = 0;
  try {
    const a = fs.readdirSync(dir).find((f) => f.startsWith('source-audio.'));
    if (a) audio = fs.statSync(path.join(dir, a)).size;
  } catch {
    /* ignore */
  }
  return { downloaded: idx.downloadedBytes + audio, full: idx.fullSizeEstimate };
}

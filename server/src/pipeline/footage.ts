import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { projects, type ProjectRow } from '../db/index.js';
import { probe } from './media.js';
import { pool } from '../lib/proc.js';
import { download, downloadSections, type Section } from './ytdlp.js';

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

export interface Footage {
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
  const padded = ranges
    .map((r) => ({ start: Math.max(0, r.start - pad), end: Math.min(duration || Infinity, r.end + pad) }))
    .sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const r of padded) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 5) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

// one download at a time per project (clips rendering in parallel may ask for footage together)
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  next.finally(() => locks.get(key) === next && locks.delete(key)).catch(() => {});
  return next;
}

/** Download the video parts for these ranges that aren't on disk yet. */
export function prefetchFootage(
  p: ProjectRow,
  dir: string,
  ranges: { start: number; end: number }[],
  onProgress: (done: number, total: number, detail: string) => void = () => {},
): Promise<void> {
  return withLock(p.id, async () => {
    const idx = readFootage(dir);
    if (!idx) return;
    const missing = ranges.filter((r) => !idx.sections.some((s) => covers(s, r.start, r.end)));
    if (!missing.length) return;
    let got: Section[];
    try {
      // YouTube serves each part at roughly playback speed, so fetch up to 3 parts at the same time.
      const plan = planRanges(missing, p.duration ?? 0);
      const done = new Array(plan.length).fill(0);
      const report = () => {
        const sum = done.reduce((a, b) => a + b, 0);
        onProgress(sum, plan.length, `part ${Math.min(plan.length, Math.floor(sum) + 1)} of ${plan.length}`);
      };
      got = (
        await pool(plan, 3, (r, i) =>
          downloadSections(idx.url, path.join(dir, 'sections'), [r], (d) => ((done[i] = Math.max(done[i], d)), report()), infoJsonPath(dir)).then((x) => {
            done[i] = 1;
            report();
            return x;
          }),
        )
      ).flat();
    } catch (e) {
      // Some sites don't allow downloading just a part. Fall back to the whole video once, then everything uses it.
      console.warn(`[project ${p.id}] part download failed (${(e as Error).message.slice(0, 200)}) — downloading the whole video instead`);
      const full = await download(idx.url, dir, (pct, d) => onProgress(pct / 100, 1, `whole video · ${d}`), infoJsonPath(dir));
      const pr = await probe(full);
      projects.update(p.id, { mediaPath: full, width: pr.width, height: pr.height });
      endSectionMode(dir);
      return;
    }
    const cur = readFootage(dir) ?? idx;
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
    if (!after) return footageFor(projects.get(p.id) ?? p, dir, start, end); // switched to the whole video
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

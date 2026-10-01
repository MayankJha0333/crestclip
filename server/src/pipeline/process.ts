import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { withRequiredTags } from './instructions.js';
import { clips as clipDb, projects, type ClipDefaults, type ClipRow, type ProjectRow } from '../db/index.js';
import { pool, run } from '../lib/proc.js';
import { projectDir } from '../lib/paths.js';
import { buildAss, wordsInRange } from './captions.js';
import { part, uploadToGcs, deleteFromGcs, usage } from './gemini.js';
import { extractAudio, extractAudioRange, hasLibass, loudnessPerSecond, makeProxy, probe, silences as findSilences, thumbnail } from './media.js';
import { aiScore, describeClips, findMoments, finalizeClips, snapRange } from './moments.js';
import { planReframe } from './reframe.js';
import { concatParts, mixMusic, planZooms, renderClip } from './render.js';
import { resolveMusic } from './music.js';
import { buildSignals, rangeScore } from './signals.js';
import { transcribe } from './transcribe.js';
import { download, downloadAudio, fetchComments, fetchInfo, type Comment, type SourceInfo } from './ytdlp.js';
import { endSectionMode, footageFor, footageSavings, infoJsonPath, prefetchFootage, readFootage, startSectionMode } from './footage.js';
import { classifyFileLink, downloadFileLink, fileLinkLabel } from './filelink.js';
import type { CaptionStyle, Layout, ProjectOptions, ReframePlan, Segment, Signals, TimeRange } from '../types.js';

type Stage = 'fetch' | 'listen' | 'transcribe' | 'moments' | 'render';
const STAGE_RANGE: Record<Stage, [number, number]> = {
  fetch: [0, 22],
  listen: [22, 28],
  transcribe: [28, 55],
  moments: [55, 64],
  render: [64, 100],
};

function stage(id: string, s: Stage, frac = 0, detail = '') {
  const [a, b] = STAGE_RANGE[s];
  projects.update(id, { stage: s, progress: +(a + (b - a) * Math.max(0, Math.min(1, frac))).toFixed(1), stageDetail: detail });
}

export async function processProject(id: string) {
  const p = projects.get(id);
  if (!p) return;
  const dir = projectDir(id);
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(path.join(dir, 'clips'), { recursive: true });
  projects.update(id, { status: 'processing', error: null });
  const startedUsage = { ...usage };

  try {
    // Resume: moments already found → only (re)render what's missing.
    const existing = clipDb.forProject(id);
    if (p.transcript && p.signals && existing.length && p.mediaPath && fs.existsSync(p.mediaPath)) {
      const todo = existing.filter((c) => c.status !== 'ready');
      await fetchClipFootage(id, todo);
      await renderAll(id, todo);
      projects.update(id, { status: 'done', stage: 'done', progress: 100, stageDetail: '' });
      return;
    }

    // Parts picked by hand (Explore graph): skip the AI search, fetch + clip exactly those parts.
    if (p.options.ranges?.length && p.sourceType === 'url' && p.sourceUrl) {
      await processPickedParts(id);
      return;
    }

    // ---------- 1. fetch ----------
    stage(id, 'fetch', 0, p.sourceType === 'url' ? 'Reading the link…' : 'Reading your upload…');
    let src = p.mediaPath && fs.existsSync(p.mediaPath) ? p.mediaPath : null;
    // a file link (Google Drive, Dropbox, OneDrive, direct .mp4): download it, then treat it like an upload
    if (!src && p.sourceType === 'upload' && p.sourceUrl) {
      const link = classifyFileLink(p.sourceUrl);
      if (!link || 'error' in link) throw new Error(link && 'error' in link ? link.error : 'That link isn’t a video file.');
      const where = fileLinkLabel[link.kind];
      stage(id, 'fetch', 0.02, `Downloading from ${where}…`);
      const got = await downloadFileLink(link, dir, (pct, detail) => stage(id, 'fetch', 0.02 + (pct / 100) * 0.9, `Downloading from ${where} · ${detail}`));
      src = got.file;
      const title = got.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 120);
      projects.update(id, { mediaPath: src, ...(title && title !== 'video' ? { title } : {}) });
    }
    let info: SourceInfo | null = null;
    let commentsP: Promise<Comment[]> = Promise.resolve([]);
    if (p.sourceType === 'url' && p.sourceUrl) {
      info = await fetchInfo(p.sourceUrl, infoJsonPath(dir));
      if (info.duration && info.duration > config.maxSourceMinutes * 60)
        throw new Error(`This video is ${Math.round(info.duration / 60)} min long. The limit is ${config.maxSourceMinutes} min (MAX_SOURCE_MINUTES).`);
      projects.update(id, {
        title: info.title,
        channel: info.channel,
        description: info.description,
        duration: info.duration,
        viewCount: info.viewCount,
      });
      if (info.isYouTube && p.options.useAudienceData) commentsP = fetchComments(info.webpageUrl);
      if (!src) {
        const smart = config.downloadMode === 'smart' && info.duration >= config.smartMinMinutes * 60 && info.liveStatus !== 'is_live';
        const fetchStage = (label: string) => (pct: number, detail: string) => stage(id, 'fetch', 0.1 + (pct / 100) * 0.85, `${label} · ${detail}`);
        if (smart) {
          // Long video: grab only the audio now. Video is fetched later, just for the clip parts.
          try {
            src = await downloadAudio(info.webpageUrl, dir, fetchStage('Downloading the audio'), infoJsonPath(dir));
            startSectionMode(dir, info.webpageUrl, info.fullSizeEstimate);
          } catch (e) {
            console.warn(`[project ${id}] audio-only download failed, downloading the full video instead:`, (e as Error).message);
            src = null;
          }
        }
        if (!src) src = await download(info.webpageUrl, dir, fetchStage('Downloading'), infoJsonPath(dir));
      }
    }
    if (!src) throw new Error('No video file to work with.');
    const pr = await probe(src, { audioOnlyOk: true });
    if (!pr.width && !readFootage(dir)) throw new Error('This file has no video track.');
    if (pr.width && readFootage(dir)) endSectionMode(dir); // the "audio" download turned out to be a full video — use it as is
    const duration = pr.duration || info?.duration || 0;
    if (!duration) throw new Error('Could not read the video length.');
    const thumb = path.join(dir, 'thumb.jpg');
    if (pr.width) await thumbnail(src, Math.min(duration * 0.15, 60), thumb).catch(() => {});
    else if (info?.thumbnail) await remoteThumbnail(info.thumbnail, thumb, work).catch(() => {});
    projects.update(id, {
      mediaPath: src,
      duration,
      width: pr.width || info?.width || null,
      height: pr.height || info?.height || null,
      thumbPath: fs.existsSync(thumb) ? thumb : null,
    });
    stage(id, 'fetch', 1, pr.width ? 'Video ready' : 'Audio ready — video will be fetched only for the clips');

    // ---------- 2. listen ----------
    if (!pr.hasAudio) throw new Error('This video has no audio track. CrestClip needs speech to find moments.');
    const audio = path.join(work, 'audio.mp3');
    const silPath = path.join(work, 'silences.json');
    const rmsPath = path.join(work, 'rms.json');
    let sil: { s: number; e: number }[];
    let rms: number[] | null;
    if (fs.existsSync(audio) && fs.existsSync(silPath) && fs.existsSync(rmsPath)) {
      sil = JSON.parse(fs.readFileSync(silPath, 'utf8'));
      rms = JSON.parse(fs.readFileSync(rmsPath, 'utf8'));
    } else {
      stage(id, 'listen', 0, 'Pulling out the audio…');
      await extractAudio(src, audio);
      stage(id, 'listen', 0.5, 'Measuring energy and pauses…');
      [rms, sil] = await Promise.all([
        loudnessPerSecond(audio, work).catch((e) => (console.warn('[loudness]', e.message), null)),
        findSilences(audio).catch(() => [] as { s: number; e: number }[]),
      ]);
      fs.writeFileSync(silPath, JSON.stringify(sil));
      fs.writeFileSync(rmsPath, JSON.stringify(rms));
    }

    // ---------- 3. transcribe (reuse a saved transcript on retry) ----------
    let segments = p.transcript;
    if (!segments?.length) {
      stage(id, 'transcribe', 0, 'Listening with Gemini…');
      const tr = await transcribe(
        audio,
        duration,
        work,
        p.options.language,
        (d, t) => stage(id, 'transcribe', d / t, `Transcribing · part ${d} of ${t}`),
        sil,
      );
      if (!tr.segments.length) throw new Error('No speech was found in this video.');
      segments = tr.segments;
      projects.update(id, { transcript: segments });
    }
    const tr = { segments };

    // ---------- 4. find moments ----------
    stage(id, 'moments', 0.05, 'Reading the audience heatmap…');
    const comments = await commentsP;
    const signals: Signals = buildSignals({
      duration,
      heatmap: info?.heatmap ?? null,
      chapters: info?.chapters ?? [],
      comments,
      rmsPerSecond: rms,
      useAudience: p.options.useAudienceData,
    });
    projects.update(id, { signals });

    let videoPart = null;
    let gcsObject: string | null = null;
    if (config.sendVideoToGemini && !config.fakeAi && duration <= 45 * 60) {
      try {
        if (info?.isYouTube) {
          videoPart = part.uri(info.webpageUrl, 'video/mp4', { fps: 0.5 });
        } else if (config.gcsBucket && pr.width) {
          stage(id, 'moments', 0.15, 'Uploading a preview to Cloud Storage…');
          const proxy = path.join(work, 'proxy.mp4');
          await makeProxy(src, proxy);
          gcsObject = `crestclip/${id}/proxy.mp4`;
          videoPart = part.uri(await uploadToGcs(proxy, gcsObject, 'video/mp4'), 'video/mp4', { fps: 0.5 });
        }
      } catch {
        videoPart = null;
      }
    }

    stage(id, 'moments', 0.35, 'Gemini is hunting for viral moments…');
    const found = await findMoments({
      segments: tr.segments,
      duration,
      title: info?.title ?? p.title ?? 'Untitled',
      channel: info?.channel ?? '',
      description: info?.description ?? '',
      signals,
      options: p.options,
      videoPart,
    }).finally(() => {
      if (gcsObject) deleteFromGcs(gcsObject);
    });
    const { clips: cands, notes } = found;
    const final = finalizeClips(cands, tr.segments, sil, duration, signals, p.options).map((c) => ({ ...c, hashtags: withRequiredTags(c.hashtags, p.options) }));
    if (!final.length) throw new Error('Gemini did not find any clip-worthy moments in this video.');
    const saved = clipDb.replaceForProject(id, final, clipDefaults(p.options));
    projects.update(id, { aiNotes: notes });
    stage(id, 'moments', 1, `Found ${saved.length} moments`);

    // ---------- 5. fetch only the clip parts (section mode), then reframe + render ----------
    await fetchClipFootage(id, saved);
    await renderAll(id, saved);
    const used = { calls: usage.calls - startedUsage.calls, input: usage.input - startedUsage.input, output: usage.output - startedUsage.output };
    projects.update(id, {
      status: 'done',
      stage: 'done',
      progress: 100,
      stageDetail: [savingsText(dir), used.calls ? `${used.calls} Gemini calls · ${(used.input / 1000).toFixed(0)}K in / ${(used.output / 1000).toFixed(1)}K out tokens` : '']
        .filter(Boolean)
        .join(' · '),
    });
    fs.rmSync(path.join(work, 'frames'), { recursive: true, force: true });
    for (const f of fs.readdirSync(work)) if (f.startsWith('chunk_')) fs.rmSync(path.join(work, f), { force: true });
  } catch (e) {
    console.error(`[project ${id}]`, e);
    projects.update(id, { status: 'failed', error: (e as Error).message || String(e) });
  }
}

const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
function savingsText(dir: string) {
  const s = footageSavings(dir);
  if (!s || !s.full || s.full <= s.downloaded) return '';
  return `Downloaded ${mb(s.downloaded)} instead of ~${mb(s.full)}`;
}

/** Section mode: download the video only for the clips, all in one go (no-op for full downloads). */
async function fetchClipFootage(projectId: string, list: ClipRow[]) {
  const p = projects.get(projectId);
  const dir = projectDir(projectId);
  if (!p || !list.length || !readFootage(dir)) return;
  stage(projectId, 'render', 0, 'Downloading only the clip parts…');
  try {
    await prefetchFootage(p, dir, list.map((c) => ({ start: c.start, end: c.end })), (done, total, detail) =>
      stage(projectId, 'render', (done / total) * 0.3, `Downloading only the clip parts · ${detail}`),
    );
  } catch (e) {
    // Not fatal here: each clip retries its own part when it renders, and shows an error if that fails too.
    console.warn(`[project ${projectId}] part download failed:`, (e as Error).message);
  }
}

/** Project thumbnail from the video's poster image (section mode has no local video yet). */
async function remoteThumbnail(url: string, out: string, work: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`thumbnail ${res.status}`);
  const tmp = path.join(work, 'poster.img');
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  await run(config.ffmpeg, ['-y', '-v', 'error', '-i', tmp, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3', out], { timeoutMs: 30_000 });
  fs.rmSync(tmp, { force: true });
}

async function renderAll(projectId: string, list: ClipRow[]) {
  let done = 0;
  const total = list.length;
  const base = readFootage(projectDir(projectId)) ? 0.3 : 0; // the first 30% was the part download
  stage(projectId, 'render', base, `Reframing & rendering 0 of ${total}`);
  await pool(list, config.renderConcurrency, async (c) => {
    await renderClipJob(c.id).catch(() => {});
    done++;
    stage(projectId, 'render', base + (1 - base) * (done / total), `Reframing & rendering ${done} of ${total}`);
  });
}

const inflight = new Map<string, Promise<void>>();
const again = new Set<string>();

/** Reframe (face tracking via Gemini) + captions + encode one clip. Safe to call again after edits:
 *  a call that arrives mid-render is coalesced into one re-render after the current one finishes. */
export function renderClipJob(clipId: string): Promise<void> {
  const cur = inflight.get(clipId);
  if (cur) {
    again.add(clipId);
    return cur;
  }
  const job = (async () => {
    try {
      await renderOnce(clipId);
    } finally {
      inflight.delete(clipId);
      if (again.delete(clipId)) await renderClipJob(clipId);
    }
  })();
  inflight.set(clipId, job);
  return job;
}

const near = (a: number | undefined, b: number) => a != null && Math.abs(a - b) < 0.05;

/** Parts of a clip: one continuous range, or several joined together. */
export const clipParts = (c: Pick<ClipRow, 'start' | 'end' | 'segments'>): TimeRange[] => (c.segments?.length ? c.segments : [{ start: c.start, end: c.end }]);

async function renderOnce(clipId: string) {
  const c = clipDb.get(clipId);
  if (!c) return;
  const p = projects.get(c.projectId);
  if (!p?.mediaPath && !readFootage(projectDir(c.projectId))) return;
  clipDb.update(clipId, { status: 'rendering', error: null });
  const dir = projectDir(p!.id);
  const work = path.join(dir, 'work', `clip_${c.id}_${Date.now()}`);
  fs.mkdirSync(work, { recursive: true });
  try {
    const parts = clipParts(c);
    const style = (c.captionStyle || 'pop') as CaptionStyle;
    const wantsText = !(style === 'none' && !c.showHook);
    const canText = wantsText && (await hasLibass());
    const oldPlans = c.reframe?.parts ?? (c.reframe ? [c.reframe] : []);
    const version = (c.version ?? 0) + 1;
    const out = path.join(dir, 'clips', `${c.id}_v${version}.mp4`);
    const needsPost = parts.length > 1 || c.music.track !== 'none';

    const plans: ReframePlan[] = [];
    const files: string[] = [];
    let hasVoice = false;
    let total = 0;
    for (const [i, seg] of parts.entries()) {
      // where the pixels come from: the full video, or just the downloaded part around this piece
      const foot = await footageFor(projects.get(p!.id) ?? p!, dir, seg.start, seg.end);
      const ls = seg.start - foot.offset;
      const le = seg.end - foot.offset;
      let plan = oldPlans.find((pl) => near(pl.start, seg.start) && near(pl.end, seg.end)) ?? null;
      if (!plan) {
        const fresh = await planReframe({ src: foot.src, start: ls, end: le, width: foot.width, height: foot.height, workDir: work, layout: c.layout as Layout });
        plan = { ...fresh, start: seg.start, end: seg.end };
      }
      let want = c.layout === 'auto' ? plan.suggested ?? plan.layout : (c.layout as typeof plan.layout);
      if (want === 'split' && !plan.splitCenters) want = 'fit'; // fewer than two faces found
      plan = { ...plan, layout: want };
      plans.push(plan);

      const dur = seg.end - seg.start;
      const words = wordsInRange(p!.transcript ?? [], seg.start, seg.end);
      const first = i === 0;
      const ass = canText ? buildAss({ words, duration: dur, style, layout: plan.layout, hook: first ? c.hook : '', showHook: first && c.showHook }) : null;
      const partOut = needsPost ? path.join(work, `part_${i}.mp4`) : out;
      await renderClip({
        src: foot.src,
        start: ls,
        end: le,
        width: foot.width,
        height: foot.height,
        hasAudio: foot.hasAudio,
        plan,
        assContent: ass,
        workDir: path.join(work, `r${i}`),
        out: partOut,
        motion: c.motion,
        zooms: planZooms(words, dur, c.motion),
        introZoom: c.motion === 'dynamic' && first,
      });
      files.push(partOut);
      hasVoice ||= foot.hasAudio;
      total += dur;
    }

    let current = files[0];
    if (files.length > 1) {
      current = path.join(work, 'joined.mp4');
      await concatParts(files, current, work);
    }
    const notes: string[] = [];
    if (wantsText && !canText) notes.push('Captions were skipped: the custom ffmpeg set in FFMPEG_PATH can’t draw text. Remove FFMPEG_PATH from .env to use the built-in one, then re-render.');
    if (c.music.track !== 'none') {
      try {
        const m = await resolveMusic(c.music.track, c.category);
        if (m) {
          const mixed = path.join(work, 'music.mp4');
          await mixMusic({ input: current, music: m.file, volume: c.music.volume, duck: c.music.duck, hasVoice, duration: total, out: mixed });
          current = mixed;
        }
      } catch (e) {
        notes.push(`Music skipped — ${(e as Error).message}`);
      }
    }
    if (current !== out) fs.renameSync(current, out);

    const thumbOut = path.join(dir, 'clips', `${c.id}_v${version}.jpg`);
    await thumbnail(out, Math.min(1.2, total / 3), thumbOut, 540).catch(() => {});

    // remove the previous render
    for (const old of [c.filePath, c.thumbPath]) if (old && old !== out && fs.existsSync(old)) fs.rmSync(old, { force: true });
    const aud = partsScore(p!, parts);
    clipDb.update(clipId, {
      status: 'ready',
      error: notes.join(' ') || null,
      filePath: out,
      thumbPath: fs.existsSync(thumbOut) ? thumbOut : null,
      version,
      reframe: plans.length > 1 ? { ...plans[0], parts: plans } : plans[0],
      ...(aud != null ? { audienceScore: aud } : {}),
    });
  } catch (e) {
    console.error(`[clip ${clipId}]`, e);
    clipDb.update(clipId, { status: 'failed', error: (e as Error).message || String(e) });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Audience score of a (multi-part) clip = length-weighted average of its parts. */
function partsScore(p: ProjectRow, parts: TimeRange[]) {
  let sum = 0;
  let w = 0;
  for (const r of parts) {
    const v = rangeScore(p.signals, p.duration ?? 0, r.start, r.end);
    if (v == null) continue;
    sum += v * (r.end - r.start);
    w += r.end - r.start;
  }
  return w ? Math.round(sum / w) : null;
}

function clipDefaults(o: ProjectOptions): ClipDefaults {
  return {
    layout: o.layout,
    captionStyle: o.captionStyle,
    showHook: o.showHook,
    motion: o.motion ?? 'subtle',
    music: { track: o.music ?? 'none', volume: o.musicVolume ?? 15, duck: true },
  };
}

// ---------------- parts picked by hand ----------------
const coveredPath = (dir: string) => path.join(dir, 'work', 'covered.json');
/** Which time ranges have a transcript. null = the whole video. */
function readCovered(dir: string): TimeRange[] | null {
  try {
    return JSON.parse(fs.readFileSync(coveredPath(dir), 'utf8'));
  } catch {
    return null;
  }
}

/** Make sure these ranges have a transcript (projects built from picked parts only transcribe what they need). */
async function ensureTranscript(projectId: string, ranges: TimeRange[], onProgress?: (done: number, total: number) => void): Promise<Segment[]> {
  const p = projects.get(projectId)!;
  const dir = projectDir(projectId);
  const covered = readCovered(dir);
  let segs = p.transcript ?? [];
  if (covered === null && segs.length) return segs;
  const cov = covered ?? [];
  const missing = ranges.filter((r) => !cov.some((c) => c.start <= r.start + 0.5 && c.end >= r.end - 0.5));
  for (const [i, r] of missing.entries()) {
    const s0 = Math.max(0, r.start - 1.5);
    const e0 = Math.min(p.duration || r.end + 1.5, r.end + 1.5);
    const foot = await footageFor(projects.get(projectId) ?? p, dir, s0, e0);
    const sub = path.join(dir, 'work', `tr_${Math.round(s0)}_${Math.round(e0)}`);
    fs.mkdirSync(sub, { recursive: true });
    try {
      const audio = path.join(sub, 'audio.mp3');
      await extractAudioRange(foot.src, s0 - foot.offset, e0 - s0, audio);
      const tr = await transcribe(audio, e0 - s0, sub, p.options.language, (d, t) => onProgress?.(i + d / t, missing.length));
      const shifted = tr.segments.map((sg) => ({ ...sg, s: sg.s + s0, e: sg.e + s0, words: sg.words.map((w) => ({ ...w, s: w.s + s0, e: w.e + s0 })) }));
      segs = [...segs.filter((sg) => sg.e <= s0 || sg.s >= e0), ...shifted].sort((a, b) => a.s - b.s);
      cov.push({ start: s0, end: e0 });
    } finally {
      fs.rmSync(sub, { recursive: true, force: true });
    }
  }
  projects.update(projectId, { transcript: segs });
  fs.writeFileSync(coveredPath(dir), JSON.stringify(cov));
  return segs;
}

/** Tidy picked ranges: clamp to the video, merge overlaps, snap to sentence edges. */
function tidyRanges(ranges: TimeRange[], segs: Segment[], sil: { s: number; e: number }[], duration: number): TimeRange[] {
  const sorted = ranges
    .map((r) => ({ start: Math.max(0, Math.min(r.start, r.end)), end: Math.min(duration || Infinity, Math.max(r.start, r.end)) }))
    .filter((r) => r.end - r.start >= 1)
    .sort((a, b) => a.start - b.start);
  const merged: TimeRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged.map((r) => {
    if (!segs.length) return r;
    const s = snapRange(r.start, r.end, segs, sil, duration);
    return s.end - s.start >= Math.min(3, (r.end - r.start) * 0.7) ? { start: +s.start.toFixed(3), end: +s.end.toFixed(3) } : r;
  });
}

/** Group ranges into clips (each range its own clip, or all joined into one) and write their packaging with Gemini. */
async function packagePicked(p: ProjectRow, groups: TimeRange[][], segs: Segment[]) {
  const described = await describeClips({
    title: p.title ?? 'Untitled',
    channel: p.channel ?? '',
    options: p.options,
    clips: groups.map((g) => ({ parts: g, segments: segs.filter((s) => g.some((r) => s.e > r.start && s.s < r.end)) })),
  });
  return groups.map((g, i) => {
    const d = described[i];
    const ai = aiScore(d.rubric);
    const aud = partsScore(p, g);
    return {
      ...d,
      start: g[0].start,
      end: g[g.length - 1].end,
      segments: g.length > 1 ? g : null,
      aiScore: ai,
      audienceScore: aud,
      peakScore: aud == null ? ai : Math.round(ai * 0.6 + aud * 0.4),
    };
  });
}

function groupRanges(ranges: TimeRange[], join: boolean): TimeRange[][] {
  const capped: TimeRange[][] = join ? [ranges] : ranges.map((r) => [r]);
  // keep every clip within 3 minutes
  return capped.map((g) => {
    let total = 0;
    const out: TimeRange[] = [];
    for (const r of g) {
      const room = 180 - total;
      if (room < 1) break;
      const e = Math.min(r.end, r.start + room);
      out.push({ start: r.start, end: e });
      total += e - r.start;
    }
    return out;
  });
}

/** Explore → "Clip the parts I picked": fetch only those parts, transcribe them, package + render. */
async function processPickedParts(id: string) {
  const p0 = projects.get(id)!;
  const dir = projectDir(id);
  const work = path.join(dir, 'work');
  stage(id, 'fetch', 0, 'Reading the link…');
  const info = await fetchInfo(p0.sourceUrl!, infoJsonPath(dir));
  const duration = info.duration || 0;
  projects.update(id, { title: info.title, channel: info.channel, description: info.description, duration, viewCount: info.viewCount });
  const thumb = path.join(dir, 'thumb.jpg');
  if (info.thumbnail && !fs.existsSync(thumb)) await remoteThumbnail(info.thumbnail, thumb, work).catch(() => {});
  if (fs.existsSync(thumb)) projects.update(id, { thumbPath: thumb });

  const picked = (p0.options.ranges ?? [])
    .map((r) => ({ start: Math.max(0, r.start), end: duration ? Math.min(duration, r.end) : r.end }))
    .filter((r) => r.end - r.start >= 1);
  if (!picked.length) throw new Error('The picked parts are outside this video.');

  // only the picked parts of the video are downloaded
  if (!readFootage(dir) && !(p0.mediaPath && fs.existsSync(p0.mediaPath))) startSectionMode(dir, info.webpageUrl, info.fullSizeEstimate);
  stage(id, 'fetch', 0.2, 'Downloading only the parts you picked…');
  await prefetchFootage(projects.get(id)!, dir, picked, (done, total, detail) => stage(id, 'fetch', 0.2 + (done / total) * 0.75, `Downloading only the parts you picked · ${detail}`));
  const first = await footageFor(projects.get(id)!, dir, picked[0].start, picked[0].end);
  projects.update(id, { mediaPath: first.src, width: first.width, height: first.height });
  stage(id, 'fetch', 1, 'Parts ready');

  stage(id, 'transcribe', 0, 'Transcribing your parts…');
  const segs = await ensureTranscript(id, picked, (d, t) => stage(id, 'transcribe', d / t, `Transcribing part ${Math.min(t, Math.floor(d) + 1)} of ${t}`));

  stage(id, 'moments', 0.2, 'Writing titles and hooks…');
  const signals: Signals = buildSignals({ duration, heatmap: info.heatmap, chapters: info.chapters, comments: [], rmsPerSecond: null, useAudience: true });
  projects.update(id, { signals });
  const p = projects.get(id)!;
  const ranges = tidyRanges(picked, segs, [], duration);
  const list = await packagePicked(p, groupRanges(ranges, Boolean(p.options.joinRanges)), segs);
  const saved = clipDb.replaceForProject(id, list, clipDefaults(p.options), 'manual');
  stage(id, 'moments', 1, `${saved.length} clip${saved.length > 1 ? 's' : ''} ready to render`);

  await renderAll(id, saved);
  projects.update(id, { status: 'done', stage: 'done', progress: 100, stageDetail: savingsText(dir) });
}

/** Project page → "clip the parts I selected on the graph". Creates the clips now; `prepare` fills them in. */
export function createPickedClips(projectId: string, ranges: TimeRange[], join: boolean): ClipRow[] {
  const p = projects.get(projectId);
  if (!p) throw new Error('Project not found');
  const dur = p.duration || Infinity;
  const clean = ranges
    .map((r) => ({ start: Math.max(0, Math.min(r.start, r.end)), end: Math.min(dur, Math.max(r.start, r.end)) }))
    .filter((r) => r.end - r.start >= 1)
    .sort((a, b) => a.start - b.start);
  if (!clean.length) throw new Error('Pick at least one part that is 1 second or longer.');
  const groups = groupRanges(clean, join);
  const rows = groups.map((g, i) => ({
    start: g[0].start,
    end: g[g.length - 1].end,
    segments: g.length > 1 ? g : null,
    title: `Your pick${groups.length > 1 ? ` #${i + 1}` : ''} · ${formatClock(g[0].start)}`,
    hook: '',
    description: '',
    hashtags: [] as string[],
    reason: 'Picked by you on the graph — writing the title and hook…',
    category: 'insight',
    rubric: { hook: 5, standalone: 5, payoff: 5, emotion: 5, shareability: 5, pacing: 5, loop: 5, lengthFit: 5, trend: 5 },
    aiScore: 50,
    audienceScore: partsScore(p, g),
    peakScore: 50,
  }));
  return clipDb.insert(projectId, rows, clipDefaults(p.options), undefined, 'manual');
}

/** Fill in picked clips: transcript for any new part, snap edges, Gemini titles/hooks/scores. Then they're ready to render. */
export async function preparePickedClips(projectId: string, clipIds: string[]) {
  const dir = projectDir(projectId);
  const list = clipIds.map((id) => clipDb.get(id)).filter((c): c is ClipRow => Boolean(c));
  if (!list.length) return;
  try {
    const all = list.flatMap((c) => clipParts(c));
    if (readFootage(dir)) await prefetchFootage(projects.get(projectId)!, dir, all);
    const segs = await ensureTranscript(projectId, all);
    const p = projects.get(projectId)!;
    const sil = silencesFor(projectId);
    const groups = list.map((c) => tidyRanges(clipParts(c), segs, sil, p.duration ?? 0));
    const packaged = await packagePicked(p, groups, segs);
    list.forEach((c, i) => {
      const k = packaged[i];
      clipDb.update(c.id, {
        start: k.start,
        end: k.end,
        segments: k.segments,
        title: k.title,
        hook: k.hook,
        description: k.description,
        hashtags: k.hashtags,
        reason: k.reason,
        category: k.category,
        rubric: k.rubric,
        aiScore: k.aiScore,
        peakScore: k.peakScore,
        ...(k.audienceScore != null ? { audienceScore: k.audienceScore } : {}),
      });
    });
  } catch (e) {
    for (const c of list) clipDb.update(c.id, { status: 'failed', error: `Couldn’t prepare this clip: ${(e as Error).message}` });
    throw e;
  }
}

const formatClock = (t: number) => {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

function silencesFor(projectId: string): { s: number; e: number }[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectDir(projectId), 'work', 'silences.json'), 'utf8'));
  } catch {
    return [];
  }
}

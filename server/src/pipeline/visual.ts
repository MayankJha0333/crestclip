import fs from 'node:fs';
import path from 'node:path';
import type { Part } from '@google/genai';
import { config } from '../config.js';
import { pool, run } from '../lib/proc.js';
import { deleteFromGcs, generateJson, part, uploadToGcs } from './gemini.js';
import { framesAt, sceneCuts } from './media.js';
import { cleanTitle, rangeFor, wordingRule } from './moments.js';
import { formatTime } from './signals.js';
import { spokenWords } from './transcribe.js';
import type { ClipCandidate, ProjectOptions, Segment, Signals } from '../types.js';

/**
 * No-speech mode: videos with no talking (ASMR, unboxings with music, gameplay, sports, cooking, product demos).
 * There is no transcript to pick moments from, so the AI WATCHES the video and picks them by what happens on screen.
 *
 * Long videos are watched in windows of ~30 minutes (a 3-hour video = 6 calls, run a few at a time), so no single
 * call is too big for the model and one slow window can't sink the whole video. Each window gets its own share of
 * the clips asked for; the best ones across all windows are kept.
 *
 * How the AI sees the video, best first:
 *   1. a YouTube link: the model watches it straight from YouTube (nothing to upload)
 *   2. a file (upload, Drive, any downloaded link) + GCS_BUCKET: a small 360p copy per window, uploaded and deleted after
 *   3. otherwise: still frames taken every few seconds, sent as pictures
 */

// ---------------- when to use it ----------------

/** Too little talking to pick clips from words: under 12 words, or under 4 words a minute on anything 5 min or longer. */
export function tooLittleSpeech(segs: Pick<Segment, 'text'>[] | null | undefined, duration: number): boolean {
  const words = spokenWords(segs ?? []);
  if (words < 12) return true;
  return duration >= 300 && words / (duration / 60) < 4;
}

/** Almost nothing but silence (the measured pauses cover ≥ 92% of it): no point asking anyone to transcribe. */
export function mostlySilent(silences: { s: number; e: number }[], duration: number): boolean {
  if (!duration) return false;
  const quiet = silences.reduce((a, x) => a + Math.max(0, Math.min(duration, x.e) - Math.max(0, x.s)), 0);
  return quiet / duration >= 0.92;
}

// ---------------- windows ----------------

export const WINDOW = 30 * 60; // seconds per watch
const OVERLAP = 30; // windows overlap a little so a moment on the border isn't cut in two
const SINGLE_MAX = 40 * 60; // up to this long, one watch covers the whole video

export interface Window {
  start: number;
  end: number;
}

export function windowsFor(duration: number): Window[] {
  if (duration <= SINGLE_MAX) return [{ start: 0, end: duration }];
  const out: Window[] = [];
  for (let s = 0; s < duration; s += WINDOW) {
    const e = Math.min(duration, s + WINDOW + OVERLAP);
    out.push({ start: s, end: e });
    if (e >= duration) break;
  }
  // a short tail (< 5 min) joins the window before it
  const last = out[out.length - 1];
  if (out.length > 1 && last.end - last.start < 5 * 60) {
    out[out.length - 2].end = last.end;
    out.pop();
  }
  return out;
}

/** Frames per second the model looks at: more for short videos (quick reveals), fewer for long windows. */
export const fpsFor = (len: number) => (len <= 300 ? 2 : len <= SINGLE_MAX ? 1 : 0.5);

/** How many candidates to ask a window for: its share of the clips (by length), with room to choose. */
export function askFor(want: number, w: Window, duration: number, windows: number): number {
  if (windows === 1) return Math.min(30, Math.ceil(want * 1.6) + 2);
  return Math.max(3, Math.min(15, Math.ceil(((want * (w.end - w.start)) / duration) * 1.6) + 2));
}

/**
 * The model's times → seconds in the whole video. For a window watched as its own file the times start at 0; for a
 * window of a YouTube link (watched with start/end offsets) the model may answer either way, so it's worked out from
 * the answers themselves: times mostly past the window's own length can only be whole-video times.
 */
export function toVideoTime(cands: { start: number; end: number }[], w: Window, mode: 'relative' | 'auto'): (t: number) => number {
  const len = w.end - w.start;
  if (mode === 'relative' || w.start === 0) return (t) => w.start + t;
  const starts = cands
    .map((c) => Number(c.start))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const median = starts.length ? starts[Math.floor(starts.length / 2)] : 0;
  return median > len + 5 ? (t) => t : (t) => w.start + t;
}

// ---------------- the AI call ----------------

const CATEGORIES = ['reveal', 'satisfying', 'action', 'reaction', 'humor', 'surprising', 'emotional', 'educational', 'relatable', 'story'];

const schema = {
  type: 'object',
  properties: {
    notes: { type: 'string', description: 'one or two sentences: what this video shows and where its best moments are' },
    video_title: { type: 'string', description: 'a natural title for the whole video, as its creator might name it (<= 70 chars, no hashtags)' },
    clips: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number', description: 'seconds, where the clip starts (the start of the build-up, never mid-action)' },
          end: { type: 'number', description: 'seconds, right after the payoff is fully shown' },
          title: { type: 'string', description: 'post title, <= 70 chars, curiosity-driven, no clickbait lies' },
          hook: { type: 'string', description: 'the best on-screen headline for the first 3 seconds, <= 8 words' },
          hooks: { type: 'array', items: { type: 'string' }, description: 'exactly 3 headline options from different angles; the first equals `hook`' },
          description: { type: 'string', description: '1-2 sentence post caption with a question or CTA' },
          hashtags: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string', description: 'what happens on screen and why people will watch to the end, plain words, <= 30 words' },
          category: { type: 'string', enum: CATEGORIES },
          hook_s: { type: 'number' },
          standalone: { type: 'number' },
          payoff: { type: 'number' },
          emotion: { type: 'number' },
          shareability: { type: 'number' },
          pacing: { type: 'number' },
          loop: { type: 'number' },
          length_fit: { type: 'number' },
          trend: { type: 'number' },
        },
        required: [
          'start',
          'end',
          'title',
          'hook',
          'hooks',
          'description',
          'hashtags',
          'reason',
          'category',
          'hook_s',
          'standalone',
          'payoff',
          'emotion',
          'shareability',
          'pacing',
          'loop',
          'length_fit',
          'trend',
        ],
      },
    },
  },
  required: ['clips'],
};

const SYSTEM = `You are CrestClip, a world-class short-form video editor. This video has NO talking — think unboxings and reveals, ASMR, product demos, cooking, crafts, gameplay, sports, stunts, pets, music-backed vlogs. You WATCH it and pick the moments that will make strangers stop scrolling, watch to the end, rewatch and share — for TikTok, YouTube Shorts and Instagram Reels.

What makes a no-talking clip work:
- A visible mini-arc: set-up → build-up → PAYOFF (the reveal, the finished result, the trick landing, the goal, the reaction, the satisfying moment). The payoff must be fully on screen before the clip ends.
- Something changes every couple of seconds; skip dead stretches, slow set-up and repeated footage.
- Strong visuals: motion, close-ups, colour, faces reacting, hands doing something interesting, a clear before/after.
- Satisfying sounds count (unwrapping, crunching, clicking) — the original sound stays in the clip.

Rules for every clip:
1. START a beat before the action that leads to the payoff — never mid-motion, never on a blank or black frame.
2. END right after the payoff has fully landed — never mid-reveal.
3. Clips must not overlap each other by more than a few seconds. Spread across the video.
4. Times are seconds on the video's own timeline (the clock you see while watching). Never invent moments you did not see.

PACKAGING (nobody speaks, so describe what we SEE):
- hooks: 3 on-screen headlines from different angles (curiosity, bold claim, question) about what is about to happen. Short, concrete, no clickbait lies, no hashtags. The first is your best and equals "hook".
- title, description, hashtags: about what is shown (product names, places, games only when clearly visible).

Score each clip 0-10 (be a harsh, honest critic — average moments 4-6, only truly great ones 8+):
- hook_s: do the first ~3 s grab attention visually?
- standalone: understandable without the rest of the video?
- payoff: is there a clear visual payoff that lands before the end?
- emotion: intensity (wow, cute, satisfying, funny, tense)
- shareability: would someone send this to a friend?
- pacing: something new every few seconds?
- loop: ends cleanly or loops back to the start?
- length_fit: natural length within the requested range?
- trend: a recognisable product, game, place or trend?`;

type Raw = { notes?: string; video_title?: string; clips: (Record<string, unknown> & { start: number; end: number })[] };

const clamp10 = (v: unknown) => Math.max(0, Math.min(10, Number(v) || 0));

function toCandidate(c: Raw['clips'][number], toTime: (t: number) => number, w: Window): ClipCandidate | null {
  let start = toTime(Number(c.start));
  let end = toTime(Number(c.end));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  start = Math.max(w.start, start);
  end = Math.min(w.end, end);
  if (end - start < 2) return null;
  const hooks = [c.hook, ...(Array.isArray(c.hooks) ? c.hooks : [])]
    .map((h) =>
      String(h ?? '')
        .trim()
        .slice(0, 80),
    )
    .filter(Boolean);
  return {
    start,
    end,
    title: String(c.title || '').slice(0, 100),
    hook: String(c.hook || '').slice(0, 80),
    hooks: [...new Map(hooks.map((h) => [h.toLowerCase(), h])).values()].slice(0, 3),
    keywords: [],
    teaser: null,
    description: String(c.description || ''),
    hashtags: (Array.isArray(c.hashtags) ? c.hashtags : []).map((h) => '#' + String(h).replace(/^#+/, '').replace(/\s+/g, '')).slice(0, 6),
    reason: String(c.reason || ''),
    category: CATEGORIES.includes(String(c.category)) ? String(c.category) : 'surprising',
    rubric: {
      hook: clamp10(c.hook_s),
      standalone: clamp10(c.standalone),
      payoff: clamp10(c.payoff),
      emotion: clamp10(c.emotion),
      shareability: clamp10(c.shareability),
      pacing: clamp10(c.pacing),
      loop: clamp10(c.loop),
      lengthFit: clamp10(c.length_fit),
      trend: clamp10(c.trend),
    },
  };
}

// ---------------- what the model watches ----------------

export type VisualSource = { kind: 'youtube'; url: string } | { kind: 'file'; src: string };

interface Watch {
  parts: Part[];
  mode: 'relative' | 'auto';
  cleanup: () => void;
}

/** A small low-res copy of one part of the video (accurate start: re-encoded, not stream-copied). Default 360p, 10 fps. */
export async function previewCut(src: string, w: Window, out: string, look: { height?: number; fps?: number } = {}) {
  await run(
    config.ffmpeg,
    [
      '-y',
      '-v',
      'error',
      '-ss',
      w.start.toFixed(3),
      '-t',
      (w.end - w.start).toFixed(3),
      '-i',
      src,
      '-vf',
      `scale=-2:${look.height ?? 360},fps=${look.fps ?? 10}`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '32',
      '-c:a',
      'aac',
      '-b:a',
      '48k',
      '-ac',
      '1',
      out,
    ],
    { timeoutMs: 60 * 60 * 1000 },
  );
}

/** Still frames every few seconds, labelled with their time — when the video itself can't be sent. */
async function framesWatch(src: string, w: Window, dir: string): Promise<Watch> {
  const len = w.end - w.start;
  const count = Math.max(8, Math.min(150, Math.round(len / 2)));
  const times = Array.from({ length: count }, (_, i) => +(((i + 0.5) * len) / count).toFixed(2));
  const files = await framesAt(src, w.start, times, dir, 384);
  const parts: Part[] = [part.text(`Below are ${files.length} still frames from the video, in order, each labelled with its time in seconds.`)];
  files.forEach((f, i) => parts.push(part.text(`t=${(w.start + times[i]).toFixed(1)}s`), part.file(f, 'image/jpeg')));
  return { parts, mode: 'relative', cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function watchWindow(source: VisualSource, w: Window, single: boolean, work: string, id: string, i: number): Promise<Watch & { framesOnly: boolean }> {
  const fps = fpsFor(w.end - w.start);
  if (source.kind === 'youtube' && config.sendVideoToGemini) {
    const meta = single ? { fps } : { fps, startOffset: `${Math.round(w.start)}s`, endOffset: `${Math.round(w.end)}s` };
    return { parts: [part.uri(source.url, 'video/mp4', meta)], mode: single ? 'relative' : 'auto', cleanup: () => {}, framesOnly: false };
  }
  if (source.kind === 'file' && config.sendVideoToGemini && config.gcsBucket) {
    const proxy = path.join(work, `watch_${i}.mp4`);
    const object = `crestclip/tmp/${id}/watch_${i}.mp4`; // temporary — deleted right after the model has watched it
    try {
      await previewCut(source.src, w, proxy);
      const uri = await uploadToGcs(proxy, object, 'video/mp4');
      return {
        parts: [part.uri(uri, 'video/mp4', { fps })],
        mode: 'relative',
        cleanup: () => {
          fs.rmSync(proxy, { force: true });
          void deleteFromGcs(object);
        },
        framesOnly: false,
      };
    } catch (e) {
      fs.rmSync(proxy, { force: true });
      console.warn(`[visual] window ${i + 1}: couldn't send the video (${(e as Error).message}) — using still frames`);
    }
  }
  if (source.kind === 'file') return { ...(await framesWatch(source.src, w, path.join(work, `watch_frames_${i}`))), framesOnly: true };
  throw new Error('This video has no talking, and CrestClip couldn’t watch it. Try again in a few minutes, or upload the video file.');
}

// ---------------- main ----------------

export async function findVisualMoments(input: {
  id: string;
  source: VisualSource;
  duration: number;
  work: string;
  title: string;
  channel: string;
  description: string;
  signals: Signals | null;
  options: ProjectOptions;
  onProgress: (frac: number, detail: string) => void;
}): Promise<{ clips: ClipCandidate[]; notes: string; videoTitle: string | null }> {
  const { options, duration } = input;
  const range = rangeFor(options);
  const want = Math.max(1, Math.min(30, options.clipCount));
  if (config.fakeAi) return { clips: fakeVisual(duration, range, want), notes: 'Fake AI mode — clips are placeholders.', videoTitle: null };

  const windows = windowsFor(duration);
  const single = windows.length === 1;
  const short = duration <= range.max * 1.3;
  const hot = input.signals?.hotspots?.length
    ? input.signals.hotspots
        .map((h) => `- ${formatTime(h.start)}–${formatTime(h.end)} (${h.start.toFixed(0)}s–${h.end.toFixed(0)}s), strength ${(h.value * 100).toFixed(0)}%, from ${h.source}`)
        .join('\n')
    : '';

  let done = 0;
  const results = await pool(windows, 3, async (w, i) => {
    let watch: Awaited<ReturnType<typeof watchWindow>> | null = null;
    const ask = askFor(want, w, duration, windows.length);
    const inWindow = hot ? input.signals!.hotspots.filter((h) => h.end > w.start && h.start < w.end) : [];
    try {
      watch = await watchWindow(input.source, w, single, input.work, input.id, i);
      const where = single
        ? `the whole video (${formatTime(duration)}, ${duration.toFixed(0)} s)`
        : `part ${i + 1} of ${windows.length}: ${formatTime(w.start)}–${formatTime(w.end)} of a ${formatTime(duration)} video. ${watch.mode === 'relative' && !watch.framesOnly ? `Give times in seconds from the START OF THIS PART (0 = ${formatTime(w.start)}).` : 'Give times in seconds on the full video’s timeline.'}`;
      const prompt = `VIDEO: "${input.title}"${input.channel ? ` by ${input.channel}` : ''} — nobody talks in it.
You are watching ${where}
Target clip length: ${range.label}. Hard limits: ${range.min}–${range.max} s.
${options.captionLanguage === 'english' || !options.captionLanguage ? '' : wordingRule(options)}${short ? `\nThis video is short: return the 1–${Math.min(3, ask)} best cuts. Using almost the whole video is fine when all of it is good.` : `\nReturn the ${ask} best clip candidates, best first.`}
${options.focus ? `Creator's focus request: "${options.focus}" — prioritize moments that match it.` : ''}
${options.rules?.length ? `\nTHE CREATOR'S RULES — every clip MUST follow these:\n${options.rules.map((r) => `- ${r}`).join('\n')}` : ''}
${options.instructions && !options.rules?.length ? `\nTHE CREATOR'S INSTRUCTIONS (follow them):\n${options.instructions.slice(0, 2500)}` : ''}
${inWindow.length ? `\nMOMENTS VIEWERS REWATCH OR LOUD MOMENTS (full-video times — a hint where to look, not an exact cut):\n${inWindow.map((h) => `- ${formatTime(h.start)}–${formatTime(h.end)}`).join('\n')}` : ''}
${input.description ? `\nVIDEO DESCRIPTION (context only):\n${input.description.slice(0, 1200)}` : ''}`;

      const raw = await generateJson<Raw>({
        system: SYSTEM,
        parts: [...watch.parts, part.text(prompt)],
        schema,
        thinking: 'MEDIUM',
        lowMediaRes: !watch.framesOnly && !short,
        maxOutputTokens: 24000,
        timeoutMs: 8 * 60_000,
        label: single ? 'watch the video' : `watch part ${i + 1}/${windows.length}`,
      });
      const list = Array.isArray(raw.clips) ? raw.clips : [];
      // still frames are labelled with full-video times; video windows answer from 0 (or either way, for YouTube)
      const toTime = watch.framesOnly ? (t: number) => t : toVideoTime(list, w, watch.mode);
      return { clips: list.map((c) => toCandidate(c, toTime, w)).filter((c): c is ClipCandidate => Boolean(c)), notes: raw.notes ?? '', videoTitle: cleanTitle(raw.video_title) };
    } catch (e) {
      // one bad window doesn't sink the whole video — unless every window fails (checked below)
      console.warn(`[visual] ${single ? 'watching the video' : `part ${i + 1}/${windows.length}`} failed:`, (e as Error).message);
      if (single) throw e;
      return { clips: [] as ClipCandidate[], notes: '', videoTitle: null as string | null };
    } finally {
      watch?.cleanup();
      done++;
      input.onProgress(done / windows.length, single ? 'Watched the video' : `Watched part ${done} of ${windows.length}`);
    }
  });

  const clips = results.flatMap((r) => r.clips);
  if (!clips.length && windows.length > 1) throw new Error('The AI couldn’t watch this video. Please try again in a few minutes.');
  const notes = results.map((r) => r.notes).find(Boolean) ?? '';
  return { clips, notes, videoTitle: results.map((r) => r.videoTitle).find(Boolean) ?? null };
}

/**
 * Put clip edges on camera cuts when one is close (≤ 1.5 s): a clip that starts on a fresh shot and ends as a shot
 * ends looks edited, not chopped. Needs the video file here (skipped while a long YouTube video is audio-only).
 */
export async function snapToShots<T extends { start: number; end: number }>(clips: T[], src: string, duration: number): Promise<T[]> {
  const near = async (t: number) => {
    const from = Math.max(0, t - 1.5);
    const cuts = await sceneCuts(src, from, Math.min(3, duration - from)).catch(() => [] as number[]);
    return cuts.map((c) => from + c).sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0];
  };
  return pool(clips, 3, async (c) => {
    const s = await near(c.start);
    const e = await near(c.end);
    let start = s != null && Math.abs(s - c.start) <= 1.5 ? s + 0.04 : c.start;
    let end = e != null && Math.abs(e - c.end) <= 1.5 ? e - 0.04 : c.end;
    if (end - start < 3) [start, end] = [c.start, c.end];
    return { ...c, start: +Math.max(0, start).toFixed(3), end: +Math.min(duration, end).toFixed(3) };
  });
}

function fakeVisual(duration: number, range: { min: number; max: number }, n: number): ClipCandidate[] {
  const len = Math.min((range.min + range.max) / 2, duration * 0.9);
  const step = Math.max(len + 1, (duration - len) / Math.max(1, n));
  const out: ClipCandidate[] = [];
  for (let t = 0, i = 0; t + Math.min(len, 4) <= duration && i < n; t += step, i++)
    out.push({
      start: t,
      end: Math.min(duration, t + len),
      title: 'The reveal at the end is worth it',
      hook: 'Wait for the reveal',
      hooks: ['Wait for the reveal', 'You won’t guess what’s inside', 'Is this the best one yet?'],
      keywords: [],
      teaser: null,
      description: 'Did you see that coming? 👀',
      hashtags: ['#unboxing', '#satisfying'],
      reason: 'Clear build-up and a visual payoff.',
      category: 'reveal',
      rubric: { hook: 6, standalone: 7, payoff: 7, emotion: 6, shareability: 6, pacing: 6, loop: 5, lengthFit: 8, trend: 4 },
    });
  return out;
}

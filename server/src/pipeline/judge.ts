import fs from 'node:fs';
import path from 'node:path';
import type { Part } from '@google/genai';
import { config } from '../config.js';
import { pool } from '../lib/proc.js';
import { deleteFromGcs, generateJson, part, uploadToGcs } from './gemini.js';
import { aiScore, rangeFor } from './moments.js';
import { previewCut, type VisualSource } from './visual.js';
import type { ClipCandidate, ProjectOptions, Rubric, Segment, TimeRange } from '../types.js';

/**
 * The judge: a second, separate AI call that grades the clips.
 *
 * Why: the call that PICKS the clips used to grade them too, and it marked its own picks 8–9.5 on everything, so
 * every clip scored 79–96 and the score said nothing. The judge fixes that three ways:
 *   1. Blind — it doesn't know which cuts were picked. It's told these are candidate cuts, most of them ordinary.
 *   2. Decoys — a few random cuts from the same video are mixed in, so it always sees ordinary moments to compare
 *      against (and we can log whether picks really beat random cuts).
 *   3. A fixed scale — every score level is described, with three worked examples (≈27, ≈56, ≈86), so an 80 means
 *      the same thing in every project.
 *
 * Talking videos are judged from the transcript (text only, cheap). No-talking videos are judged from short,
 * low-res previews of each cut. If the judge fails, the picker's own scores are kept — nothing breaks.
 */

const SCALE = `Score every criterion 0–10. Use the whole scale. 5 = an ordinary moment from this kind of video.

hook — the first ~3 seconds
  2: opens on filler, a greeting, setup or mid-thought
  5: on topic, but nothing makes you need what comes next
  8: a bold claim, sharp question, conflict, surprising fact or striking image right away
  10: the opening alone would stop almost anyone scrolling
standalone — makes sense with zero context
  2: depends on earlier parts ("like I said", an unexplained "he"/"that")
  5: understandable, but something feels missing
  8: complete for a stranger
payoff
  2: no landing — trails off or stops mid-idea
  5: a mild point or soft ending
  8: a clear punchline, reveal, strong opinion or useful takeaway that lands before the end
  10: a payoff people will quote or replay
emotion — 2: flat · 5: some energy or warmth · 8: real laughter, anger, shock, awe or vulnerability · 10: peak intensity
shareability — 2: nobody would send this · 5: mildly interesting · 8: you'd send it to a specific friend · 10: people will repost and argue about it
pacing — 2: slow wind-up, dead air, repetition · 5: steady · 8: something new every few seconds
loop — 2: ends abruptly or mid-word · 5: a clean ending · 8: a satisfying full stop, or it flows back into the start
length_fit — 2: far too long or too short for what's in it · 5: some padding · 8: exactly as long as the idea needs
trend — 2: niche, nothing searchable · 5: a general-interest topic · 8: a current topic, famous person or much-searched thing`;

const TALK_EXAMPLES = `Fixed reference points (apply them the same way to every video):
- About 27/100: "So, um, yeah, I think it's important to, you know, stay consistent. Like, consistency is key. Anyway, let's move on to the next question."
  hook 2, standalone 6, payoff 2, emotion 1, shareability 1, pacing 3, loop 3, length_fit 4, trend 3
- About 56/100: "The best advice I got was to write every day, even when it's bad. Most of what I wrote that first year was terrible, but it taught me what I actually sounded like."
  hook 5, standalone 8, payoff 6, emotion 4, shareability 5, pacing 6, loop 6, length_fit 7, trend 3
- About 86/100: "I got fired on a Tuesday. By Friday I'd built the thing they said was impossible — and they tried to buy it back for ten times my salary. I said no."
  hook 9, standalone 9, payoff 9, emotion 8, shareability 9, pacing 9, loop 7, length_fit 9, trend 5`;

const VISUAL_EXAMPLES = `Fixed reference points (apply them the same way to every video):
- About 25/100: 45 seconds of hands slowly sorting beads; nothing changes, no result.
  hook 2, standalone 6, payoff 2, emotion 1, shareability 1, pacing 2, loop 4, length_fit 3, trend 2
- About 54/100: a cake being frosted neatly; pleasant, but the result is what you expected.
  hook 4, standalone 8, payoff 6, emotion 4, shareability 4, pacing 6, loop 6, length_fit 7, trend 4
- About 82/100: a mystery box opened, a tiny detailed figure revealed within 3 seconds, a close-up of the surprising detail, ending on the finished display.
  hook 9, standalone 9, payoff 9, emotion 7, shareability 8, pacing 8, loop 8, length_fit 8, trend 5`;

const system = (visual: boolean) => `You are a strict reviewer at a short-video agency (TikTok, YouTube Shorts, Reels).
Editors hand you candidate cuts from one long video. Most candidates are ordinary; a few may be strong. You did not choose them and have no reason to favour any of them.
Score each cut on its own against the fixed scale below — don't grade on a curve, and don't give every cut similar scores.
Most cuts should land in 3–7. A score of 8 or more must be earned by something specific you can name.
${visual ? 'Nobody talks in these videos: judge what you SEE and hear (action, reveals, results, reactions, satisfying moments).' : 'You get each cut as its transcript, with times in seconds from the start of the cut.'}

${SCALE}

${visual ? VISUAL_EXAMPLES : TALK_EXAMPLES}

For each cut, first write "weakest": the single biggest thing holding it back (one short sentence). Then the scores.`;

const schema = {
  type: 'object',
  properties: {
    cuts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          weakest: { type: 'string' },
          hook: { type: 'number' },
          standalone: { type: 'number' },
          payoff: { type: 'number' },
          emotion: { type: 'number' },
          shareability: { type: 'number' },
          pacing: { type: 'number' },
          loop: { type: 'number' },
          length_fit: { type: 'number' },
          trend: { type: 'number' },
        },
        required: ['id', 'weakest', 'hook', 'standalone', 'payoff', 'emotion', 'shareability', 'pacing', 'loop', 'length_fit', 'trend'],
      },
    },
  },
  required: ['cuts'],
};

type RawCut = { id: string; weakest?: string } & Record<string, unknown>;
const n10 = (v: unknown) => Math.max(0, Math.min(10, Number(v) || 0));
const toRubric = (c: RawCut): Rubric => ({
  hook: n10(c.hook),
  standalone: n10(c.standalone),
  payoff: n10(c.payoff),
  emotion: n10(c.emotion),
  shareability: n10(c.shareability),
  pacing: n10(c.pacing),
  loop: n10(c.loop),
  lengthFit: n10(c.length_fit),
  trend: n10(c.trend),
});

// ---------------- decoys ----------------

/** Same random numbers for the same video, so re-running a project gives the same decoys. */
function seeded(seed: number) {
  let a = Math.floor(seed * 1000) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const overlap = (a: TimeRange, b: TimeRange) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/**
 * Random cuts from the same video, about as long as the picks, that don't overlap them. With a transcript they
 * start and end on sentence edges and have real talking in them, so they look like any other candidate.
 */
export function pickDecoys(picks: TimeRange[], duration: number, segs: Segment[] | null, count: number): TimeRange[] {
  if (!picks.length || count <= 0) return [];
  const lens = picks.map((p) => p.end - p.start).sort((a, b) => a - b);
  const len = lens[Math.floor(lens.length / 2)];
  if (duration < len * 2) return [];
  const rand = seeded(duration + picks.length);
  const taken: TimeRange[] = [...picks];
  const out: TimeRange[] = [];
  for (let tries = 0; tries < 80 && out.length < count; tries++) {
    let start = rand() * (duration - len);
    let end = start + len;
    if (segs?.length) {
      const first = segs.find((s) => s.s >= start);
      if (!first) continue;
      start = first.s;
      const inside = segs.filter((s) => s.s >= start && s.e <= start + len * 1.15);
      if (inside.length < 2) continue;
      end = inside[inside.length - 1].e;
      const words = inside.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
      if (end - start < len * 0.6 || words < 12) continue;
    }
    const cut = { start: +start.toFixed(3), end: +Math.min(duration, end).toFixed(3) };
    if (taken.some((t) => overlap(t, cut) > 0.2 * (cut.end - cut.start))) continue;
    taken.push(cut);
    out.push(cut);
  }
  return out;
}

// ---------------- what the judge sees ----------------

interface Item {
  id: string;
  range: TimeRange;
  pick: number | null; // index into the clips, or null for a decoy
}

function transcriptOf(segs: Segment[], r: TimeRange): string {
  const lines = segs.filter((s) => s.e > r.start + 0.05 && s.s < r.end - 0.05).map((s) => `[${Math.max(0, s.s - r.start).toFixed(1)}] ${s.text}`);
  const text = lines.join('\n');
  return text.length > 6000 ? `${text.slice(0, 6000)}\n[…]` : text || '(nothing said)';
}

type Viewer = (item: Item) => Promise<{ parts: Part[]; cleanup: () => void }>;

/** For no-talking cuts: a small preview of each cut (YouTube offsets, or a 240p copy on GCS / inline). */
function videoViewer(source: VisualSource, work: string, id: string): Viewer | null {
  if (!config.sendVideoToGemini) return null;
  if (source.kind === 'youtube')
    return async (it) => ({
      parts: [part.uri(source.url, 'video/mp4', { fps: 1, startOffset: `${Math.floor(it.range.start)}s`, endOffset: `${Math.ceil(it.range.end)}s` })],
      cleanup: () => {},
    });
  const dir = path.join(work, 'judge');
  return async (it) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${it.id}.mp4`);
    await previewCut(source.src, it.range, file, { height: 240, fps: 5 });
    if (config.gcsBucket) {
      const object = `crestclip/tmp/${id}/judge_${it.id}.mp4`; // temporary — deleted right after
      const uri = await uploadToGcs(file, object, 'video/mp4');
      return {
        parts: [part.uri(uri, 'video/mp4', { fps: 2 })],
        cleanup: () => {
          fs.rmSync(file, { force: true });
          void deleteFromGcs(object);
        },
      };
    }
    if (fs.statSync(file).size > 1.5e6) throw new Error('preview too big to send inline');
    return { parts: [part.file(file, 'video/mp4')], cleanup: () => fs.rmSync(file, { force: true }) };
  };
}

// ---------------- the judge ----------------

/**
 * Re-grade the clips with the blind judge. Returns the same clips (same order) with the judge's rubric; a clip the
 * judge couldn't grade keeps the picker's rubric. Never throws.
 */
export async function judgeClips<T extends ClipCandidate>(input: {
  clips: T[];
  duration: number;
  title: string;
  channel: string;
  options: ProjectOptions;
  /** talking video: the transcript */
  segments: Segment[];
  /** no-talking video: where to watch the cuts (null = talking video) */
  visual: { source: VisualSource; work: string; id: string } | null;
  label?: string;
}): Promise<T[]> {
  const { clips, duration } = input;
  if (config.fakeAi || !clips.length) return clips;
  const visual = Boolean(input.visual);
  const viewer = input.visual ? videoViewer(input.visual.source, input.visual.work, input.visual.id) : null;
  if (visual && !viewer) return clips;

  // video cuts are sent as videos, so keep each call small; transcript cuts all fit in one call
  const perCall = visual ? 8 : 30;
  const batches: number[][] = [];
  for (let i = 0; i < clips.length; i += perCall) batches.push(clips.slice(i, i + perCall).map((_, j) => i + j));

  const range = rangeFor(input.options);
  const graded = new Map<number, Rubric>();
  const decoyScores: number[] = [];
  const tag = input.label ?? input.title.slice(0, 40);

  await pool(batches, 3, async (batch, b) => {
    const picks = batch.map((i) => ({ start: clips[i].start, end: clips[i].end }));
    const decoys = pickDecoys(picks, duration, visual ? null : input.segments, visual ? 2 : Math.min(4, Math.max(2, Math.ceil(batch.length / 3))));
    const rand = seeded(duration + b + 7);
    const items: Item[] = [...batch.map((i) => ({ range: picks[batch.indexOf(i)], pick: i as number | null })), ...decoys.map((r) => ({ range: r, pick: null }))]
      .map((it) => ({ ...it, key: rand() }))
      .sort((a, b2) => a.key - b2.key)
      .map((it, k) => ({ id: `C${k + 1}`, range: it.range, pick: it.pick }));

    const cleanups: (() => void)[] = [];
    try {
      const parts: Part[] = [
        part.text(
          `VIDEO: "${input.title}"${input.channel ? ` by ${input.channel}` : ''}\nThe cuts are for TikTok, YouTube Shorts and Instagram Reels. Wanted length: ${range.min}–${range.max} s.\nThere are ${items.length} candidate cuts (${items.map((i) => i.id).join(', ')}). Score every one.`,
        ),
      ];
      for (const it of items) {
        const head = `### ${it.id} · ${Math.round(it.range.end - it.range.start)} s`;
        if (viewer) {
          const seen = await viewer(it);
          cleanups.push(seen.cleanup);
          parts.push(part.text(head), ...seen.parts);
        } else {
          parts.push(part.text(`${head}\n${transcriptOf(input.segments, it.range)}`));
        }
      }
      const raw = await generateJson<{ cuts: RawCut[] }>({
        system: system(visual),
        parts,
        schema,
        thinking: 'LOW',
        lowMediaRes: visual,
        maxOutputTokens: 12000,
        timeoutMs: 4 * 60_000,
        label: batches.length > 1 ? `judge the clips ${b + 1}/${batches.length}` : 'judge the clips',
      });
      const byId = new Map((Array.isArray(raw.cuts) ? raw.cuts : []).map((c) => [String(c.id).trim().toUpperCase(), c]));
      for (const it of items) {
        const c = byId.get(it.id);
        if (!c) continue;
        if (it.pick == null) decoyScores.push(aiScore(toRubric(c)));
        else graded.set(it.pick, toRubric(c));
      }
    } catch (e) {
      console.warn(`[judge] ${tag}: grading failed, keeping the picker's scores —`, (e as Error).message);
    } finally {
      for (const c of cleanups) c();
    }
  });
  if (input.visual) fs.rmSync(path.join(input.visual.work, 'judge'), { recursive: true, force: true });

  const out = clips.map((c, i) => (graded.has(i) ? { ...c, rubric: graded.get(i)! } : c));
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const before = avg(clips.map((c) => aiScore(c.rubric)));
  const after = avg([...graded.values()].map(aiScore));
  console.log(`[judge] ${tag}: graded ${graded.size}/${clips.length} · picks ${before} → ${after} · random cuts ${avg(decoyScores) ?? '—'}`);
  return out;
}

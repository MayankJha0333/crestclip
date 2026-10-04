import type { Pace, TimeRange, Word } from '../types.js';

/**
 * Tightening a clip like a short-form editor: long pauses are shortened and a lone "um"/"uh" between two pauses
 * is dropped. Cuts are made only on REAL silences measured from the audio (ffmpeg silencedetect) — word timings
 * from the transcript are estimates, so they're never used to decide where to cut, only to recognise fillers.
 *
 * Everything here is relative to the start of one clip part (0 … dur).
 */

type Range = { s: number; e: number };

const RULES = {
  // gap: pauses longer than this get shortened; keep: pause left on each side of a cut; tail: quiet allowed at the very end
  natural: { gap: 0.6, keep: 0.18, tail: 0.7 },
  fast: { gap: 0.35, keep: 0.1, tail: 0.4 },
} as const;

const FILLER = /^(u+m+|u+h+m*|e+r+m*|e+r+|a+h+|h+m+|mm+)[.,!?…]*$/i;
const MIN_CUT = 0.12; // shorter cuts aren't worth a jump
const MIN_KEEP = 0.1; // never leave slivers of picture
const MAX_REMOVED = 0.5; // more than half cut usually means the "silence" was quiet speech — give up

/** Which parts of the clip to keep, in play order. A single [0, dur] range = nothing cut. */
export function planKeep(o: { dur: number; silences: Range[]; words: Word[]; pace: Pace; gentle?: boolean }): Range[] {
  const whole = [{ s: 0, e: o.dur }];
  if (o.pace === 'off' || o.dur < 4) return whole;
  const base = RULES[o.pace];
  const rule = o.gentle && o.pace === 'natural' ? { ...base, gap: 1.0 } : base; // stories / emotional moments breathe more
  const sil = o.silences
    .map((x) => ({ s: Math.max(0, x.s), e: Math.min(o.dur, x.e) }))
    .filter((x) => x.e - x.s > 0.05)
    .sort((a, b) => a.s - b.s);

  const cuts: Range[] = [];
  for (const x of sil) {
    if (x.s <= 0.05)
      cuts.push({ s: 0, e: x.e - rule.keep }); // dead air before the first word
    else if (x.e >= o.dur - 0.05)
      cuts.push({ s: x.s + rule.tail, e: o.dur }); // long quiet tail
    else if (x.e - x.s > rule.gap) cuts.push({ s: x.s + rule.keep, e: x.e - rule.keep });
  }

  // a filler alone between two pauses: "…and then. Um. We tried…" → cut pause + um + pause as one
  const centre = (w: Word) => (w.s + w.e) / 2;
  for (let i = 0; i + 1 < sil.length; i++) {
    const a = sil[i];
    const b = sil[i + 1];
    const blip = b.s - a.e;
    if (blip < 0.12 || blip > 0.8) continue;
    const inside = o.words.filter((w) => centre(w) > a.e - 0.35 && centre(w) < b.s + 0.35);
    if (inside.length && inside.every((w) => FILLER.test(w.w))) cuts.push({ s: a.s + rule.keep, e: b.e - rule.keep });
  }

  const merged = mergeRanges(cuts.filter((c) => c.e - c.s >= MIN_CUT));
  const keep: Range[] = [];
  let t = 0;
  for (const c of merged) {
    if (c.s - t >= MIN_KEEP) keep.push({ s: t, e: c.s });
    t = Math.max(t, c.e);
  }
  if (o.dur - t >= MIN_KEEP) keep.push({ s: t, e: o.dur });
  const kept = keep.reduce((a, k) => a + k.e - k.s, 0);
  if (!keep.length || kept < o.dur * (1 - MAX_REMOVED)) return whole;
  return keep.map((k) => ({ s: +k.s.toFixed(3), e: +k.e.toFixed(3) }));
}

function mergeRanges(rs: Range[]): Range[] {
  const out: Range[] = [];
  for (const r of [...rs].sort((a, b) => a.s - b.s)) {
    const last = out[out.length - 1];
    if (last && r.s <= last.e + 0.02) last.e = Math.max(last.e, r.e);
    else out.push({ ...r });
  }
  return out;
}

export const FPS = 30;
/** Seconds rounded to the 30 fps frame grid. */
export const toFrame = (t: number) => Math.round(t * FPS) / FPS;

/**
 * Put every cut exactly on a video frame. The picture can only be cut between frames (1/30 s) while the sound can be
 * cut anywhere — if the two are cut at slightly different spots, each jump cut moves the sound a few ms against the
 * picture and after a dozen cuts lips and captions are visibly out of sync. Snapped, both are cut identically.
 */
export function snapKeep(keep: Range[], dur: number): Range[] {
  const end = Math.floor(dur * FPS + 1e-6) / FPS;
  const out: Range[] = [];
  for (const k of keep) {
    const s = Math.max(0, toFrame(k.s));
    const e = Math.min(end, toFrame(k.e));
    if (e - s < MIN_KEEP) continue;
    const last = out[out.length - 1];
    if (last && s <= last.e + 1e-6) last.e = Math.max(last.e, e);
    else out.push({ s: +s.toFixed(4), e: +e.toFixed(4) });
  }
  return out.length ? out : [{ s: 0, e: +end.toFixed(4) }];
}

/** Length of the edited clip. */
export const keptLength = (keep: Range[]) => keep.reduce((a, k) => a + k.e - k.s, 0);

/** Where each kept piece starts in the edited clip (these are the jump cuts, after the first). */
export function cutTimes(keep: Range[]): number[] {
  const out: number[] = [];
  let t = 0;
  for (const k of keep) {
    if (t > 0) out.push(+t.toFixed(3));
    t += k.e - k.s;
  }
  return out;
}

/**
 * Words re-timed onto the edited clip. Pieces play in `keep` order (a flash-forward piece can come first,
 * so a word may appear twice). Words whose middle falls in a cut are dropped.
 */
export function retimeWords(words: Word[], keep: Range[]): Word[] {
  const out: Word[] = [];
  let offset = 0;
  for (const k of keep) {
    for (const w of words) {
      const mid = (w.s + w.e) / 2;
      if (mid < k.s || mid >= k.e) continue;
      out.push({ ...w, s: +(offset + Math.max(w.s, k.s) - k.s).toFixed(3), e: +(offset + Math.min(w.e, k.e) - k.s).toFixed(3) });
    }
    offset += k.e - k.s;
  }
  return out;
}

/** Silences (absolute, whole video) → relative to one clip part. */
export const silencesIn = (sil: Range[], part: TimeRange): Range[] => sil.filter((x) => x.e > part.start && x.s < part.end).map((x) => ({ s: x.s - part.start, e: x.e - part.start }));

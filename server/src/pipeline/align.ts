import { config } from '../config.js';
import { run } from '../lib/proc.js';
import type { Segment, Word } from '../types.js';
import type { TimedWord } from './ytdlp.js';

/**
 * Word timings that follow the real speech.
 *
 * The transcript gives each short phrase a rough start and end (often a few hundred ms off), and the words inside a
 * phrase are spread evenly by length — so a word-by-word caption can show up before the person says it, run on
 * through a pause, or lag behind. Here every phrase is pinned to the speech that is actually there (measured from the
 * audio), and its words are spread over the spoken parts only, skipping the pauses inside it.
 */

type Range = { s: number; e: number };
export type Phrase = { s: number; e: number; words: Word[] };

/** Pauses between words in one stretch of audio (seconds from `start`). Finer than the project-wide silences. */
export async function speechGaps(src: string, start: number, dur: number): Promise<Range[]> {
  const { stderr } = await run(
    config.ffmpeg,
    ['-v', 'info', '-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', src, '-vn', '-af', 'silencedetect=noise=-35dB:d=0.12', '-f', 'null', '-'],
    { timeoutMs: 5 * 60 * 1000 },
  );
  const out: Range[] = [];
  let cur: number | null = null;
  for (const line of stderr.split('\n')) {
    const a = line.match(/silence_start: (-?[\d.]+)/);
    const b = line.match(/silence_end: (-?[\d.]+)/);
    if (a) cur = Math.max(0, Number(a[1]));
    if (b && cur != null) {
      out.push({ s: cur, e: Math.min(dur, Number(b[1])) });
      cur = null;
    }
  }
  if (cur != null && cur < dur) out.push({ s: cur, e: dur }); // quiet until the end
  return out;
}

const BAND = 12; // seconds: how far the transcript's time for a word may be from its measured time
const key = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');

/**
 * Put measured word times (see fetchWordTimings) on the transcript. The two word lists are matched in order — an
 * alignment that copes with the two transcripts wording things a little differently — and every matched word takes
 * its measured time; the others move with the matched words around them. Null when too few words match (another
 * language, music…), so the transcript keeps its own times.
 */
export function retimeToWords(segs: Segment[], measured: TimedWord[], band = BAND): Segment[] | null {
  const ours = segs.flatMap((seg) => seg.words.map((w) => ({ k: key(w.w), t: (w.s + w.e) / 2, s: w.s })));
  const n = ours.length;
  const m = measured.length;
  if (!n || !m) return null;
  const theirs = measured.map((x) => key(x.w));
  // our word r may only match measured words [lo[r], hi[r])
  const lo = new Int32Array(n);
  const hi = new Int32Array(n);
  for (let r = 0, a = 0, b = 0; r < n; r++) {
    while (a < m && measured[a].s < ours[r].t - band) a++;
    b = Math.max(a, b);
    while (b < m && measured[b].s <= ours[r].t + band) b++;
    lo[r] = Math.max(a, r ? lo[r - 1] : 0);
    hi[r] = Math.max(b, r ? hi[r - 1] : 0);
  }
  // most matched words inside that band, each word skipped between two matches costing a little — so of two equally
  // long matchings the tight one wins (not one that pairs the last word with the same word a minute later); words
  // before the first match and after the last are free. rows[r][j - lo[r]] = best for ours[0..r] vs measured[0..j)
  const SKIP = 0.01;
  const rows: Float64Array[] = [];
  const get = (r: number, j: number): number => {
    for (let skipped = 0; r >= 0; r--, skipped++) {
      if (j >= lo[r]) {
        const k = Math.min(j, hi[r]);
        return rows[r][k - lo[r]] - SKIP * (j - k + skipped);
      }
    }
    return 0;
  };
  const hit = (r: number, j: number) => j > lo[r] && ours[r].k !== '' && ours[r].k === theirs[j - 1];
  for (let r = 0; r < n; r++) {
    const row = new Float64Array(hi[r] - lo[r] + 1);
    rows.push(row);
    for (let j = lo[r]; j <= hi[r]; j++) {
      let v = Math.max(get(r - 1, j) - SKIP, (j > lo[r] ? row[j - 1 - lo[r]] : get(r, j - 1)) - SKIP);
      if (hit(r, j)) v = Math.max(v, get(r - 1, j - 1) + 1);
      row[j - lo[r]] = v;
    }
  }
  const same = (x: number, y: number) => Math.abs(x - y) < 1e-9;
  let end = lo[n - 1];
  for (let j = lo[n - 1]; j <= hi[n - 1]; j++) if (get(n - 1, j) > get(n - 1, end) + 1e-9) end = j;
  const match = new Int32Array(n).fill(-1);
  for (let r = n - 1, j = end; r >= 0 && j > 0; ) {
    const v = get(r, j);
    if (j < lo[r]) r--;
    else if (hit(r, j) && same(v, get(r - 1, j - 1) + 1)) {
      match[r] = j - 1;
      r--;
      j--;
    } else if (same(v, get(r - 1, j) - SKIP)) r--;
    else j--;
  }
  const found = match.filter((j) => j >= 0).length;
  if (found < 0.5 * ours.filter((o) => o.k).length) return null;

  // unmatched words take the shift of the matched words around them
  const shift = (r: number) => measured[match[r]].s - ours[r].s;
  const out: Segment[] = [];
  let r = 0;
  let prev = -1;
  for (const seg of segs) {
    const words = seg.words.map((w) => {
      const i = r++;
      if (match[i] >= 0) {
        prev = i;
        return { ...w, s: measured[match[i]].s, e: measured[match[i]].e };
      }
      let next = i + 1;
      while (next < n && match[next] < 0) next++;
      const d = prev < 0 ? shift(next) : next >= n ? shift(prev) : shift(prev) + ((shift(next) - shift(prev)) * (i - prev)) / (next - prev);
      return { ...w, s: w.s + d, e: w.e + d };
    });
    for (let k = 1; k < words.length; k++) {
      words[k].s = Math.max(words[k].s, words[k - 1].s + 0.05);
      words[k - 1].e = Math.min(words[k - 1].e, words[k].s);
    }
    for (const w of words) w.e = Math.max(w.e, w.s + 0.05);
    const s = words.length ? words[0].s : seg.s;
    const e = words.length ? words[words.length - 1].e : seg.e;
    out.push({ ...seg, s: +s.toFixed(3), e: +e.toFixed(3), words: words.map((w) => ({ ...w, s: +w.s.toFixed(3), e: +w.e.toFixed(3) })), timed: true });
  }
  for (let k = 1; k < out.length; k++) if (out[k].s < out[k - 1].e) out[k - 1].e = Math.max(out[k - 1].s + 0.1, out[k].s);
  return out;
}

/** The transcript's phrases inside [start, end], as times relative to `start` (sound labels like [laughs] dropped). */
export function phrasesInRange(segs: Segment[], start: number, end: number): Phrase[] {
  const out: Phrase[] = [];
  for (const seg of segs) {
    if (seg.e < start || seg.s > end) continue;
    const words = seg.words
      .filter((w) => !/^\[.*\]$/.test(w.w))
      .map((w) => ({ ...w, w: w.w.replace(/\[[^\]]*\]/g, '').trim() }))
      .filter((w) => w.w);
    if (!words.length) continue;
    out.push({ s: seg.s - start, e: seg.e - start, words: words.map((w) => ({ ...w, s: w.s - start, e: w.e - start })) });
  }
  return out;
}

const SNAP = 0.4; // how far a phrase edge may move to meet the real start/end of speech
const weight = (w: string) => Math.max(2, w.replace(/[^\p{L}\p{M}\p{N}]/gu, '').length + 1);

/**
 * Pin phrases to the measured speech and spread their words over the spoken parts. `gaps` are pauses (relative
 * times); words whose middle ends up outside [0, dur] are dropped, as before.
 */
export function alignPhrases(phrases: Phrase[], gaps: Range[], dur: number): Word[] {
  if (!gaps.length) return phrases.flatMap((p) => p.words).filter((w) => (w.s + w.e) / 2 >= 0 && (w.s + w.e) / 2 <= dur);
  const inGap = (t: number) => gaps.find((g) => t > g.s && t < g.e) ?? null;
  const ps = phrases.map((p) => ({ ...p }));
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    const prevEnd = i > 0 ? ps[i - 1].e : -Infinity;
    const nextStart = i + 1 < ps.length ? ps[i + 1].s : Infinity;
    // start: out of a pause onto the first spoken sound; or back to a speech onset just before it
    let g = inGap(p.s);
    if (g && g.e - p.s <= SNAP + 0.6) p.s = g.e;
    else {
      const onset = gaps.filter((x) => x.e < p.s && p.s - x.e <= SNAP && x.s >= prevEnd - 0.05).pop();
      if (onset) p.s = onset.e;
    }
    // end: back out of a pause to the last spoken sound; or on to a speech end just after it
    g = inGap(p.e);
    if (g && p.e - g.s <= SNAP + 0.6) p.e = g.s;
    else {
      const offset = gaps.find((x) => x.s > p.e && x.s - p.e <= SNAP && x.e <= nextStart + 0.05);
      if (offset) p.e = offset.s;
    }
    if (p.e - p.s < 0.15) {
      // snapping collapsed it (the transcript was far off) — keep the original timing
      p.s = phrases[i].s;
      p.e = phrases[i].e;
    }
    p.s = Math.max(p.s, prevEnd);
    if (p.e <= p.s) p.e = p.s + 0.15;
  }

  const out: Word[] = [];
  for (const p of ps) {
    // spoken stretches inside the phrase (pauses of 0.12 s or more taken out)
    const voiced: Range[] = [];
    let t = p.s;
    for (const g of gaps) {
      if (g.e <= p.s || g.s >= p.e) continue;
      if (g.s > t) voiced.push({ s: t, e: g.s });
      t = Math.max(t, g.e);
    }
    if (t < p.e) voiced.push({ s: t, e: p.e });
    const total = voiced.reduce((a, v) => a + v.e - v.s, 0);
    if (total < 0.1) {
      voiced.length = 0;
      voiced.push({ s: p.s, e: p.e });
    }
    // tiny blips (a breath, a click) aren't words
    const stretches = voiced.filter((v) => v.e - v.s >= 0.08);
    if (!stretches.length) stretches.push({ s: p.s, e: p.e });
    const ws = p.words.map((w) => weight(w.w));
    const sum = ws.reduce((a, b) => a + b, 0) || 1;
    const cum = [0];
    for (const x of ws) cum.push(cum[cum.length - 1] + x);
    const n = p.words.length;
    const m = stretches.length;
    const lens = stretches.map((v) => v.e - v.s);
    const totalLen = lens.reduce((a, b) => a + b, 0);
    // every pause inside the phrase falls between two words: put each one at the word boundary closest to where it
    // sits in the phrase, so a new word starts exactly when the speaker starts again
    const bounds = [0];
    let acc = 0;
    for (let j = 0; j < m - 1; j++) {
      acc += lens[j];
      const lo = n >= m ? bounds[j] + 1 : bounds[j];
      const hi = n >= m ? n - (m - 1 - j) : n;
      let best = lo;
      for (let k = lo; k <= hi; k++) if (Math.abs(cum[k] / sum - acc / totalLen) < Math.abs(cum[best] / sum - acc / totalLen)) best = k;
      bounds.push(best);
    }
    bounds.push(n);
    stretches.forEach((v, j) => {
      const a = bounds[j];
      const b = bounds[j + 1];
      if (b <= a) return; // a stretch with no words (noise)
      const wsum = cum[b] - cum[a] || 1;
      for (let k = a; k < b; k++) {
        const s = v.s + ((cum[k] - cum[a]) / wsum) * (v.e - v.s);
        const e = v.s + ((cum[k + 1] - cum[a]) / wsum) * (v.e - v.s);
        out.push({ ...p.words[k], s: +s.toFixed(3), e: +Math.max(e, s + 0.05).toFixed(3) });
      }
    });
  }
  return out.filter((w) => (w.s + w.e) / 2 >= 0 && (w.s + w.e) / 2 <= dur).map((w) => ({ ...w, s: Math.max(0, w.s), e: Math.min(dur, w.e) }));
}

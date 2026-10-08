import type { HeatPoint, Signals } from '../types.js';
import type { Comment } from './ytdlp.js';

const BINS = 100;

/**
 * "Where do people actually watch?" — CrestClip's audience signal.
 *
 * 1. YouTube "Most replayed" heatmap (via yt-dlp): 100 points, 0..1, relative to the video's own peak.
 * 2. Timestamps viewers write in comments ("12:34 😂"), weighted by likes.
 * 3. Audio energy (loudness spikes: laughter, shouting, excitement) — a fallback when there's no audience data.
 */
export function buildSignals(input: {
  duration: number;
  heatmap: HeatPoint[] | null;
  chapters: Signals['chapters'];
  comments: Comment[];
  rmsPerSecond: number[] | null;
  /** sound labels from the captions ([Laughter], [Applause]…): a stand-in for loudness when the audio isn't here */
  reactions?: { t: number; label: string }[] | null;
  useAudience: boolean;
}): Signals {
  const { duration } = input;
  const sources: string[] = [];

  const heatBins = input.useAudience && input.heatmap?.length ? resampleHeat(input.heatmap, duration) : null;
  if (heatBins) sources.push('heatmap');

  const commentBins = input.useAudience ? commentTimestampBins(input.comments, duration) : null;
  if (commentBins) sources.push('comments');

  let loudnessBins = input.rmsPerSecond?.length ? loudBins(input.rmsPerSecond) : null;
  if (loudnessBins) sources.push('loudness');
  else if (input.reactions?.length) {
    loudnessBins = reactionBins(input.reactions, duration);
    if (loudnessBins) sources.push('reactions');
  }

  let curve: number[];
  let curveKind: Signals['curveKind'];
  if (heatBins || commentBins) {
    curveKind = 'audience';
    const parts: [number[], number][] = [];
    if (heatBins) parts.push([heatBins, 0.7]);
    if (commentBins) parts.push([commentBins, heatBins ? 0.2 : 0.75]);
    if (loudnessBins) parts.push([loudnessBins, heatBins ? 0.1 : 0.25]);
    curve = blend(parts);
  } else if (loudnessBins) {
    curveKind = 'energy';
    curve = loudnessBins;
  } else {
    curveKind = 'none';
    curve = new Array(BINS).fill(0);
  }

  return {
    sources,
    heatmap: input.heatmap,
    chapters: input.chapters,
    commentBins,
    loudnessBins,
    curve: curve.map((v) => +v.toFixed(4)),
    curveKind,
    hotspots: hotspots(curve, duration, heatBins ? 'heatmap' : commentBins ? 'comments' : 'energy'),
  };
}

function resampleHeat(heat: HeatPoint[], duration: number): number[] {
  const bins = new Array(BINS).fill(0);
  for (let i = 0; i < BINS; i++) {
    const t = ((i + 0.5) / BINS) * duration;
    const p = heat.find((h) => t >= h.start_time && t < h.end_time) ?? heat[heat.length - 1];
    bins[i] = Math.max(0, Math.min(1, Number(p?.value) || 0));
  }
  // The very first seconds are almost always "replayed" because every viewer starts there — damp them.
  for (let i = 0; i < 3; i++) bins[i] *= 0.35 + i * 0.2;
  return normalize(bins);
}

/** Laughter, applause and cheering in the captions, each spread over ~±10 s, as a curve like loudness. */
function reactionBins(reactions: { t: number; label: string }[], duration: number): number[] | null {
  if (!duration) return null;
  const bins = new Array(BINS).fill(0);
  const weight = (label: string) => (/laugh|applau|cheer|scream|gasp/.test(label) ? 1 : /music|silence|inaudible|blank/.test(label) ? 0 : 0.4);
  let hits = 0;
  for (const r of reactions) {
    const w = weight(r.label);
    if (!w) continue;
    hits++;
    const c = (r.t / duration) * BINS;
    for (let i = Math.max(0, Math.floor(c - 2)); i <= Math.min(BINS - 1, Math.ceil(c + 2)); i++) bins[i] += w * Math.exp(-((i - c) * (i - c)) / 2);
  }
  return hits >= 3 ? normalize(bins) : null;
}

const TS = /(?<![\d:])(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?![\d:])/g;

function commentTimestampBins(comments: Comment[], duration: number): number[] | null {
  if (!comments?.length || !duration) return null;
  const bins = new Array(BINS).fill(0);
  let hits = 0;
  for (const c of comments) {
    const seen = new Set<number>();
    for (const m of c.text.matchAll(TS)) {
      const h = m[1] ? Number(m[1]) : 0;
      const sec = h * 3600 + Number(m[2]) * 60 + Number(m[3]);
      if (Number(m[3]) >= 60 || sec >= duration || sec < 1) continue;
      const b = Math.min(BINS - 1, Math.floor((sec / duration) * BINS));
      if (seen.has(b)) continue;
      seen.add(b);
      bins[b] += 1 + Math.log10(1 + (c.like_count ?? 0));
      hits++;
    }
  }
  if (hits < 3) return null;
  // light smoothing: people write a timestamp slightly before the moment
  const sm = bins.map((_, i) => bins[i] * 0.6 + (bins[i - 1] ?? 0) * 0.15 + (bins[i + 1] ?? 0) * 0.25);
  return normalize(sm);
}

function loudBins(rms: number[]): number[] {
  const secs = rms.length;
  const bins = new Array(BINS).fill(0);
  for (let i = 0; i < BINS; i++) {
    const a = Math.floor((i / BINS) * secs);
    const b = Math.max(a + 1, Math.floor(((i + 1) / BINS) * secs));
    const slice = rms.slice(a, b).filter((v) => v > -80);
    if (!slice.length) continue;
    // mix of average level and peaks (laughs/shouts show up as peaks)
    const avg = slice.reduce((x, y) => x + y, 0) / slice.length;
    const peak = Math.max(...slice);
    bins[i] = avg * 0.6 + peak * 0.4;
  }
  // z-score then squash, so "energy above normal" stands out
  const valid = bins.filter((v) => v !== 0);
  const mean = valid.reduce((x, y) => x + y, 0) / (valid.length || 1);
  const sd = Math.sqrt(valid.reduce((x, y) => x + (y - mean) ** 2, 0) / (valid.length || 1)) || 1;
  const squashed = bins.map((v) => (v === 0 ? 0 : 1 / (1 + Math.exp(-((v - mean) / sd) * 1.4))));
  // light smoothing so single-second spikes don't dominate
  return squashed.map((v, i) => (squashed[i - 1] ?? v) * 0.25 + v * 0.5 + (squashed[i + 1] ?? v) * 0.25);
}

function blend(parts: [number[], number][]): number[] {
  const total = parts.reduce((a, [, w]) => a + w, 0);
  return normalize(new Array(BINS).fill(0).map((_, i) => parts.reduce((a, [arr, w]) => a + arr[i] * w, 0) / total));
}

function normalize(a: number[]): number[] {
  const max = Math.max(...a);
  const min = Math.min(...a);
  if (max - min < 1e-9) return a.map(() => 0);
  return a.map((v) => (v - min) / (max - min));
}

function hotspots(curve: number[], duration: number, source: string) {
  const binDur = duration / BINS;
  const sorted = [...curve].sort((a, b) => b - a);
  const threshold = Math.max(0.55, sorted[Math.floor(BINS * 0.12)] ?? 0.55);
  const spots: Signals['hotspots'] = [];
  let i = 0;
  while (i < BINS) {
    if (curve[i] >= threshold) {
      let j = i;
      let peak = curve[i];
      while (j + 1 < BINS && curve[j + 1] >= threshold * 0.85) {
        j++;
        peak = Math.max(peak, curve[j]);
      }
      spots.push({ start: +(i * binDur).toFixed(1), end: +((j + 1) * binDur).toFixed(1), value: +peak.toFixed(3), source });
      i = j + 1;
    } else i++;
  }
  return spots.sort((a, b) => b.value - a.value).slice(0, 12);
}

/**
 * How strong is the audience/energy signal inside [start,end] compared to the rest of the video? 0..100
 * (percentile rank: "this moment is more re-watched than X% of the video").
 */
export function rangeScore(signals: Signals | null, duration: number, start: number, end: number): number | null {
  if (!signals || signals.curveKind === 'none' || !duration) return null;
  const c = signals.curve;
  const a = Math.max(0, Math.floor((start / duration) * BINS));
  const b = Math.min(BINS, Math.max(a + 1, Math.ceil((end / duration) * BINS)));
  const slice = c.slice(a, b).sort((x, y) => y - x);
  const top = slice.slice(0, Math.max(1, Math.ceil(slice.length / 2)));
  const v = top.reduce((x, y) => x + y, 0) / top.length;
  const rank = c.filter((x) => x <= v).length / c.length;
  return Math.round(rank * 100);
}

export function formatTime(sec: number) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

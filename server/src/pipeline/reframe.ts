import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { framesAt, sceneCuts } from './media.js';
import { generateJson, part } from './gemini.js';
import type { CropHold, Layout, ReframePlan } from '../types.js';

type Box = [number, number, number, number]; // ymin, xmin, ymax, xmax (0..1000)

interface FrameAnalysis {
  content: string;
  frames: { i: number; faces: { box: number[]; speaking: boolean }[]; subject: number[] }[];
}

const schema = {
  type: 'object',
  properties: {
    content: { type: 'string', enum: ['talking_heads', 'single_speaker', 'screen_or_slides', 'gameplay', 'sports_or_action', 'other'] },
    frames: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          faces: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                box: { type: 'array', items: { type: 'integer' }, description: '[ymin, xmin, ymax, xmax] normalized 0-1000' },
                speaking: { type: 'boolean', description: 'true if this person appears to be the one talking' },
              },
              required: ['box', 'speaking'],
            },
          },
          subject: { type: 'array', items: { type: 'integer' }, description: 'main subject box [ymin,xmin,ymax,xmax] 0-1000 when no face; else []' },
        },
        required: ['i', 'faces', 'subject'],
      },
    },
  },
  required: ['content', 'frames'],
};

const SYSTEM = `You are the auto-reframe engine of a video editor that turns 16:9 video into 9:16 vertical clips.
For each numbered frame, return bounding boxes of every clearly visible human FACE (not whole bodies) as [ymin, xmin, ymax, xmax] normalized to 0-1000, and mark which person seems to be SPEAKING (mouth open, gesturing, camera focus, or the only person). If there are no faces, give the box of the most important subject (e.g. the product, the game character, the slide text), otherwise an empty subject list. Ignore faces in small thumbnails/overlays/posters. Limit 4 faces per frame.`;

export async function planReframe(opts: {
  src: string;
  start: number;
  end: number;
  width: number;
  height: number;
  workDir: string;
  layout: Layout;
}): Promise<ReframePlan & { suggested: Exclude<Layout, 'auto'>; content: string; start: number; end: number }> {
  const { src, start, end, width, height } = opts;
  const dur = end - start;
  const cropW = (height * 9) / 16 / width; // crop width as fraction of source width
  const base = { start, end };

  // Already vertical-ish: nothing to track.
  if (cropW >= 0.95) {
    return { ...base, layout: 'fill', suggested: 'fill', holds: [{ t: 0, x: 0.5 }], faceRatio: 1, content: 'vertical_source' };
  }

  const [cuts, analysis] = await Promise.all([sceneCuts(src, start, dur).catch(() => [] as number[]), analyzeFrames(opts)]);
  const n = analysis.times.length;

  // pick a target x for every sampled frame
  const targets: (number | null)[] = [];
  let faceFrames = 0;
  let twoFaceFrames = 0;
  const lefts: number[] = [];
  const rights: number[] = [];
  const faceY: number[] = [];
  for (let i = 0; i < n; i++) {
    const f = analysis.data.frames.find((x) => x.i === i);
    const faces = (f?.faces ?? []).filter((x) => validBox(x.box)).map((x) => ({ box: x.box as Box, speaking: x.speaking }));
    if (faces.length) {
      faceFrames++;
      const bySize = [...faces].sort((a, b) => area(b.box) - area(a.box));
      const speaking = faces.find((x) => x.speaking) ?? bySize[0];
      targets.push(cx(speaking.box));
      faceY.push(cy(speaking.box));
      if (faces.length >= 2) {
        const [a, b] = bySize.slice(0, 2).sort((p, q) => cx(p.box) - cx(q.box));
        if (cx(b.box) - cx(a.box) > cropW * 0.85 && area(b.box) > area(a.box) * 0.25 && area(a.box) > area(b.box) * 0.25) {
          twoFaceFrames++;
          lefts.push(cx(a.box));
          rights.push(cx(b.box));
        }
      }
    } else if (f && validBox(f.subject)) targets.push(cx(f.subject as Box));
    else targets.push(null);
  }
  const faceRatio = n ? faceFrames / n : 0;
  const twoRatio = n ? twoFaceFrames / n : 0;

  const content = analysis.data.content || 'other';
  let suggested: Exclude<Layout, 'auto'> = 'fill';
  if (faceRatio < 0.35 && /screen|gameplay|other|sports/.test(content)) suggested = 'fit';
  else if (twoRatio >= 0.55) suggested = 'split';
  const layout = opts.layout === 'auto' ? suggested : opts.layout;

  // fill missing targets from neighbours
  let last = targets.find((t) => t != null) ?? 0.5;
  const filled = targets.map((t) => (t == null ? last : (last = t)));

  const holds = buildHolds(analysis.times, filled, cuts, dur, cropW);
  const splitCenters: [number, number] | undefined = lefts.length ? [median(lefts), median(rights)] : undefined;
  return { ...base, layout, suggested, holds, faceRatio, splitCenters, content, ...(faceY.length ? { faceY: median(faceY) } : {}) };
}

async function analyzeFrames(opts: { src: string; start: number; end: number; workDir: string }) {
  const dur = opts.end - opts.start;
  const count = Math.max(4, Math.min(36, Math.round(dur / 1.5)));
  const times = Array.from({ length: count }, (_, i) => +(((i + 0.5) * dur) / count).toFixed(2));
  if (config.fakeAi) {
    return { times, data: { content: 'single_speaker', frames: times.map((_, i) => ({ i, faces: [{ box: [200, 400, 520, 600], speaking: true }], subject: [] })) } };
  }
  const dir = path.join(opts.workDir, 'frames');
  fs.rmSync(dir, { recursive: true, force: true });
  const files = await framesAt(opts.src, opts.start, times, dir);
  const parts = files.flatMap((f, i) => [part.text(`Frame ${i} (t=${times[i]}s):`), part.file(f, 'image/jpeg')]);
  parts.push(part.text(`Analyze all ${files.length} frames. Return one entry per frame index 0..${files.length - 1}.`));
  const data = await generateJson<FrameAnalysis>({
    model: config.fastModel,
    system: SYSTEM,
    parts,
    schema,
    thinking: 'MINIMAL',
    maxOutputTokens: 16000,
    label: 'find faces for reframing',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { times: times.slice(0, files.length), data };
}

/**
 * Turn noisy per-frame targets into steady "camera holds":
 * - one position per shot (between scene cuts) unless the speaker clearly moves/changes,
 * - ignore small jitter (dead zone), require a change to persist before moving.
 * Result looks like a human editor cutting between speakers, not a wobbly auto-pan.
 */
function buildHolds(times: number[], xs: number[], cuts: number[], dur: number, cropW: number): CropHold[] {
  const bounds = [0, ...cuts, dur];
  const holds: CropHold[] = [];
  const dead = Math.max(0.06, cropW * 0.22);
  for (let s = 0; s < bounds.length - 1; s++) {
    const a = bounds[s];
    const b = bounds[s + 1];
    const idx = times
      .map((t, i) => [t, i] as const)
      .filter(([t]) => t >= a && t < b)
      .map(([, i]) => i);
    if (!idx.length) {
      // no sample in this shot → nearest sample
      const nearest = times.reduce((best, t, i) => (Math.abs(t - (a + b) / 2) < Math.abs(times[best] - (a + b) / 2) ? i : best), 0);
      holds.push({ t: a, x: xs[nearest] ?? 0.5, cut: s > 0 });
      continue;
    }
    let groupStart = a;
    let group: number[] = [xs[idx[0]]];
    for (let k = 1; k < idx.length; k++) {
      const x = xs[idx[k]];
      const cur = median(group);
      const persists = k + 1 < idx.length ? Math.abs(xs[idx[k + 1]] - x) < dead : true;
      if (Math.abs(x - cur) > dead && persists && times[idx[k]] - groupStart > 1.2) {
        holds.push({ t: groupStart, x: median(group), cut: groupStart === a && s > 0 });
        groupStart = Math.max(a, (times[idx[k - 1]] + times[idx[k]]) / 2);
        group = [x];
      } else group.push(x);
    }
    holds.push({ t: groupStart, x: median(group), cut: groupStart === a && s > 0 });
  }
  // merge consecutive holds that are basically the same position
  const merged: CropHold[] = [];
  for (const h of holds) {
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(prev.x - h.x) < dead * 0.5) continue;
    merged.push({ t: +h.t.toFixed(3), x: +h.x.toFixed(4), cut: Boolean(h.cut) });
  }
  return merged.length ? merged : [{ t: 0, x: 0.5 }];
}

const validBox = (b: unknown): b is Box => Array.isArray(b) && b.length === 4 && b.every((v) => Number.isFinite(v)) && b[2] > b[0] && b[3] > b[1];
const cx = (b: Box) => Math.max(0, Math.min(1, (b[1] + b[3]) / 2000));
const cy = (b: Box) => Math.max(0, Math.min(1, (b[0] + b[2]) / 2000));
const area = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);
function median(a: number[]) {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

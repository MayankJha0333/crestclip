import path from 'node:path';
import { config } from '../config.js';
import { pool } from '../lib/proc.js';
import { cutAudio } from './media.js';
import { generateJson, part } from './gemini.js';
import type { Segment, Word } from '../types.js';

const CHUNK = 8 * 60; // seconds per transcription request

const schema = {
  type: 'object',
  properties: {
    language: { type: 'string' },
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          s: { type: 'number', description: 'start time in seconds from the beginning of THIS audio file' },
          e: { type: 'number', description: 'end time in seconds' },
          sp: { type: 'string', description: 'speaker label: S1, S2, ...' },
          t: { type: 'string', description: 'exact spoken words' },
        },
        required: ['s', 'e', 't'],
      },
    },
  },
  required: ['segments'],
};

const system = `You are a precise transcription engine for a video-editing tool.
Transcribe the audio verbatim (keep filler words out unless they matter for meaning).
Split into SHORT phrases of at most 8 words each, following natural speech pauses.
Every phrase must have accurate start and end timestamps in seconds (decimals allowed) measured from the start of this audio file.
Label speakers S1, S2, ... consistently within this file. Mark laughter or applause as [laughs] / [applause] inside the text only when clearly audible.
Never invent speech. If there is no speech, return an empty list.`;

/** Chunk boundaries placed in the middle of pauses so no word is cut in half between two requests. */
function chunkPlan(duration: number, silences: { s: number; e: number }[]) {
  const bounds = [0];
  while (duration - bounds[bounds.length - 1] > CHUNK * 1.15) {
    const target = bounds[bounds.length - 1] + CHUNK;
    let best = target;
    let bd = Infinity;
    for (const x of silences) {
      const mid = (x.s + x.e) / 2;
      const d = Math.abs(mid - target);
      if (d < bd && d <= 75 && x.e - x.s >= 0.3) {
        bd = d;
        best = mid;
      }
    }
    bounds.push(best);
  }
  bounds.push(duration);
  return bounds.slice(0, -1).map((s, i) => ({ start: s, dur: bounds[i + 1] - s }));
}

export async function transcribe(
  audioPath: string,
  duration: number,
  workDir: string,
  onProgress: (done: number, total: number) => void,
  silences: { s: number; e: number }[] = [],
): Promise<{ segments: Segment[]; language: string }> {
  if (config.fakeAi) return fakeTranscript(duration);

  const chunks = chunkPlan(duration, silences);
  let done = 0;
  let lang = '';
  const results = await pool(chunks, 4, async (c, i) => {
    const file = path.join(workDir, `chunk_${String(i).padStart(3, '0')}.mp3`);
    await cutAudio(audioPath, file, c.start, c.dur);
    const r = await generateJson<{ language?: string; segments: { s: number; e: number; sp?: string; t: string }[] }>({
      model: config.fastModel,
      system,
      parts: [part.file(file, 'audio/mp3'), part.text(`Transcribe this ${Math.round(c.dur)}-second audio chunk. Work out which language is spoken and return its name too.`)],
      schema,
      audioTimestamp: true,
      thinking: 'MINIMAL',
      maxOutputTokens: 60000,
      label: `transcribe chunk ${i + 1}/${chunks.length}`,
    });
    done++;
    onProgress(done, chunks.length);
    if (r.language && !lang) lang = r.language;
    return (r.segments || [])
      .filter((x) => x && typeof x.t === 'string' && x.t.trim())
      .map((x) => ({
        s: c.start + Math.max(0, Number(x.s) || 0),
        e: c.start + Math.max(Number(x.e) || 0, (Number(x.s) || 0) + 0.2),
        text: x.t.trim(),
        speaker: x.sp,
      }))
      .filter((x) => x.s < c.start + c.dur);
  });

  const flat = results.flat().sort((a, b) => a.s - b.s);
  return { segments: withWords(cleanTimeline(flat, duration)), language: lang || 'auto' };
}

/** Make timestamps monotonic and non-overlapping. */
function cleanTimeline(segs: { s: number; e: number; text: string; speaker?: string }[], duration: number) {
  const out: typeof segs = [];
  for (const seg of segs) {
    const prev = out[out.length - 1];
    let s = Math.min(seg.s, duration);
    let e = Math.min(Math.max(seg.e, s + 0.2), duration);
    if (prev && s < prev.e) {
      if (s < prev.s + 0.1) s = prev.e;
      else prev.e = s;
    }
    if (e <= s) e = Math.min(duration, s + 0.3);
    if (e - s > 12) e = s + 12; // guard against runaway timestamps
    out.push({ ...seg, s, e });
  }
  return out;
}

/** Distribute word timings inside each phrase by character length (good enough for word-by-word captions). */
function withWords(segs: { s: number; e: number; text: string; speaker?: string }[]): Segment[] {
  return segs.map((seg) => {
    const tokens = seg.text.split(/\s+/).filter(Boolean);
    const weights = tokens.map((t) => Math.max(2, t.replace(/[^\p{L}\p{N}]/gu, '').length + 1));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const span = seg.e - seg.s;
    let t = seg.s;
    const words: Word[] = tokens.map((w, i) => {
      const d = (span * weights[i]) / total;
      const word = { w, s: +t.toFixed(3), e: +(t + d).toFixed(3) };
      t += d;
      return word;
    });
    return { ...seg, words };
  });
}

// ---------------- development-only fake transcript ----------------
function fakeTranscript(duration: number) {
  const lines = [
    'Nobody tells you this about building a startup',
    'the first hundred users are the hardest part',
    'we tried ads and it completely failed',
    'then one tweet changed everything for us',
    'honestly I could not believe the numbers',
    'here is the exact thing we did differently',
    'we stopped selling and started teaching',
    'and people shared it with their friends',
    'that is the whole secret really',
    'you do not need a big budget to grow',
  ];
  const segs: { s: number; e: number; text: string; speaker?: string }[] = [];
  let t = 0.4;
  let i = 0;
  while (t < duration - 1) {
    const text = lines[i % lines.length];
    const d = 1.6 + (text.length % 5) * 0.25;
    segs.push({ s: t, e: Math.min(duration, t + d), text, speaker: i % 3 === 0 ? 'S2' : 'S1' });
    t += d + 0.35;
    i++;
  }
  return { segments: withWords(segs), language: 'English' };
}

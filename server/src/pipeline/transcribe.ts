import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { pool } from '../lib/proc.js';
import { cutAudio } from './media.js';
import { generateJson, part } from './gemini.js';
import type { CaptionLanguage, Segment, Word } from '../types.js';

// Seconds per transcription request. Gemini's timestamps drift the further into a file it gets: on 8-minute chunks the
// captions ran 5–30 s behind the voice by the end of each chunk. Measured on a TED talk against its official subtitles:
// 8 min → median 7.6 s off, 2 min → 0.9 s, 30 s → 0.4 s.
const CHUNK = 30;
const CHUNK_SLACK = 8; // a chunk may end this much earlier/later to fall in a pause

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

/** What the person chose for the words on screen (New clips → More options → Caption language). */
export const SCRIPT_RULE: Record<CaptionLanguage, string> = {
  auto: 'Hindi (and Hindi mixed with English) is written in Latin (English) letters the way people type it in chat — Hinglish: "main hota na", "kya baat hai" — never in Devanagari, and not translated. Every other language is written in its own script: Marathi and Nepali in Devanagari, Bengali in Bengali script, Tamil in Tamil script, Arabic and Urdu in Arabic script, and so on. English words stay in Latin letters.',
  roman:
    'Write EVERYTHING in Latin (English) letters. Speech in Hindi, Urdu, Punjabi, Tamil or any other language is romanised the way people type it in chat (Hinglish: "main hota na", "kya baat hai"), NOT translated. English stays English.',
  english: 'Translate every phrase into natural, idiomatic English (keep names and brand words). The timestamps stay those of the original speech.',
};

/** Chunk boundaries placed in the middle of pauses so no word is cut in half between two requests. */
function chunkPlan(duration: number, silences: { s: number; e: number }[]) {
  const bounds = [0];
  while (duration - bounds[bounds.length - 1] > CHUNK + CHUNK_SLACK) {
    const target = bounds[bounds.length - 1] + CHUNK;
    let best = target;
    let bd = Infinity;
    for (const x of silences) {
      const mid = (x.s + x.e) / 2;
      const d = Math.abs(mid - target);
      if (d < bd && d <= CHUNK_SLACK && x.e - x.s >= 0.3) {
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
  script: CaptionLanguage = 'auto',
): Promise<{ segments: Segment[]; language: string }> {
  if (config.fakeAi) return fakeTranscript(duration);
  const sys = `${system}\n${SCRIPT_RULE[script]}`;

  const chunks = chunkPlan(duration, silences);
  let done = 0;
  let lang = '';
  const results = await pool(chunks, config.transcribeParallel, async (c, i) => {
    const file = path.join(workDir, `chunk_${String(i).padStart(3, '0')}.mp3`);
    // each chunk's answer is kept next to its audio: a restart mid-way (deploy, crash) picks up where it stopped
    // instead of paying for the whole video again; the key holds the script choice and the chunk's exact bounds
    const cacheFile = path.join(workDir, `chunk_${String(i).padStart(3, '0')}.${script}.${Math.round(c.start)}-${Math.round(c.dur)}.json`);
    const cached = readChunkCache(cacheFile);
    if (!cached) await cutAudio(audioPath, file, c.start, c.dur);
    const ask = (timeoutMs = 40_000) =>
      generateJson<RawChunk>({
        model: config.fastModel,
        system: sys,
        parts: [part.file(file, 'audio/mp3'), part.text(`Transcribe this ${Math.round(c.dur)}-second audio chunk. Work out which language is spoken and return its name too.`)],
        schema,
        audioTimestamp: true,
        thinking: 'MINIMAL',
        maxOutputTokens: 8192,
        // a 30-second piece normally answers in a few seconds; a stuck call must not hold a clip for minutes
        timeoutMs,
        label: `transcribe chunk ${i + 1}/${chunks.length}`,
      });
    // a stuck request (no answer in ~45 s, when a short piece normally takes a few) is asked once more rather than
    // failing the piece: the second try usually answers right away
    const askOnce = () =>
      ask().catch((e: Error) => {
        if (!/took too long/i.test(e.message)) throw e;
        console.warn(`[transcribe] chunk ${i + 1}/${chunks.length}: no answer in time — asking again`);
        return ask(75_000);
      });
    let r = cached ?? (await askOnce());
    if (!cached) {
      for (let tries = 1; tries < 3 && badTimes(r.segments || [], c.dur); tries++) r = await askOnce();
      if (badTimes(r.segments || [], c.dur)) {
        console.warn(`[transcribe] chunk ${i + 1}: timestamps still broken after 3 tries — spreading its phrases evenly`);
        r = { ...r, segments: spreadEvenly(r.segments || [], c.dur) };
      }
      writeChunkCache(cacheFile, r);
    }
    done++;
    onProgress(done, chunks.length);
    if (r.language && !lang) lang = r.language;
    return (
      (r.segments || [])
        .filter((x) => x && typeof x.t === 'string' && x.t.trim())
        .map((x) => ({
          s: c.start + Math.max(0, Number(x.s) || 0),
          e: c.start + Math.max(Number(x.e) || 0, (Number(x.s) || 0) + 0.2),
          text: x.t.trim(),
          speaker: x.sp,
        }))
        .filter((x) => x.s < c.start + c.dur)
        // a model stuck in a loop repeats one line over and over — keep at most two in a row
        .filter((x, k, all) => !(k >= 2 && all[k - 1].text === x.text && all[k - 2].text === x.text))
    );
  });

  const flat = results.flat().sort((a, b) => a.s - b.s);
  return { segments: withWords(cleanTimeline(flat, duration)), language: lang || 'auto' };
}

type RawChunk = { language?: string; segments: { s: number; e: number; sp?: string; t: string }[] };

function readChunkCache(file: string): RawChunk | null {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8')) as RawChunk;
    return Array.isArray(r?.segments) ? r : null;
  } catch {
    return null;
  }
}
function writeChunkCache(file: string, r: RawChunk) {
  try {
    fs.writeFileSync(file, JSON.stringify(r));
  } catch {
    /* a full disk only loses the shortcut */
  }
}

/** Words actually spoken (sound tags like [music] or [laughs] don't count). */
export function spokenWords(segs: { text: string }[]): number {
  let n = 0;
  for (const s of segs)
    n += s.text
      .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
      .split(/\s+/)
      .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return n;
}

/**
 * Is anyone talking? Listens to a few 30-second slices spread across the video instead of all of it — a silent
 * 3-hour video would otherwise cost ~360 transcription calls before finding out. Returns the words heard.
 */
export async function sampleSpeech(audioPath: string, duration: number, workDir: string, samples = 8): Promise<number> {
  if (config.fakeAi) return 999;
  const len = 30;
  const n = Math.max(1, Math.min(samples, Math.floor(duration / len)));
  const starts = Array.from({ length: n }, (_, i) => Math.max(0, Math.min(duration - len, ((i + 0.5) * duration) / n - len / 2)));
  const counts = await pool(starts, 4, async (s, i) => {
    const file = path.join(workDir, `probe_${i}.mp3`);
    await cutAudio(audioPath, file, s, Math.min(len, duration - s));
    try {
      const r = await generateJson<RawChunk>({
        model: config.fastModel,
        system,
        parts: [part.file(file, 'audio/mp3'), part.text('Transcribe the speech in this audio. Return an empty list when nobody is talking (only music, sound effects, ASMR sounds or noise).')],
        schema,
        thinking: 'MINIMAL',
        maxOutputTokens: 4096,
        timeoutMs: 75_000,
        label: `speech check ${i + 1}/${n}`,
      });
      return spokenWords((r.segments || []).map((x) => ({ text: String(x?.t ?? '') })));
    } catch {
      return 99; // can't tell: assume talking, so the normal transcription runs
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
  return counts.reduce((a, b) => a + b, 0);
}

/** Timestamps that stall (phrase after phrase at the same time) or run past the chunk: the model lost track of time. */
function badTimes(segs: RawChunk['segments'], dur: number) {
  if (segs.length < 3) return false;
  let wrong = 0;
  for (const [k, x] of segs.entries()) {
    const s = Number(x.s);
    if (!Number.isFinite(s) || s > dur + 1 || (k > 0 && s <= Number(segs[k - 1].s) + 0.05)) wrong++;
  }
  return wrong / segs.length > 0.3;
}

function spreadEvenly(segs: RawChunk['segments'], dur: number): RawChunk['segments'] {
  const len = segs.map((x) => Math.max(1, x.t.length));
  const total = len.reduce((a, b) => a + b, 0);
  let t = 0;
  return segs.map((x, k) => {
    const s = t;
    t += (dur * len[k]) / total;
    return { ...x, s, e: t };
  });
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
    const weights = tokens.map((t) => Math.max(2, t.replace(/[^\p{L}\p{M}\p{N}]/gu, '').length + 1));
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

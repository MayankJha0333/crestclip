import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { config } from '../config.js';
import { run } from '../lib/proc.js';

/**
 * Background music.
 *
 *  • AI moods — instrumental tracks made with Google's Lyria model on Vertex AI (same project + credits as Gemini).
 *    Each mood is generated once, then reused for every clip (cached in data/music/ai).
 *  • Your own tracks — uploaded files (data/music/uploads).
 *
 * A clip's music setting is 'none', 'auto' (mood picked from the clip's category), a mood id, or 'upload:<id>'.
 */

export interface Mood {
  id: string;
  label: string;
  hint: string;
  prompt: string;
}

const MOODS: Mood[] = [
  { id: 'chill', label: 'Chill lo-fi', hint: 'Podcasts, stories, calm talks', prompt: 'Chill lo-fi hip hop instrumental, warm Rhodes piano chords, soft dusty drums, mellow bass, relaxed and cozy, 85 BPM' },
  { id: 'upbeat', label: 'Upbeat', hint: 'Relatable, feel-good moments', prompt: 'Upbeat feel-good pop instrumental, bright plucky synths, claps and punchy drums, positive and catchy, 118 BPM' },
  { id: 'inspiring', label: 'Inspiring', hint: 'Insights, motivation, big ideas', prompt: 'Inspiring cinematic instrumental, hopeful piano motif with warm strings slowly building, motivational, modern documentary style' },
  { id: 'hype', label: 'Hype', hint: 'Sports, gaming, high energy', prompt: 'High-energy trap instrumental, hard hitting drums, deep 808 bass, bold synth lead, intense and confident, 140 BPM' },
  { id: 'suspense', label: 'Suspense', hint: 'Surprising facts, hot takes', prompt: 'Suspenseful dark instrumental, ticking percussion, low pulsing synth bass, tense strings, mysterious documentary tension' },
  { id: 'funny', label: 'Funny', hint: 'Comedy, awkward moments', prompt: 'Playful quirky comedic instrumental, pizzicato strings, bouncy tuba and bassoon, light percussion, cartoon-like and cheeky' },
  { id: 'emotional', label: 'Emotional', hint: 'Heartfelt, vulnerable moments', prompt: 'Emotional soft piano instrumental, gentle and heartfelt, slow tempo, reflective with light ambient pads' },
  { id: 'tech', label: 'Clean tech', hint: 'Business, tech, tutorials', prompt: 'Clean modern corporate tech instrumental, light electronic beat, airy synth pads, optimistic and focused, 110 BPM' },
];
const NEGATIVE = 'vocals, singing, lyrics, spoken words, speech, voice';
/** Every track is levelled to the same loudness, so the volume slider means the same thing for all of them. */
const LEVEL = 'loudnorm=I=-16:TP=-1.5:LRA=11,aformat=sample_rates=48000:channel_layouts=stereo';

/** Older/foreign files: level them once (marker file = done). */
async function ensureLevelled(file: string) {
  if (fs.existsSync(`${file}.ok`)) return;
  const tmp = `${file}.lvl.m4a`;
  await run(config.ffmpeg, ['-y', '-v', 'error', '-i', file, '-af', LEVEL, '-c:a', 'aac', '-b:a', '192k', tmp], { timeoutMs: 180_000 });
  fs.renameSync(tmp, file);
  fs.writeFileSync(`${file}.ok`, '');
}

/** 'auto' → a mood that fits the clip's category */
const CATEGORY_MOOD: Record<string, string> = {
  humor: 'funny',
  insight: 'inspiring',
  story: 'chill',
  controversy: 'suspense',
  emotional: 'emotional',
  educational: 'tech',
  surprising: 'suspense',
  relatable: 'upbeat',
};

const root = () => path.join(config.dataDir, 'music');
const aiDir = () => path.join(root(), 'ai');
const upDir = () => path.join(root(), 'uploads');
const aiFile = (mood: string) => path.join(aiDir(), `${mood}.m4a`);

export interface Upload {
  id: string;
  name: string;
  file: string;
  createdAt: number;
}
function readUploads(): Upload[] {
  try {
    return (JSON.parse(fs.readFileSync(path.join(upDir(), 'index.json'), 'utf8')) as Upload[]).filter((u) => fs.existsSync(u.file));
  } catch {
    return [];
  }
}
function writeUploads(list: Upload[]) {
  fs.mkdirSync(upDir(), { recursive: true });
  fs.writeFileSync(path.join(upDir(), 'index.json'), JSON.stringify(list, null, 1));
}

export function musicLibrary() {
  return {
    moods: MOODS.map((m) => ({ id: m.id, label: m.label, hint: m.hint, ready: fs.existsSync(aiFile(m.id)), file: fs.existsSync(aiFile(m.id)) ? aiFile(m.id) : null })),
    uploads: readUploads().map((u) => ({ id: u.id, name: u.name, file: u.file })),
    status: { ...lyriaStatus },
  };
}

/** Save an uploaded track (converted to AAC so every browser can preview it). */
export async function addUpload(tmpPath: string, originalName: string): Promise<Upload> {
  fs.mkdirSync(upDir(), { recursive: true });
  const id = randomUUID().slice(0, 10);
  const file = path.join(upDir(), `${id}.m4a`);
  await run(config.ffmpeg, ['-y', '-v', 'error', '-i', tmpPath, '-vn', '-t', '600', '-af', LEVEL, '-ac', '2', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', file], { timeoutMs: 180_000 });
  fs.writeFileSync(`${file}.ok`, '');
  fs.rmSync(tmpPath, { force: true });
  const u: Upload = { id, name: originalName.replace(/\.[^.]+$/, '').slice(0, 80) || 'My track', file, createdAt: Date.now() };
  writeUploads([u, ...readUploads()]);
  return u;
}

export function removeUpload(id: string) {
  const list = readUploads();
  const u = list.find((x) => x.id === id);
  if (u) {
    fs.rmSync(u.file, { force: true });
    fs.rmSync(`${u.file}.ok`, { force: true });
  }
  writeUploads(list.filter((x) => x.id !== id));
}

// ---------------- Lyria (Vertex AI) ----------------
export const lyriaStatus: { ok: boolean | null; detail: string } = { ok: null, detail: '' };
let auth: GoogleAuth | null = null;

async function lyriaGenerate(prompt: string, seed: number): Promise<Buffer> {
  const model = config.musicModel;
  const loc = config.musicLocation;
  const body = JSON.stringify({ instances: [{ prompt, negative_prompt: NEGATIVE, seed }], parameters: {} });
  let url: string;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.gcpProject) {
    url = `https://${loc}-aiplatform.googleapis.com/v1/projects/${config.gcpProject}/locations/${loc}/publishers/google/models/${model}:predict`;
    auth ??= new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const token = await (await auth.getClient()).getAccessToken();
    headers.authorization = `Bearer ${token.token ?? token}`;
  } else if (config.vertexApiKey) {
    url = `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:predict?key=${encodeURIComponent(config.vertexApiKey)}`;
  } else throw new Error('Google Cloud is not configured');

  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(180_000) });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      msg = (JSON.parse(text).error?.message as string) || msg;
    } catch {
      /* not json */
    }
    if (res.status === 403) msg = `No permission to use ${model} in this project (${msg})`;
    if (res.status === 404) msg = `${model} isn’t available in ${loc} for this project (${msg})`;
    throw new Error(msg);
  }
  const j = JSON.parse(text) as { predictions?: Record<string, unknown>[] };
  const pred = j.predictions?.[0] ?? {};
  const b64 = (pred.bytesBase64Encoded ?? pred.audioContent ?? Object.values(pred).find((v) => typeof v === 'string' && v.length > 1000)) as string | undefined;
  if (!b64) throw new Error('Lyria returned no audio');
  return Buffer.from(b64, 'base64');
}

/** Dev/offline stand-in: a soft chord loop made with ffmpeg (only used in CRESTCLIP_FAKE_AI mode). */
async function synthPlaceholder(out: string, mood: string) {
  const roots: Record<string, number[]> = { chill: [220, 174.6, 196, 164.8], upbeat: [261.6, 196, 220, 174.6] };
  const r = roots[mood] ?? [196, 220, 174.6, 261.6];
  const chord = (f: number, t0: number) =>
    `(0.10*sin(2*PI*${f}*t)+0.07*sin(2*PI*${f * 1.26}*t)+0.06*sin(2*PI*${f * 1.5}*t))*between(mod(t,8),${t0},${t0 + 2})`;
  const expr = r.map((f, i) => chord(f, i * 2)).join('+');
  const beat = `0.25*sin(2*PI*55*t)*exp(-18*mod(t,0.5))`;
  await run(config.ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `aevalsrc='${expr}+${beat}':s=48000:d=30`, '-ac', '2', '-c:a', 'aac', '-b:a', '160k', out], { timeoutMs: 60_000 });
}

/** A 30 s Lyria take is short; stitch it with itself (smooth crossfades) so it covers long clips without a hard loop seam. */
async function extendTrack(wav: string, out: string) {
  await run(
    config.ffmpeg,
    ['-y', '-v', 'error', '-i', wav, '-i', wav, '-i', wav, '-filter_complex', `[0:a][1:a]acrossfade=d=3:c1=tri:c2=tri[a01];[a01][2:a]acrossfade=d=3:c1=tri:c2=tri,${LEVEL}[a]`, '-map', '[a]', '-c:a', 'aac', '-b:a', '192k', out],
    { timeoutMs: 120_000 },
  );
}

const generating = new Map<string, Promise<string>>();

/** Make (or re-make) the track for a mood. */
export function generateMood(moodId: string, fresh = false): Promise<string> {
  const mood = MOODS.find((m) => m.id === moodId);
  if (!mood) return Promise.reject(new Error(`Unknown music mood “${moodId}”`));
  const out = aiFile(mood.id);
  if (!fresh && fs.existsSync(out)) return ensureLevelled(out).then(() => out);
  const cur = generating.get(mood.id);
  if (cur) return cur;
  const job = (async () => {
    fs.mkdirSync(aiDir(), { recursive: true });
    const tmpOut = `${out}.tmp.m4a`;
    if (config.fakeAi) {
      await synthPlaceholder(tmpOut, mood.id);
    } else {
      const wav = path.join(aiDir(), `${mood.id}.raw.wav`);
      try {
        fs.writeFileSync(wav, await lyriaGenerate(mood.prompt, Math.floor(Math.random() * 2 ** 31)));
        lyriaStatus.ok = true;
        lyriaStatus.detail = '';
      } catch (e) {
        lyriaStatus.ok = false;
        lyriaStatus.detail = (e as Error).message;
        throw new Error(`AI music isn’t available right now: ${(e as Error).message}`);
      }
      await extendTrack(wav, tmpOut);
      fs.rmSync(wav, { force: true });
    }
    fs.renameSync(tmpOut, out);
    fs.writeFileSync(`${out}.ok`, '');
    return out;
  })().finally(() => generating.delete(mood.id));
  generating.set(mood.id, job);
  return job;
}

/** Resolve a clip's music setting to a local audio file (generating the mood track the first time). */
export async function resolveMusic(track: string, category: string): Promise<{ file: string; label: string } | null> {
  if (!track || track === 'none') return null;
  if (track.startsWith('upload:')) {
    const u = readUploads().find((x) => x.id === track.slice(7));
    if (!u) throw new Error('The uploaded music track was deleted.');
    await ensureLevelled(u.file);
    return { file: u.file, label: u.name };
  }
  const moodId = track === 'auto' ? (CATEGORY_MOOD[category] ?? 'chill') : track;
  const mood = MOODS.find((m) => m.id === moodId);
  if (!mood) return null;
  return { file: await generateMood(mood.id), label: mood.label };
}

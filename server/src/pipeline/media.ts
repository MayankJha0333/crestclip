import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { run } from '../lib/proc.js';

export interface Probe {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  rotation: number;
}

export async function probe(file: string, opts: { audioOnlyOk?: boolean } = {}): Promise<Probe> {
  const { stdout } = await run(config.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {
    timeoutMs: 60_000,
  });
  const j = JSON.parse(stdout);
  const v = (j.streams || []).find((s: { codec_type: string }) => s.codec_type === 'video');
  const a = (j.streams || []).find((s: { codec_type: string }) => s.codec_type === 'audio');
  if (!v) {
    if (opts.audioOnlyOk && a) return { duration: Number(j.format?.duration || a.duration || 0), width: 0, height: 0, fps: 0, hasAudio: true, rotation: 0 };
    throw new Error('This file has no video track.');
  }
  const [n, d] = String(v.avg_frame_rate || v.r_frame_rate || '30/1').split('/').map(Number);
  let rotation = 0;
  for (const sd of v.side_data_list || []) if (typeof sd.rotation === 'number') rotation = sd.rotation;
  if (v.tags?.rotate) rotation = Number(v.tags.rotate);
  let width = Number(v.width);
  let height = Number(v.height);
  if (Math.abs(rotation) === 90 || Math.abs(rotation) === 270) [width, height] = [height, width];
  return {
    duration: Number(j.format?.duration || v.duration || 0),
    width,
    height,
    fps: d ? n / d : 30,
    hasAudio: Boolean(a),
    rotation,
  };
}

/** Mono 16 kHz audio for Gemini transcription (small, speech-friendly). */
export async function extractAudio(src: string, out: string) {
  await run(config.ffmpeg, ['-y', '-v', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', out], {
    timeoutMs: 60 * 60 * 1000,
  });
}

/** Mono 16 kHz audio for just one part of a file. */
export async function extractAudioRange(src: string, start: number, dur: number, out: string) {
  await run(config.ffmpeg, ['-y', '-v', 'error', '-ss', Math.max(0, start).toFixed(3), '-t', dur.toFixed(3), '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', out], {
    timeoutMs: 10 * 60 * 1000,
  });
}

export async function cutAudio(src: string, out: string, start: number, dur: number) {
  await run(config.ffmpeg, ['-y', '-v', 'error', '-ss', String(start), '-t', String(dur), '-i', src, '-c', 'copy', out], {
    timeoutMs: 10 * 60 * 1000,
  });
}

/** RMS loudness (dB) per second — a cheap "energy" signal (laughs, shouting, excitement). */
export async function loudnessPerSecond(audio: string, workDir: string): Promise<number[]> {
  const out = path.join(workDir, 'rms.txt');
  await run(
    config.ffmpeg,
    [
      '-v',
      'error',
      '-i',
      audio,
      '-af',
      `asetnsamples=n=16000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=rms.txt`,
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 30 * 60 * 1000, cwd: workDir },
  );
  const vals: number[] = [];
  for (const line of fs.readFileSync(out, 'utf8').split('\n')) {
    const m = line.match(/RMS_level=(-?[\d.]+|-inf)/);
    if (m) vals.push(m[1] === '-inf' ? -90 : Math.max(-90, Number(m[1])));
  }
  return vals;
}

/** Silence ranges — used to snap clip edges into natural pauses. */
export async function silences(audio: string): Promise<{ s: number; e: number }[]> {
  const { stderr } = await run(config.ffmpeg, ['-v', 'info', '-i', audio, '-af', 'silencedetect=noise=-32dB:d=0.25', '-f', 'null', '-'], {
    timeoutMs: 30 * 60 * 1000,
  });
  const res: { s: number; e: number }[] = [];
  let cur: number | null = null;
  for (const line of stderr.split('\n')) {
    const a = line.match(/silence_start: (-?[\d.]+)/);
    const b = line.match(/silence_end: (-?[\d.]+)/);
    if (a) cur = Math.max(0, Number(a[1]));
    if (b && cur != null) {
      res.push({ s: cur, e: Number(b[1]) });
      cur = null;
    }
  }
  return res;
}

/** Scene cuts (seconds relative to `start`) inside a range, detected on a low-res decode. */
export async function sceneCuts(src: string, start: number, dur: number): Promise<number[]> {
  const { stderr } = await run(
    config.ffmpeg,
    ['-v', 'info', '-ss', String(start), '-t', String(dur), '-i', src, '-an', '-vf', 'scale=320:-2,scdet=threshold=12', '-f', 'null', '-'],
    { timeoutMs: 10 * 60 * 1000 },
  );
  const cuts: number[] = [];
  for (const line of stderr.split('\n')) {
    const m = line.match(/lavfi\.scd\.time:\s*([\d.]+)/);
    if (m) cuts.push(Number(m[1]));
  }
  return cuts.filter((t) => t > 0.3 && t < dur - 0.3);
}

/** Extract JPEG frames at the given times (relative to clip start), small, for Gemini framing analysis. */
export async function framesAt(src: string, start: number, times: number[], dir: string, width = 448): Promise<string[]> {
  fs.mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  // One ffmpeg call per frame with fast input seeking is simple and robust for ~40 frames.
  for (let i = 0; i < times.length; i++) {
    const f = path.join(dir, `f${String(i).padStart(3, '0')}.jpg`);
    await run(
      config.ffmpeg,
      ['-y', '-v', 'error', '-ss', (start + times[i]).toFixed(3), '-i', src, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '5', f],
      { timeoutMs: 60_000 },
    );
    if (fs.existsSync(f)) files.push(f);
  }
  return files;
}

export async function thumbnail(src: string, at: number, out: string, width = 640) {
  await run(config.ffmpeg, ['-y', '-v', 'error', '-ss', String(Math.max(0, at)), '-i', src, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', out], {
    timeoutMs: 60_000,
  });
}

/** Small proxy video (for sending to Gemini through Cloud Storage). */
export async function makeProxy(src: string, out: string) {
  await run(
    config.ffmpeg,
    ['-y', '-v', 'error', '-i', src, '-vf', 'scale=-2:360,fps=10', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-c:a', 'aac', '-b:a', '48k', '-ac', '1', out],
    { timeoutMs: 2 * 60 * 60 * 1000 },
  );
}

let libass: boolean | null = null;
/** Call after switching to a different ffmpeg binary. */
export function resetFfmpegCache() {
  libass = null;
}
/** Captions are burned in with libass. The built-in ffmpeg has it; a custom FFMPEG_PATH might not. */
export async function hasLibass(): Promise<boolean> {
  if (libass == null) {
    libass = await run(config.ffmpeg, ['-hide_banner', '-filters'], { timeoutMs: 15_000 })
      .then((r) => /^\s*\S+\s+ass\s+V->V/m.test(r.stdout))
      .catch(() => false);
  }
  return libass;
}

export async function ffmpegVersion(): Promise<string | null> {
  try {
    const { stdout } = await run(config.ffmpeg, ['-version'], { timeoutMs: 15_000 });
    const hasAss = await hasLibass();
    return stdout.split('\n')[0].replace(/ Copyright.*$/, '') + (hasAss ? '' : ' (no caption support)');
  } catch {
    return null;
  }
}

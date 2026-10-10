import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { run } from '../lib/proc.js';

interface LocalFaceTrack {
  times: number[];
  frames: { i: number; faces: { box: number[]; speaking: boolean }[]; subject: number[] }[];
}

/** Returns null when the optional local model is unavailable; the existing Gemini detector remains the fallback. */
export async function trackFacesLocally(src: string, start: number, end: number): Promise<LocalFaceTrack | null> {
  if (!config.localFaceTracking) return null;
  try {
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'face_tracker.py');
    const { stdout } = await run(config.python, [script, src, String(start), String(end)], { timeoutMs: Math.max(60_000, (end - start) * 4000) });
    const result = JSON.parse(stdout) as LocalFaceTrack;
    if (!Array.isArray(result.times) || !Array.isArray(result.frames) || result.frames.length < 1) return null;
    return result;
  } catch (e) {
    console.warn(`[reframe] local face model unavailable — using Gemini detection: ${(e as Error).message.slice(0, 180)}`);
    return null;
  }
}

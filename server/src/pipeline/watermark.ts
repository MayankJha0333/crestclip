import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { run } from '../lib/proc.js';

/**
 * The person's watermark: one logo, set up once in Settings, stamped on every clip CrestClip renders.
 * Stored as a small JSON file + a PNG in <data>/brand.
 */
export type WatermarkPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type WatermarkSize = 'small' | 'medium' | 'large';

export interface Watermark {
  enabled: boolean;
  file: string | null; // the logo PNG (absolute path), null = no logo yet
  name: string; // original file name, for the UI
  position: WatermarkPosition;
  size: WatermarkSize;
  opacity: number; // 20-100 (%)
}

/**
 * Where the logo sits on the 1080×1920 frame (kept in sync with the web preview in WatermarkMark.tsx).
 * Everything stays inside the area no app covers: below the ~210 px Reels top bar, ~90 px in from the sides,
 * and bottom corners above the caption + buttons area (~320 px) of TikTok / Reels / Shorts.
 */
export const WATERMARK_BOX = { small: 0.13, medium: 0.19, large: 0.26 } as const; // max width AND height, as a share of the frame width
const SIDE = 0.085; // gap from the left/right edge, share of width (92 px)
const TOP = 0.115; // gap from the top, share of height (221 px)
const BOTTOM = 0.22; // gap from the bottom, share of height

const DEFAULTS: Watermark = { enabled: true, file: null, name: '', position: 'top-right', size: 'medium', opacity: 85 };

const dir = () => path.join(config.dataDir, 'brand');
const settingsFile = () => path.join(dir(), 'watermark.json');

export function readWatermark(): Watermark {
  try {
    const w = { ...DEFAULTS, ...(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Partial<Watermark>) };
    if (w.file && !fs.existsSync(w.file)) return { ...w, file: null, name: '' };
    return w;
  } catch {
    return { ...DEFAULTS };
  }
}

function writeWatermark(w: Watermark) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(w, null, 1));
  return w;
}

export function updateWatermark(patch: Partial<Pick<Watermark, 'enabled' | 'position' | 'size' | 'opacity'>>) {
  return writeWatermark({ ...readWatermark(), ...patch });
}

/** Save an uploaded image as the logo: one frame, transparent PNG, at most 600px wide. Replaces the old logo. */
export async function setWatermarkLogo(tmpPath: string, originalName: string) {
  fs.mkdirSync(dir(), { recursive: true });
  const file = path.join(dir(), `logo-${randomUUID().slice(0, 8)}.png`);
  try {
    await run(config.ffmpeg, ['-y', '-v', 'error', '-i', tmpPath, '-frames:v', '1', '-vf', "scale='min(600,iw)':-1:flags=lanczos,format=rgba", file], { timeoutMs: 60_000 });
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
  const old = readWatermark();
  if (old.file && old.file !== file) fs.rmSync(old.file, { force: true });
  return writeWatermark({ ...old, file, name: originalName.slice(0, 80), enabled: true });
}

export function removeWatermarkLogo() {
  const w = readWatermark();
  if (w.file) fs.rmSync(w.file, { force: true });
  return writeWatermark({ ...w, file: null, name: '' });
}

/** Lowest point of a top-corner logo on the frame (px), so headlines can sit under it; null for bottom corners. */
export const watermarkTopBottom = (w: Watermark) => (w.position.startsWith('top') ? Math.round(1920 * TOP + 1080 * WATERMARK_BOX[w.size]) : null);

/** What the renderer needs, or null when there's nothing to stamp. */
export function watermarkForRender(): (Watermark & { file: string }) | null {
  const w = readWatermark();
  return w.enabled && w.file ? (w as Watermark & { file: string }) : null;
}

/**
 * ffmpeg filter that stamps the logo (input #`input`) on the video `inLabel` → `outLabel`.
 * Works on the final 1080×1920 frame, after reframing and zooms, under the captions.
 */
export function watermarkFilter(w: Watermark, input: number, inLabel: string, outLabel: string) {
  const box = Math.round(1080 * WATERMARK_BOX[w.size]);
  const x = w.position.endsWith('left') ? `${Math.round(1080 * SIDE)}` : `W-w-${Math.round(1080 * SIDE)}`;
  const y = w.position.startsWith('top') ? `${Math.round(1920 * TOP)}` : `H-h-${Math.round(1920 * BOTTOM)}`;
  const alpha = Math.max(0.2, Math.min(1, w.opacity / 100)).toFixed(2);
  return [
    `[${input}:v]format=rgba,scale=w=${box}:h=${box}:force_original_aspect_ratio=decrease:flags=lanczos,colorchannelmixer=aa=${alpha}[wm]`,
    `${inLabel}[wm]overlay=x=${x}:y=${y}:format=auto${outLabel}`,
  ].join(';');
}

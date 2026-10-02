import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { run } from '../lib/proc.js';
import { Resvg } from '@resvg/resvg-js';

/**
 * The person's watermark: one logo, set up once in Settings, stamped on every clip CrestClip renders (paid plans).
 * Free-plan clips carry a small CrestClip mark instead (see crestclipMark).
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

/** Each person's watermark lives in <data>/brand/<userId>. */
const dir = (userId: string) => path.join(config.dataDir, 'brand', userId.replace(/[^\w-]/g, ''));
const settingsFile = (userId: string) => path.join(dir(userId), 'watermark.json');

export function readWatermark(userId: string): Watermark {
  try {
    const w = { ...DEFAULTS, ...(JSON.parse(fs.readFileSync(settingsFile(userId), 'utf8')) as Partial<Watermark>) };
    if (w.file && !fs.existsSync(w.file)) return { ...w, file: null, name: '' };
    return w;
  } catch {
    return { ...DEFAULTS };
  }
}

function writeWatermark(userId: string, w: Watermark) {
  fs.mkdirSync(dir(userId), { recursive: true });
  fs.writeFileSync(settingsFile(userId), JSON.stringify(w, null, 1));
  return w;
}

export function updateWatermark(userId: string, patch: Partial<Pick<Watermark, 'enabled' | 'position' | 'size' | 'opacity'>>) {
  return writeWatermark(userId, { ...readWatermark(userId), ...patch });
}

/** Save an uploaded image as the logo: one frame, transparent PNG, at most 600px wide. Replaces the old logo. */
export async function setWatermarkLogo(userId: string, tmpPath: string, originalName: string) {
  fs.mkdirSync(dir(userId), { recursive: true });
  const file = path.join(dir(userId), `logo-${randomUUID().slice(0, 8)}.png`);
  try {
    await run(config.ffmpeg, ['-y', '-v', 'error', '-i', tmpPath, '-frames:v', '1', '-vf', "scale='min(600,iw)':-1:flags=lanczos,format=rgba", file], { timeoutMs: 60_000 });
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
  const old = readWatermark(userId);
  if (old.file && old.file !== file) fs.rmSync(old.file, { force: true });
  return writeWatermark(userId, { ...old, file, name: originalName.slice(0, 80), enabled: true });
}

export function removeWatermarkLogo(userId: string) {
  const w = readWatermark(userId);
  if (w.file) fs.rmSync(w.file, { force: true });
  return writeWatermark(userId, { ...w, file: null, name: '' });
}

/** The watermark set up before accounts existed (<data>/brand/watermark.json) becomes the first account's. */
export function adoptLegacyWatermark(userId: string) {
  const legacy = path.join(config.dataDir, 'brand', 'watermark.json');
  if (!fs.existsSync(legacy)) return;
  try {
    const w = { ...DEFAULTS, ...(JSON.parse(fs.readFileSync(legacy, 'utf8')) as Partial<Watermark>) };
    fs.mkdirSync(dir(userId), { recursive: true });
    if (w.file && fs.existsSync(w.file)) {
      const moved = path.join(dir(userId), path.basename(w.file));
      fs.renameSync(w.file, moved);
      w.file = moved;
    } else w.file = null;
    writeWatermark(userId, w);
    fs.rmSync(legacy, { force: true });
  } catch (e) {
    console.warn('[watermark] could not move the old watermark:', (e as Error).message);
  }
}

/** Lowest point of a top-corner logo on the frame (px), so headlines can sit under it; null for bottom corners. */
export const watermarkTopBottom = (w: Watermark) => (w.position.startsWith('top') ? Math.round(1920 * TOP + 1080 * WATERMARK_BOX[w.size]) : null);

/** What the renderer needs, or null when there's nothing to stamp. */
export function watermarkForRender(userId: string): (Watermark & { file: string }) | null {
  const w = readWatermark(userId);
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

// ---------------- the CrestClip mark on Free-plan clips ----------------
const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="150" viewBox="0 0 560 150">
  <rect x="4" y="4" width="552" height="142" rx="71" fill="#1e1b2b" fill-opacity=".62"/>
  <rect x="22" y="22" width="106" height="106" rx="34" fill="#FF8A5B"/>
  <g transform="translate(41 41) scale(1.7)">
    <path d="M3.5 29 C9.5 29 12 21.5 16 16.5 C20 11.5 26.5 7.5 31.8 10 C35.8 11.9 36 17.4 32.2 18.6 C29.4 19.5 27.4 17 28.9 15" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M5 36 C9 33.5 13 33.5 17 36 C21 38.5 25 38.5 29 36 C31.5 34.5 33.5 34 35.5 34.6" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="3" stroke-linecap="round"/>
    <circle cx="34.6" cy="5" r="3.4" fill="#FFD65C"/>
  </g>
  <text x="150" y="98" font-family="Poppins" font-weight="700" font-size="62" fill="#ffffff">Crest<tspan fill="#FFB08A">Clip</tspan></text>
</svg>`;

/** The "made with CrestClip" mark (drawn once into <data>/brand/crestclip-mark.png). */
export function crestclipMark(): Watermark & { file: string } {
  const file = path.join(config.dataDir, 'brand', 'crestclip-mark.png');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const png = new Resvg(MARK_SVG, {
      fitTo: { mode: 'width', value: 560 },
      font: { fontFiles: [path.join(config.fontsDir, 'Poppins-Bold.ttf')], loadSystemFonts: false, defaultFontFamily: 'Poppins' },
    })
      .render()
      .asPng();
    fs.writeFileSync(file, png);
  }
  return { enabled: true, file, name: 'CrestClip', position: 'top-left', size: 'large', opacity: 90 };
}

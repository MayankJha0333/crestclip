import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { run } from '../lib/proc.js';
import type { LogoChoice } from '../types.js';
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
  /** a free spot (0-1 across / down the frame's safe area) instead of `position`'s corner — set per project */
  x?: number;
  y?: number;
}

/** Every logo the person has uploaded (the Settings one included), so a project can pick a different one. */
export interface LogoEntry {
  id: string;
  name: string;
}

interface Stored extends Watermark {
  logos?: LogoEntry[];
}

/**
 * Where the logo sits on the 1080×1920 frame (kept in sync with the web preview in WatermarkMark.tsx):
 * tucked into the chosen corner of the video, a small even gap from the edges.
 */
const WATERMARK_BOX = { small: 0.13, medium: 0.19, large: 0.26 } as const; // max width AND height, as a share of the frame width
const SIDE = 0.04; // gap from the left/right edge, share of width (43 px)
const TOP = 0.025; // gap from the top, share of height (48 px)
const BOTTOM = 0.025; // gap from the bottom, share of height (48 px)

const DEFAULTS: Watermark = { enabled: true, file: null, name: '', position: 'top-right', size: 'medium', opacity: 85 };
const CORNERS: Record<WatermarkPosition, { x: number; y: number }> = {
  'top-left': { x: 0, y: 0 },
  'top-right': { x: 1, y: 0 },
  'bottom-left': { x: 0, y: 1 },
  'bottom-right': { x: 1, y: 1 },
};
const spotOf = (w: Watermark) => (w.x != null && w.y != null ? { x: w.x, y: w.y } : CORNERS[w.position]);

/** Each person's watermark lives in <data>/brand/<userId>. */
const dir = (userId: string) => path.join(config.dataDir, 'brand', userId.replace(/[^\w-]/g, ''));
const settingsFile = (userId: string) => path.join(dir(userId), 'watermark.json');
export const LOGO_ID = /^[a-f0-9]{8}$/;
const logoFile = (userId: string, id: string) => path.join(dir(userId), `logo-${id}.png`);
const idOf = (file: string) => /logo-([a-f0-9]{8})\.png$/.exec(file)?.[1] ?? null;

function readStored(userId: string): Stored {
  try {
    return { ...DEFAULTS, ...(JSON.parse(fs.readFileSync(settingsFile(userId), 'utf8')) as Partial<Stored>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function readWatermark(userId: string): Watermark {
  const { logos: _l, ...w } = readStored(userId);
  if (w.file && !fs.existsSync(w.file)) return { ...w, file: null, name: '' };
  return w;
}

/** The logo library, newest last. Logos saved before the library existed (the Settings one) are listed too. */
export function listLogos(userId: string): (LogoEntry & { file: string })[] {
  const s = readStored(userId);
  const logos = [...(s.logos ?? [])];
  const def = s.file ? idOf(s.file) : null;
  if (def && !logos.some((l) => l.id === def)) logos.unshift({ id: def, name: s.name });
  return logos.map((l) => ({ ...l, file: logoFile(userId, l.id) })).filter((l) => fs.existsSync(l.file));
}

/** Id of the Settings logo inside the library. */
export const defaultLogoId = (w: Watermark) => (w.file ? idOf(w.file) : null);

function writeStored(userId: string, w: Watermark, logos: LogoEntry[]) {
  fs.mkdirSync(dir(userId), { recursive: true });
  fs.writeFileSync(settingsFile(userId), JSON.stringify({ ...w, logos }, null, 1));
  return w;
}

function writeWatermark(userId: string, w: Watermark) {
  return writeStored(
    userId,
    w,
    listLogos(userId).map(({ id, name }) => ({ id, name })),
  );
}

export function updateWatermark(userId: string, patch: Partial<Pick<Watermark, 'enabled' | 'position' | 'size' | 'opacity'>>) {
  return writeWatermark(userId, { ...readWatermark(userId), ...patch });
}

/** Turn an uploaded image into a library logo: one frame, transparent PNG, at most 600px wide. */
async function saveLogoImage(userId: string, tmpPath: string, originalName: string): Promise<LogoEntry & { file: string }> {
  fs.mkdirSync(dir(userId), { recursive: true });
  const id = randomUUID().replace(/-/g, '').slice(0, 8);
  const file = logoFile(userId, id);
  try {
    await run(config.ffmpeg, ['-y', '-v', 'error', '-i', tmpPath, '-frames:v', '1', '-vf', "scale='min(600,iw)':-1:flags=lanczos,format=rgba", file], { timeoutMs: 60_000 });
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
  return { id, name: originalName.slice(0, 80), file };
}

/** Save an uploaded image as the Settings logo. Replaces the old one (it leaves the library too). */
export async function setWatermarkLogo(userId: string, tmpPath: string, originalName: string) {
  const logo = await saveLogoImage(userId, tmpPath, originalName);
  const old = readWatermark(userId);
  const oldId = defaultLogoId(old);
  if (old.file && old.file !== logo.file) fs.rmSync(old.file, { force: true });
  const logos = listLogos(userId)
    .filter((l) => l.id !== oldId && l.id !== logo.id)
    .map(({ id, name }) => ({ id, name }));
  return writeStored(userId, { ...old, file: logo.file, name: logo.name, enabled: true }, [...logos, { id: logo.id, name: logo.name }]);
}

export function removeWatermarkLogo(userId: string) {
  const w = readWatermark(userId);
  if (w.file) fs.rmSync(w.file, { force: true });
  return writeWatermark(userId, { ...w, file: null, name: '' });
}

/** Add a logo to the library without touching the Settings one (picked for a single project). */
export async function addLogo(userId: string, tmpPath: string, originalName: string) {
  const logo = await saveLogoImage(userId, tmpPath, originalName);
  const logos = listLogos(userId).map(({ id, name }) => ({ id, name }));
  writeStored(userId, readWatermark(userId), [...logos.filter((l) => l.id !== logo.id), { id: logo.id, name: logo.name }]);
  return logo;
}

/** Delete a library logo. Deleting the Settings logo clears it there too. */
export function removeLogo(userId: string, id: string) {
  if (!LOGO_ID.test(id)) return readWatermark(userId);
  const w = readWatermark(userId);
  fs.rmSync(logoFile(userId, id), { force: true });
  return writeWatermark(userId, defaultLogoId(w) === id ? { ...w, file: null, name: '' } : w);
}

/** How the instructions ask for the logo. Fields left out keep what was picked in the form (or Settings). */
export interface LogoAsk {
  none?: boolean;
  x?: number;
  y?: number;
  size?: WatermarkSize;
  opacity?: number;
  /** the words about the logo, to find a library logo by name ("use the nike logo") */
  hint: string;
}

const GENERIC = new Set(['logo', 'logos', 'watermark', 'brand', 'final', 'new', 'copy', 'white', 'black', 'transparent', 'icon', 'image', 'png', 'jpg', 'jpeg', 'webp']);
const nameWords = (name: string) =>
  name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !GENERIC.has(t) && !/^\d+$/.test(t));

/** The library logo whose file name the words mention most (none on a tie or no mention). */
export function matchLogo<T extends LogoEntry>(logos: T[], words: string): T | null {
  const said = new Set(words.toLowerCase().split(/[^a-z0-9]+/));
  const scored = logos.map((l) => ({ l, n: nameWords(l.name).filter((t) => said.has(t)).length })).sort((a, b) => b.n - a.n);
  return scored[0]?.n && scored[0].n !== scored[1]?.n ? scored[0].l : null;
}

/**
 * Apply what the instructions say about the logo on top of the form's pick (or, without one, the Settings logo in
 * its corner). Asking for a logo when the pick was "none" uses the named logo, else the Settings one, else the newest.
 */
export function applyLogoAsk(userId: string, base: LogoChoice | undefined, ask: LogoAsk): LogoChoice | undefined {
  const w = readWatermark(userId);
  const start: LogoChoice = base ?? { id: w.enabled ? defaultLogoId(w) : null, ...CORNERS[w.position], size: w.size, opacity: w.opacity };
  if (ask.none) return { ...start, id: null };
  const logos = listLogos(userId);
  const named = matchLogo(logos, ask.hint);
  const touched = named || ask.x != null || ask.size || ask.opacity != null;
  if (!touched) return base;
  const id = named?.id ?? start.id ?? defaultLogoId(w) ?? logos.at(-1)?.id ?? null;
  if (!id) return base; // nothing uploaded to place
  return { id, x: ask.x ?? start.x, y: ask.y ?? start.y, size: ask.size ?? start.size, opacity: ask.opacity ?? start.opacity };
}

/** Lowest point of a logo in the top part of the frame (px), so headlines can sit under it; null when it sits lower. */
export function watermarkTopBottom(w: Watermark) {
  const box = 1080 * WATERMARK_BOX[w.size];
  const top = 1920 * TOP + (1920 * (1 - TOP - BOTTOM) - box) * spotOf(w).y;
  return top < 1920 * 0.3 ? Math.round(top + box) : null;
}

/**
 * What the renderer needs, or null when there's nothing to stamp. `choice` is the project's own pick from New clips;
 * without one, the Settings logo. A picked logo deleted since then falls back to the Settings one, in the picked spot.
 */
export function watermarkForRender(userId: string, choice?: LogoChoice | null): (Watermark & { file: string }) | null {
  const w = readWatermark(userId);
  if (!choice) return w.enabled && w.file ? (w as Watermark & { file: string }) : null;
  if (choice.id === null) return null;
  const file = LOGO_ID.test(choice.id) && fs.existsSync(logoFile(userId, choice.id)) ? logoFile(userId, choice.id) : w.file;
  if (!file) return null;
  return { ...w, enabled: true, file, size: choice.size, opacity: choice.opacity, x: choice.x, y: choice.y };
}

/**
 * ffmpeg filter that stamps the logo (input #`input`) on the video `inLabel` → `outLabel`.
 * Works on the final 1080×1920 frame, after reframing and zooms, under the captions.
 * The spot is a share of the room left inside the edge gaps, so 0/1 are the corners and the logo never leaves the frame.
 */
export function watermarkFilter(w: Watermark, input: number, inLabel: string, outLabel: string) {
  const box = Math.round(1080 * WATERMARK_BOX[w.size]);
  const side = Math.round(1080 * SIDE);
  const top = Math.round(1920 * TOP);
  const bottom = Math.round(1920 * BOTTOM);
  const spot = spotOf(w);
  const fx = Math.max(0, Math.min(1, spot.x)).toFixed(4);
  const fy = Math.max(0, Math.min(1, spot.y)).toFixed(4);
  const x = `${side}+(W-w-${2 * side})*${fx}`;
  const y = `${top}+(H-h-${top + bottom})*${fy}`;
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

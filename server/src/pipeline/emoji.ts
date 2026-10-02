import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';
import { config } from '../config.js';

/**
 * Emoji as transparent PNGs, drawn from Twemoji (graphics © Twitter/X and contributors, CC-BY 4.0).
 * The subtitle renderer can't draw colour emoji, so caption emoji are laid over the video as small images.
 * Made once per emoji and size, then reused from <data>/emoji.
 */
const svgDir = path.dirname(createRequire(import.meta.url).resolve('@twemoji/svg/package.json'));
const cacheDir = () => path.join(config.dataDir, 'emoji');

/** "👍🏽" → "1f44d-1f3fd" (Twemoji file names drop the FE0F variation selector unless the emoji has a ZWJ). */
function codeOf(emoji: string, keepFe0f: boolean) {
  return [...emoji]
    .map((c) => c.codePointAt(0)!.toString(16))
    .filter((c) => keepFe0f || c !== 'fe0f')
    .join('-');
}

export function emojiPng(emoji: string, size = 150): string | null {
  const svg = [codeOf(emoji, true), codeOf(emoji, false)].map((c) => path.join(svgDir, `${c}.svg`)).find((f) => fs.existsSync(f));
  if (!svg) return null;
  const out = path.join(cacheDir(), `${path.basename(svg, '.svg')}_${size}.png`);
  if (fs.existsSync(out)) return out;
  try {
    const png = new Resvg(fs.readFileSync(svg), { fitTo: { mode: 'width', value: size } }).render().asPng();
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(out, png);
    return out;
  } catch (e) {
    console.warn('[emoji]', emoji, (e as Error).message);
    return null;
  }
}

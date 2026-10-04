import type { LogoChoice, Watermark, WatermarkSize } from '../../lib/api';

/**
 * What "Tell the AI what you want" says about the logo, read in the browser for the preview.
 * The server reads it the same way (server/src/pipeline/instructions.ts readLogoAsk — keep in sync), plus Gemini for looser wording.
 */
export interface LogoAsk {
  none?: boolean;
  x?: number;
  y?: number;
  size?: WatermarkSize;
  opacity?: number;
  /** the words about the logo, to find a library logo by name */
  hint: string;
}

const ARTICLE = String.raw`(?:(?:a|an|the|any|my|our|your)\s+)?`;
const LOGO_NONE = new RegExp(
  [
    String.raw`\b(no|without)\s+${ARTICLE}(logo|watermark)`,
    String.raw`\b(remove|skip|hide|drop)\s+${ARTICLE}(logo|watermark)`,
    String.raw`\b(don'?t|do not|never)\s+(add|put|use|include|show|want|need)\s+${ARTICLE}(logo|watermark)`,
    String.raw`\b(logo|watermark)\s*[:-]?\s*(off|none)\b`,
  ].join('|'),
);
const clampOpacity = (n: number) => Math.min(100, Math.max(20, Math.round(n / 5) * 5));

export function readLogoAsk(text: string): LogoAsk | null {
  const lines = text.replace(/\r/g, '').split(/\n|(?<=[.!?;])\s+/);
  const isLogo = (l = '') => /\b(logo|watermark)s?\b/i.test(l);
  const said = lines.filter((l, i) => isLogo(l) || (isLogo(lines[i - 1]) && /\bit\b/i.test(l)));
  if (!said.length) return null;
  const t = said
    .join(' ')
    .toLowerCase()
    .replace(/\bon top of\b/g, 'over');
  if (LOGO_NONE.test(t)) return { none: true, hint: t };
  const ask: LogoAsk = { hint: t };
  const v = /\b(top|upper)\b/.test(t) ? 0 : /\b(bottom|lower)\b/.test(t) ? 1 : undefined;
  const h = /\bleft\b/.test(t) ? 0 : /\bright\b/.test(t) ? 1 : undefined;
  if (v !== undefined || h !== undefined || /\b(cent(er|re)|middle)\b/.test(t)) {
    ask.x = h ?? 0.5;
    ask.y = v ?? 0.5;
  }
  ask.size = /\b(tiny|small|smaller|mini)\b/.test(t) ? 'small' : /\b(big|bigger|large|larger|huge)\b/.test(t) ? 'large' : /\b(medium|normal|regular)\b/.test(t) ? 'medium' : undefined;
  const pct = t.match(/(\d{1,3})\s*%\s*(opacity|opaque|visible|visibility|transparen\w*|see-?through)/);
  const pct2 = t.match(/(opacity|visibility)\s*(?:of|at|to|:)?\s*(\d{1,3})\s*%/);
  if (pct) ask.opacity = clampOpacity(/transparen|see/.test(pct[2]) ? 100 - Number(pct[1]) : Number(pct[1]));
  else if (pct2) ask.opacity = clampOpacity(Number(pct2[2]));
  else if (/\b(faint|subtle|faded|semi-?transparent|transparent|see-?through)\b/.test(t)) ask.opacity = 50;
  else if (/\b(solid|opaque|fully visible|full opacity)\b/.test(t)) ask.opacity = 100;
  return ask;
}

const GENERIC = new Set(['logo', 'logos', 'watermark', 'brand', 'final', 'new', 'copy', 'white', 'black', 'transparent', 'icon', 'image', 'png', 'jpg', 'jpeg', 'webp']);
const nameWords = (name: string) =>
  name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !GENERIC.has(t) && !/^\d+$/.test(t));

/** The library logo whose file name the words mention most (none on a tie or no mention). */
export function matchLogo<T extends { name: string }>(logos: T[], words: string): T | null {
  const said = new Set(words.toLowerCase().split(/[^a-z0-9]+/));
  const scored = logos.map((l) => ({ l, n: nameWords(l.name).filter((t) => said.has(t)).length })).sort((a, b) => b.n - a.n);
  return scored[0]?.n && scored[0].n !== scored[1]?.n ? scored[0].l : null;
}

/** The pick after the instructions are applied (same rules as the server's applyLogoAsk). */
export function withLogoAsk(w: Watermark, c: LogoChoice, ask: LogoAsk | null): LogoChoice {
  if (!ask) return c;
  if (ask.none) return { ...c, id: null };
  const named = matchLogo(w.logos, ask.hint);
  if (!named && ask.x == null && !ask.size && ask.opacity == null) return c;
  const id = named?.id ?? c.id ?? w.defaultLogoId ?? w.logos.at(-1)?.id ?? null;
  if (!id) return c;
  return { id, x: ask.x ?? c.x, y: ask.y ?? c.y, size: ask.size ?? c.size, opacity: ask.opacity ?? c.opacity };
}

const ROW_NAMES = ['Top', 'Middle', 'Bottom'];
const COL_NAMES = ['left', 'center', 'right'];
export const spotName = (x: number, y: number) => {
  const r = Math.round(y * 2);
  const c = Math.round(x * 2);
  return r === 1 && c === 1 ? 'Center' : `${ROW_NAMES[r]} ${COL_NAMES[c]}`;
};

/** "bottom left · small · 50%", "no logo", or null when the text asks nothing this account can act on. */
export function logoAskLabel(w: Watermark | null, ask: LogoAsk | null): string | null {
  if (!ask) return null;
  if (ask.none) return 'no logo';
  const named = w ? matchLogo(w.logos, ask.hint) : null;
  const parts = [
    named?.name.replace(/\.[a-z0-9]+$/i, ''),
    ask.x != null && ask.y != null ? spotName(ask.x, ask.y).toLowerCase() : null,
    ask.size,
    ask.opacity != null ? `${ask.opacity}%` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

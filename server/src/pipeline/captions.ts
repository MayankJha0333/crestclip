import type { CaptionStyle, Segment, Word } from '../types.js';

/**
 * Word-by-word animated captions rendered as an .ass subtitle file (burned in by ffmpeg/libass).
 * Canvas is 1080x1920. Captions sit at ~61% height — inside the TikTok / Reels / Shorts safe zones.
 */

interface StyleDef {
  font: string;
  size: number;
  bold: 0 | 1;
  upper: boolean;
  primary: string;
  outline: string;
  back: string;
  borderStyle: 1 | 3;
  outlineW: number;
  shadow: number;
  maxWords: number;
  maxChars: number;
  active: string; // override tags for the word being spoken
  inactive?: string;
  extra?: string; // tags for the whole line
}

// Colors are ASS format &HAABBGGRR
const CAPTION_STYLES: Record<Exclude<CaptionStyle, 'none'>, StyleDef> = {
  pop: {
    font: 'Anton', size: 118, bold: 0, upper: true, primary: '&H00FFFFFF', outline: '&H00000000', back: '&H80000000',
    borderStyle: 1, outlineW: 7, shadow: 3, maxWords: 3, maxChars: 18,
    active: '\\c&H0000DDFF&\\fscx112\\fscy112',
  },
  clay: {
    font: 'Poppins ExtraBold', size: 92, bold: 0, upper: false, primary: '&H005A212B', outline: '&H00FFFFFF', back: '&H00FFFFFF',
    borderStyle: 3, outlineW: 18, shadow: 0, maxWords: 3, maxChars: 20,
    active: '\\c&H00FF5C7C&',
  },
  neon: {
    font: 'Poppins ExtraBold', size: 96, bold: 0, upper: true, primary: '&H00FFFFFF', outline: '&H00FFE500', back: '&H00000000',
    borderStyle: 1, outlineW: 3, shadow: 0, maxWords: 3, maxChars: 18,
    active: '\\c&H00B2FF7C&\\3c&H00B2FF7C&', extra: '\\blur4',
  },
  comic: {
    font: 'Bangers', size: 120, bold: 0, upper: true, primary: '&H0000E6FF', outline: '&H00000000', back: '&H00000000',
    borderStyle: 1, outlineW: 9, shadow: 5, maxWords: 2, maxChars: 14,
    active: '\\c&H00FFFFFF&\\fscx118\\fscy118',
  },
  minimal: {
    font: 'Poppins', size: 72, bold: 1, upper: false, primary: '&H00FFFFFF', outline: '&H00000000', back: '&H99000000',
    borderStyle: 1, outlineW: 0, shadow: 3, maxWords: 5, maxChars: 28,
    active: '', inactive: '',
  },
};

const esc = (s: string) => s.replace(/\\/g, '/').replace(/[{}]/g, '').replace(/\r?\n|\r/g, ' ');

function ts(t: number) {
  const x = Math.max(0, t);
  const h = Math.floor(x / 3600);
  const m = Math.floor((x % 3600) / 60);
  const s = Math.floor(x % 60);
  const cs = Math.floor((x - Math.floor(x)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function wordsInRange(segs: Segment[], start: number, end: number): Word[] {
  const out: Word[] = [];
  for (const seg of segs) {
    if (seg.e < start || seg.s > end) continue;
    for (const w of seg.words) {
      const mid = (w.s + w.e) / 2;
      if (mid < start || mid > end) continue;
      if (/^\[.*\]$/.test(w.w)) continue; // [laughs]
      out.push({ w: w.w.replace(/\[[^\]]*\]/g, '').trim(), s: w.s - start, e: Math.min(w.e, end) - start });
    }
  }
  return out.filter((w) => w.w);
}

function groupWords(words: Word[], st: StyleDef): Word[][] {
  const groups: Word[][] = [];
  let cur: Word[] = [];
  let chars = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const gap = cur.length ? w.s - cur[cur.length - 1].e : 0;
    if (cur.length && (cur.length >= st.maxWords || chars + w.w.length > st.maxChars || gap > 0.45)) {
      groups.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(w);
    chars += w.w.length + 1;
    if (/[.!?,;:…]$/.test(w.w) && cur.length >= Math.min(2, st.maxWords)) {
      groups.push(cur);
      cur = [];
      chars = 0;
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

export function buildAss(opts: {
  words: Word[];
  duration: number;
  style: CaptionStyle;
  layout: 'fill' | 'fit' | 'split';
  hook?: string;
  showHook: boolean;
}): string {
  const W = 1080;
  const H = 1920;
  const capY = opts.layout === 'split' ? 960 : opts.layout === 'fit' ? 1290 : 1180;
  const lines: string[] = [];
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
`;
  const styles: string[] = [];
  if (opts.style !== 'none') {
    const s = CAPTION_STYLES[opts.style];
    styles.push(
      `Style: Cap,${s.font},${s.size},${s.primary},&H000000FF,${s.outline},${s.back},${s.bold ? -1 : 0},0,0,0,100,100,0,0,${s.borderStyle},${s.outlineW},${s.shadow},5,80,80,0,1`,
    );
  }
  styles.push(`Style: Hook,Poppins ExtraBold,70,&H002B1B1E,&H000000FF,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,3,22,0,8,110,110,0,1`);

  if (opts.style !== 'none' && opts.words.length) {
    const s = CAPTION_STYLES[opts.style];
    const groups = groupWords(opts.words, s);
    groups.forEach((g, gi) => {
      const next = groups[gi + 1];
      const groupEnd = Math.min(next ? next[0].s : opts.duration, g[g.length - 1].e + 0.3);
      const text = (w: Word) => esc(s.upper ? w.w.toUpperCase() : w.w);
      if (!s.active) {
        lines.push(`Dialogue: 0,${ts(g[0].s)},${ts(groupEnd)},Cap,,0,0,0,,{\\pos(${W / 2},${capY})${s.extra ?? ''}}${g.map(text).join(' ')}`);
        return;
      }
      g.forEach((w, wi) => {
        const a = wi === 0 ? g[0].s : w.s;
        const b = wi + 1 < g.length ? g[wi + 1].s : groupEnd;
        if (b - a < 0.02) return;
        const body = g.map((x, xi) => (xi === wi ? `{${s.active}}${text(x)}{\\r}` : text(x))).join(' ');
        lines.push(`Dialogue: 0,${ts(a)},${ts(b)},Cap,,0,0,0,,{\\pos(${W / 2},${capY})${s.extra ?? ''}}${body.replace(/\{\\r\}/g, `{\\r${s.extra ?? ''}}`)}`);
      });
    });
  }

  if (opts.showHook && opts.hook?.trim()) {
    const end = Math.min(3.2, Math.max(1.5, opts.duration - 0.2));
    lines.push(`Dialogue: 1,${ts(0)},${ts(end)},Hook,,0,0,0,,{\\an8\\pos(${W / 2},${opts.layout === 'split' ? 90 : 300})\\fad(120,220)}${esc(opts.hook.trim())}`);
  }

  return `${header}${styles.join('\n')}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${lines.join('\n')}\n`;
}

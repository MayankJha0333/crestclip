import type { CaptionStyle, Keyword, Segment, Word } from '../types.js';

/**
 * Word-by-word animated captions rendered as an .ass subtitle file (burned in by ffmpeg/libass).
 * Canvas is 1080x1920. Captions sit at ~61-71% height — below the speaker's face, above the TikTok / Reels / Shorts
 * buttons and description at the bottom.
 * Key words (picked by the AI) are drawn bigger and in an accent colour, at most one per line.
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
  emph: string; // override tags for a key word (always on, also while spoken)
  inactive?: string;
  extra?: string; // tags for the whole line
}

// Colors are ASS format &HAABBGGRR
const CAPTION_STYLES: Record<Exclude<CaptionStyle, 'none'>, StyleDef> = {
  pop: {
    font: 'Anton',
    size: 118,
    bold: 0,
    upper: true,
    primary: '&H00FFFFFF',
    outline: '&H00000000',
    back: '&H80000000',
    borderStyle: 1,
    outlineW: 7,
    shadow: 3,
    maxWords: 3,
    maxChars: 18,
    active: '\\c&H0000DDFF&\\fscx112\\fscy112',
    emph: '\\c&H0055FF7C&\\fscx124\\fscy124',
  },
  clay: {
    font: 'Poppins ExtraBold',
    size: 92,
    bold: 0,
    upper: false,
    primary: '&H005A212B',
    outline: '&H00FFFFFF',
    back: '&H00FFFFFF',
    borderStyle: 3,
    outlineW: 18,
    shadow: 0,
    maxWords: 3,
    maxChars: 20,
    active: '\\c&H00FF5C7C&',
    emph: '\\c&H002E7BFF&\\fscx116\\fscy116',
  },
  neon: {
    font: 'Poppins ExtraBold',
    size: 96,
    bold: 0,
    upper: true,
    primary: '&H00FFFFFF',
    outline: '&H00FFE500',
    back: '&H00000000',
    borderStyle: 1,
    outlineW: 3,
    shadow: 0,
    maxWords: 3,
    maxChars: 18,
    active: '\\c&H00B2FF7C&\\3c&H00B2FF7C&',
    extra: '\\blur4',
    emph: '\\c&H00FF4DFF&\\3c&H00FF4DFF&\\fscx118\\fscy118',
  },
  comic: {
    font: 'Bangers',
    size: 120,
    bold: 0,
    upper: true,
    primary: '&H0000E6FF',
    outline: '&H00000000',
    back: '&H00000000',
    borderStyle: 1,
    outlineW: 9,
    shadow: 5,
    maxWords: 2,
    maxChars: 14,
    active: '\\c&H00FFFFFF&\\fscx118\\fscy118',
    emph: '\\c&H003838FF&\\fscx126\\fscy126',
  },
  minimal: {
    font: 'Poppins',
    size: 72,
    bold: 1,
    upper: false,
    primary: '&H00FFFFFF',
    outline: '&H00000000',
    back: '&H99000000',
    borderStyle: 1,
    outlineW: 0,
    shadow: 3,
    maxWords: 5,
    maxChars: 28,
    active: '',
    inactive: '',
    emph: '\\c&H0000D7FF&',
  },
};

const esc = (s: string) =>
  s
    .replace(/\\/g, '/')
    .replace(/[{}]/g, '')
    .replace(/\r?\n|\r/g, ' ');

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

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{M}\p{N}$%'-]/gu, '');

/** The key word this spoken word is (exact, or a short ending like "fail" → "failed"), if any. */
function keywordOf(w: string, kws: Keyword[]): Keyword | undefined {
  const n = norm(w);
  if (n.length < 2) return undefined;
  return kws.find((k) => n === k.w || (k.w.length >= 4 && (n.startsWith(k.w) || k.w.startsWith(n)) && Math.abs(n.length - k.w.length) <= 3));
}

/** An emoji to lay over the video (as an image) while its caption line is on screen. */
export interface EmojiCue {
  emoji: string;
  s: number;
  e: number;
}

export function buildAss(opts: {
  words: Word[];
  duration: number;
  style: CaptionStyle;
  layout: 'fill' | 'fit' | 'split';
  hook?: string;
  showHook: boolean;
  keywords?: Keyword[];
  emoji?: boolean;
  /** top of the hook headline (moved down when a logo sits in a top corner) */
  hookY?: number;
  /** caption line centre (px on 1920), when the face position is known — keeps captions off the face */
  captionY?: number;
}): { ass: string; emojis: EmojiCue[]; captionY: number } {
  const W = 1080;
  const H = 1920;
  const capY = opts.layout === 'split' ? 960 : opts.layout === 'fit' ? 1290 : (opts.captionY ?? 1180);
  const lines: string[] = [];
  const emojis: EmojiCue[] = [];
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
    styles.push(`Style: Cap,${s.font},${s.size},${s.primary},&H000000FF,${s.outline},${s.back},${s.bold ? -1 : 0},0,0,0,100,100,0,0,${s.borderStyle},${s.outlineW},${s.shadow},5,80,80,0,1`);
  }
  styles.push(`Style: Hook,Poppins ExtraBold,70,&H002B1B1E,&H000000FF,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,3,22,0,8,110,110,0,1`);

  if (opts.style !== 'none' && opts.words.length) {
    const s = CAPTION_STYLES[opts.style];
    const groups = groupWords(opts.words, s);
    const kws = opts.keywords ?? [];
    const used = new Map<string, number>();
    groups.forEach((g, gi) => {
      const next = groups[gi + 1];
      const groupEnd = Math.min(next ? next[0].s : opts.duration, g[g.length - 1].e + 0.3);
      // at most one key word per line, and each key word stands out at most twice per clip
      let emphAt = -1;
      for (let i = 0; i < g.length && emphAt < 0; i++) {
        const k = keywordOf(g[i].w, kws);
        if (!k || (used.get(k.w) ?? 0) >= 2) continue;
        emphAt = i;
        used.set(k.w, (used.get(k.w) ?? 0) + 1);
        if (opts.emoji && k.emoji && used.get(k.w) === 1 && groupEnd - g[0].s >= 0.35) emojis.push({ emoji: k.emoji, s: g[0].s, e: groupEnd });
      }
      const text = (w: Word) => esc(s.upper ? w.w.toUpperCase() : w.w);
      const reset = `{\\r${s.extra ?? ''}}`;
      const word = (x: Word, xi: number, active: boolean) => {
        const tags = (active ? s.active : '') + (xi === emphAt ? s.emph : '');
        return tags ? `{${tags}}${text(x)}${reset}` : text(x);
      };
      if (!s.active) {
        lines.push(`Dialogue: 0,${ts(g[0].s)},${ts(groupEnd)},Cap,,0,0,0,,{\\pos(${W / 2},${capY})${s.extra ?? ''}}${g.map((x, xi) => word(x, xi, false)).join(' ')}`);
        return;
      }
      g.forEach((w, wi) => {
        const a = wi === 0 ? g[0].s : w.s;
        const b = wi + 1 < g.length ? g[wi + 1].s : groupEnd;
        if (b - a < 0.02) return;
        lines.push(`Dialogue: 0,${ts(a)},${ts(b)},Cap,,0,0,0,,{\\pos(${W / 2},${capY})${s.extra ?? ''}}${g.map((x, xi) => word(x, xi, xi === wi)).join(' ')}`);
      });
    });
  }

  if (opts.showHook && opts.hook?.trim()) {
    const end = Math.min(3.2, Math.max(1.5, opts.duration - 0.2));
    // y stays below the top ~210 px that Reels covers with its own buttons
    lines.push(`Dialogue: 1,${ts(0)},${ts(end)},Hook,,0,0,0,,{\\an8\\pos(${W / 2},${Math.max(opts.hookY ?? 0, opts.layout === 'split' ? 230 : 300)})\\fad(120,220)}${esc(opts.hook.trim())}`);
  }

  return { ass: `${header}${styles.join('\n')}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${lines.join('\n')}\n`, emojis, captionY: capY };
}

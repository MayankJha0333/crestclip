import type { CSSProperties, ReactNode } from 'react';
import type { CaptionStyle, Layout, Platform, Rubric } from '../lib/api';

export function Logo({ size = 40, withText = true }: { size?: number; withText?: boolean }) {
  return (
    <span className="row" style={{ gap: 10 }}>
      <span
        className="tint-tangerine"
        style={{ width: size, height: size, borderRadius: size * 0.34, display: 'grid', placeItems: 'center', flex: 'none' }}
        aria-hidden
      >
        <svg width={size * 0.64} height={size * 0.64} viewBox="0 0 40 40">
          {/* a wave cresting — the moment everyone rewatches */}
          <path d="M3.5 29 C9.5 29 12 21.5 16 16.5 C20 11.5 26.5 7.5 31.8 10 C35.8 11.9 36 17.4 32.2 18.6 C29.4 19.5 27.4 17 28.9 15" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M5 36 C9 33.5 13 33.5 17 36 C21 38.5 25 38.5 29 36 C31.5 34.5 33.5 34 35.5 34.6" fill="none" stroke="#fff" strokeOpacity=".6" strokeWidth="3" strokeLinecap="round" />
          <circle cx="34.6" cy="5" r="3.4" fill="#FFD65C" />
        </svg>
      </span>
      {withText && (
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: size * 0.6, letterSpacing: '-0.02em' }}>
          Crest<span style={{ color: 'var(--tangerine-d)' }}>Clip</span>
        </span>
      )}
    </span>
  );
}

/** Round clay score dial. */
export function ScoreRing({ value, size = 64, label }: { value: number; size?: number; label?: string }) {
  const r = size / 2 - 7;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  const color = v >= 80 ? 'var(--mint-d)' : v >= 65 ? 'var(--tangerine)' : v >= 50 ? 'var(--butter-d)' : 'var(--ink-3)';
  return (
    <div
      className="clay-sm"
      style={{ width: size, height: size, borderRadius: '50%', position: 'relative', display: 'grid', placeItems: 'center', flex: 'none' }}
      title={label}
    >
      <svg width={size} height={size} style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)' }} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(140,92,58,.12)" strokeWidth="6" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} />
      </svg>
      <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: size * 0.32, lineHeight: 1 }}>{Math.round(v)}</span>
    </div>
  );
}

export const RUBRIC_LABELS: Record<keyof Rubric, string> = {
  hook: 'Hook (first 3s)',
  standalone: 'Makes sense alone',
  payoff: 'Payoff',
  emotion: 'Emotion',
  shareability: 'Shareability',
  pacing: 'Pacing',
  loop: 'Clean ending / loop',
  lengthFit: 'Length fit',
  trend: 'Trend / search',
};

export function RubricBars({ rubric }: { rubric: Rubric }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      {(Object.keys(RUBRIC_LABELS) as (keyof Rubric)[]).map((k) => (
        <div key={k} className="row" style={{ gap: 10, fontSize: 13 }}>
          <span style={{ width: 132, flex: 'none' }} className="muted">
            {RUBRIC_LABELS[k]}
          </span>
          <span className="well grow" style={{ height: 12, borderRadius: 99, padding: 2 }}>
            <span
              style={{
                display: 'block',
                height: '100%',
                width: `${rubric[k] * 10}%`,
                borderRadius: 99,
                background: rubric[k] >= 8 ? 'var(--mint)' : rubric[k] >= 6 ? 'var(--tangerine)' : 'var(--butter)',
              }}
            />
          </span>
          <span style={{ width: 22, textAlign: 'right', fontWeight: 800 }}>{rubric[k]}</span>
        </div>
      ))}
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      <span>{children}</span>
    </label>
  );
}

/** Mini preview of each burned-in caption style, drawn with the same fonts/colors the renderer uses. */
export const CAPTION_PREVIEW: Record<CaptionStyle, { name: string; style: CSSProperties; active: CSSProperties; words: string[] }> = {
  pop: {
    name: 'Pop',
    words: ['THIS', 'CHANGED', 'EVERYTHING'],
    style: { fontFamily: 'Anton, sans-serif', color: '#fff', textTransform: 'uppercase', WebkitTextStroke: '5px #000', paintOrder: 'stroke fill', fontSize: 22, letterSpacing: '.01em' },
    active: { color: '#FFDD00', display: 'inline-block', transform: 'scale(1.12)', margin: '0 .14em' },
  },
  clay: {
    name: 'Clay',
    words: ['this', 'changed', 'everything'],
    style: { fontFamily: 'Poppins, sans-serif', fontWeight: 800, color: '#2B215A', background: '#fff', padding: '3px 8px', borderRadius: 6, fontSize: 16 },
    active: { color: '#7C5CFF' },
  },
  neon: {
    name: 'Neon',
    words: ['THIS', 'CHANGED', 'EVERYTHING'],
    style: { fontFamily: 'Poppins, sans-serif', fontWeight: 800, color: '#fff', textShadow: '0 0 6px #00E5FF, 0 0 12px #00E5FF', fontSize: 16 },
    active: { color: '#7CFFB2', textShadow: '0 0 8px #7CFFB2, 0 0 14px #7CFFB2' },
  },
  comic: {
    name: 'Comic',
    words: ['THIS', 'CHANGED'],
    style: { fontFamily: 'Bangers, sans-serif', color: '#FFE600', WebkitTextStroke: '5px #000', paintOrder: 'stroke fill', fontSize: 26, letterSpacing: '.03em' },
    active: { color: '#fff', display: 'inline-block', transform: 'scale(1.15) rotate(-3deg)', margin: '0 .16em' },
  },
  minimal: {
    name: 'Minimal',
    words: ['this changed', 'everything'],
    style: { fontFamily: 'Poppins, sans-serif', fontWeight: 700, color: '#fff', textShadow: '0 2px 6px rgba(0,0,0,.6)', fontSize: 14 },
    active: {},
  },
  none: { name: 'No captions', words: ['—'], style: { color: '#fff', fontWeight: 800, fontSize: 16, opacity: 0.6 }, active: {} },
};

export function CaptionSample({ style, big, scale = 1 }: { style: CaptionStyle; big?: boolean; scale?: number }) {
  const p = CAPTION_PREVIEW[style];
  return (
    <span style={{ ...p.style, fontSize: (p.style.fontSize as number) * (big ? 1.35 : 1) * scale, lineHeight: 1.15, textAlign: 'center' }}>
      {p.words.map((w, i) => (
        <span key={i}>
          {i > 0 ? ' ' : ''}
          <span style={i === 1 ? p.active : undefined}>{w}</span>
        </span>
      ))}
    </span>
  );
}

export function CaptionPicker({ value, onChange }: { value: CaptionStyle; onChange: (v: CaptionStyle) => void }) {
  const list: CaptionStyle[] = ['pop', 'clay', 'neon', 'comic', 'minimal', 'none'];
  return (
    <div className="cap-grid" role="group" aria-label="Caption style">
      {list.map((s) => (
        <button key={s} type="button" className="cap-tile" aria-pressed={value === s} onClick={() => onChange(s)}>
          <span className="cap-tile-screen">
            <CaptionSample style={s} scale={0.74} />
          </span>
          <span className="cap-tile-name">{CAPTION_PREVIEW[s].name}</span>
        </button>
      ))}
    </div>
  );
}

export const PLATFORM_OPTIONS: { value: Platform; label: string }[] = [
  { value: 'shorts', label: 'Shorts' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'reels', label: 'Reels' },
];

export const LAYOUT_OPTIONS: { value: Layout; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'CrestClip picks per clip' },
  { value: 'fill', label: 'Face track', hint: 'Full-screen, follows the speaker' },
  { value: 'split', label: 'Split', hint: 'Two speakers stacked' },
  { value: 'fit', label: 'Fit', hint: 'Whole frame on a blurred background (screens, games)' },
];

export const CATEGORY_TINT: Record<string, string> = {
  humor: 'tint-butter',
  insight: 'tint-sky',
  story: 'tint-lilac',
  controversy: 'tint-bubble',
  emotional: 'tint-bubble',
  educational: 'tint-mint',
  surprising: 'tint-tangerine',
  relatable: 'tint-mint',
};

import type { CaptionStyle } from '../../lib/api';
import { cn } from '../../lib/cn';
import { CAPTION_ORDER, CAPTIONS } from './options';

export function CaptionSample({ style, scale = 1 }: { style: CaptionStyle; scale?: number }) {
  const p = CAPTIONS[style];
  return (
    <span className="text-center leading-[1.15]" style={{ ...p.style, fontSize: (p.style.fontSize as number) * scale }}>
      {p.words.map((w, i) => (
        <span key={i}>
          {i > 0 ? ' ' : ''}
          <span style={i === 1 ? p.active : undefined}>{w}</span>
        </span>
      ))}
    </span>
  );
}

/** Caption style tiles — each shows a live sample of the style. */
export function CaptionPicker({ value, onChange }: { value: CaptionStyle; onChange: (v: CaptionStyle) => void }) {
  return (
    <div role="group" aria-label="Caption style" className="grid grid-cols-3 gap-2.5 sm:grid-cols-6">
      {CAPTION_ORDER.map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={value === s}
          onClick={() => onChange(s)}
          className={cn(
            'flex flex-col gap-2 rounded-[18px] p-2 text-left transition-transform duration-200 hover:-translate-y-0.5',
            value === s ? 'bg-surface shadow-[0_0_0_3px_var(--tangerine)]' : 'bg-row shadow-flat hover:shadow-[0_0_0_1px_var(--line-strong)]',
          )}
        >
          <span className="grid h-16 place-items-center overflow-hidden rounded-xl bg-[radial-gradient(circle_at_30%_30%,#7b6a8e,#2f2540)] p-1.5">
            <CaptionSample style={s} scale={0.7} />
          </span>
          <span className="text-center text-[13px] font-extrabold">{CAPTIONS[s].name}</span>
        </button>
      ))}
    </div>
  );
}

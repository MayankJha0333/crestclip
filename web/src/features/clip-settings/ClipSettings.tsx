import { useState } from 'react';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import type { ProjectOptions } from '../../lib/api';
import { cn } from '../../lib/cn';
import { readLocal, writeLocal } from '../../lib/storage';
import { FieldLabel, Input, Segmented, Toggle } from '../../components/ui';
import { CaptionPicker } from './CaptionPicker';
import { MotionPicker } from './MotionPicker';
import { MusicPicker } from './MusicPicker';
import { CAPTIONS, LAYOUTS, LENGTHS, MOTIONS, PLATFORMS } from './options';

const musicName = (t: string) => (t === 'none' ? 'No music' : t === 'auto' ? 'Auto music' : t.startsWith('upload:') ? 'Your track' : `${t} music`);

/**
 * All the "how should the clips look" settings, folded into one summary line.
 * Most people never change them, so they stay out of the way until opened.
 */
export function ClipSettings({ value, onChange, lengthNote }: { value: ProjectOptions; onChange: (o: ProjectOptions) => void; lengthNote?: string | null }) {
  const [open, setOpen] = useState(() => readLocal('crestclip:settings-open', false));
  const toggle = () => {
    writeLocal('crestclip:settings-open', !open);
    setOpen(!open);
  };
  const set = <K extends keyof ProjectOptions>(k: K, v: ProjectOptions[K]) => onChange({ ...value, [k]: v });

  const summary = [
    PLATFORMS.find((p) => p.value === value.platform)?.long,
    lengthNote ?? (value.length === 'auto' ? 'auto length' : LENGTHS.find((l) => l.value === value.length)?.long),
    `${value.clipCount} clips`,
    `${CAPTIONS[value.captionStyle].name} captions`,
    `${MOTIONS.find((m) => m.value === value.motion)?.label} motion`,
    musicName(value.music),
  ].filter(Boolean);

  return (
    <div className="rounded-[22px] bg-row shadow-flat">
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full items-center gap-3 rounded-[22px] px-4 py-3.5 text-left">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-orange-bg text-orange-ink">
          <SlidersHorizontal size={17} />
        </span>
        <span className="min-w-0 flex-1">
          <b className="block font-display text-[15px] font-semibold">Clip settings</b>
          <span className="block truncate text-sm text-ink-3">{summary.join(' · ')}</span>
        </span>
        <span className="hidden text-sm font-extrabold text-ink-2 sm:inline">{open ? 'Close' : 'Change'}</span>
        <ChevronDown size={18} className={cn('shrink-0 text-ink-2 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="flex flex-col gap-6 border-t border-line px-4 pt-5 pb-5">
          <div className="grid gap-5 md:grid-cols-[auto_auto_1fr]">
            <div>
              <FieldLabel>Posting to</FieldLabel>
              <Segmented label="Platform" value={value.platform} onChange={(v) => set('platform', v)} options={PLATFORMS} />
            </div>
            <div>
              <FieldLabel>Clip length{lengthNote ? ` · ${lengthNote} from your instructions` : ''}</FieldLabel>
              <Segmented label="Clip length" value={value.length} onChange={(v) => set('length', v)} options={LENGTHS} />
            </div>
            <div className="min-w-48">
              <FieldLabel>How many clips · {value.clipCount}</FieldLabel>
              <input className="mt-2" type="range" min={1} max={20} value={value.clipCount} onChange={(e) => set('clipCount', Number(e.target.value))} aria-label="Number of clips" />
            </div>
          </div>

          <div>
            <FieldLabel>Caption style</FieldLabel>
            <CaptionPicker value={value.captionStyle} onChange={(v) => set('captionStyle', v)} />
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <div>
              <FieldLabel>Edit motion</FieldLabel>
              <MotionPicker value={value.motion} onChange={(v) => set('motion', v)} />
            </div>
            <div>
              <FieldLabel>Background music</FieldLabel>
              <MusicPicker
                compact
                track={value.music}
                volume={value.musicVolume}
                onChange={(v) => onChange({ ...value, ...(v.track !== undefined ? { music: v.track } : {}), ...(v.volume !== undefined ? { musicVolume: v.volume } : {}) })}
              />
            </div>
          </div>

          <div className="grid gap-5 md:grid-cols-3">
            <div>
              <FieldLabel>Framing</FieldLabel>
              <Segmented label="Framing" size="sm" value={value.layout} onChange={(v) => set('layout', v)} options={LAYOUTS} />
              <p className="mt-2 text-[13px] text-ink-3">{LAYOUTS.find((o) => o.value === value.layout)?.hint}</p>
            </div>
            <label className="flex flex-col">
              <FieldLabel>Spoken language</FieldLabel>
              <Input value={value.language} maxLength={40} onChange={(e) => set('language', e.target.value || 'auto')} placeholder="auto" />
            </label>
            <div className="flex flex-col justify-center gap-3">
              <Toggle checked={value.showHook} onChange={(v) => set('showHook', v)}>
                Hook headline in the first 3s
              </Toggle>
              <Toggle checked={value.useAudienceData} onChange={(v) => set('useAudienceData', v)}>
                Use “Most replayed” + comments
              </Toggle>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

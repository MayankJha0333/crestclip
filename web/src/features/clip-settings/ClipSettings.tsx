import { useState } from 'react';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import type { ProjectOptions } from '../../lib/api';
import { cn } from '../../lib/cn';
import { readLocal, writeLocal } from '../../lib/storage';
import { FieldLabel, Input, Segmented, Toggle } from '../../components/ui';
import { MotionPicker } from './MotionPicker';
import { MusicPicker } from './MusicPicker';
import { LAYOUTS, MOTIONS } from './options';

const musicName = (t: string) => (t === 'none' ? 'no music' : t === 'auto' ? 'auto music' : t.startsWith('upload:') ? 'your track' : `${t} music`);

/**
 * The less-used settings (motion, music, framing, language, hook), folded into one line.
 * Platform, length, clip count and captions live next to the live preview instead.
 */
export function ClipSettings({ value, onChange }: { value: ProjectOptions; onChange: (o: ProjectOptions) => void }) {
  const [open, setOpen] = useState(() => readLocal('crestclip:settings-open', false));
  const toggle = () => {
    writeLocal('crestclip:settings-open', !open);
    setOpen(!open);
  };
  const set = <K extends keyof ProjectOptions>(k: K, v: ProjectOptions[K]) => onChange({ ...value, [k]: v });
  const summary = [`${MOTIONS.find((m) => m.value === value.motion)?.label} motion`, musicName(value.music), LAYOUTS.find((l) => l.value === value.layout)?.label.toLowerCase() + ' framing'];

  return (
    <div className="rounded-[20px] bg-row shadow-flat">
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full items-center gap-3 rounded-[20px] px-3.5 py-3 text-left">
        <SlidersHorizontal size={17} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1">
          <b className="block text-sm">More options</b>
          <span className="block truncate text-xs text-ink-3">{summary.join(' · ')}</span>
        </span>
        <ChevronDown size={17} className={cn('shrink-0 text-ink-2 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="flex flex-col gap-5 border-t border-line px-3.5 pt-4 pb-4">
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
          <div>
            <FieldLabel>Framing</FieldLabel>
            <Segmented label="Framing" size="sm" value={value.layout} onChange={(v) => set('layout', v)} options={LAYOUTS} />
            <p className="mt-2 text-[13px] text-ink-3">{LAYOUTS.find((o) => o.value === value.layout)?.hint}</p>
          </div>
          <label className="flex flex-col">
            <FieldLabel>Spoken language</FieldLabel>
            <Input value={value.language} maxLength={40} onChange={(e) => set('language', e.target.value || 'auto')} placeholder="auto" />
          </label>
          <div className="flex flex-col gap-3">
            <Toggle checked={value.showHook} onChange={(v) => set('showHook', v)}>
              Hook headline in the first 3s
            </Toggle>
            <Toggle checked={value.useAudienceData} onChange={(v) => set('useAudienceData', v)}>
              Use “Most replayed” + comments
            </Toggle>
          </div>
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { Check, ChevronRight, SlidersHorizontal } from 'lucide-react';
import type { ProjectOptions } from '../../lib/api';
import { Button, FieldLabel, Segmented, Sheet, Toggle } from '../../components/ui';
import { MotionPicker } from './MotionPicker';
import { MusicPicker } from './MusicPicker';
import { LAYOUTS, MOTIONS } from './options';

const musicName = (t: string) => (t === 'none' ? 'no music' : t === 'auto' ? 'auto music' : t.startsWith('upload:') ? 'your track' : `${t} music`);

/**
 * The less-used settings (motion, music, framing, hook, audience data): one summary row that opens a side panel,
 * so the page layout never jumps.
 * Length, clip count and captions live next to the live preview instead. The watermark is set once in Settings.
 */
export function ClipSettings({ value, onChange }: { value: ProjectOptions; onChange: (o: ProjectOptions) => void }) {
  const [open, setOpen] = useState(false);
  const set = <K extends keyof ProjectOptions>(k: K, v: ProjectOptions[K]) => onChange({ ...value, [k]: v });
  const summary = [`${MOTIONS.find((m) => m.value === value.motion)?.label} motion`, musicName(value.music), LAYOUTS.find((l) => l.value === value.layout)?.label.toLowerCase() + ' framing'];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="flex w-full items-center gap-3 rounded-[20px] bg-row px-3.5 py-3 text-left shadow-flat transition-shadow hover:shadow-[0_0_0_1px_var(--line-strong)]"
      >
        <SlidersHorizontal size={17} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1">
          <b className="block text-sm">More options</b>
          <span className="block truncate text-xs text-ink-3">{summary.join(' · ')}</span>
        </span>
        <ChevronRight size={17} className="shrink-0 text-ink-2" />
      </button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="More options"
        description="These apply to every clip from these videos."
        footer={
          <Button variant="primary" onClick={() => setOpen(false)}>
            <Check size={17} /> Done
          </Button>
        }
      >
        <div className="flex flex-col gap-7">
          <section>
            <FieldLabel>Edit motion</FieldLabel>
            <MotionPicker value={value.motion} onChange={(v) => set('motion', v)} />
          </section>
          <section>
            <FieldLabel>Background music</FieldLabel>
            <MusicPicker
              compact
              track={value.music}
              volume={value.musicVolume}
              onChange={(v) => onChange({ ...value, ...(v.track !== undefined ? { music: v.track } : {}), ...(v.volume !== undefined ? { musicVolume: v.volume } : {}) })}
            />
          </section>
          <section>
            <FieldLabel>Framing</FieldLabel>
            <Segmented label="Framing" size="sm" value={value.layout} onChange={(v) => set('layout', v)} options={LAYOUTS} />
            <p className="mt-2 text-[13px] text-ink-3">{LAYOUTS.find((o) => o.value === value.layout)?.hint}</p>
          </section>
          <section className="flex flex-col gap-3 rounded-2xl bg-row p-4 shadow-flat">
            <Toggle checked={value.showHook} onChange={(v) => set('showHook', v)}>
              Hook headline in the first 3s
            </Toggle>
            <Toggle checked={value.useAudienceData} onChange={(v) => set('useAudienceData', v)}>
              Use “Most replayed” + comments
            </Toggle>
          </section>
        </div>
      </Sheet>
    </>
  );
}

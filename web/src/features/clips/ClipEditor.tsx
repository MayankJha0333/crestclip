import { useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { api, type CaptionStyle, type Clip, type Layout, type Motion, type MusicSettings } from '../../lib/api';
import { cn } from '../../lib/cn';
import { fmtPrecise, fmtTime } from '../../lib/format';
import { Button, Dialog, Field, FieldLabel, Input, Segmented, Textarea, Toggle } from '../../components/ui';
import { CaptionPicker } from '../clip-settings/CaptionPicker';
import { MotionPicker } from '../clip-settings/MotionPicker';
import { MusicPicker } from '../clip-settings/MusicPicker';
import { LAYOUTS } from '../clip-settings/options';
import { ClipVideo } from './ClipVideo';

type Line = { s: number; e: number; text: string; speaker?: string };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <FieldLabel>{title}</FieldLabel>
      {children}
    </section>
  );
}

function TrimControl({ label, value, onMinus, onPlus }: { label: string; value: number; onMinus: () => void; onPlus: () => void }) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-2xl bg-row px-3.5 py-2.5 shadow-flat">
      <span className="text-xs font-extrabold tracking-wider text-ink-3 uppercase">{label}</span>
      <div className="flex items-center gap-2">
        <Button size="icon-sm" onClick={onMinus} aria-label={`${label} −0.5s`}>
          <Minus size={16} />
        </Button>
        <b className="min-w-18 text-center font-display text-xl">{fmtPrecise(value)}</b>
        <Button size="icon-sm" onClick={onPlus} aria-label={`${label} +0.5s`}>
          <Plus size={16} />
        </Button>
      </div>
    </div>
  );
}

/** Edit a clip: hook, look, trim (with the transcript), and the post text. */
export function ClipEditor({ clip, siblings = [], onClose, onSaved }: { clip: Clip; siblings?: Clip[]; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(clip.title);
  const [hook, setHook] = useState(clip.hook);
  const [showHook, setShowHook] = useState(clip.showHook);
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle>(clip.captionStyle);
  const [layout, setLayout] = useState<Layout>(clip.layout);
  const [start, setStart] = useState(clip.start);
  const [end, setEnd] = useState(clip.end);
  const [description, setDescription] = useState(clip.description);
  const [tags, setTags] = useState(clip.hashtags.join(' '));
  const [motion, setMotion] = useState<Motion>(clip.motion ?? 'subtle');
  const [music, setMusic] = useState<MusicSettings>(clip.music ?? { track: 'none', volume: 15, duck: true });
  const [applyAll, setApplyAll] = useState(false);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [videoDuration, setVideoDuration] = useState(Infinity);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parts = clip.segments?.length ? clip.segments : null;
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .transcript(clip.id)
      .then((t) => {
        setLines(t.segments);
        setVideoDuration(t.duration ?? Infinity);
      })
      .catch(() => setLines([]));
  }, [clip.id]);

  // scroll the transcript to the clip once it arrives
  useEffect(() => {
    const el = box.current?.querySelector('[data-in="true"]') as HTMLElement | null;
    if (el && box.current) box.current.scrollTop = el.offsetTop - box.current.offsetTop - 8;
  }, [lines]);

  const needsRender =
    hook !== clip.hook ||
    showHook !== clip.showHook ||
    captionStyle !== clip.captionStyle ||
    layout !== clip.layout ||
    Math.abs(start - clip.start) > 0.01 ||
    Math.abs(end - clip.end) > 0.01 ||
    motion !== clip.motion ||
    JSON.stringify(music) !== JSON.stringify(clip.music);

  const nudge = (which: 'start' | 'end', d: number) => {
    if (which === 'start') setStart((s) => +Math.max(0, Math.min(end - 3, s + d)).toFixed(2));
    else setEnd((e) => +Math.min(videoDuration, Math.max(start + 3, e + d)).toFixed(2));
  };

  // joined clips: the first part starts at `start`, the last part ends at `end`
  const ranges = useMemo(() => {
    if (!parts) return [{ start, end }];
    const r = parts.map((x) => ({ ...x }));
    r[0].start = start;
    r[r.length - 1].end = end;
    return r;
  }, [parts, start, end]);
  const len = ranges.reduce((a, r) => a + r.end - r.start, 0);
  const inClip = (l: Line) => ranges.some((r) => l.e > r.start + 0.05 && l.s < r.end - 0.05);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateClip(clip.id, { title, hook, showHook, captionStyle, layout, start, end, description, hashtags: tags.split(/[\s,]+/).filter(Boolean), motion, music });
      if (applyAll) await Promise.all(siblings.filter((c) => c.id !== clip.id).map((c) => api.updateClip(c.id, { motion, music })));
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      busy={saving}
      size="xl"
      title="Edit clip"
      footer={
        <>
          {error && <p className="mr-auto text-sm font-bold text-bad">{error}</p>}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={saving}>
            {needsRender ? 'Save & re-render' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="grid gap-8 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="flex flex-col gap-3 lg:sticky lg:top-0 lg:self-start">
          <ClipVideo clip={clip} className="mx-auto max-w-[280px]" />
          <p className="text-center text-[13px] text-ink-3">Shows the current render. Changing the hook, look or trim re-renders the clip.</p>
        </div>

        <div className="flex flex-col gap-6">
          <Section title="On-screen hook (first 3 seconds)">
            <Input value={hook} maxLength={80} onChange={(e) => setHook(e.target.value)} placeholder="Nobody tells you this…" />
            <Toggle className="mt-3" checked={showHook} onChange={setShowHook}>
              Show the hook headline
            </Toggle>
          </Section>

          <Section title={`Trim · ${len.toFixed(1)}s${parts ? ` · ${parts.length} parts joined` : ''}`}>
            {parts && <p className="mb-2 text-[13px] text-ink-3">Parts: {ranges.map((r) => `${fmtTime(r.start)}–${fmtTime(r.end)}`).join(' + ')}. Start trims the first part, End trims the last.</p>}
            <div className="mb-3 flex flex-wrap gap-3">
              <TrimControl label="Start" value={start} onMinus={() => nudge('start', -0.5)} onPlus={() => nudge('start', 0.5)} />
              <TrimControl label="End" value={end} onMinus={() => nudge('end', -0.5)} onPlus={() => nudge('end', 0.5)} />
            </div>
            <div ref={box} className="max-h-64 overflow-y-auto rounded-[18px] bg-sunken p-2 shadow-well">
              {lines == null && <p className="p-2 text-ink-3">Loading transcript…</p>}
              {lines?.length === 0 && <p className="p-2 text-ink-3">No transcript available.</p>}
              {lines?.map((l, i) => {
                const on = inClip(l);
                return (
                  <div key={i} data-in={on} className={cn('group flex items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-sm', on ? 'bg-mint/30 font-bold text-ink' : 'text-ink-3')}>
                    <span className="w-12 shrink-0 text-xs font-extrabold tabular-nums">{fmtPrecise(l.s)}</span>
                    <span className="flex-1">{l.text}</span>
                    <span className="flex shrink-0 gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                      <button
                        type="button"
                        className="rounded-full bg-surface px-2.5 py-1 text-[11px] font-extrabold shadow-flat disabled:opacity-35"
                        onClick={() => setStart(+Math.max(0, l.s - 0.1).toFixed(2))}
                        disabled={l.s >= end - 3}
                      >
                        Start here
                      </button>
                      <button
                        type="button"
                        className="rounded-full bg-surface px-2.5 py-1 text-[11px] font-extrabold shadow-flat disabled:opacity-35"
                        onClick={() => setEnd(+(l.e + 0.25).toFixed(2))}
                        disabled={l.e <= start + 3}
                      >
                        End here
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          </Section>

          <Section title="Caption style">
            <CaptionPicker value={captionStyle} onChange={setCaptionStyle} />
          </Section>

          <div className="grid gap-6 md:grid-cols-2">
            <Section title="Framing">
              <Segmented label="Framing" size="sm" value={layout} onChange={setLayout} options={LAYOUTS} />
              <p className="mt-2 text-[13px] text-ink-3">
                {LAYOUTS.find((o) => o.value === layout)?.hint}
                {layout === 'auto' && clip.appliedLayout ? ` · now “${LAYOUTS.find((o) => o.value === clip.appliedLayout)?.label}”` : ''}
              </p>
            </Section>
            <Section title="Edit motion">
              <MotionPicker value={motion} onChange={setMotion} />
            </Section>
          </div>

          <Section title="Background music">
            <MusicPicker track={music.track} volume={music.volume} duck={music.duck} onChange={(v) => setMusic((m) => ({ ...m, ...v }))} />
            {siblings.length > 1 && (
              <Toggle className="mt-3" checked={applyAll} onChange={setApplyAll}>
                Use this motion and music for all {siblings.length} clips
              </Toggle>
            )}
          </Section>

          <div className="flex flex-col gap-4 rounded-2xl bg-row p-4 shadow-flat">
            <b className="font-display">Post text</b>
            <Field label="Title">
              <Input value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label="Caption / description">
              <Textarea value={description} maxLength={2200} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <Field label="Hashtags">
              <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="#podcast #startup" />
            </Field>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

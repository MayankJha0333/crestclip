import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Info, Minus, Plus, RefreshCw, Scissors, Send, Sparkles, Type } from 'lucide-react';
import { api, type CaptionStyle, type Clip, type Layout, type Motion, type MusicSettings } from '../../lib/api';
import { cn } from '../../lib/cn';
import { fmtPrecise, fmtTime } from '../../lib/format';
import { Button, ConfirmDialog, Dialog, FieldLabel, Input, Segmented, Tabs, Textarea, Toggle } from '../../components/ui';
import { CaptionPicker } from '../clip-settings/CaptionPicker';
import { MotionPicker } from '../clip-settings/MotionPicker';
import { MusicPicker } from '../clip-settings/MusicPicker';
import { LAYOUTS } from '../clip-settings/options';
import { ClipVideo } from './ClipVideo';
import { MIN_CLIP, TrimTimeline } from './TrimTimeline';

type Line = { s: number; e: number; text: string; speaker?: string };
type Tab = 'trim' | 'text' | 'look' | 'post';
const TAB_NAME: Record<Tab, string> = { trim: 'Trim', text: 'Hook & captions', look: 'Look & music', post: 'Post text' };
const TAB_SHORT: Record<Tab, string> = { trim: 'Trim', text: 'Text', look: 'Look', post: 'Post' }; // phones

/** A titled block inside a tab. */
function Block({ title, hint, aside, children }: { title: string; hint?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2.5 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <FieldLabel className="mb-0">{title}</FieldLabel>
          {hint && <p className="text-[13px] text-ink-3">{hint}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** "12 / 80" under a text box; turns orange near the limit. */
const Count = ({ n, max }: { n: number; max: number }) => <span className={cn('shrink-0 text-xs font-bold tabular-nums', n > max * 0.9 ? 'text-warn-ink' : 'text-ink-3')}>{`${n} / ${max}`}</span>;

/** − 1:18.2 + : nudge one end of the clip by half a second. */
function Nudge({ label, value, onStep }: { label: string; value: number; onStep: (d: number) => void }) {
  return (
    <div className="flex items-center gap-1.5 rounded-full bg-row p-1 shadow-flat">
      <Button size="icon-sm" variant="ghost" aria-label={`${label} 0.5s earlier`} onClick={() => onStep(-0.5)}>
        <Minus size={15} />
      </Button>
      <span className="min-w-16 text-center leading-tight">
        <span className="block text-[10px] font-extrabold tracking-wider text-ink-3 uppercase">{label}</span>
        <b className="font-display tabular-nums">{fmtPrecise(value)}</b>
      </span>
      <Button size="icon-sm" variant="ghost" aria-label={`${label} 0.5s later`} onClick={() => onStep(0.5)}>
        <Plus size={15} />
      </Button>
    </div>
  );
}

const lineBtn = 'rounded-full bg-surface px-2.5 py-1 text-[11px] font-extrabold shadow-flat transition-colors hover:text-accent disabled:pointer-events-none disabled:opacity-35';

/** Edit a clip: trim, hook & captions, look & music, and the post text — one tab each. */
export function ClipEditor({ clip, siblings = [], onClose, onSaved }: { clip: Clip; siblings?: Clip[]; onClose: () => void; onSaved: () => void }) {
  const [tab, setTab] = useState<Tab>('trim');
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
  const [confirmClose, setConfirmClose] = useState(false);
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
    if (tab !== 'trim') return;
    const el = box.current?.querySelector('[data-in="true"]') as HTMLElement | null;
    if (el && box.current) box.current.scrollTop = el.offsetTop - box.current.offsetTop - 8;
  }, [lines, tab]);

  const hashtags = tags.split(/[\s,]+/).filter(Boolean);
  const changed: Record<Tab, boolean> = {
    trim: Math.abs(start - clip.start) > 0.01 || Math.abs(end - clip.end) > 0.01,
    text: hook !== clip.hook || showHook !== clip.showHook || captionStyle !== clip.captionStyle,
    look: layout !== clip.layout || motion !== (clip.motion ?? 'subtle') || JSON.stringify(music) !== JSON.stringify(clip.music ?? { track: 'none', volume: 15, duck: true }) || applyAll,
    post: title !== clip.title || description !== clip.description || hashtags.join(' ') !== clip.hashtags.join(' '),
  };
  const rebuild = (['trim', 'text', 'look'] as const).filter((t) => changed[t]);
  const dirty = rebuild.length > 0 || changed.post;

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

  // the stretch of video the timeline shows: the original clip with room on both sides
  const bounds = useMemo(() => {
    const first = parts ? parts[0].start : clip.start;
    const last = parts ? parts[parts.length - 1].end : clip.end;
    const pad = Math.max(15, (last - first) * 0.6);
    return { from: Math.max(0, Math.min(first - pad, start - 2)), to: Math.min(videoDuration, Math.max(last + pad, end + 2)) };
  }, [parts, clip.start, clip.end, videoDuration, start, end]);

  const trimTo = (s: number, e: number) => {
    setStart(+Math.max(0, s).toFixed(2));
    setEnd(+Math.min(videoDuration, e).toFixed(2));
  };

  const close = () => (dirty ? setConfirmClose(true) : onClose());

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateClip(clip.id, { title, hook, showHook, captionStyle, layout, start, end, description, hashtags, motion, music });
      if (applyAll) await Promise.all(siblings.filter((c) => c.id !== clip.id).map((c) => api.updateClip(c.id, { motion, music })));
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const tabs = (Object.keys(TAB_NAME) as Tab[]).map((t) => ({
    value: t,
    label: (
      <>
        <span className="sm:hidden">{TAB_SHORT[t]}</span>
        <span className="hidden sm:inline">{TAB_NAME[t]}</span>
      </>
    ),
    icon: <span className="hidden sm:contents">{{ trim: <Scissors size={15} />, text: <Type size={15} />, look: <Sparkles size={15} />, post: <Send size={15} /> }[t]}</span>,
    count: null,
  }));

  return (
    <>
      <Dialog
        open
        onClose={close}
        busy={saving}
        size="xl"
        title={
          <span className="block">
            Edit clip
            <span className="mt-0.5 block truncate font-body text-sm font-normal text-ink-3">{clip.title}</span>
          </span>
        }
        footer={
          <>
            <p className="mr-auto flex min-w-0 items-center gap-2 text-[13px] text-ink-3">
              {error ? (
                <span className="font-bold text-bad">{error}</span>
              ) : rebuild.length ? (
                <>
                  <RefreshCw size={14} className="shrink-0 text-accent" />
                  <span>
                    Saving rebuilds the clip — <b className="text-ink">{rebuild.map((t) => TAB_NAME[t].toLowerCase()).join(', ')}</b> changed
                  </span>
                </>
              ) : changed.post ? (
                'Only the post text changed — no rebuild needed'
              ) : (
                'No changes yet'
              )}
            </p>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={save} loading={saving} disabled={!dirty}>
              {rebuild.length ? 'Save & rebuild' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="grid gap-6 lg:grid-cols-[230px_minmax(0,1fr)] lg:gap-8">
          {/* the current render */}
          <div className="flex flex-col items-center gap-3 lg:items-stretch">
            <ClipVideo clip={clip} className="max-w-[150px] sm:max-w-[180px] lg:max-w-none" />
            <p className="flex gap-2 rounded-2xl bg-row px-3 py-2.5 text-xs text-ink-3 shadow-flat">
              <Info size={14} className="mt-px shrink-0" />
              {rebuild.length ? 'This is the current version. Your changes show after you save.' : 'This is the current version of the clip.'}
            </p>
          </div>

          <div className="flex min-w-0 flex-col lg:h-[min(600px,calc(100dvh-16rem))]">
            <Tabs label="Edit sections" value={tab} onChange={setTab} tabs={tabs} className="mb-5 w-full shrink-0 sm:w-fit" />
            <ChangedDots changed={changed} tab={tab} />

            <div className="-mx-2 min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-2">
              {tab === 'trim' && (
                <div className="flex h-full flex-col gap-5">
                  <Block
                    title="Trim"
                    hint={parts ? `${parts.length} parts joined · the handles move the start of the first part and the end of the last` : 'Drag the handles, or use the buttons for half-second steps.'}
                    aside={<span className="shrink-0 rounded-full bg-orange-bg px-3 py-1 font-display text-sm font-bold text-orange-ink tabular-nums">{len.toFixed(1)}s</span>}
                  >
                    <TrimTimeline start={start} end={end} parts={ranges} lines={lines ?? []} bounds={bounds} onChange={trimTo} />
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                      <Nudge label="Start" value={start} onStep={(d) => trimTo(Math.min(end - MIN_CLIP, start + d), end)} />
                      {changed.trim && (
                        <Button size="sm" variant="ghost" onClick={() => trimTo(clip.start, clip.end)}>
                          Undo trim
                        </Button>
                      )}
                      <Nudge label="End" value={end} onStep={(d) => trimTo(start, Math.max(start + MIN_CLIP, end + d))} />
                    </div>
                  </Block>

                  <section className="flex min-h-56 flex-1 flex-col">
                    <div className="mb-2 flex items-end justify-between gap-3">
                      <FieldLabel className="mb-0">What’s said</FieldLabel>
                      <span className="text-xs text-ink-3">Point at a line to start or end there</span>
                    </div>
                    <div ref={box} className="min-h-0 flex-1 overflow-y-auto rounded-[20px] bg-sunken p-1.5 shadow-well">
                      {lines == null && <p className="p-3 text-sm text-ink-3">Loading what’s said…</p>}
                      {lines?.length === 0 && <p className="p-3 text-sm text-ink-3">No transcript for this clip.</p>}
                      {lines?.map((l, i) => {
                        const on = inClip(l);
                        return (
                          <div
                            key={i}
                            data-in={on}
                            className={cn(
                              'group relative flex items-center gap-3 rounded-xl py-2 pr-2 pl-4 text-sm transition-colors',
                              on ? 'bg-surface text-ink shadow-flat' : 'text-ink-3 hover:bg-row',
                            )}
                          >
                            {on && <span aria-hidden className="absolute inset-y-2 left-1.5 w-1 rounded-full bg-tangerine" />}
                            <span className="w-11 shrink-0 text-xs font-extrabold tabular-nums">{fmtTime(l.s)}</span>
                            <span className={cn('min-w-0 flex-1', on && 'font-semibold')}>{l.text}</span>
                            <span className="flex shrink-0 gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                              <button type="button" className={lineBtn} onClick={() => trimTo(l.s - 0.1, end)} disabled={l.s >= end - MIN_CLIP}>
                                Start here
                              </button>
                              <button type="button" className={lineBtn} onClick={() => trimTo(start, l.e + 0.25)} disabled={l.e <= start + MIN_CLIP}>
                                End here
                              </button>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                </div>
              )}

              {tab === 'text' && (
                <div className="flex flex-col gap-7">
                  <Block
                    title="On-screen hook"
                    hint="A short headline on screen for the first 3 seconds, to stop the scroll."
                    aside={
                      <Toggle checked={showHook} onChange={setShowHook}>
                        Show
                      </Toggle>
                    }
                  >
                    <div className={cn('transition-opacity', !showHook && 'opacity-50')}>
                      <Input value={hook} maxLength={80} onChange={(e) => setHook(e.target.value)} placeholder="Nobody tells you this…" aria-label="Hook text" />
                      <div className="mt-1.5 flex justify-end">
                        <Count n={hook.length} max={80} />
                      </div>
                    </div>
                  </Block>
                  <Block title="Caption style" hint="How the spoken words appear on screen.">
                    <CaptionPicker value={captionStyle} onChange={setCaptionStyle} />
                  </Block>
                </div>
              )}

              {tab === 'look' && (
                <div className="flex flex-col gap-7">
                  <Block
                    title="Framing"
                    hint={
                      <>
                        {LAYOUTS.find((o) => o.value === layout)?.hint}
                        {layout === 'auto' && clip.appliedLayout ? ` · now “${LAYOUTS.find((o) => o.value === clip.appliedLayout)?.label}”` : ''}
                      </>
                    }
                  >
                    <Segmented label="Framing" value={layout} onChange={setLayout} options={LAYOUTS} />
                  </Block>
                  <Block title="Edit motion">
                    <MotionPicker value={motion} onChange={setMotion} />
                  </Block>
                  <Block title="Background music">
                    <MusicPicker track={music.track} volume={music.volume} duck={music.duck} onChange={(v) => setMusic((m) => ({ ...m, ...v }))} />
                  </Block>
                  {siblings.length > 1 && (
                    <div className="rounded-2xl bg-row p-4 shadow-flat">
                      <Toggle checked={applyAll} onChange={setApplyAll}>
                        Use this motion and music for all {siblings.length} clips
                      </Toggle>
                    </div>
                  )}
                </div>
              )}

              {tab === 'post' && (
                <div className="flex flex-col gap-6">
                  <p className="flex gap-2 rounded-2xl bg-row px-4 py-3 text-[13px] text-ink-3 shadow-flat">
                    <Info size={15} className="mt-px shrink-0" />
                    Used when you post to YouTube or Instagram. Changing it doesn’t rebuild the clip.
                  </p>
                  <Block title="Title" aside={<Count n={title.length} max={100} />}>
                    <Input value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
                  </Block>
                  <Block title="Caption" aside={<Count n={description.length} max={2200} />}>
                    <Textarea value={description} maxLength={2200} rows={5} onChange={(e) => setDescription(e.target.value)} aria-label="Caption" />
                  </Block>
                  <Block title="Hashtags" hint="Separate with spaces." aside={<span className="text-xs font-bold text-ink-3">{hashtags.length} tags</span>}>
                    <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="#podcast #startup" aria-label="Hashtags" />
                    {hashtags.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {hashtags.map((h, i) => (
                          <span key={i} className="rounded-full bg-info-bg px-2.5 py-1 text-xs font-bold text-info-ink">
                            {h.startsWith('#') ? h : `#${h}`}
                          </span>
                        ))}
                      </div>
                    )}
                  </Block>
                </div>
              )}
            </div>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog open={confirmClose} title="Throw away your changes?" confirmLabel="Discard" onCancel={() => setConfirmClose(false)} onConfirm={onClose}>
        You changed{' '}
        {(Object.keys(changed) as Tab[])
          .filter((t) => changed[t])
          .map((t) => TAB_NAME[t].toLowerCase())
          .join(', ')}
        . Closing now loses those edits.
      </ConfirmDialog>
    </>
  );
}

/** A line under the tabs naming the other tabs that have unsaved changes. */
function ChangedDots({ changed, tab }: { changed: Record<Tab, boolean>; tab: Tab }) {
  const list = (Object.keys(changed) as Tab[]).filter((t) => changed[t] && t !== tab);
  if (!list.length) return null;
  return (
    <p className="-mt-3 mb-3 flex shrink-0 flex-wrap items-center gap-1.5 text-xs text-ink-3">
      <span className="size-1.5 rounded-full bg-tangerine" /> Also changed: {list.map((t) => TAB_NAME[t]).join(', ')}
    </p>
  );
}

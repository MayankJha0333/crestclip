import { useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus, X } from 'lucide-react';
import { api, fmtPrecise, fmtTime, type CaptionStyle, type Clip, type Layout, type Motion, type MusicSettings } from '../lib/api';
import { CaptionPicker, LAYOUT_OPTIONS, Seg, Toggle } from './bits';
import { MotionPicker, MusicPicker } from './MusicPicker';

type TSeg = { s: number; e: number; text: string; speaker?: string };

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
  const parts = clip.segments?.length ? clip.segments : null;
  const [segs, setSegs] = useState<TSeg[] | null>(null);
  const [videoDuration, setVideoDuration] = useState<number>(Infinity);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .transcript(clip.id)
      .then((t) => {
        setSegs(t.segments);
        setVideoDuration(t.duration ?? Infinity);
      })
      .catch(() => setSegs([]));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    dialog.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [clip.id, onClose]);

  const dirtyRender =
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

  const tbox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = tbox.current?.querySelector('.tline.in') as HTMLElement | null;
    if (el && tbox.current) tbox.current.scrollTop = el.offsetTop - tbox.current.offsetTop - 8;
    // only when the transcript first arrives
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segs]);

  // joined clips: the first part starts at `start`, the last part ends at `end`
  const ranges = useMemo(() => {
    if (!parts) return [{ start, end }];
    const r = parts.map((x) => ({ ...x }));
    r[0].start = start;
    r[r.length - 1].end = end;
    return r;
  }, [parts, start, end]);
  const len = ranges.reduce((a, r) => a + r.end - r.start, 0);
  const inRange = useMemo(() => (s: TSeg) => ranges.some((r) => s.e > r.start + 0.05 && s.s < r.end - 0.05), [ranges]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateClip(clip.id, {
        title,
        hook,
        showHook,
        captionStyle,
        layout,
        start,
        end,
        description,
        hashtags: tags.split(/[\s,]+/).filter(Boolean),
        motion,
        music,
      });
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
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal clay pop-in" role="dialog" aria-modal="true" aria-label="Edit clip" tabIndex={-1} ref={dialog}>
        <header className="row" style={{ justifyContent: 'space-between', marginBottom: 18 }}>
          <h2 style={{ fontSize: 26 }}>Edit clip</h2>
          <button className="btn btn-icon" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </header>

        <div className="editor-grid">
          <div className="stack" style={{ gap: 12 }}>
            <div className="clip-phone" style={{ maxWidth: 280, margin: '0 auto' }}>
              {clip.videoUrl ? <video src={clip.videoUrl} poster={clip.thumbUrl ?? undefined} controls playsInline /> : <div className="clip-phone-empty">No render yet</div>}
            </div>
            <p className="faint" style={{ fontSize: 13, textAlign: 'center' }}>
              Preview shows the current render. Changes to hook, captions, layout or trim re-render the clip.
            </p>
          </div>

          <div className="stack" style={{ gap: 22 }}>
            <section>
              <span className="label">On-screen hook (first 3 seconds)</span>
              <input className="field" value={hook} maxLength={80} onChange={(e) => setHook(e.target.value)} placeholder="Nobody tells you this…" />
              <div style={{ marginTop: 10 }}>
                <Toggle checked={showHook} onChange={setShowHook}>
                  Show hook headline
                </Toggle>
              </div>
            </section>

            <section>
              <span className="label">Caption style</span>
              <CaptionPicker value={captionStyle} onChange={setCaptionStyle} />
            </section>

            <section>
              <span className="label">Edit motion</span>
              <MotionPicker value={motion} onChange={setMotion} />
            </section>

            <section>
              <span className="label">Background music</span>
              <MusicPicker track={music.track} volume={music.volume} duck={music.duck} onChange={(v) => setMusic((m) => ({ ...m, ...v }))} />
              {siblings.length > 1 && (
                <div style={{ marginTop: 12 }}>
                  <Toggle checked={applyAll} onChange={setApplyAll}>
                    Use this motion + music for all {siblings.length} clips
                  </Toggle>
                </div>
              )}
            </section>

            <section>
              <span className="label">Framing</span>
              <Seg label="Framing" value={layout} onChange={setLayout} options={LAYOUT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
              <p className="faint" style={{ fontSize: 13, marginTop: 8 }}>
                {LAYOUT_OPTIONS.find((o) => o.value === layout)?.hint}
                {layout === 'auto' && clip.appliedLayout ? ` · currently “${LAYOUT_OPTIONS.find((o) => o.value === clip.appliedLayout)?.label}”` : ''}
              </p>
            </section>

            <section>
              <span className="label">Trim · {len.toFixed(1)}s{parts ? ` · ${parts.length} parts joined` : ''}</span>
              {parts && (
                <p className="faint" style={{ fontSize: 13, marginBottom: 8 }}>
                  Parts: {ranges.map((r) => `${fmtTime(r.start)}–${fmtTime(r.end)}`).join(' + ')}. Start trims the first part, End trims the last.
                </p>
              )}
              <div className="trim-row">
                <TrimControl label="Start" value={start} onMinus={() => nudge('start', -0.5)} onPlus={() => nudge('start', 0.5)} />
                <TrimControl label="End" value={end} onMinus={() => nudge('end', -0.5)} onPlus={() => nudge('end', 0.5)} />
              </div>
              <div className="transcript well" ref={tbox}>
                {segs == null && <p className="faint">Loading transcript…</p>}
                {segs?.length === 0 && <p className="faint">No transcript available.</p>}
                {segs?.map((s, i) => (
                  <div key={i} className={`tline ${inRange(s) ? 'in' : ''}`}>
                    <span className="tt">{fmtPrecise(s.s)}</span>
                    <span className="grow">{s.text}</span>
                    <span className="tbtns">
                      <button type="button" onClick={() => setStart(+Math.max(0, s.s - 0.1).toFixed(2))} disabled={s.s >= end - 3}>
                        Start here
                      </button>
                      <button type="button" onClick={() => setEnd(+(s.e + 0.25).toFixed(2))} disabled={s.e <= start + 3}>
                        End here
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section className="stack" style={{ gap: 12 }}>
              <div>
                <span className="label">Post title</span>
                <input className="field" value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div>
                <span className="label">Caption / description</span>
                <textarea className="field" value={description} maxLength={2200} onChange={(e) => setDescription(e.target.value)} />
              </div>
              <div>
                <span className="label">Hashtags</span>
                <input className="field" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="#podcast #startup" />
              </div>
            </section>

            {error && <p style={{ color: 'var(--bad)', fontWeight: 700 }}>{error}</p>}
            <div className="row" style={{ justifyContent: 'flex-end', gap: 10 }}>
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? <span className="spinner" /> : null}
                {dirtyRender ? 'Save & re-render' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TrimControl({ label, value, onMinus, onPlus }: { label: string; value: number; onMinus: () => void; onPlus: () => void }) {
  return (
    <div className="trim clay-sm">
      <span className="faint" style={{ fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em' }}>
        {label}
      </span>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-icon btn-sm" onClick={onMinus} aria-label={`${label} −0.5s`}>
          <Minus size={16} />
        </button>
        <b style={{ fontFamily: 'var(--font-display)', fontSize: 20, minWidth: 72, textAlign: 'center' }}>{fmtPrecise(value)}</b>
        <button type="button" className="btn btn-icon btn-sm" onClick={onPlus} aria-label={`${label} +0.5s`}>
          <Plus size={16} />
        </button>
      </div>
    </div>
  );
}

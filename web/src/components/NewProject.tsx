import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Film, Link2, SlidersHorizontal, UploadCloud, Wand2 } from 'lucide-react';
import { api, DEFAULT_OPTIONS, type LengthPref, type ProjectOptions } from '../lib/api';
import { CaptionPicker, LAYOUT_OPTIONS, PLATFORM_OPTIONS, Seg, Toggle } from './bits';
import { MotionPicker, MusicPicker } from './MusicPicker';

const LENGTHS: { value: LengthPref; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'short', label: '< 30s' },
  { value: 'medium', label: '30–60s' },
  { value: 'long', label: '60s+' },
];

export function NewProject({ initialUrl = '' }: { initialUrl?: string }) {
  const nav = useNavigate();
  const [mode, setMode] = useState<'link' | 'upload'>('link');
  const [url, setUrl] = useState(initialUrl);
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [opts, setOpts] = useState<ProjectOptions>(() => {
    try {
      const saved = { ...DEFAULT_OPTIONS, ...JSON.parse(localStorage.getItem('peakclip:opts') || '{}') } as ProjectOptions;
      delete saved.ranges;
      delete saved.joinRanges;
      return saved;
    } catch {
      return DEFAULT_OPTIONS;
    }
  });
  const [showMore, setShowMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const set = <K extends keyof ProjectOptions>(k: K, v: ProjectOptions[K]) => setOpts((o) => ({ ...o, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      localStorage.setItem('peakclip:opts', JSON.stringify(opts));
    } catch {
      /* ignore */
    }
    setBusy(true);
    try {
      let p;
      if (mode === 'link') {
        if (!/^https?:\/\//i.test(url.trim())) throw new Error('Paste a full link that starts with https://');
        p = await api.createFromUrl(url.trim(), opts);
      } else {
        if (!file) throw new Error('Choose a video file first');
        setUploadPct(0);
        p = await api.upload(file, opts, setUploadPct);
      }
      nav(`/app/p/${p.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setUploadPct(null);
    }
  };

  return (
    <form className="new-card clay" onSubmit={submit}>
      <div className="row wrap" style={{ justifyContent: 'space-between', gap: 16, marginBottom: 18 }}>
        <div>
          <h2 style={{ fontSize: 30 }}>Find the peaks</h2>
          <p className="muted">Paste a link or drop a long video. You'll get vertical clips of the moments people rewatch.</p>
        </div>
        <Seg
          label="Source"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'link', label: <span className="row" style={{ gap: 6 }}><Link2 size={16} /> Paste link</span> },
            { value: 'upload', label: <span className="row" style={{ gap: 6 }}><UploadCloud size={16} /> Upload file</span> },
          ]}
        />
      </div>

      {mode === 'link' ? (
        <div className="big-input well">
          <Link2 size={22} className="faint" />
          <input
            autoFocus
            aria-label="Video link"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=…  (also Twitch VODs, Vimeo, TikTok, X…)"
          />
        </div>
      ) : (
        <div
          className={`dropzone well ${drag ? 'drag' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files?.[0];
            if (f) setFile(f);
          }}
          onClick={() => fileInput.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInput.current?.click()}
        >
          <input ref={fileInput} type="file" accept="video/*,.mkv" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <span className="tint-sky drop-icon">{file ? <Film size={28} /> : <UploadCloud size={28} />}</span>
          {file ? (
            <div>
              <b>{file.name}</b>
              <div className="faint">{(file.size / 1024 / 1024).toFixed(1)} MB · click to change</div>
            </div>
          ) : (
            <div>
              <b>Drop a video here</b>
              <div className="faint">mp4, mov, mkv or webm — podcasts, streams, webinars</div>
            </div>
          )}
        </div>
      )}

      <div className="opt-grid">
        <div>
          <span className="label">Posting to</span>
          <Seg label="Platform" value={opts.platform} onChange={(v) => set('platform', v)} options={PLATFORM_OPTIONS} />
        </div>
        <div>
          <span className="label">Clip length {opts.length === 'auto' ? '· best for the platform' : ''}</span>
          <Seg label="Clip length" value={opts.length} onChange={(v) => set('length', v)} options={LENGTHS} />
        </div>
        <div>
          <span className="label">How many clips · {opts.clipCount}</span>
          <input type="range" min={1} max={20} value={opts.clipCount} onChange={(e) => set('clipCount', Number(e.target.value))} aria-label="Number of clips" />
        </div>
      </div>

      <div style={{ marginTop: 22 }}>
        <span className="label">Caption style</span>
        <CaptionPicker value={opts.captionStyle} onChange={(v) => set('captionStyle', v)} />
      </div>

      <div className="opt-grid motion-music" style={{ marginTop: 22 }}>
        <div>
          <span className="label">Edit motion</span>
          <MotionPicker value={opts.motion} onChange={(v) => set('motion', v)} />
        </div>
        <div>
          <span className="label">Background music</span>
          <MusicPicker compact track={opts.music} volume={opts.musicVolume} onChange={(v) => setOpts((o) => ({ ...o, ...(v.track !== undefined ? { music: v.track } : {}), ...(v.volume !== undefined ? { musicVolume: v.volume } : {}) }))} />
        </div>
      </div>

      <button type="button" className="linkish" style={{ marginTop: 18 }} onClick={() => setShowMore((s) => !s)} aria-expanded={showMore}>
        <SlidersHorizontal size={16} /> {showMore ? 'Fewer options' : 'More options'}
      </button>
      {showMore && (
        <div className="opt-grid" style={{ marginTop: 16 }}>
          <div>
            <span className="label">Framing</span>
            <Seg label="Framing" value={opts.layout} onChange={(v) => set('layout', v)} options={LAYOUT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
            <p className="faint" style={{ fontSize: 13, marginTop: 6 }}>{LAYOUT_OPTIONS.find((o) => o.value === opts.layout)?.hint}</p>
          </div>
          <div>
            <span className="label">Focus (optional)</span>
            <input className="field" value={opts.focus} maxLength={300} onChange={(e) => set('focus', e.target.value)} placeholder="e.g. only funny moments, or money tips" />
          </div>
          <div>
            <span className="label">Spoken language</span>
            <input className="field" value={opts.language} maxLength={40} onChange={(e) => set('language', e.target.value || 'auto')} placeholder="auto" />
          </div>
          <div className="stack" style={{ gap: 12, justifyContent: 'center' }}>
            <Toggle checked={opts.showHook} onChange={(v) => set('showHook', v)}>
              Hook headline in first 3s
            </Toggle>
            <Toggle checked={opts.useAudienceData} onChange={(v) => set('useAudienceData', v)}>
              Use “Most replayed” + comments
            </Toggle>
          </div>
        </div>
      )}

      {error && <p className="form-error">{error}</p>}
      <div className="row wrap" style={{ justifyContent: 'space-between', marginTop: 24, gap: 12 }}>
        <p className="faint" style={{ fontSize: 14 }}>
          Gemini on Vertex AI does the thinking · billed to your Google Cloud credits
        </p>
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
          {busy ? <span className="spinner" /> : <Wand2 size={20} />}
          {uploadPct != null ? `Uploading ${Math.round(uploadPct)}%` : busy ? 'Starting…' : 'Find my peaks'}
        </button>
      </div>
    </form>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Cloud, Film, Link2, ListChecks, Plus, ScrollText, SlidersHorizontal, Twitch, UploadCloud, Wand2, X, Youtube } from 'lucide-react';
import { detectLink } from '../lib/links';
import { api, DEFAULT_OPTIONS, type LengthPref, type ProjectOptions } from '../lib/api';
import { CaptionPicker, LAYOUT_OPTIONS, PLATFORM_OPTIONS, Seg, Toggle } from './bits';
import { MotionPicker, MusicPicker } from './MusicPicker';
import { toast } from '../lib/toast';

const LENGTHS: { value: LengthPref; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'short', label: '< 30s' },
  { value: 'medium', label: '30–60s' },
  { value: 'long', label: '60s+' },
];

/** Every link in the box (one per line, or separated by spaces/commas). */
const splitLinks = (text: string) =>
  [...new Set(text.split(/[\s,]+/).map((x) => x.trim()).filter((x) => /^(https?:\/\/)?[\w-]+(\.[\w-]+)+\//i.test(x)))].map((x) => (/^https?:\/\//i.test(x) ? x : `https://${x}`));

const VIDEO_LINK = /(youtube\.com|youtu\.be|drive\.google\.com\/file|docs\.google\.com\/file|dropbox\.com|1drv\.ms|onedrive\.live\.com|sharepoint\.com|twitch\.tv|vimeo\.com|\.(mp4|mov|mkv|webm)(\?|$))/i;

/** What the instructions box will be read as (a quick preview — the server reads it properly with Gemini). */
function previewInstructions(t: string) {
  const range = t.match(/(\d{1,3})\s*(?:-|–|to)\s*(\d{1,3})\s*(?:s\b|sec|seconds)/i);
  const max = t.match(/(?:max(?:imum)?|under|less than|no longer than|up to)\s*(\d{1,3})\s*(?:s\b|sec|seconds)/i);
  const tags = [...new Set([...(t.match(/(?:^|\s)@[\w.]{2,30}/g) ?? []).map((x) => x.trim().replace(/\.+$/, '')), ...(t.match(/#[\p{L}\p{N}_]{2,40}/gu) ?? [])])];
  const links = [...new Set((t.match(/https?:\/\/[^\s<>"')\]]+/g) ?? []).filter((u) => VIDEO_LINK.test(u)).map((u) => u.replace(/[.,;:!?]+$/, '')))];
  return { length: range ? `${range[1]}–${range[2]}s clips` : max ? `up to ${max[1]}s` : null, tags: tags.slice(0, 8), links };
}

export function NewProject({ initialUrl = '' }: { initialUrl?: string }) {
  const nav = useNavigate();
  const [mode, setMode] = useState<'link' | 'upload'>('link');
  const [url, setUrl] = useState(initialUrl);
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [opts, setOpts] = useState<ProjectOptions>(() => {
    try {
      const saved = { ...DEFAULT_OPTIONS, ...JSON.parse(localStorage.getItem('crestclip:opts') || localStorage.getItem('peakclip:opts') || '{}') } as ProjectOptions;
      delete saved.ranges;
      delete saved.joinRanges;
      return saved;
    } catch {
      return DEFAULT_OPTIONS;
    }
  });
  const [showMore, setShowMore] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [upInfo, setUpInfo] = useState<{ loaded: number; total: number; speed: number } | null>(null);
  const [fileDur, setFileDur] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const links = splitLinks(url);
  const link = links.length === 1 ? detectLink(links[0]) : detectLink(url);
  const many = links.length > 1;
  const linkInfos = links.map((u) => ({ url: u, info: detectLink(u) }));
  const brief = previewInstructions(instructions);
  const newFromBrief = brief.links.filter((u) => !links.includes(u));

  // read the picked file's length (shown before uploading)
  useEffect(() => {
    setFileDur(null);
    if (!file) return;
    const v = document.createElement('video');
    const src = URL.createObjectURL(file);
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      if (Number.isFinite(v.duration)) setFileDur(v.duration);
      URL.revokeObjectURL(src);
    };
    v.onerror = () => URL.revokeObjectURL(src);
    v.src = src;
  }, [file]);

  const MAX_MB = 4096;
  const pickFile = (f: File | null | undefined) => {
    setError(null);
    if (!f) return;
    const looksVideo = f.type.startsWith('video/') || /\.(mp4|m4v|mov|mkv|webm|avi|mpe?g|ts|mts|wmv|flv|3gp)$/i.test(f.name);
    if (!looksVideo) return setError(`“${f.name}” isn’t a video file. Use mp4, mov, mkv or webm.`);
    if (f.size > MAX_MB * 1024 * 1024) return setError(`That file is ${(f.size / 1024 ** 3).toFixed(1)} GB — the limit is ${MAX_MB / 1024} GB.`);
    setMode('upload');
    setFile(f);
  };
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const set = <K extends keyof ProjectOptions>(k: K, v: ProjectOptions[K]) => setOpts((o) => ({ ...o, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      localStorage.setItem('crestclip:opts', JSON.stringify({ ...opts, instructions: undefined }));
    } catch {
      /* ignore */
    }
    setBusy(true);
    try {
      let p;
      const send: ProjectOptions = { ...opts, focus: '', instructions: instructions.trim() || undefined };
      if (mode === 'link') {
        if (!links.length) throw new Error('Paste a full video link (YouTube, Twitch, Google Drive, Dropbox…)');
        const bad = linkInfos.find((l) => !l.info || l.info.error);
        if (bad) throw new Error(bad.info?.error ? `${bad.info.label}: ${bad.info.error}` : `“${bad.url}” isn’t a video link`);
        if (many) {
          const r = await api.createFromUrls(links, send);
          const bits = [r.understood.minSeconds && r.understood.maxSeconds ? `${r.understood.minSeconds}–${r.understood.maxSeconds}s` : '', r.understood.tags.slice(0, 3).join(' ')].filter(Boolean).join(' · ');
          toast(`Clipping ${r.projects.length} videos into one project${bits ? ` · ${bits}` : ''}`);
          nav(`/app/p/${r.project.id}`);
          return;
        }
        p = await api.createFromUrl(links[0], send);
      } else {
        if (!file) throw new Error('Choose a video file first');
        setUploadPct(0);
        const started = Date.now();
        abort.current = new AbortController();
        p = await api.upload(
          file,
          send,
          (pct, loaded, total) => {
            setUploadPct(pct);
            setUpInfo({ loaded, total, speed: loaded / Math.max(0.5, (Date.now() - started) / 1000) });
          },
          abort.current.signal,
        );
      }
      nav(`/app/p/${p.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setUploadPct(null);
      setUpInfo(null);
      abort.current = null;
    }
  };
  const fmtMB = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${Math.max(0.1, b / 1024 ** 2).toFixed(b < 1024 ** 2 * 10 ? 1 : 0)} MB`);
  const fmtLen = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s2 = Math.floor(sec % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s2).padStart(2, '0')}` : `${m}:${String(s2).padStart(2, '0')}`;
  };
  const eta = upInfo && upInfo.speed > 0 ? Math.max(0, (upInfo.total - upInfo.loaded) / upInfo.speed) : null;

  return (
    <form
      className={`new-card clay ${drag ? 'is-dragging' : ''}`}
      onSubmit={submit}
      onDragOver={(e) => {
        if (busy || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files?.length) return;
        e.preventDefault();
        setDrag(false);
        pickFile(e.dataTransfer.files[0]);
      }}
    >
      <div className="row wrap" style={{ justifyContent: 'space-between', gap: 16, marginBottom: 18 }}>
        <div>
          <h2 style={{ fontSize: 30 }}>Find the peaks</h2>
          <p className="muted">Paste one or more links, or drop a video file on this card. Add instructions and every clip follows them.</p>
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
        <>
          <div className={`big-input well ${link?.error ? 'has-error' : ''}`}>
            {link?.kind === 'youtube' ? <Youtube size={22} color="#e0453a" /> : link?.kind === 'twitch' ? <Twitch size={22} color="#9146ff" /> : link && ['gdrive', 'dropbox', 'onedrive'].includes(link.kind) ? <Cloud size={22} color="#2f80ed" /> : <Link2 size={22} className="faint" />}
            <textarea
              autoFocus
              aria-label="Video links"
              aria-describedby="link-hint"
              rows={Math.min(6, Math.max(url.trim() ? 1 : 2, url.split('\n').length + (url.trim() ? 0 : 0)))}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onPaste={(e) => {
                const f = e.clipboardData.files?.[0];
                if (f) {
                  e.preventDefault();
                  pickFile(f);
                }
              }}
              onKeyDown={(e) => {
                // Enter = new line for the next link · ⌘/Ctrl + Enter = start clipping
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
                }
              }}
              placeholder={"Paste a video link — YouTube, Twitch, Google Drive, Dropbox…\nMore videos? Press Enter and paste the next link on a new line"}
            />
            {url && (
              <button type="button" className="btn btn-icon btn-sm" aria-label="Clear link" onClick={() => setUrl('')}>
                <X size={16} />
              </button>
            )}
          </div>
          {many ? (
            <div id="link-hint" className="multi-links">
              <span className="faint">
                <b>{links.length} videos</b> — all clipped into one project, with the same settings
              </span>
              {linkInfos.map(({ url: u, info }) => (
                <div key={u} className={`multi-link ${!info || info.error ? 'bad' : ''}`}>
                  {info?.kind === 'youtube' ? <Youtube size={15} color="#e0453a" /> : info?.kind === 'twitch' ? <Twitch size={15} color="#9146ff" /> : info && ['gdrive', 'dropbox', 'onedrive'].includes(info.kind) ? <Cloud size={15} color="#2f80ed" /> : <Link2 size={15} />}
                  <b>{info?.label ?? 'Not a link'}</b>
                  <span className="clamp1">{info?.error ?? u}</span>
                  <button type="button" aria-label="Remove link" onClick={() => setUrl(links.filter((x) => x !== u).join('\n'))}>
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p id="link-hint" className={`link-hint ${link?.error ? 'bad' : link ? 'ok' : ''}`}>
              {link ? (
                link.error ? (
                  <>
                    <AlertTriangle size={14} /> {link.error}
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={14} /> <b>{link.label}</b> · {link.hint} · <span className="faint">press Enter to add another link</span>
                  </>
                )
              ) : (
                <>Works with YouTube · Twitch · Google Drive · Dropbox · OneDrive · direct .mp4 links · 1,000+ video sites · <b>more than one video? press Enter and paste the next link</b></>
              )}
            </p>
          )}
        </>
      ) : (
        <div
          className={`dropzone well ${drag ? 'drag' : ''}`}
          onClick={() => !busy && fileInput.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInput.current?.click()}
        >
          <input
            ref={fileInput}
            type="file"
            accept="video/*,.mkv,.mov,.m4v,.webm"
            hidden
            onChange={(e) => {
              pickFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <span className="tint-sky drop-icon">{file ? <Film size={28} /> : <UploadCloud size={28} />}</span>
          {file ? (
            <div className="grow" style={{ minWidth: 0 }}>
              <b className="clamp1">{file.name}</b>
              <div className="faint">
                {fmtMB(file.size)}
                {fileDur ? ` · ${fmtLen(fileDur)} long` : ''}
                {uploadPct == null ? ' · click to change' : ''}
              </div>
              {uploadPct != null && (
                <div style={{ marginTop: 10 }}>
                  <div className="progress well" style={{ height: 14 }}>
                    <span style={{ width: `${Math.max(2, uploadPct)}%` }} />
                  </div>
                  <div className="faint" style={{ fontSize: 13, marginTop: 6, fontWeight: 700 }}>
                    Uploading {Math.round(uploadPct)}%
                    {upInfo ? ` · ${fmtMB(upInfo.loaded)} of ${fmtMB(upInfo.total)} · ${fmtMB(upInfo.speed)}/s` : ''}
                    {eta != null && uploadPct < 100 ? ` · ~${eta < 60 ? `${Math.ceil(eta)} s` : `${Math.ceil(eta / 60)} min`} left` : ''}
                    {uploadPct >= 100 ? ' · finishing…' : ''}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div>
              <b>Drop a video here, or click to choose</b>
              <div className="faint">mp4, mov, mkv or webm · up to {MAX_MB / 1024} GB — podcasts, streams, webinars</div>
            </div>
          )}
          {file && uploadPct != null && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                abort.current?.abort();
              }}
            >
              <X size={14} /> Cancel
            </button>
          )}
          {file && uploadPct == null && (
            <button
              type="button"
              className="btn btn-icon btn-sm"
              aria-label="Remove file"
              onClick={(e) => {
                e.stopPropagation();
                setFile(null);
              }}
            >
              <X size={16} />
            </button>
          )}
        </div>
      )}

      <div className="instr well">
        <div className="instr-head">
          <ScrollText size={18} />
          <span className="label" style={{ margin: 0 }}>
            Instructions for the AI <span className="faint">· optional</span>
          </span>
        </div>
        <textarea
          className="instr-box"
          rows={instructions ? Math.min(10, Math.max(3, instructions.split('\n').length + 1)) : 3}
          value={instructions}
          maxLength={6000}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={'What should the clips be? e.g.\n• Clips 15–60 seconds, only the funny moments\n• Must include #brand and tag @brand · no swearing\nYou can also paste a whole campaign brief here.'}
        />
        {instructions.trim() && (
          <div className="instr-read">
            <ListChecks size={14} />
            <span>CrestClip will follow these{brief.length ? ` · ${brief.length}` : ''}</span>
            {brief.tags.map((t) => (
              <span key={t} className="instr-tag">
                {t}
              </span>
            ))}
            {mode === 'link' && newFromBrief.length > 0 && (
              <button type="button" className="btn btn-sm" onClick={() => setUrl([...links, ...newFromBrief].join('\n'))}>
                <Plus size={14} /> Clip the {newFromBrief.length} video link{newFromBrief.length > 1 ? 's' : ''} in your instructions
              </button>
            )}
          </div>
        )}
      </div>

      <div className="opt-grid">
        <div>
          <span className="label">Posting to</span>
          <Seg label="Platform" value={opts.platform} onChange={(v) => set('platform', v)} options={PLATFORM_OPTIONS} />
        </div>
        <div>
          <span className="label">Clip length {brief.length && instructions.trim() ? `· ${brief.length} (from your instructions)` : opts.length === 'auto' ? '· best for the platform' : ''}</span>
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
          {uploadPct != null ? `Uploading ${Math.round(uploadPct)}%` : busy ? (instructions.trim() ? 'Reading your instructions…' : 'Starting…') : many ? `Clip ${links.length} videos` : 'Find my peaks'}
        </button>
      </div>
    </form>
  );
}

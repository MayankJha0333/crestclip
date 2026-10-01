import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Film, Link2, ListChecks, Plus, ScrollText, UploadCloud, Wand2, X } from 'lucide-react';
import { api, saveOptions, savedOptions, type ProjectOptions } from '../../lib/api';
import { cn } from '../../lib/cn';
import { fmtTime } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Badge, Button, Card, Progress, Segmented } from '../../components/ui';
import { ClipSettings } from '../clip-settings/ClipSettings';
import { fmtBytes, previewInstructions, splitLinks } from './instructions';
import { LinkSourceIcon } from './LinkSourceIcon';
import { detectLink } from './links';

const MAX_MB = 4096;
const VIDEO_FILE = /\.(mp4|m4v|mov|mkv|webm|avi|mpe?g|ts|mts|wmv|flv|3gp)$/i;

/** Read a picked file's length in the browser (shown before uploading). */
function useFileDuration(file: File | null) {
  const [dur, setDur] = useState<number | null>(null);
  useEffect(() => {
    setDur(null);
    if (!file) return;
    const v = document.createElement('video');
    const src = URL.createObjectURL(file);
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      if (Number.isFinite(v.duration)) setDur(v.duration);
      URL.revokeObjectURL(src);
    };
    v.onerror = () => URL.revokeObjectURL(src);
    v.src = src;
  }, [file]);
  return dur;
}

/**
 * Start a project: paste one or more links (or upload a file), optionally write instructions,
 * check the clip settings, go. Several links become ONE project that holds every video.
 */
export function NewClipForm({ initialUrl = '' }: { initialUrl?: string }) {
  const nav = useNavigate();
  const [mode, setMode] = useState<'link' | 'upload'>('link');
  const [text, setText] = useState(initialUrl);
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [opts, setOpts] = useState<ProjectOptions>(savedOptions);
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ pct: number; loaded: number; total: number; speed: number } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileDur = useFileDuration(file);

  const links = splitLinks(text);
  const many = links.length > 1;
  const single = links.length === 1 ? detectLink(links[0]) : detectLink(text);
  const linkInfos = links.map((u) => ({ url: u, info: detectLink(u) }));
  const brief = previewInstructions(instructions);
  const newFromBrief = brief.links.filter((u) => !links.includes(u));

  const pickFile = (f: File | null | undefined) => {
    setError(null);
    if (!f) return;
    if (!f.type.startsWith('video/') && !VIDEO_FILE.test(f.name)) return setError(`“${f.name}” isn’t a video file. Use mp4, mov, mkv or webm.`);
    if (f.size > MAX_MB * 1024 * 1024) return setError(`That file is ${(f.size / 1024 ** 3).toFixed(1)} GB — the limit is ${MAX_MB / 1024} GB.`);
    setMode('upload');
    setFile(f);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    saveOptions(opts);
    const send: ProjectOptions = { ...opts, focus: '', instructions: instructions.trim() || undefined };
    setBusy(true);
    try {
      if (mode === 'link') {
        if (!links.length) throw new Error('Paste a full video link (YouTube, Twitch, Google Drive, Dropbox…)');
        const bad = linkInfos.find((l) => !l.info || l.info.error);
        if (bad) throw new Error(bad.info?.error ? `${bad.info.label}: ${bad.info.error}` : `“${bad.url}” isn’t a video link`);
        if (many) {
          const r = await api.createFromUrls(links, send);
          toast(`Clipping ${r.projects.length} videos into one project`);
          return nav(`/app/p/${r.project.id}`);
        }
        const p = await api.createFromUrl(links[0], send);
        return nav(`/app/p/${p.id}`);
      }
      if (!file) throw new Error('Choose a video file first');
      const started = Date.now();
      abort.current = new AbortController();
      setUpload({ pct: 0, loaded: 0, total: file.size, speed: 0 });
      const p = await api.upload(file, send, (pct, loaded, total) => setUpload({ pct, loaded, total, speed: loaded / Math.max(0.5, (Date.now() - started) / 1000) }), abort.current.signal);
      nav(`/app/p/${p.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setUpload(null);
      abort.current = null;
    }
  };

  const eta = upload && upload.speed > 0 ? Math.max(0, (upload.total - upload.loaded) / upload.speed) : null;
  const submitLabel = upload
    ? `Uploading ${Math.round(upload.pct)}%`
    : busy
      ? instructions.trim()
        ? 'Reading your instructions…'
        : 'Starting…'
      : many
        ? `Clip ${links.length} videos`
        : 'Find the best moments';

  return (
    <Card
      className={cn('relative p-5 transition-shadow sm:p-7', drag && 'shadow-[0_0_0_4px_var(--tangerine)]')}
      onDragOver={(e) => {
        if (busy || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDrag(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files?.length) return;
        e.preventDefault();
        setDrag(false);
        pickFile(e.dataTransfer.files[0]);
      }}
    >
      {drag && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-[inherit] bg-orange-bg font-display text-2xl text-orange-ink backdrop-blur-sm">
          Drop the video to upload it
        </div>
      )}
      <form onSubmit={submit} className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl">1 · Your video</h2>
          <Segmented
            label="Source"
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              {
                value: 'link',
                label: (
                  <>
                    <Link2 size={15} /> Paste link
                  </>
                ),
              },
              {
                value: 'upload',
                label: (
                  <>
                    <UploadCloud size={15} /> Upload file
                  </>
                ),
              },
            ]}
          />
        </div>

        {mode === 'link' ? (
          <div>
            <div className={cn('flex items-start gap-3 rounded-[22px] bg-sunken px-4 py-3.5 shadow-well', single?.error && 'shadow-[var(--shadow-well),inset_0_0_0_2px_var(--bad)]')}>
              <span className="mt-1">
                <LinkSourceIcon info={single} />
              </span>
              <textarea
                autoFocus
                aria-label="Video links"
                aria-describedby="link-hint"
                rows={Math.min(6, Math.max(text.trim() ? 1 : 2, text.split('\n').length))}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onPaste={(e) => {
                  const f = e.clipboardData.files?.[0];
                  if (f) {
                    e.preventDefault();
                    pickFile(f);
                  }
                }}
                onKeyDown={(e) => {
                  // Enter = new line for the next link · ⌘/Ctrl + Enter = start
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder={'Paste a video link — YouTube, Twitch, Google Drive, Dropbox…\nMore videos? Press Enter and paste the next link on a new line'}
                className="min-w-0 flex-1 resize-none bg-transparent text-[17px] leading-normal text-ink outline-none placeholder:text-ink-3"
              />
              {text && (
                <Button variant="ghost" size="icon-sm" aria-label="Clear links" onClick={() => setText('')}>
                  <X size={16} />
                </Button>
              )}
            </div>
            {many ? (
              <div id="link-hint" className="mt-3 flex flex-col gap-1.5 text-[13px]">
                <span className="text-ink-3">
                  <b className="text-ink">{links.length} videos</b> — all clipped into one project, with the same settings
                </span>
                {linkInfos.map(({ url: u, info }) => (
                  <div key={u} className={cn('flex min-w-0 items-center gap-2 rounded-xl px-3 py-1.5', !info || info.error ? 'bg-bad-bg text-bad-ink' : 'bg-row shadow-flat')}>
                    <LinkSourceIcon info={info} size={15} />
                    <b className="shrink-0">{info?.label ?? 'Not a link'}</b>
                    <span className="min-w-0 flex-1 truncate text-ink-3">{info?.error ?? u}</span>
                    <button
                      type="button"
                      aria-label="Remove link"
                      className="grid size-6 shrink-0 place-items-center rounded-full bg-muted-bg"
                      onClick={() => setText(links.filter((x) => x !== u).join('\n'))}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p id="link-hint" className={cn('mt-2.5 flex flex-wrap items-center gap-1.5 px-1 text-[13px] font-semibold', single?.error ? 'text-bad' : single ? 'text-good-ink' : 'text-ink-3')}>
                {single ? (
                  single.error ? (
                    <>
                      <AlertTriangle size={14} /> {single.error}
                    </>
                  ) : (
                    <>
                      <CheckCircle2 size={14} /> <b>{single.label}</b> · {single.hint}
                    </>
                  )
                ) : (
                  <>Works with YouTube, Twitch, Google Drive, Dropbox, OneDrive, direct .mp4 links and 1,000+ video sites. More than one video? Press Enter and paste the next link.</>
                )}
              </p>
            )}
          </div>
        ) : (
          <div
            role="button"
            tabIndex={0}
            onClick={() => !busy && fileInput.current?.click()}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInput.current?.click()}
            className="flex cursor-pointer items-center gap-4 rounded-[22px] border-[3px] border-dashed border-line-strong bg-sunken p-5 shadow-well transition-colors hover:border-tangerine"
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
            <span className="grid size-14 shrink-0 place-items-center rounded-[20px] clay-sky text-[#103552]">{file ? <Film size={26} /> : <UploadCloud size={26} />}</span>
            {file ? (
              <div className="min-w-0 flex-1">
                <b className="block truncate">{file.name}</b>
                <span className="text-sm text-ink-3">
                  {fmtBytes(file.size)}
                  {fileDur ? ` · ${fmtTime(fileDur)} long` : ''}
                  {!upload ? ' · click to change' : ''}
                </span>
                {upload && (
                  <div className="mt-2.5">
                    <Progress value={upload.pct} label="Upload progress" />
                    <p className="mt-1.5 text-[13px] font-bold text-ink-3">
                      {Math.round(upload.pct)}% · {fmtBytes(upload.loaded)} of {fmtBytes(upload.total)}
                      {upload.speed ? ` · ${fmtBytes(upload.speed)}/s` : ''}
                      {eta != null && upload.pct < 100 ? ` · ~${eta < 60 ? `${Math.ceil(eta)} s` : `${Math.ceil(eta / 60)} min`} left` : ''}
                      {upload.pct >= 100 ? ' · finishing…' : ''}
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div>
                <b>Drop a video here, or click to choose</b>
                <p className="text-sm text-ink-3">mp4, mov, mkv or webm · up to {MAX_MB / 1024} GB — podcasts, streams, webinars</p>
              </div>
            )}
            {file && (
              <Button
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  if (upload) abort.current?.abort();
                  else setFile(null);
                }}
              >
                <X size={14} /> {upload ? 'Cancel' : 'Remove'}
              </Button>
            )}
          </div>
        )}

        <div>
          <h2 className="mb-2.5 flex items-center gap-2 text-xl">
            2 · Instructions <span className="font-body text-sm font-semibold text-ink-3">optional</span>
          </h2>
          <div className="rounded-[22px] bg-sunken px-4 py-3.5 shadow-well">
            <div className="flex items-start gap-3">
              <ScrollText size={18} className="mt-1 shrink-0 text-accent" />
              <textarea
                aria-label="Instructions for the AI"
                rows={instructions ? Math.min(10, Math.max(3, instructions.split('\n').length + 1)) : 3}
                value={instructions}
                maxLength={6000}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder={'What should the clips be? For example:\n• Clips 15–60 seconds, only the funny moments\n• Must include #brand and tag @brand · no swearing'}
                className="min-w-0 flex-1 resize-y bg-transparent text-[15px] leading-normal text-ink outline-none placeholder:text-ink-3"
              />
            </div>
            {instructions.trim() && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-7 text-[13px] font-extrabold text-good-ink">
                <ListChecks size={14} /> Every clip will follow these{brief.length ? ` · ${brief.length} clips` : ''}
                {brief.tags.map((t) => (
                  <Badge key={t} tone="info">
                    {t}
                  </Badge>
                ))}
                {mode === 'link' && newFromBrief.length > 0 && (
                  <Button size="sm" onClick={() => setText([...links, ...newFromBrief].join('\n'))}>
                    <Plus size={14} /> Add the {newFromBrief.length} video link{newFromBrief.length > 1 ? 's' : ''} from your instructions
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>

        <div>
          <h2 className="mb-2.5 text-xl">3 · How the clips look</h2>
          <ClipSettings value={opts} onChange={setOpts} lengthNote={instructions.trim() ? brief.length : null} />
        </div>

        {error && (
          <p role="alert" className="flex items-center gap-2 rounded-2xl bg-bad-bg px-4 py-3 text-sm font-bold text-bad-ink">
            <AlertTriangle size={16} /> {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <p className="text-sm text-ink-3">Gemini on Vertex AI does the thinking · billed to your Google Cloud credits</p>
          <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full sm:w-auto">
            {!busy && <Wand2 size={20} />}
            {submitLabel}
          </Button>
        </div>
      </form>
    </Card>
  );
}

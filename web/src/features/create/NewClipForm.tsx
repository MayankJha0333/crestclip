import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Check, Film, Link2, ListChecks, Minus, Plus, UploadCloud, Wand2, X } from 'lucide-react';
import { api, saveOptions, savedOptions, type ProjectOptions } from '../../lib/api';
import { cn } from '../../lib/cn';
import { fmtTime } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Badge, Button, FieldLabel, Progress, Segmented, Select, Toggle } from '../../components/ui';
import { CaptionPicker } from '../clip-settings/CaptionPicker';
import { ClipSettings } from '../clip-settings/ClipSettings';
import { LENGTHS } from '../clip-settings/options';
import { fmtBytes, previewInstructions, splitLinks } from './instructions';
import { detectLink } from './links';
import { LinkList } from './LinkList';
import { FolderSummary, useFolderPreview } from './FolderSummary';
import { useAccount, useAuth } from '../auth/auth';
import { UpgradeCallout } from '../billing/UpgradeCallout';
import { LivePreview } from './LivePreview';
import { effectiveLogo, LogoPicker, previewOf } from '../watermark/LogoPicker';
import { logoAskLabel, withLogoAsk } from '../watermark/logoAsk';
import { useWatermark } from '../watermark/useWatermark';
import { track } from '../../lib/analytics';

const MAX_MB = 4096;
const VIDEO_FILE = /\.(mp4|m4v|mov|mkv|webm|avi|mpe?g|ts|mts|wmv|flv|3gp)$/i;
/** One tap adds a common rule to the instructions. */
const QUICK_RULES = ['Only the funniest moments', 'Clips 15–30 seconds', 'Strong hook in the first 2 seconds', 'No swearing', 'Skip intros and ads'];

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

/** A single YouTube link's length (and title), read in about a second, so the form can size the project before anything is spent. */
function useLinkPeek(url: string | null) {
  const [peek, setPeek] = useState<{ url: string; duration: number; title: string } | null>(null);
  useEffect(() => {
    if (!url) return setPeek(null);
    let gone = false;
    const t = setTimeout(() => {
      api
        .peek(url)
        .then((p) => !gone && setPeek({ url, duration: p.duration, title: p.title }))
        .catch(() => !gone && setPeek(null));
    }, 500);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [url]);
  return peek && peek.url === url ? peek : null;
}

const linkInfos0 = (u: string, ytOk: boolean) => detectLink(u, { youtube: ytOk })?.kind === 'youtube';
const brief0 = (t: string) => Boolean(previewInstructions(t).length);

/** How many clips a video of this length usually holds: 3 under 10 min, 6 up to an hour, 10 above. */
export const suggestedClips = (seconds: number) => (seconds < 10 * 60 ? 3 : seconds <= 60 * 60 ? 6 : 10);

/**
 * A rough wait, in minutes: reading the audio and finding moments grow with the video, rendering with the clips.
 * (Measured on the live server: a 14-min talk with 5 clips takes about 6 minutes end to end.)
 */
export const waitMinutes = (seconds: number | null, clips: number) => Math.max(2, Math.round(2 + (seconds ? (seconds / 60) * 0.12 : 3) + clips * 0.5));

/** Numbered step with a dot that turns into a check when the step is done. */
function Step({ n, title, hint, done, children, last }: { n: number; title: string; hint?: ReactNode; done?: boolean; children: ReactNode; last?: boolean }) {
  return (
    <section className="relative flex gap-4">
      <div className="flex flex-col items-center">
        <span
          className={cn('grid size-9 shrink-0 place-items-center rounded-full font-display font-bold transition-all duration-300', done ? 'clay-mint text-[#0f3b2e]' : 'clay-tangerine text-[#2b1407]')}
        >
          {done ? <Check size={17} strokeWidth={3} /> : n}
        </span>
        {!last && <span aria-hidden className="mt-2 w-0.5 flex-1 rounded-full bg-[repeating-linear-gradient(var(--line-strong)_0_6px,transparent_6px_12px)]" />}
      </div>
      <div className={cn('min-w-0 flex-1', !last && 'pb-8')}>
        <h2 className="text-xl leading-9">{title}</h2>
        {hint && <div className="-mt-0.5 mb-3.5 text-sm text-ink-3">{hint}</div>}
        {children}
      </div>
    </section>
  );
}

/**
 * Start a project. Left: three steps — what to clip, what the AI should look for, how the clips look.
 * Right (stays in view while scrolling): a live phone preview, how many clips and how long — then go.
 * Several links become ONE project that holds every video.
 */
export function NewClipForm({ initialUrl = '' }: { initialUrl?: string }) {
  const nav = useNavigate();
  const [mode, setMode] = useState<'link' | 'upload'>('link');
  const [items, setItems] = useState<string[]>(() => splitLinks(initialUrl));
  const [draft, setDraft] = useState('');
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
  const account = useAccount();
  const { refresh } = useAuth();
  const plan = account.plan;
  const ytOk = plan.youtubeSource !== false; // YouTube links: Creator and Pro
  const MAX_VIDEOS = plan.maxVideosPerProject;
  const balance = account.credits.balance;
  // what this will cost: credits per clip × clips × videos (unused clips are given back)
  const perClip = account.credits.perClip;
  const tooLong = mode === 'upload' && fileDur != null && fileDur > plan.maxVideoMinutes * 60;
  // true once the person sets the clip count by hand — then the video's length no longer changes it
  const [countTouched, setCountTouched] = useState(false);

  // links in the list, plus one still being typed (counts too, so Enter isn't required)
  const links = [...new Set([...items, ...splitLinks(draft)])].slice(0, MAX_VIDEOS);
  const many = links.length > 1;
  // a Google Drive folder: read on its own, the AI picks the videos inside
  const folderLink = mode === 'link' ? (links.find((u) => detectLink(u, { youtube: ytOk })?.folder) ?? null) : null;
  const folderMixed = Boolean(folderLink && links.length > 1);
  const folder = useFolderPreview(folderMixed ? null : folderLink);
  const folderVideos = folder.status === 'ready' ? folder.data.willClip : 0;
  const videos = mode === 'upload' ? 1 : folderLink ? Math.max(1, folderVideos) : Math.max(1, links.length);
  // one YouTube link: its length, so the clip count and the wait can be sized to the video
  const peek = useLinkPeek(mode === 'link' && links.length === 1 && !folderLink && linkInfos0(links[0], ytOk) ? links[0] : null);
  const knownDur = mode === 'upload' ? fileDur : (peek?.duration ?? null);
  useEffect(() => {
    if (!knownDur || countTouched || brief0(instructions)) return;
    // a first-timer on the free credits starts with 3 clips, so one try doesn't use up most of the month
    const n = Math.min(suggestedClips(knownDur), balance <= 60 ? 3 : 20, Math.max(1, Math.floor(balance / perClip)));
    setOpts((o) => (o.clipCount === n ? o : { ...o, clipCount: n }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knownDur, countTouched]);
  const wait = waitMinutes(knownDur, opts.clipCount);
  const cost = opts.clipCount * perClip * videos;
  const linkInfos = links.map((u) => ({ url: u, info: detectLink(u, { youtube: ytOk }) }));
  const brief = previewInstructions(instructions);
  const newFromBrief = brief.links.filter((u) => !links.includes(u));
  const videoReady = mode === 'upload' ? Boolean(file) : folderLink ? !folderMixed && folderVideos > 0 : links.length > 0 && linkInfos.every((l) => l.info && !l.info.error);
  const set = <K extends keyof ProjectOptions>(k: K, v: ProjectOptions[K]) => setOpts((o) => ({ ...o, [k]: v }));
  const watermark = useWatermark();
  // the instructions win over the picks for whatever they say about the logo
  const textLogo = instructions.trim() && watermark && !watermark.locked ? brief.logo : null;
  const textLogoLabel = logoAskLabel(watermark, textLogo);
  const logo = watermark && !watermark.locked ? withLogoAsk(watermark, effectiveLogo(watermark, opts.logo), textLogo) : null;

  const pickFile = (f: File | null | undefined) => {
    setError(null);
    if (!f) return;
    if (!f.type.startsWith('video/') && !VIDEO_FILE.test(f.name)) return setError(`“${f.name}” isn’t a video file. Use mp4, mov, mkv or webm.`);
    if (f.size > MAX_MB * 1024 * 1024) return setError(`That file is ${(f.size / 1024 ** 3).toFixed(1)} GB — the limit is ${MAX_MB / 1024} GB.`);
    setMode('upload');
    setFile(f);
  };
  const addRule = (r: string) => setInstructions((t) => (t.toLowerCase().includes(r.toLowerCase()) ? t : `${t.trim() ? `${t.trimEnd()}\n` : ''}• ${r}`));

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null);
    saveOptions(opts);
    const send: ProjectOptions = { ...opts, focus: '', instructions: instructions.trim() || undefined };
    setBusy(true);
    try {
      if (mode === 'link') {
        if (!links.length)
          throw new Error(
            ytOk ? 'Paste a full video link first (YouTube, Twitch, Google Drive, Dropbox…)' : 'Paste a full video link first (Google Drive, Dropbox, Twitch…), or upload the video file.',
          );
        const bad = linkInfos.find((l) => !l.info || l.info.error);
        if (bad) throw new Error(bad.info?.error ? `${bad.info.label}: ${bad.info.error}` : `“${bad.url}” isn’t a video link`);
        if (folderLink) {
          if (folderMixed) throw new Error('A Drive folder link goes on its own — remove the other links, or clip them in a separate project.');
          if (folder.status === 'error') throw new Error(folder.message);
          const r = await api.createFromFolder(folderLink, send);
          track('create_clips', { source: 'drive_folder', videos: r.projects.length });
          toast(`Clipping ${r.projects.length} of ${r.folder.videos} video${r.folder.videos === 1 ? '' : 's'} from “${r.folder.name}”`);
          void refresh();
          return nav(`/app/p/${r.project.id}`);
        }
        if (many) {
          const r = await api.createFromUrls(links, send);
          track('create_clips', { source: 'links', videos: r.projects.length });
          toast(`Clipping ${r.projects.length} videos into one project`);
          void refresh();
          return nav(`/app/p/${r.project.id}`);
        }
        const p = await api.createFromUrl(links[0], send);
        track('create_clips', { source: 'link', videos: 1 });
        void refresh();
        return nav(`/app/p/${p.id}`);
      }
      if (!file) throw new Error('Choose a video file first');
      const started = Date.now();
      abort.current = new AbortController();
      setUpload({ pct: 0, loaded: 0, total: file.size, speed: 0 });
      const p = await api.upload(file, send, (pct, loaded, total) => setUpload({ pct, loaded, total, speed: loaded / Math.max(0.5, (Date.now() - started) / 1000) }), abort.current.signal);
      track('create_clips', { source: 'upload', videos: 1 });
      void refresh();
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
      ? folderLink
        ? 'Reading your folder…'
        : instructions.trim()
          ? 'Reading your instructions…'
          : 'Starting…'
      : folderLink && folderVideos
        ? `Clip ${folderVideos === 1 ? '1 video' : `up to ${folderVideos} videos`} from the folder`
        : many
          ? `Clip ${links.length} videos`
          : 'Find the best moments';

  return (
    <form
      onSubmit={submit}
      className="relative grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_380px]"
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
        <div className="pointer-events-none absolute -inset-3 z-20 grid place-items-center rounded-[34px] border-[3px] border-dashed border-tangerine bg-orange-bg/90 backdrop-blur-sm">
          <span className="flex flex-col items-center gap-2 font-display text-2xl text-orange-ink">
            <UploadCloud size={40} /> Drop the video to upload it
          </span>
        </div>
      )}

      {/* ---------- left: what to clip ---------- */}
      <div className="rounded-[28px] bg-surface p-5 shadow-clay sm:p-7">
        <Step
          n={1}
          done={videoReady}
          title={mode === 'upload' ? 'Upload your video' : folderLink && !folderMixed ? 'Your Drive folder' : links.length > 1 ? `Your videos · ${links.length}` : 'Add your videos'}
          hint={
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {mode === 'upload' ? 'One file at a time — or drop it anywhere on this card.' : `One link or many (up to ${MAX_VIDEOS}) — they all go into one project. A Google Drive folder works too.`}
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
                        <Link2 size={14} /> Link
                      </>
                    ),
                  },
                  {
                    value: 'upload',
                    label: (
                      <>
                        <UploadCloud size={14} /> Upload
                      </>
                    ),
                  },
                ]}
              />
            </span>
          }
        >
          {mode === 'link' ? (
            <>
              <LinkList
                max={MAX_VIDEOS}
                upgradeHint={plan.id === 'free' ? 'Creator and Pro hold up to 15.' : null}
                items={items}
                onItems={setItems}
                draft={draft}
                onDraft={setDraft}
                onFile={pickFile}
                onSubmit={() => submit()}
                youtube={ytOk}
              />
              {folderLink && <FolderSummary state={folder} mixed={folderMixed} />}
            </>
          ) : (
            <div
              role="button"
              tabIndex={0}
              onClick={() => !busy && fileInput.current?.click()}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInput.current?.click()}
              className={cn(
                'flex cursor-pointer flex-col items-center gap-3 rounded-[22px] border-[3px] border-dashed bg-sunken p-6 text-center shadow-well transition-colors hover:border-tangerine sm:flex-row sm:text-left',
                file ? 'border-mint-d' : 'border-line-strong',
              )}
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
              <span className={cn('grid size-14 shrink-0 place-items-center rounded-[20px]', file ? 'clay-mint text-[#0f3b2e]' : 'clay-sky text-[#103552]')}>
                {file ? <Film size={26} /> : <UploadCloud size={26} />}
              </span>
              {file ? (
                <div className="w-full min-w-0 flex-1">
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
                  <b className="font-display text-lg">Drop a video here, or click to choose</b>
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
        </Step>

        <Step n={2} done={Boolean(instructions.trim())} title="Tell the AI what you want" hint="Optional — every clip follows these rules. You can paste a whole brief.">
          <textarea
            aria-label="Instructions for the AI"
            rows={instructions ? Math.min(10, Math.max(3, instructions.split('\n').length + 1)) : 3}
            value={instructions}
            maxLength={6000}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder={'For example: only the funny moments, 15–60 second clips, tag @brand and add #brand, small logo in the bottom left'}
            className="w-full resize-y rounded-[22px] bg-sunken px-4 py-3.5 text-[15px] leading-normal text-ink shadow-well outline-none placeholder:text-ink-3 focus-visible:shadow-[var(--shadow-well),0_0_0_3px_rgba(255,138,91,.4)]"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            {QUICK_RULES.map((r) => {
              const on = instructions.toLowerCase().includes(r.toLowerCase());
              return (
                <button
                  key={r}
                  type="button"
                  disabled={on}
                  onClick={() => addRule(r)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[13px] font-bold transition-all',
                    on ? 'bg-good-bg text-good-ink' : 'bg-row text-ink-2 shadow-flat hover:-translate-y-px hover:text-ink hover:shadow-[0_0_0_1px_var(--line-strong)]',
                  )}
                >
                  {on ? <Check size={13} /> : <Plus size={13} />} {r}
                </button>
              );
            })}
          </div>
          {instructions.trim() && (brief.length || brief.tags.length || textLogoLabel || newFromBrief.length > 0) && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5 rounded-2xl bg-good-bg px-3 py-2.5 text-[13px] font-extrabold text-good-ink">
              <ListChecks size={14} /> Understood:
              {brief.length && <Badge tone="good">{brief.length} clips</Badge>}
              {textLogoLabel && <Badge tone="info">Logo: {textLogoLabel}</Badge>}
              {brief.tags.map((t) => (
                <Badge key={t} tone="info">
                  {t}
                </Badge>
              ))}
              {mode === 'link' && newFromBrief.length > 0 && (
                <Button size="sm" onClick={() => setItems([...links, ...newFromBrief].slice(0, MAX_VIDEOS))}>
                  <Plus size={14} /> Add the {newFromBrief.length} video link{newFromBrief.length > 1 ? 's' : ''} from your text
                </Button>
              )}
            </div>
          )}
        </Step>

        <Step n={3} last title="Make them look yours" hint="Captions, music and your logo. The phone preview changes as you pick.">
          <div className="flex flex-col gap-5 @container">
            <div>
              <FieldLabel>Caption style</FieldLabel>
              <CaptionPicker fitContainer value={opts.captionStyle} onChange={(v) => set('captionStyle', v)} />
            </div>
            <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
              <label className="flex items-center justify-between gap-3 rounded-2xl bg-row px-3.5 py-2.5 shadow-flat">
                <span className="min-w-0">
                  <b className="block text-sm">Background music</b>
                  <span className="block text-xs text-ink-3">{opts.music === 'none' ? 'Off — just the video’s own sound' : 'On, quietly under the voice · change the mood in More options'}</span>
                </span>
                <Toggle checked={opts.music !== 'none'} onChange={(on) => set('music', on ? 'auto' : 'none')}>
                  <span className="sr-only">Background music</span>
                </Toggle>
              </label>
              <ClipSettings value={opts} onChange={setOpts} />
            </div>
            <LogoPicker value={opts.logo} onChange={(v) => set('logo', v)} ask={textLogo} />
          </div>
        </Step>
      </div>

      {/* ---------- right: the preview, how many clips + go ---------- */}
      <aside className="flex flex-col gap-4 rounded-[28px] bg-surface p-5 shadow-clay xl:sticky xl:top-6">
        <h2 className="text-xl">Your clips</h2>

        <div className="grid grid-cols-[170px_minmax(0,1fr)] items-start gap-4">
          <LivePreview
            opts={opts}
            link={mode === 'link' ? (links[0] ?? null) : null}
            file={mode === 'upload' ? file : null}
            videoCount={mode === 'link' ? links.length : 1}
            watermark={watermark && logo ? previewOf(watermark, logo) : undefined}
            onMoveLogo={logo?.id && textLogo?.x == null ? (x, y) => set('logo', { ...logo, x, y }) : undefined}
          />
          <div className="flex flex-col gap-4 pt-2">
            <div>
              <FieldLabel>Clips</FieldLabel>
              <div className="inline-flex items-center gap-1.5 rounded-full bg-sunken p-1 shadow-well">
                <Button
                  size="icon-sm"
                  className="size-8"
                  aria-label="Fewer clips"
                  disabled={opts.clipCount <= 1}
                  onClick={() => {
                    setCountTouched(true);
                    set('clipCount', opts.clipCount - 1);
                  }}
                >
                  <Minus size={14} />
                </Button>
                <b className="min-w-6 text-center font-display text-lg" aria-live="polite">
                  {opts.clipCount}
                </b>
                <Button
                  size="icon-sm"
                  className="size-8"
                  aria-label="More clips"
                  disabled={opts.clipCount >= 20}
                  onClick={() => {
                    setCountTouched(true);
                    set('clipCount', opts.clipCount + 1);
                  }}
                >
                  <Plus size={14} />
                </Button>
              </div>
              <small className="mt-1 block text-xs text-ink-3">
                {knownDur ? `${fmtTime(knownDur)} video · ` : ''}~{wait} min wait{videos > 1 ? ' per video' : ''}
              </small>
            </div>
            <label className="flex max-w-56 flex-col">
              <FieldLabel>Length</FieldLabel>
              {brief.length && instructions.trim() ? (
                <span className="rounded-2xl bg-good-bg px-3 py-2 text-sm font-bold text-good-ink">{brief.length} · from your text</span>
              ) : (
                <Select className="rounded-2xl py-2 text-sm font-bold" value={opts.length} onChange={(e) => set('length', e.target.value as ProjectOptions['length'])}>
                  {LENGTHS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {{ auto: 'Auto', short: 'Under 30s', medium: '30–60s', long: 'Over 60s' }[l.value]}
                    </option>
                  ))}
                </Select>
              )}
            </label>
            <p className="text-xs leading-snug text-ink-3">The preview shows your hook headline and caption style. Each clip gets its own words.</p>
          </div>
        </div>

        {error && (
          <p role="alert" className="flex items-start gap-2 rounded-2xl bg-bad-bg px-3.5 py-3 text-sm font-bold text-bad-ink">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
          </p>
        )}
        {tooLong && (
          <UpgradeCallout title={`This video is ${Math.round(fileDur! / 60)} min long`} cta="Upgrade">
            The {plan.name} plan clips videos up to {plan.maxVideoMinutes} min.
          </UpgradeCallout>
        )}
        {balance < perClip ? (
          <UpgradeCallout title="You’re out of credits" cta="Get credits">
            Buy a top-up or upgrade to keep clipping
            {account.cycleEnd ? ` — or wait for your free credits on ${new Date(account.cycleEnd).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : ''}.
          </UpgradeCallout>
        ) : (
          <div>
            <Button type="submit" variant="primary" size="lg" loading={busy} disabled={tooLong} className="w-full">
              {!busy && <Wand2 size={20} />}
              {submitLabel}
            </Button>
            <p
              className="mt-2.5 text-center text-xs text-ink-3"
              title={`${cost.toLocaleString()} of your ${balance.toLocaleString()} credits (${perClip} per clip); clips that don’t come out are refunded`}
            >
              Up to {(opts.clipCount * videos).toLocaleString()} clip{opts.clipCount * videos === 1 ? '' : 's'} · you can make {Math.floor(balance / perClip).toLocaleString()} more
              {cost > balance &&
                (folderLink ? (
                  <b className="mt-1 block text-warn-ink">The AI will pick only as many videos as your credits cover.</b>
                ) : (
                  <b className="mt-1 block text-warn-ink">
                    Enough for {Math.floor(balance / perClip)} clip{Math.floor(balance / perClip) === 1 ? '' : 's'} — ask for fewer, or top up first.
                  </b>
                ))}
            </p>
          </div>
        )}
      </aside>
    </form>
  );
}

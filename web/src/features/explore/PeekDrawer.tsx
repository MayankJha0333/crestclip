import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Calendar, ChevronLeft, ChevronRight, Clock, Combine, ExternalLink, Eye, Flame, ListVideo, Plus, Radio, Scissors, ThumbsUp, User, X } from 'lucide-react';
import { api, saveOptions, savedOptions, type ExploreItem, type Peek, type ProjectOptions, type TimeRange } from '../../lib/api';
import { cn } from '../../lib/cn';
import { fmtCount, fmtDate, fmtTime } from '../../lib/format';
import { toast } from '../../lib/toast';
import { Badge, Button, buttonClass, Skeleton } from '../../components/ui';
import { HeatChart, PickBar } from '../media/HeatChart';
import { useAccount } from '../auth/auth';
import { track } from '../../lib/analytics';

const MAX_MINUTES = 240;

function embedUrl(item: ExploreItem, start = 0) {
  const host = window.location.hostname || 'localhost';
  // enablejsapi lets us seek the player from the graph without reloading it
  if (item.source === 'youtube')
    return `https://www.youtube-nocookie.com/embed/${item.id}?rel=0&modestbranding=1&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}${start ? `&start=${Math.floor(start)}&autoplay=1` : ''}`;
  if (item.kind === 'clip') return `https://clips.twitch.tv/embed?clip=${encodeURIComponent(item.id)}&parent=${host}&autoplay=false`;
  if (item.kind === 'channel') return `https://player.twitch.tv/?channel=${encodeURIComponent(item.id)}&parent=${host}&autoplay=false`;
  const h = Math.floor(start / 3600);
  const m = Math.floor((start % 3600) / 60);
  const s = Math.floor(start % 60);
  return `https://player.twitch.tv/?video=v${item.id.replace(/^v/, '')}&parent=${host}&autoplay=${start ? 'true' : 'false'}${start ? `&time=${h}h${m}m${s}s` : ''}`;
}

/** Rough wall-clock estimate so people know what they're committing to. */
function estimate(durationSec: number) {
  const min = Math.max(2, Math.round(2 + (durationSec / 60) * 0.18));
  return min >= 60 ? `about ${Math.round(min / 60)} h` : `about ${min} min`;
}

function HotRow({ onClick, children, onPick, pickDisabled, pickLabel }: { onClick: () => void; children: React.ReactNode; onPick?: () => void; pickDisabled?: boolean; pickLabel?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={onClick}
        title="Play from here"
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl bg-row px-3 py-2 text-left text-sm font-bold shadow-flat transition-transform hover:translate-x-0.5"
      >
        {children}
      </button>
      {onPick && (
        <Button size="icon-sm" title={pickLabel} aria-label={pickLabel} disabled={pickDisabled} onClick={onPick}>
          <Plus size={16} />
        </Button>
      )}
    </div>
  );
}

/** Side panel: watch a video, see where viewers rewatch, pick parts — then clip it. */
export function PeekDrawer({
  items,
  index,
  onIndex,
  onClose,
  onSeen,
  onChannel,
}: {
  items: ExploreItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onSeen?: (it: ExploreItem) => void;
  onChannel?: (url: string) => void;
}) {
  const item = items[index];
  const nav = useNavigate();
  const [peek, setPeek] = useState<Peek | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [start, setStart] = useState(0);
  const [opts, setOpts] = useState<ProjectOptions>(savedOptions);
  const [busy, setBusy] = useState(false);
  const perClip = useAccount().credits.perClip;
  const [picks, setPicks] = useState<TimeRange[]>([]);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const hasPrev = index > 0;
  const hasNext = index < items.length - 1;

  useEffect(() => {
    let cancelled = false;
    setPeek(null);
    setErr(null);
    setStart(0);
    setPicks([]);
    setPlayhead(null);
    api
      .peek(item.url)
      .then((p) => {
        if (cancelled) return;
        setPeek(p);
        onSeen?.({
          ...item,
          title: p.title || item.title,
          channel: p.channel || item.channel,
          channelUrl: p.channelUrl ?? item.channelUrl,
          views: p.views ?? item.views,
          duration: p.duration || item.duration,
          thumbnail: item.thumbnail ?? p.thumbnail,
        });
      })
      .catch((e: Error) => !cancelled && setErr(e.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.url]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/input|textarea|select/i.test((e.target as HTMLElement).tagName)) return;
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' && hasNext) onIndex(index + 1);
      if (e.key === 'ArrowLeft' && hasPrev) onIndex(index - 1);
    };
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose, onIndex, index, hasNext, hasPrev]);

  const vertical = item.kind === 'short' || item.kind === 'clip';
  // the iframe only reloads for Twitch (or a new video); YouTube is seeked in place
  const src = useMemo(() => embedUrl(item, item.source === 'youtube' ? 0 : start), [item, start]);

  // YouTube player: listen for its time updates so the graph can show where you are
  useEffect(() => {
    if (item.source !== 'youtube') return;
    const onMsg = (e: MessageEvent) => {
      try {
        if (!/youtube(-nocookie)?\.com$/.test(new URL(e.origin).hostname)) return;
        const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (typeof d?.info?.currentTime === 'number') setPlayhead(d.info.currentTime);
      } catch {
        /* not ours */
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [item.source]);

  const post = (msg: object) => frame.current?.contentWindow?.postMessage(JSON.stringify({ ...msg, id: 1, channel: 'widget' }), '*');
  const seek = (t: number) => {
    const at = Math.max(0, Math.floor(t));
    if (item.source === 'youtube' && frame.current) {
      post({ event: 'listening' });
      post({ event: 'command', func: 'seekTo', args: [at, true] });
      post({ event: 'command', func: 'playVideo', args: [] });
      setPlayhead(at);
    } else setStart(at);
  };

  const live = Boolean(peek?.isLive || item.isLive || item.kind === 'live');
  const dur = peek?.duration || item.duration || 0;
  const tooLong = dur > MAX_MINUTES * 60;
  const channelUrl = peek?.channelUrl ?? item.channelUrl;
  const bands = (peek?.hotspots ?? []).map((h, i) => ({ id: `h${i}`, start: h.start, end: h.end, rank: i + 1 }));
  const blocked = live ? 'Clip after the stream ends' : tooLong ? `Longer than ${MAX_MINUTES / 60} h — too long to clip` : null;
  const picked = (s: number, e?: number) => picks.some((r) => Math.abs(r.start - s) < 1 && (e == null || Math.abs(r.end - e) < 1));

  const start_ = async (o: ProjectOptions, msg: string) => {
    setBusy(true);
    saveOptions(opts);
    try {
      const p = await api.createFromUrl(peek?.url ?? item.url, o);
      track('create_clips', { source: 'explore_preview', videos: 1 });
      toast(msg);
      nav(`/app/p/${p.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-scrim backdrop-blur-[4px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Preview: ${peek?.title ?? item.title}`}
        className="flex h-full w-full max-w-[540px] animate-[pop-in_.4s_var(--ease-squish)_both] flex-col gap-4 overflow-y-auto bg-surface p-5 shadow-clay sm:m-4 sm:h-[calc(100vh-2rem)] sm:rounded-[28px]"
      >
        <header className="flex items-center justify-between gap-2.5">
          <Badge tone={item.source === 'youtube' ? 'bubble' : 'lilac'}>
            {item.source === 'youtube' ? 'YouTube' : 'Twitch'} · {item.kind === 'vod' ? 'past stream' : item.kind}
          </Badge>
          <div className="flex items-center gap-1.5">
            {items.length > 1 && (
              <>
                <Button size="icon-sm" onClick={() => onIndex(index - 1)} disabled={!hasPrev} aria-label="Previous video (←)" title="Previous (←)">
                  <ChevronLeft size={18} />
                </Button>
                <span className="min-w-12 text-center text-[13px] font-extrabold text-ink-3">
                  {index + 1} / {items.length}
                </span>
                <Button size="icon-sm" onClick={() => onIndex(index + 1)} disabled={!hasNext} aria-label="Next video (→)" title="Next (→)">
                  <ChevronRight size={18} />
                </Button>
              </>
            )}
            <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close preview (Esc)" title="Close (Esc)">
              <X size={18} />
            </Button>
          </div>
        </header>

        <div className={cn('relative shrink-0 overflow-hidden rounded-[22px] bg-media shadow-lift', vertical ? 'mx-auto aspect-[9/16] max-h-[60vh]' : 'aspect-video w-full')}>
          <iframe
            ref={frame}
            key={src}
            src={src}
            onLoad={() => setTimeout(() => post({ event: 'listening' }), 400)}
            title={item.title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            className="absolute inset-0 size-full border-0"
          />
        </div>

        <div>
          <h2 className="text-xl leading-snug">{peek?.title ?? item.title}</h2>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {(peek?.channel || item.channel) &&
              (channelUrl && onChannel ? (
                <button type="button" onClick={() => onChannel(channelUrl)} title="See more from this channel">
                  <Badge className="hover:bg-row-hover">
                    <User size={12} /> {peek?.channel || item.channel} <ChevronRight size={12} />
                  </Badge>
                </button>
              ) : (
                <Badge>{peek?.channel || item.channel}</Badge>
              ))}
            {live && (
              <Badge tone="bubble">
                <Radio size={12} /> Live now
              </Badge>
            )}
            {dur ? (
              <Badge>
                <Clock size={12} /> {fmtTime(dur)}
              </Badge>
            ) : null}
            {(peek?.views ?? item.views) != null && (
              <Badge>
                <Eye size={12} /> {fmtCount(peek?.views ?? item.views, 'views')}
              </Badge>
            )}
            {peek?.likes != null && (
              <Badge>
                <ThumbsUp size={12} /> {fmtCount(peek.likes)}
              </Badge>
            )}
            {peek?.uploadDate && (
              <Badge>
                <Calendar size={12} /> {fmtDate(peek.uploadDate)}
              </Badge>
            )}
          </div>
        </div>

        <section className="rounded-[22px] bg-sunken p-4 shadow-well">
          <div className="mb-1 flex items-center gap-2">
            <Flame size={18} className="text-accent" />
            <b className="font-display text-[17px]">Where viewers rewatch</b>
          </div>
          {!peek && !err && (
            <>
              <p className="mb-2 text-[13px] text-ink-3">Reading the replay graph…</p>
              <Skeleton className="h-28" />
            </>
          )}
          {err && <p className="text-sm text-ink-3">Couldn’t load details ({err}). You can still clip it.</p>}
          {peek && peek.curve && peek.duration ? (
            <>
              <p className="mb-1.5 text-[13px] text-ink-3">
                Peaks are moments viewers replayed. <b>Click</b> to jump there · <b>drag</b> to pick the parts you want clipped.
              </p>
              <HeatChart
                curve={peek.curve}
                duration={peek.duration}
                kind="audience"
                bands={bands}
                height={130}
                onSeek={seek}
                playhead={playhead}
                selections={live ? undefined : picks}
                onSelectionsChange={live ? undefined : setPicks}
              />
              <div className="mt-2.5 flex flex-col gap-1.5">
                {peek.hotspots.map((h, i) => (
                  <HotRow
                    key={i}
                    onClick={() => seek(h.start)}
                    onPick={live ? undefined : () => setPicks((p) => [...p, { start: h.start, end: Math.min(h.end, h.start + 180) }])}
                    pickDisabled={picked(h.start, h.end)}
                    pickLabel={`Pick ${fmtTime(h.start)} to ${fmtTime(h.end)}`}
                  >
                    <Badge tone="butter">#{i + 1}</Badge>
                    <span className="flex-1">
                      {fmtTime(h.start)} – {fmtTime(h.end)}
                    </span>
                    <span className="h-2 w-16 overflow-hidden rounded-full bg-sunken shadow-well" aria-hidden>
                      <span className="block h-full rounded-full bg-[linear-gradient(90deg,var(--butter),var(--tangerine))]" style={{ width: `${Math.round(h.value * 100)}%` }} />
                    </span>
                    <b className="w-10 text-right">{Math.round(h.value * 100)}%</b>
                  </HotRow>
                ))}
              </div>
            </>
          ) : peek ? (
            <>
              <p className="text-sm text-ink-2">
                {peek.isYouTube
                  ? 'No “Most replayed” graph for this one — YouTube only shows it on popular videos a few days old. CrestClip finds the peaks with Gemini and audio energy instead.'
                  : 'Twitch has no replay graph. CrestClip finds the peaks with Gemini and audio energy.'}
              </p>
              {peek.duration && !live ? (
                <>
                  <p className="mt-2.5 mb-0.5 text-[13px] text-ink-3">
                    Timeline: <b>click</b> to jump there · <b>drag</b> to pick the parts you want clipped.
                  </p>
                  <HeatChart curve={[]} duration={peek.duration} kind="none" bands={[]} height={70} onSeek={seek} playhead={playhead} selections={picks} onSelectionsChange={setPicks} />
                </>
              ) : null}
            </>
          ) : null}
        </section>

        {peek && peek.chapters.length > 0 && (
          <section>
            <div className="mb-2 flex items-center gap-2">
              <ListVideo size={18} />
              <b className="font-display">Chapters</b>
            </div>
            <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto p-1">
              {peek.chapters.slice(0, 12).map((c, i) => (
                <HotRow
                  key={i}
                  onClick={() => seek(c.start_time)}
                  onPick={!live && c.end_time > c.start_time ? () => setPicks((p) => [...p, { start: c.start_time, end: Math.min(c.end_time, c.start_time + 180) }]) : undefined}
                  pickDisabled={picked(c.start_time)}
                  pickLabel={c.end_time - c.start_time > 180 ? 'Pick the first 3 minutes of this chapter' : `Pick chapter ${c.title}`}
                >
                  <span className="w-12 shrink-0 text-xs font-extrabold tabular-nums">{fmtTime(c.start_time)}</span>
                  <span className="flex-1 truncate">{c.title}</span>
                </HotRow>
              ))}
            </div>
          </section>
        )}

        <section className="sticky -bottom-5 z-[6] mt-auto -mx-5 flex flex-col gap-3 border-t border-line bg-surface px-5 pt-4 pb-5">
          <PickBar picks={picks} onChange={setPicks}>
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={Boolean(blocked)}
              onClick={() => start_({ ...opts, ranges: picks, joinRanges: false }, 'Clipping your parts — only those parts are downloaded')}
            >
              {!busy && <Scissors size={16} />} {picks.length > 1 ? `Clip these ${picks.length} parts` : 'Clip this part'} · {picks.length * perClip} credits
            </Button>
            {picks.length > 1 && (
              <Button
                size="sm"
                disabled={busy || Boolean(blocked)}
                onClick={() => start_({ ...opts, ranges: picks, joinRanges: true }, 'Joining your parts into one clip — only those parts are downloaded')}
                title="Stitch the parts, in time order, into one clip"
              >
                <Combine size={16} /> Join into 1 clip · {perClip} credits
              </Button>
            )}
          </PickBar>
          <label className="flex items-center gap-2.5 text-sm font-bold">
            <span className="min-w-16">Clips · {opts.clipCount}</span>
            <input
              type="range"
              min={1}
              max={20}
              value={opts.clipCount}
              onChange={(e) => setOpts((o) => ({ ...o, clipCount: Number(e.target.value) }))}
              aria-label="Number of clips"
              className="flex-1"
            />
          </label>
          <p className="text-[13px] font-bold text-ink-3">
            {blocked ?? (
              <>
                You’ll get {opts.clipCount} vertical clip{opts.clipCount > 1 ? 's' : ''} with captions, a hook and a score · {opts.clipCount * perClip} credits
                {dur ? ` · ready in ${estimate(dur)}` : ''}
              </>
            )}
          </p>
          <div className="flex gap-2.5">
            <a className={buttonClass('secondary', 'md')} href={peek?.url ?? item.url} target="_blank" rel="noreferrer" title="Open on the original site">
              <ExternalLink size={16} /> Open
            </a>
            <Button
              variant="primary"
              className="flex-1"
              loading={busy}
              disabled={Boolean(blocked) || item.kind === 'channel'}
              onClick={() => start_(opts, 'Clipping started — CrestClip is finding the peaks')}
            >
              {!busy && <Scissors size={18} />}
              {busy ? 'Starting…' : blocked ? 'Can’t clip yet' : 'Clip this video'}
            </Button>
          </div>
        </section>
      </aside>
    </div>,
    document.body,
  );
}

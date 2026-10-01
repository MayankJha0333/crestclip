import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Calendar, ChevronLeft, ChevronRight, Clock, Combine, ExternalLink, Eye, Flame, ListVideo, Plus, Radio, Scissors, ThumbsUp, User, X } from 'lucide-react';
import { api, DEFAULT_OPTIONS, fmtCount, fmtDate, fmtTime, type ExploreItem, type Peek, type Platform, type ProjectOptions, type TimeRange } from '../lib/api';
import { HeatChart, PickBar } from './HeatChart';
import { PLATFORM_OPTIONS, Seg } from './bits';
import { readLocal, writeLocal } from '../lib/local';
import { toast } from '../lib/toast';

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

const savedOptions = (): ProjectOptions => {
  const o = { ...DEFAULT_OPTIONS, ...readLocal<Partial<ProjectOptions>>('peakclip:opts', {}) };
  delete o.ranges;
  delete o.joinRanges;
  return o;
};

/** Rough wall-clock estimate so people know what they're committing to. */
function estimate(durationSec: number) {
  const min = Math.max(2, Math.round(2 + (durationSec / 60) * 0.18));
  return min >= 60 ? `about ${Math.round(min / 60)} h` : `about ${min} min`;
}

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
      .catch((e) => !cancelled && setErr(e.message));
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
    return () => window.removeEventListener('keydown', onKey);
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
        const t = d?.info?.currentTime;
        if (typeof t === 'number') setPlayhead(t);
      } catch {
        /* not ours */
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [item.source]);

  const ytCommand = (func: string, args: unknown[] = []) =>
    frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args, id: 1, channel: 'widget' }), '*');
  const listen = () => frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*');

  /** Jump the preview to a moment (graph click, hotspot, chapter). */
  const seek = (t: number) => {
    const at = Math.max(0, Math.floor(t));
    if (item.source === 'youtube' && frame.current) {
      listen();
      ytCommand('seekTo', [at, true]);
      ytCommand('playVideo');
      setPlayhead(at);
    } else setStart(at);
  };
  const live = Boolean(peek?.isLive || item.isLive || item.kind === 'live');
  const dur = peek?.duration || item.duration || 0;
  const tooLong = dur > MAX_MINUTES * 60;
  const channelUrl = peek?.channelUrl ?? item.channelUrl;
  const bands = (peek?.hotspots ?? []).map((h, i) => ({ id: `h${i}`, start: h.start, end: h.end, rank: i + 1 }));

  const clip = async () => {
    setBusy(true);
    writeLocal('peakclip:opts', opts);
    try {
      const p = await api.createFromUrl(peek?.url ?? item.url, opts);
      toast('Clipping started — PeakClip is finding the peaks');
      nav(`/app/p/${p.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };

  const clipPicked = async (join: boolean) => {
    setBusy(true);
    writeLocal('peakclip:opts', opts);
    try {
      const p = await api.createFromUrl(peek?.url ?? item.url, { ...opts, ranges: picks, joinRanges: join });
      toast(join ? 'Joining your parts into one clip — only those parts are downloaded' : 'Clipping your parts — only those parts are downloaded');
      nav(`/app/p/${p.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };

  const disabledReason = live ? 'Clip after the stream ends' : tooLong ? `Longer than ${MAX_MINUTES / 60} h — too long to clip` : null;

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer clay" role="dialog" aria-modal="true" aria-label={`Preview: ${peek?.title ?? item.title}`}>
        <header className="row" style={{ justifyContent: 'space-between', gap: 10 }}>
          <span className={`badge ${item.source === 'youtube' ? 'tint-bubble' : 'tint-lilac'}`}>
            {item.source === 'youtube' ? 'YouTube' : 'Twitch'} · {item.kind === 'vod' ? 'past stream' : item.kind}
          </span>
          <div className="row" style={{ gap: 6 }}>
            {items.length > 1 && (
              <>
                <button className="btn btn-icon btn-sm" onClick={() => onIndex(index - 1)} disabled={!hasPrev} aria-label="Previous video (←)" title="Previous (←)">
                  <ChevronLeft size={18} />
                </button>
                <span className="faint" style={{ fontSize: 13, fontWeight: 800, minWidth: 48, textAlign: 'center' }}>
                  {index + 1} / {items.length}
                </span>
                <button className="btn btn-icon btn-sm" onClick={() => onIndex(index + 1)} disabled={!hasNext} aria-label="Next video (→)" title="Next (→)">
                  <ChevronRight size={18} />
                </button>
              </>
            )}
            <button className="btn btn-icon btn-sm" onClick={onClose} aria-label="Close preview (Esc)" title="Close (Esc)">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className={`embed ${vertical ? 'vertical' : ''}`}>
          <iframe ref={frame} key={src} src={src} onLoad={() => setTimeout(listen, 400)} title={item.title} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
        </div>

        <div>
          <h2 style={{ fontSize: 21 }}>{peek?.title ?? item.title}</h2>
          <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
            {(peek?.channel || item.channel) &&
              (channelUrl && onChannel ? (
                <button type="button" className="badge badge-btn" onClick={() => onChannel(channelUrl)} title="See more from this channel">
                  <User size={13} /> {peek?.channel || item.channel} <ChevronRight size={13} />
                </button>
              ) : (
                <span className="badge">{peek?.channel || item.channel}</span>
              ))}
            {live && (
              <span className="badge tint-bubble">
                <Radio size={13} /> Live now
              </span>
            )}
            {dur ? (
              <span className="badge">
                <Clock size={13} /> {fmtTime(dur)}
              </span>
            ) : null}
            {(peek?.views ?? item.views) != null && (
              <span className="badge">
                <Eye size={13} /> {fmtCount(peek?.views ?? item.views, 'views')}
              </span>
            )}
            {peek?.likes != null && (
              <span className="badge">
                <ThumbsUp size={13} /> {fmtCount(peek.likes)}
              </span>
            )}
            {peek?.uploadDate && (
              <span className="badge">
                <Calendar size={13} /> {fmtDate(peek.uploadDate)}
              </span>
            )}
          </div>
        </div>

        <section className="well peek-heat">
          <div className="row" style={{ gap: 8, marginBottom: 4 }}>
            <Flame size={18} color="var(--tangerine-d)" />
            <b style={{ fontFamily: 'var(--font-display)', fontSize: 17 }}>Where viewers rewatch</b>
          </div>
          {!peek && !err && (
            <>
              <p className="faint" style={{ fontSize: 13, marginBottom: 8 }}>
                Reading the replay graph…
              </p>
              <div className="skeleton" style={{ height: 120 }} aria-label="Loading replay data" />
            </>
          )}
          {err && (
            <p className="faint" style={{ fontSize: 14 }}>
              Couldn’t load details ({err}). You can still clip it.
            </p>
          )}
          {peek && peek.curve && peek.duration ? (
            <>
              <p className="faint" style={{ fontSize: 13, marginBottom: 6 }}>
                Peaks are moments viewers replayed. <b>Click</b> the graph to jump there · <b>drag</b> to pick the parts you want clipped.
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
              <div className="stack" style={{ gap: 6, marginTop: 10 }}>
                {peek.hotspots.map((h, i) => (
                  <div key={i} className="row" style={{ gap: 6 }}>
                  <button type="button" className="hot-row" onClick={() => seek(h.start)} title="Play from here">
                    <span className="rank-badge tint-butter" style={{ position: 'static' }}>
                      #{i + 1}
                    </span>
                    <span className="grow">
                      {fmtTime(h.start)} – {fmtTime(h.end)}
                    </span>
                    <span className="heat-bar" aria-hidden>
                      <span style={{ width: `${Math.round(h.value * 100)}%` }} />
                    </span>
                    <b style={{ width: 42, textAlign: 'right' }}>{Math.round(h.value * 100)}%</b>
                  </button>
                  {!live && (
                    <button
                      type="button"
                      className="btn btn-icon btn-sm"
                      title="Pick this part to clip"
                      aria-label={`Pick ${fmtTime(h.start)} to ${fmtTime(h.end)}`}
                      disabled={picks.some((r) => Math.abs(r.start - h.start) < 1 && Math.abs(r.end - h.end) < 1)}
                      onClick={() => setPicks((p) => [...p, { start: h.start, end: Math.min(h.end, h.start + 180) }])}
                    >
                      <Plus size={16} />
                    </button>
                  )}
                  </div>
                ))}
              </div>
            </>
          ) : peek ? (
            <>
              <p className="muted" style={{ fontSize: 14 }}>
                {peek.isYouTube
                  ? 'No “Most replayed” graph for this one — YouTube only shows it on popular videos a few days old. PeakClip will find the peaks with Gemini + audio energy instead.'
                  : 'Twitch has no replay graph. PeakClip will find the peaks with Gemini + audio energy.'}
              </p>
              {peek.duration && !live ? (
                <>
                  <p className="faint" style={{ fontSize: 13, margin: '10px 0 2px' }}>
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
            <div className="row" style={{ gap: 8, marginBottom: 8 }}>
              <ListVideo size={18} />
              <b style={{ fontFamily: 'var(--font-display)' }}>Chapters</b>
            </div>
            <div className="chapters">
              {peek.chapters.slice(0, 12).map((c, i) => (
                <div key={i} className="row" style={{ gap: 6 }}>
                  <button type="button" className="hot-row" onClick={() => seek(c.start_time)} title="Play from here">
                    <span className="tt">{fmtTime(c.start_time)}</span>
                    <span className="grow">{c.title}</span>
                  </button>
                  {!live && c.end_time > c.start_time && (
                    <button
                      type="button"
                      className="btn btn-icon btn-sm"
                      title={c.end_time - c.start_time > 180 ? 'Pick the first 3 minutes of this chapter' : 'Pick this chapter to clip'}
                      aria-label={`Pick chapter ${c.title}`}
                      disabled={picks.some((r) => Math.abs(r.start - c.start_time) < 1)}
                      onClick={() => setPicks((p) => [...p, { start: c.start_time, end: Math.min(c.end_time, c.start_time + 180) }])}
                    >
                      <Plus size={16} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}


        <section className="drawer-cta clay-sm">
          <PickBar picks={picks} onChange={setPicks}>
            <button className="btn btn-primary btn-sm" disabled={busy || Boolean(disabledReason)} onClick={() => clipPicked(false)}>
              {busy ? <span className="spinner" /> : <Scissors size={16} />} {picks.length > 1 ? `Clip these ${picks.length} parts` : 'Clip this part'}
            </button>
            {picks.length > 1 && (
              <button className="btn btn-sm" disabled={busy || Boolean(disabledReason)} onClick={() => clipPicked(true)} title="Stitch the parts, in time order, into one clip">
                <Combine size={16} /> Join into 1 clip
              </button>
            )}
          </PickBar>

          <div className="row wrap" style={{ justifyContent: 'space-between', gap: 10 }}>
            <span className="label" style={{ marginBottom: 0 }}>
              Clip it for
            </span>
            <Seg label="Platform" value={opts.platform} onChange={(v: Platform) => setOpts((o) => ({ ...o, platform: v }))} options={PLATFORM_OPTIONS} />
          </div>
          <label className="row" style={{ gap: 10, fontWeight: 700, fontSize: 14 }}>
            <span style={{ minWidth: 64 }}>Clips · {opts.clipCount}</span>
            <input type="range" min={1} max={20} value={opts.clipCount} onChange={(e) => setOpts((o) => ({ ...o, clipCount: Number(e.target.value) }))} aria-label="Number of clips" style={{ flex: 1 }} />
          </label>
          <p className="faint cta-note">
            {disabledReason ? (
              disabledReason
            ) : (
              <>
                You’ll get {opts.clipCount} vertical clip{opts.clipCount > 1 ? 's' : ''} with captions, a hook and a score
                {dur ? <> · ready in {estimate(dur)}</> : null}
              </>
            )}
          </p>
          <div className="row" style={{ gap: 10 }}>
            <a className="btn btn-sm" href={peek?.url ?? item.url} target="_blank" rel="noreferrer" title="Open on the original site">
              <ExternalLink size={16} /> Open
            </a>
            <button className="btn btn-primary grow" onClick={clip} disabled={busy || Boolean(disabledReason) || item.kind === 'channel'}>
              {busy ? <span className="spinner" /> : <Scissors size={18} />}
              {busy ? 'Starting…' : disabledReason ? 'Can’t clip yet' : 'Clip this video'}
            </button>
          </div>
        </section>
      </aside>
    </div>
  );
}

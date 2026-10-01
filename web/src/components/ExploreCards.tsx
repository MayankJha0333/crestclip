import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { ChevronLeft, ChevronRight, Clock, Eye, Flame, Radio, Scissors, Twitch, Users, Youtube, Zap } from 'lucide-react';
import { api, fmtCount, fmtTime, timeAgo, type ExploreItem } from '../lib/api';

/** YouTube shows a "Most replayed" graph on popular, not-brand-new videos (~100K+ views is a safe rule of thumb). */
export const replayLikely = (it: ExploreItem) =>
  it.source === 'youtube' && (it.kind === 'video' || it.kind === 'short') && (it.views ?? 0) >= 100_000 && (it.duration ?? 0) >= 60;

const clickable = (fn: () => void) => ({
  role: 'button' as const,
  tabIndex: 0,
  onClick: fn,
  onKeyDown: (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  },
});
/** Start loading the preview (replay graph) while the pointer rests on a card, so the drawer opens ready. */
const warmed = new Set<string>();
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
const warmPeek = (it: ExploreItem) => ({
  onMouseEnter: () => {
    if (warmed.has(it.url) || it.kind === 'channel' || it.kind === 'live' || it.isLive) return;
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      warmed.add(it.url);
      api.peek(it.url).catch(() => warmed.delete(it.url));
    }, 180);
  },
  onMouseLeave: () => {
    if (hoverTimer) clearTimeout(hoverTimer);
  },
});

const stop = (fn: () => void) => (e: MouseEvent) => {
  e.stopPropagation();
  fn();
};

export function VideoCard({
  item,
  index = 0,
  onOpen,
  onChannel,
  onQuickClip,
  busy,
  compact,
}: {
  item: ExploreItem;
  index?: number;
  onOpen: () => void;
  onChannel?: () => void;
  onQuickClip?: () => void;
  busy?: boolean;
  compact?: boolean;
}) {
  const vertical = item.kind === 'short' || item.kind === 'clip';
  const [broken, setBroken] = useState(false);
  const canClip = item.kind !== 'live' && !item.isLive;
  const age = item.uploaded ? Date.parse(item.uploaded) : NaN;
  return (
    <article
      className={`xcard pop-in ${vertical ? 'is-vertical' : ''} ${compact ? 'is-compact' : ''}`}
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
      aria-label={`Peek: ${item.title}`}
      {...clickable(onOpen)}
      {...warmPeek(item)}
    >
      <div className={`thumb ${vertical ? 'thumb-9x16' : 'thumb-16x9'}`}>
        {item.thumbnail && !broken ? (
          <img
            src={item.thumbnail}
            alt=""
            loading="lazy"
            onError={() => setBroken(true)}
            onLoad={(e) => {
              // YouTube answers a missing vertical thumbnail (oar2.jpg) with a 120px grey placeholder — use the normal one instead.
              const img = e.currentTarget;
              if (img.naturalWidth <= 120 && img.src.includes('/oar2.jpg')) img.src = img.src.replace('/oar2.jpg', '/hqdefault.jpg');
            }}
          />
        ) : (
          <span className="thumb-fallback">{item.source === 'twitch' ? <Twitch size={28} /> : <Youtube size={28} />}</span>
        )}
        <div className="thumb-top">
          {item.isLive || item.kind === 'live' ? (
            <span className="badge tint-bubble">
              <Radio size={12} /> LIVE
            </span>
          ) : replayLikely(item) ? (
            <span className="badge replay-badge" title="Popular enough that YouTube likely shows a “Most replayed” graph — CrestClip clips its peaks">
              <Flame size={12} /> Replay data
            </span>
          ) : null}
        </div>
        {item.duration ? (
          <span className="badge thumb-badge">
            <Clock size={12} /> {fmtTime(item.duration)}
          </span>
        ) : null}
        <div className="thumb-hover">
          <span className="hover-cta">
            <Eye size={16} /> Peek
          </span>
          {onQuickClip && canClip && (
            <button type="button" className="hover-cta hover-clip" onClick={stop(onQuickClip)} disabled={busy} title="Start clipping now with your saved settings">
              {busy ? <span className="spinner" /> : <Zap size={16} />} {busy ? 'Starting…' : 'Quick clip'}
            </button>
          )}
        </div>
        {busy && (
          <div className="thumb-busy">
            <span className="spinner" /> Starting…
          </div>
        )}
      </div>

      <div className="xcard-body">
        <h3 className="clamp2 xcard-title" title={item.title}>
          {item.title}
        </h3>
        <div className="xcard-meta">
          {item.channel &&
            (onChannel && item.channelUrl ? (
              <button type="button" className="linkish meta-channel" onClick={stop(onChannel)} title={`Open ${item.channel}`}>
                {item.channel}
              </button>
            ) : (
              <span className="meta-channel">{item.channel}</span>
            ))}
          <span className="faint meta-stats">
            {item.views != null && (
              <>
                <Eye size={12} /> {fmtCount(item.views)}
              </>
            )}
            {Number.isFinite(age) && <> · {timeAgo(age)}</>}
          </span>
        </div>
      </div>
    </article>
  );
}

export function ChannelCard({ item, onOpen, onLive }: { item: ExploreItem; onOpen: () => void; onLive?: () => void }) {
  const [broken, setBroken] = useState(false);
  return (
    <article className="xcard channel-card pop-in" aria-label={`Open channel ${item.title}`} {...clickable(onOpen)}>
      <span className="avatar clay-sm" style={{ width: 84, height: 84 }}>
        {item.thumbnail && !broken ? (
          <img src={item.thumbnail} alt="" loading="lazy" onError={() => setBroken(true)} />
        ) : item.source === 'twitch' ? (
          <Twitch size={30} />
        ) : (
          <Users size={30} />
        )}
      </span>
      <h3 style={{ fontSize: 18, marginTop: 12 }}>{item.title}</h3>
      <p className="faint" style={{ fontSize: 13 }}>
        {item.subscribers != null ? `${fmtCount(item.subscribers)} subscribers` : item.game ? item.game : item.source === 'twitch' ? 'Twitch channel' : 'YouTube channel'}
      </p>
      {item.description && (
        <p className="muted clamp2" style={{ fontSize: 13, marginTop: 6 }}>
          {item.description}
        </p>
      )}
      <div className="row" style={{ gap: 8, marginTop: 14, justifyContent: 'center' }}>
        <span className="btn btn-sm btn-ink">Browse videos</span>
        {item.isLive && onLive && (
          <button type="button" className="btn btn-sm" onClick={stop(onLive)}>
            <Radio size={14} /> Watch live
          </button>
        )}
      </div>
    </article>
  );
}

export function SkeletonCard({ vertical }: { vertical?: boolean }) {
  return (
    <div className={`xcard skeleton-card ${vertical ? 'is-vertical' : ''}`} aria-hidden>
      <div className={`skeleton ${vertical ? 'thumb-9x16' : 'thumb-16x9'}`} />
      <div className="skeleton" style={{ height: 15, marginTop: 12, width: '88%' }} />
      <div className="skeleton" style={{ height: 12, marginTop: 8, width: '55%' }} />
    </div>
  );
}

/** Horizontal, swipeable row with arrow buttons (YouTube-home style). */
export function Rail({ children, vertical }: { children: React.ReactNode; vertical?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  };
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [children]);
  const scroll = (dir: number) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: 'smooth' });
  return (
    <div className="rail-wrap">
      {edges.left && (
        <button type="button" className="rail-btn left btn btn-icon" onClick={() => scroll(-1)} aria-label="Scroll left">
          <ChevronLeft size={18} />
        </button>
      )}
      <div className={`rail ${vertical ? 'rail-vertical' : ''}`} ref={ref} onScroll={measure}>
        {children}
      </div>
      {edges.right && (
        <button type="button" className="rail-btn right btn btn-icon" onClick={() => scroll(1)} aria-label="Scroll right">
          <ChevronRight size={18} />
        </button>
      )}
    </div>
  );
}

export function ClipBadgeLegend() {
  return (
    <span className="legend">
      <span className="badge replay-badge">
        <Flame size={12} /> Replay data
      </span>
      = YouTube likely shows where viewers rewatch → better clips
      <Scissors size={13} style={{ marginLeft: 4 }} />
    </span>
  );
}

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Clock, Eye, Flame, Radio, Twitch, Users, Youtube, Zap } from 'lucide-react';
import { api, type ExploreItem } from '../../lib/api';
import { cn } from '../../lib/cn';
import { fmtCount, fmtTime, timeAgo } from '../../lib/format';
import { Badge, Button, buttonClass, Skeleton, Spinner } from '../../components/ui';

/** YouTube shows a "Most replayed" graph on popular, not-brand-new videos (~100K+ views is a safe rule of thumb). */
const replayLikely = (it: ExploreItem) => it.source === 'youtube' && (it.kind === 'video' || it.kind === 'short') && (it.views ?? 0) >= 100_000 && (it.duration ?? 0) >= 60;

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
  onMouseLeave: () => hoverTimer && clearTimeout(hoverTimer),
});

const stop = (fn: () => void) => (e: MouseEvent) => {
  e.stopPropagation();
  fn();
};

const CARD =
  'group relative flex h-full min-w-0 cursor-pointer flex-col rounded-[24px] bg-surface p-2.5 pb-3.5 shadow-clay-sm outline-none transition-all duration-300 ease-(--ease-squish) hover:-translate-y-1 hover:shadow-clay focus-visible:shadow-[0_0_0_3px_var(--tangerine),var(--shadow-clay)]';


/** When a saved thumbnail link has died (old cached card, removed size), fall back to YouTube's standard one for the video. */
function fallbackThumb(e: React.SyntheticEvent<HTMLImageElement>, item: { source: string; kind: string; id: string }, onGiveUp: () => void) {
  const img = e.currentTarget;
  const std = item.source === 'youtube' && item.kind !== 'channel' && /^[\w-]{11}$/.test(item.id) ? `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg` : null;
  if (std && img.src !== std) img.src = std;
  else onGiveUp();
}

export function VideoCard({
  item,
  index = 0,
  onOpen,
  onChannel,
  onQuickClip,
  busy,
}: {
  item: ExploreItem;
  index?: number;
  onOpen: () => void;
  onChannel?: () => void;
  onQuickClip?: () => void;
  busy?: boolean;
}) {
  const vertical = item.kind === 'short' || item.kind === 'clip';
  const [broken, setBroken] = useState(false);
  const canClip = item.kind !== 'live' && !item.isLive;
  // Quick clip spends credits, so it takes a second click (a stray click on the card shouldn't start a job)
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);
  const quickClip = () => {
    if (!armed) return setArmed(true);
    setArmed(false);
    onQuickClip?.();
  };
  const age = item.uploaded ? Date.parse(item.uploaded) : NaN;
  return (
    <article className={cn(CARD, 'animate-pop-in')} style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }} aria-label={`Preview: ${item.title}`} {...clickable(onOpen)} {...warmPeek(item)}>
      <div className={cn('relative w-full overflow-hidden rounded-[18px] bg-sunken shadow-well', vertical ? 'aspect-[9/16]' : 'aspect-video')}>
        {item.thumbnail && !broken ? (
          <img
            src={item.thumbnail}
            alt=""
            loading="lazy"
            className="block size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
            onError={(e) => fallbackThumb(e, item, () => setBroken(true))}
            onLoad={(e) => {
              // YouTube answers a missing vertical thumbnail (oar2.jpg) with a 120px grey placeholder — use the normal one instead.
              const img = e.currentTarget;
              if (img.naturalWidth <= 120 && img.src.includes('/oar2.jpg')) img.src = img.src.replace('/oar2.jpg', '/hqdefault.jpg');
            }}
          />
        ) : (
          <span className="absolute inset-0 grid place-items-center text-ink-3">{item.source === 'twitch' ? <Twitch size={28} /> : <Youtube size={28} />}</span>
        )}
        <div className="absolute top-2.5 left-2.5 flex gap-1.5">
          {item.isLive || item.kind === 'live' ? (
            <Badge tone="bubble">
              <Radio size={12} /> LIVE
            </Badge>
          ) : replayLikely(item) ? (
            <Badge tone="warn" title="Popular enough that YouTube likely shows a “Most replayed” graph — CrestClip clips its peaks">
              <Flame size={12} /> Replay data
            </Badge>
          ) : null}
        </div>
        {item.duration ? (
          <Badge className="absolute right-2.5 bottom-2.5">
            <Clock size={12} /> {fmtTime(item.duration)}
          </Badge>
        ) : null}
        <div
          className={cn(
            'absolute inset-0 flex flex-wrap items-center justify-center gap-2 bg-ink/25 p-2.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:hidden',
            armed && 'opacity-100',
          )}
        >
          <span className={buttonClass('secondary', vertical ? 'sm' : 'md')}>
            <Eye size={16} /> Preview
          </span>
          {onQuickClip && canClip && (
            <button
              type="button"
              className={buttonClass('primary', vertical ? 'sm' : 'md')}
              onClick={stop(quickClip)}
              disabled={busy}
              title="Start clipping now with your saved settings (uses credits)"
            >
              <Zap size={16} /> {armed ? 'Click again to clip' : 'Quick clip'}
            </button>
          )}
        </div>
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-ink/55 font-extrabold text-white">
            <Spinner /> Starting…
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 px-1 pt-3">
        <h3 className={cn('line-clamp-2 font-body leading-snug font-extrabold', vertical ? 'text-sm' : 'text-[15px]')} title={item.title}>
          {item.title}
        </h3>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
          {item.channel &&
            (onChannel && item.channelUrl ? (
              <button type="button" className="max-w-full truncate font-extrabold text-ink-2 hover:text-accent hover:underline" onClick={stop(onChannel)} title={`Open ${item.channel}`}>
                {item.channel}
              </button>
            ) : (
              <span className="max-w-full truncate font-extrabold text-ink-2">{item.channel}</span>
            ))}
          <span className="inline-flex items-center gap-1 text-ink-3">
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
    <article className={cn(CARD, 'animate-pop-in items-center px-4 py-5 text-center')} aria-label={`Open channel ${item.title}`} {...clickable(onOpen)}>
      <span className="grid size-20 place-items-center overflow-hidden rounded-full bg-row text-ink-2 shadow-flat">
        {item.thumbnail && !broken ? (
          <img src={item.thumbnail} alt="" loading="lazy" className="size-full object-cover" onError={(e) => fallbackThumb(e, item, () => setBroken(true))} />
        ) : item.source === 'twitch' ? (
          <Twitch size={30} />
        ) : (
          <Users size={30} />
        )}
      </span>
      <h3 className="mt-3 text-lg">{item.title}</h3>
      <p className="text-[13px] text-ink-3">
        {item.subscribers != null ? `${fmtCount(item.subscribers)} subscribers` : item.game ? item.game : item.source === 'twitch' ? 'Twitch channel' : 'YouTube channel'}
      </p>
      {item.description && <p className="mt-1.5 line-clamp-2 text-[13px] text-ink-2">{item.description}</p>}
      <div className="mt-auto flex justify-center gap-2 pt-3.5">
        <span className={buttonClass('ink', 'sm')}>Browse videos</span>
        {item.isLive && onLive && (
          <Button size="sm" onClick={stop(onLive)}>
            <Radio size={14} /> Watch live
          </Button>
        )}
      </div>
    </article>
  );
}

export function SkeletonCard({ vertical }: { vertical?: boolean }) {
  return (
    <div className="flex flex-col rounded-[24px] bg-surface p-2.5 pb-3.5 shadow-clay-sm" aria-hidden>
      <Skeleton className={vertical ? 'aspect-[9/16]' : 'aspect-video'} />
      <Skeleton className="mt-3 h-4 w-[88%]" />
      <Skeleton className="mt-2 h-3 w-[55%]" />
    </div>
  );
}

/** Horizontal, swipeable row with arrow buttons (YouTube-home style). */
export function Rail({ children, vertical }: { children: ReactNode; vertical?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = () => {
    const el = ref.current;
    if (el) setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  };
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [children]);
  const scroll = (dir: number) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: 'smooth' });
  return (
    <div className="group/rail relative">
      {edges.left && (
        <Button
          size="icon"
          className="absolute top-[38%] -left-3 z-[3] hidden opacity-0 group-hover/rail:opacity-100 focus-visible:opacity-100 sm:inline-flex"
          onClick={() => scroll(-1)}
          aria-label="Scroll left"
        >
          <ChevronLeft size={18} />
        </Button>
      )}
      <div
        ref={ref}
        onScroll={measure}
        className={cn(
          'grid snap-x snap-mandatory auto-cols-[78%] grid-flow-col gap-4 overflow-x-auto px-1.5 pt-2 pb-4 scrollbar-none [&>*]:min-w-0 [&>*]:snap-start',
          vertical ? 'auto-cols-[46%] sm:auto-cols-[176px]' : 'sm:auto-cols-[272px]',
        )}
      >
        {children}
      </div>
      {edges.right && (
        <Button
          size="icon"
          className="absolute top-[38%] -right-3 z-[3] hidden opacity-0 group-hover/rail:opacity-100 focus-visible:opacity-100 sm:inline-flex"
          onClick={() => scroll(1)}
          aria-label="Scroll right"
        >
          <ChevronRight size={18} />
        </Button>
      )}
    </div>
  );
}

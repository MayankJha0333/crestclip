import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ExternalLink, Film } from 'lucide-react';

export interface PlayerHandle {
  /** jump to `t` seconds and play; if `until` is set, pause there (preview one moment) */
  playFrom: (t: number, until?: number) => void;
}

export function youtubeIdOf(url: string | null | undefined): string | null {
  const m = (url ?? '').match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}
const twitchVodOf = (url: string | null | undefined) => (url ?? '').match(/twitch\.tv\/videos\/(\d+)/)?.[1] ?? null;

/**
 * The original video inside the project page.
 *  • YouTube links → YouTube's player (no download needed), controlled with its iframe API
 *  • uploads / fully downloaded links → our own copy, in a <video>
 *  • Twitch VODs → Twitch's player
 * Reports the current time so the graph can show a playhead.
 */
export const SourcePlayer = forwardRef<
  PlayerHandle,
  { sourceUrl: string | null; fileUrl: string | null; poster?: string | null; vertical?: boolean; title: string; onTime?: (t: number) => void }
>(function SourcePlayer({ sourceUrl, fileUrl, poster, vertical, title, onTime }, ref) {
  const yt = youtubeIdOf(sourceUrl);
  const vod = !yt && !fileUrl ? twitchVodOf(sourceUrl) : null;
  const frame = useRef<HTMLIFrameElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stopAt = useRef<number | null>(null);
  const [twitchStart, setTwitchStart] = useState(0);

  const post = useCallback((msg: object) => frame.current?.contentWindow?.postMessage(JSON.stringify({ ...msg, id: 1, channel: 'widget' }), '*'), []);
  const ytCmd = useCallback((func: string, args: unknown[] = []) => post({ event: 'command', func, args }), [post]);

  // YouTube → time updates
  useEffect(() => {
    if (!yt) return;
    const onMsg = (e: MessageEvent) => {
      try {
        if (!/youtube(-nocookie)?\.com$/.test(new URL(e.origin).hostname)) return;
        const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        const t = d?.info?.currentTime;
        if (typeof t !== 'number') return;
        onTime?.(t);
        if (stopAt.current != null && t >= stopAt.current) {
          stopAt.current = null;
          ytCmd('pauseVideo');
        }
      } catch {
        /* not ours */
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [yt, onTime, ytCmd]);

  useImperativeHandle(
    ref,
    () => ({
      playFrom(t, until) {
        const at = Math.max(0, t);
        stopAt.current = until ?? null;
        if (yt) {
          post({ event: 'listening' });
          ytCmd('seekTo', [at, true]);
          ytCmd('playVideo');
          onTime?.(at);
        } else if (video.current) {
          video.current.currentTime = at;
          video.current.play().catch(() => {});
        } else if (vod) setTwitchStart(Math.floor(at));
      },
    }),
    [yt, vod, post, ytCmd, onTime],
  );

  const frameClass = `embed source-embed ${vertical ? 'vertical' : ''}`;
  if (yt)
    return (
      <div className={frameClass}>
        <iframe
          ref={frame}
          src={`https://www.youtube-nocookie.com/embed/${yt}?rel=0&modestbranding=1&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`}
          title={title}
          onLoad={() => setTimeout(() => post({ event: 'listening' }), 400)}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          allowFullScreen
        />
      </div>
    );
  if (fileUrl)
    return (
      <div className={frameClass}>
        <video
          ref={video}
          src={fileUrl}
          poster={poster ?? undefined}
          controls
          playsInline
          preload="metadata"
          onTimeUpdate={(e) => {
            const t = e.currentTarget.currentTime;
            onTime?.(t);
            if (stopAt.current != null && t >= stopAt.current) {
              stopAt.current = null;
              e.currentTarget.pause();
            }
          }}
        />
      </div>
    );
  if (vod) {
    const h = Math.floor(twitchStart / 3600);
    const m = Math.floor((twitchStart % 3600) / 60);
    const s = twitchStart % 60;
    const host = window.location.hostname || 'localhost';
    return (
      <div className={frameClass}>
        <iframe
          key={twitchStart}
          src={`https://player.twitch.tv/?video=v${vod}&parent=${host}&autoplay=${twitchStart ? 'true' : 'false'}&time=${h}h${m}m${s}s`}
          title={title}
          allowFullScreen
        />
      </div>
    );
  }
  return (
    <div className={`${frameClass} source-empty`}>
      {poster ? <img src={poster} alt="" /> : null}
      <div className="source-empty-msg">
        <Film size={26} />
        <b>Preview not available here</b>
        <span>PeakClip only downloaded the parts it needed from this link.</span>
        {sourceUrl && (
          <a className="btn btn-sm" href={sourceUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={14} /> Watch the original
          </a>
        )}
      </div>
    </div>
  );
});

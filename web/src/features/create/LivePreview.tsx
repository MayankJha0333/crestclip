import { useEffect, useState } from 'react';
import { Heart, Layers, MessageCircle, Send } from 'lucide-react';
import type { ProjectOptions, Watermark } from '../../lib/api';
import { cn } from '../../lib/cn';
import { CaptionSample } from '../clip-settings/CaptionPicker';
import { youtubeIdOf } from '../media/SourcePlayer';
import { useWatermark } from '../watermark/useWatermark';
import { WatermarkMark } from '../watermark/WatermarkMark';

/** A local file's first frames, for the preview background. */
function useFileUrl(file: File | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return setUrl(null);
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url;
}

/**
 * A phone showing what a finished clip will look like: your video's own picture (YouTube thumbnail
 * or the uploaded file), the hook headline, the caption style you picked and your watermark. Updates as you change things.
 * `watermark` overrides the saved one (Settings shows unsaved slider moves).
 */
export function LivePreview({ opts, link, file, videoCount, watermark }: { opts: ProjectOptions; link: string | null; file: File | null; videoCount: number; watermark?: Watermark | null }) {
  const saved = useWatermark();
  const ytId = youtubeIdOf(link);
  const fileUrl = useFileUrl(file);
  const [thumbOk, setThumbOk] = useState(true);
  useEffect(() => setThumbOk(true), [ytId]);
  const hasPicture = Boolean((ytId && thumbOk) || fileUrl);

  return (
    <div className="relative w-full pt-1 pb-2" aria-label="Preview of a finished clip">
      {/* more than one video: a little stack of phones behind */}
      {videoCount > 1 && (
        <>
          <span aria-hidden className="absolute inset-x-0 top-5 bottom-6 -rotate-6 rounded-[28px] bg-surface shadow-clay-sm" />
          {videoCount > 2 && <span aria-hidden className="absolute inset-x-0 top-5 bottom-6 rotate-6 rounded-[28px] bg-surface shadow-clay-sm" />}
        </>
      )}
      <div className="relative rounded-[28px] bg-surface p-1.5 shadow-clay">
        <div className="relative aspect-[9/16] overflow-hidden rounded-[23px] bg-[radial-gradient(circle_at_70%_18%,#ffd1b8_0_16%,transparent_17%),linear-gradient(170deg,#ffb48f_0%,#ff8fb8_48%,#9c86ff_100%)]">
          {ytId && thumbOk && (
            <img key={ytId} src={`https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`} alt="" onError={() => setThumbOk(false)} className="absolute inset-0 size-full animate-pop-in object-cover" />
          )}
          {fileUrl && !ytId && (
            <video
              src={`${fileUrl}#t=1`}
              muted
              playsInline
              preload="metadata"
              className="absolute inset-0 size-full animate-pop-in object-cover"
              onLoadedMetadata={(e) => {
                e.currentTarget.currentTime = Math.min(1, e.currentTarget.duration / 3 || 0);
              }}
            />
          )}
          {!hasPicture && (
            // a friendly clay host until there's a real video
            <div aria-hidden className="absolute bottom-0 left-1/2 h-[64%] w-[78%] -translate-x-1/2">
              <span className="absolute top-[10%] left-1/2 h-[34%] w-[46%] -translate-x-1/2 rounded-[50%_50%_46%_46%] bg-[#ffcfa8] shadow-[inset_-6px_-8px_12px_#e7a57a,inset_5px_5px_9px_rgba(255,255,255,.5)]" />
              <span className="absolute bottom-0 left-1/2 h-[46%] w-full -translate-x-1/2 rounded-t-[999px] bg-mint shadow-[inset_-8px_-8px_14px_var(--mint-d),inset_6px_6px_12px_rgba(255,255,255,.45)]" />
            </div>
          )}
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,.35)_0%,transparent_22%,transparent_60%,rgba(0,0,0,.55)_100%)]" />

          <WatermarkMark watermark={watermark === undefined ? saved : watermark} />
          {videoCount > 1 && (
            <span className="absolute top-2.5 right-2.5 inline-flex items-center gap-1 rounded-full bg-black/35 px-2 py-0.5 text-[9px] font-extrabold text-white backdrop-blur-sm">
              <Layers size={11} /> {videoCount}
            </span>
          )}
          {opts.showHook && (
            <span className="absolute top-9 left-1/2 max-w-[86%] -translate-x-1/2 -rotate-2 rounded-lg bg-white px-2.5 py-1 text-center font-[Poppins] text-[9.5px] leading-tight font-extrabold text-[#1e1b2b] shadow-lift">
              Nobody tells you this 🤫
            </span>
          )}
          {opts.captionStyle !== 'none' && (
            <div key={opts.captionStyle} className="absolute inset-x-0 top-[58%] grid animate-pop-in place-items-center px-3">
              <CaptionSample style={opts.captionStyle} scale={0.62} />
            </div>
          )}
          <div className="absolute right-2 bottom-10 flex flex-col items-center gap-2.5 text-white" aria-hidden>
            <Heart size={13} fill="currentColor" />
            <MessageCircle size={13} fill="currentColor" />
            <Send size={13} />
          </div>
          <div className="absolute inset-x-3 bottom-3" aria-hidden>
            <span className="block text-[9px] font-extrabold text-white">@yourchannel</span>
            <span className="mt-1.5 block h-[3px] overflow-hidden rounded-full bg-white/30">
              <span className={cn('block h-full w-2/5 rounded-full', 'bg-white')} />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

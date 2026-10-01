import { TriangleAlert } from 'lucide-react';
import type { Clip } from '../../lib/api';
import { cn } from '../../lib/cn';
import { Spinner } from '../../components/ui';

/** A rendered clip in a phone-shaped frame (or its render state). */
export function ClipVideo({ clip, rank, className, controls = true }: { clip: Pick<Clip, 'status' | 'videoUrl' | 'thumbUrl'>; rank?: number; className?: string; controls?: boolean }) {
  const working = clip.status === 'pending' || clip.status === 'rendering';
  return (
    <div className={cn('relative aspect-[9/16] w-full overflow-hidden rounded-[22px] bg-media shadow-lift', className)}>
      {clip.videoUrl && !working ? (
        <video key={clip.videoUrl} src={clip.videoUrl} poster={clip.thumbUrl ?? undefined} controls={controls} preload="none" playsInline className="block size-full bg-media object-contain" />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[radial-gradient(circle_at_40%_30%,#4a3c63,#211a30)] p-3 text-center text-sm font-extrabold text-[#e9dcff]">
          {clip.status === 'failed' ? (
            <>
              <TriangleAlert size={28} /> Render failed
            </>
          ) : (
            <>
              <Spinner className="size-7 border-4 border-white/15 border-t-butter" />
              {clip.status === 'rendering' ? 'Reframing & rendering…' : 'In the queue…'}
            </>
          )}
        </div>
      )}
      {rank != null && <span className="absolute top-3 left-3 z-[2] rounded-full px-2.5 py-0.5 font-display text-sm font-bold text-[#3d2a00] clay-butter">#{rank}</span>}
    </div>
  );
}

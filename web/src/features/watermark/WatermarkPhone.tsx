import { Heart, MessageCircle, Send } from 'lucide-react';
import type { Watermark, WatermarkPosition } from '../../lib/api';
import { cn } from '../../lib/cn';
import { CaptionSample } from '../clip-settings/CaptionPicker';
import { WatermarkMark } from './WatermarkMark';

export const POSITIONS: { value: WatermarkPosition; label: string }[] = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-right', label: 'Top right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-right', label: 'Bottom right' },
];

const SCENES = {
  light: 'bg-[radial-gradient(circle_at_72%_16%,#ffd1b8_0_15%,transparent_16%),linear-gradient(170deg,#ffb48f_0%,#ff8fb8_48%,#9c86ff_100%)]',
  dark: 'bg-[radial-gradient(circle_at_72%_16%,#3b3357_0_15%,transparent_16%),linear-gradient(170deg,#2a2340_0%,#1b1629_55%,#0f0c17_100%)]',
};

/**
 * Where Shorts, Reels and TikTok draw their own things over a clip (share of the 9:16 frame): the top bar, the
 * like/comment buttons down the right, and the name + caption at the bottom. A logo there can end up hidden.
 */
const COVERS = [
  { key: 'top', label: 'App top bar', className: 'inset-x-0 top-0 h-[7%]' },
  { key: 'right', label: 'Like · comment · share', className: 'right-0 top-[44%] h-[40%] w-[16%]' },
  { key: 'bottom', label: 'Your name and caption', className: 'inset-x-0 bottom-0 h-[16%]' },
];

/**
 * A phone showing a finished clip with the logo on it, exactly where the renderer will put it. With `onMove`, the
 * logo can be dragged anywhere (or nudged with the arrow keys). `scene` swaps a bright or a dark video behind it, and
 * `covers` shades the parts the apps draw over.
 */
export function WatermarkPhone({ watermark: w, scene, onMove, covers }: { watermark: Watermark; scene: 'light' | 'dark'; onMove?: (x: number, y: number) => void; covers?: boolean }) {
  return (
    <div className="w-full rounded-[30px] bg-surface p-1.5 shadow-clay">
      <div className={cn('relative aspect-[9/16] overflow-hidden rounded-[25px] transition-colors duration-500', SCENES[scene])}>
        {/* a stand-in speaker */}
        <div aria-hidden className="absolute bottom-0 left-1/2 h-[62%] w-[78%] -translate-x-1/2">
          <span className="absolute top-[10%] left-1/2 h-[34%] w-[46%] -translate-x-1/2 rounded-[50%_50%_46%_46%] bg-[#ffcfa8] shadow-[inset_-6px_-8px_12px_#e7a57a,inset_5px_5px_9px_rgba(255,255,255,.5)]" />
          <span className="absolute bottom-0 left-1/2 h-[46%] w-full -translate-x-1/2 rounded-t-[999px] bg-mint shadow-[inset_-8px_-8px_14px_var(--mint-d),inset_6px_6px_12px_rgba(255,255,255,.45)]" />
        </div>
        <div aria-hidden className="absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,.3)_0%,transparent_22%,transparent_60%,rgba(0,0,0,.55)_100%)]" />
        <div aria-hidden className="absolute inset-x-0 top-[58%] grid place-items-center px-3">
          <CaptionSample style="pop" scale={0.7} />
        </div>
        <div aria-hidden className="absolute right-2.5 bottom-12 flex flex-col items-center gap-3 text-white">
          <Heart size={15} fill="currentColor" />
          <MessageCircle size={15} fill="currentColor" />
          <Send size={15} />
        </div>
        <div aria-hidden className="absolute inset-x-3.5 bottom-3.5">
          <span className="block text-[10px] font-extrabold text-white">@yourchannel</span>
          <span className="mt-1.5 block h-[3px] overflow-hidden rounded-full bg-white/30">
            <span className="block h-full w-2/5 rounded-full bg-white" />
          </span>
        </div>

        {covers &&
          COVERS.map((c) => (
            <div
              key={c.key}
              aria-hidden
              className={cn(
                'absolute grid place-items-center bg-[repeating-linear-gradient(135deg,rgba(255,255,255,.28)_0_5px,rgba(255,255,255,.08)_5px_10px)] ring-1 ring-white/50 ring-inset',
                c.className,
              )}
            >
              <span className={cn('rounded-full bg-black/55 px-1.5 py-px text-center text-[8px] leading-tight font-extrabold text-white', c.key === 'right' && '[writing-mode:vertical-rl]')}>
                {c.label}
              </span>
            </div>
          ))}

        <WatermarkMark watermark={{ ...w, enabled: true }} onMove={onMove} />
      </div>
    </div>
  );
}

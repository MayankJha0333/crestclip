import type { CSSProperties } from 'react';
import type { CaptionStyle, Layout, LengthPref, Motion, Platform } from '../../lib/api';

export const PLATFORMS: { value: Platform; label: string; long: string }[] = [
  { value: 'shorts', label: 'Shorts', long: 'YouTube Shorts' },
  { value: 'tiktok', label: 'TikTok', long: 'TikTok' },
  { value: 'reels', label: 'Reels', long: 'Instagram Reels' },
];
export const platformName = (p: Platform) => PLATFORMS.find((x) => x.value === p)?.long ?? p;

export const LENGTHS: { value: LengthPref; label: string; long: string }[] = [
  { value: 'auto', label: 'Auto', long: 'Best length for the platform' },
  { value: 'short', label: '< 30s', long: 'Under 30 seconds' },
  { value: 'medium', label: '30–60s', long: '30–60 seconds' },
  { value: 'long', label: '60s+', long: 'Over a minute' },
];

export const LAYOUTS: { value: Layout; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'CrestClip picks per clip' },
  { value: 'fill', label: 'Face track', hint: 'Full screen, follows the speaker' },
  { value: 'split', label: 'Split', hint: 'Two speakers stacked' },
  { value: 'fit', label: 'Fit', hint: 'Whole frame on a blurred background (screens, games)' },
];

export const MOTIONS: { value: Motion; label: string; hint: string }[] = [
  { value: 'none', label: 'Off', hint: 'Steady framing, no zooms' },
  { value: 'subtle', label: 'Subtle', hint: 'A gentle punch-in every few seconds and smooth pans between speakers' },
  { value: 'dynamic', label: 'Dynamic', hint: 'Fast punch-in zooms and a zoom-out on the hook, like pro short-form edits' },
];

/** Mini preview of each burned-in caption style, drawn with the same fonts/colours the renderer uses. */
export const CAPTIONS: Record<CaptionStyle, { name: string; style: CSSProperties; active: CSSProperties; words: string[] }> = {
  pop: {
    name: 'Pop',
    words: ['THIS', 'CHANGED', 'EVERYTHING'],
    style: { fontFamily: 'Anton, sans-serif', color: '#fff', textTransform: 'uppercase', WebkitTextStroke: '5px #000', paintOrder: 'stroke fill', fontSize: 22, letterSpacing: '.01em' },
    active: { color: '#FFDD00', display: 'inline-block', transform: 'scale(1.12)', margin: '0 .14em' },
  },
  clay: {
    name: 'Clay',
    words: ['this', 'changed', 'everything'],
    style: { fontFamily: 'Poppins, sans-serif', fontWeight: 800, color: '#2B215A', background: '#fff', padding: '3px 8px', borderRadius: 6, fontSize: 16 },
    active: { color: '#7C5CFF' },
  },
  neon: {
    name: 'Neon',
    words: ['THIS', 'CHANGED', 'EVERYTHING'],
    style: { fontFamily: 'Poppins, sans-serif', fontWeight: 800, color: '#fff', textShadow: '0 0 6px #00E5FF, 0 0 12px #00E5FF', fontSize: 16 },
    active: { color: '#7CFFB2', textShadow: '0 0 8px #7CFFB2, 0 0 14px #7CFFB2' },
  },
  comic: {
    name: 'Comic',
    words: ['THIS', 'CHANGED'],
    style: { fontFamily: 'Bangers, sans-serif', color: '#FFE600', WebkitTextStroke: '5px #000', paintOrder: 'stroke fill', fontSize: 26, letterSpacing: '.03em' },
    active: { color: '#fff', display: 'inline-block', transform: 'scale(1.15) rotate(-3deg)', margin: '0 .16em' },
  },
  minimal: {
    name: 'Minimal',
    words: ['this changed', 'everything'],
    style: { fontFamily: 'Poppins, sans-serif', fontWeight: 700, color: '#fff', textShadow: '0 2px 6px rgba(0,0,0,.6)', fontSize: 14 },
    active: {},
  },
  none: { name: 'No captions', words: ['—'], style: { color: '#fff', fontWeight: 800, fontSize: 16, opacity: 0.6 }, active: {} },
};
export const CAPTION_ORDER: CaptionStyle[] = ['pop', 'clay', 'neon', 'comic', 'minimal', 'none'];

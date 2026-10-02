import { Instagram, Youtube } from 'lucide-react';
import type { PostItem } from '../../lib/api';
import type { BadgeTone } from '../../components/ui';

export type SocialPlatform = 'youtube' | 'instagram';

export const SOCIAL = {
  youtube: { name: 'YouTube', what: 'Shorts', Icon: Youtube, color: 'bg-[#ff2e2e]' },
  instagram: { name: 'Instagram', what: 'Reels', Icon: Instagram, color: 'bg-[radial-gradient(circle_at_30%_107%,#fdf497_0%,#fd5949_45%,#d6249f_60%,#285aeb_90%)]' },
} as const;

/** "Today, 6:00 PM" / "Tomorrow, …" / "12 Oct, …" */
function fmtWhen(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400_000);
  const day = d.toDateString() === today.toDateString() ? 'Today' : d.toDateString() === tomorrow.toDateString() ? 'Tomorrow' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `${day}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

export const dayLabel = (ms: number) => {
  const d = new Date(ms);
  if (d.toDateString() === new Date().toDateString()) return 'Today';
  if (d.toDateString() === new Date(Date.now() + 86400_000).toDateString()) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
};

type PostTone = 'ok' | 'sched' | 'busy' | 'bad' | 'muted';
export const TONE_BADGE: Record<PostTone, BadgeTone> = { ok: 'good', sched: 'info', busy: 'warn', bad: 'bad', muted: 'neutral' };

/** What a post's status means, in words. */
export function postLabel(p: { platform: SocialPlatform; status: string; scheduledAt: number | null }): { text: string; tone: PostTone } {
  const future = Boolean(p.scheduledAt && p.scheduledAt > Date.now());
  if (p.status === 'published' && future && p.platform === 'youtube') return { text: `Scheduled on YouTube · ${fmtWhen(p.scheduledAt!)}`, tone: 'sched' };
  if (p.status === 'published') return { text: 'Posted', tone: 'ok' };
  if (p.status === 'scheduled') return future ? { text: `Scheduled · ${fmtWhen(p.scheduledAt!)}`, tone: 'sched' } : { text: 'Starting…', tone: 'busy' };
  if (p.status === 'uploading' || p.status === 'processing') return { text: 'Uploading…', tone: 'busy' };
  if (p.status === 'canceled') return { text: 'Canceled', tone: 'muted' };
  return { text: 'Failed', tone: 'bad' };
}

/** Waiting to go out (YouTube schedules are already uploaded but not public yet). */
export const isUpcoming = (p: PostItem) => Boolean(p.scheduledAt && p.scheduledAt > Date.now() && (p.status === 'scheduled' || (p.platform === 'youtube' && p.status === 'published')));

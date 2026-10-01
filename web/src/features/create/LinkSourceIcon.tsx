import { Cloud, Link2, Twitch, Youtube } from 'lucide-react';
import type { LinkInfo } from './links';

/** Brand-coloured icon for the kind of link that was pasted. */
export function LinkSourceIcon({ info, size = 20 }: { info: LinkInfo | null; size?: number }) {
  if (info?.kind === 'youtube') return <Youtube size={size} color="#e0453a" />;
  if (info?.kind === 'twitch') return <Twitch size={size} color="#9146ff" />;
  if (info && ['gdrive', 'dropbox', 'onedrive'].includes(info.kind)) return <Cloud size={size} color="#2f80ed" />;
  return <Link2 size={size} className="text-ink-3" />;
}

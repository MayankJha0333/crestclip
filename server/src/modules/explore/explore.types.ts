/** What Explore shows: a video, Short, channel, Twitch broadcast or clip. */
export type ItemKind = 'video' | 'short' | 'channel' | 'vod' | 'clip' | 'live';
export interface ExploreItem {
  kind: ItemKind;
  source: 'youtube' | 'twitch';
  id: string;
  url: string;
  title: string;
  channel: string | null;
  channelId: string | null;
  channelUrl: string | null;
  thumbnail: string | null;
  duration: number | null;
  views: number | null;
  subscribers: number | null;
  uploaded: string | null; // ISO date when known
  isLive: boolean;
  description: string | null;
  game?: string | null;
}

export interface ExploreChannel {
  source: 'youtube' | 'twitch';
  title: string;
  url: string;
  subscribers: number | null;
  avatar: string | null;
  banner: string | null;
  description: string | null;
}

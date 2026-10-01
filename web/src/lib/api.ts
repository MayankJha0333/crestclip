export type Platform = 'shorts' | 'tiktok' | 'reels';
export type Layout = 'auto' | 'fill' | 'fit' | 'split';
export type CaptionStyle = 'pop' | 'clay' | 'neon' | 'comic' | 'minimal' | 'none';
export type LengthPref = 'auto' | 'short' | 'medium' | 'long';
export type Motion = 'none' | 'subtle' | 'dynamic';
export interface TimeRange {
  start: number;
  end: number;
}
/** track: 'none' | 'auto' | mood id | 'upload:<id>' */
export interface MusicSettings {
  track: string;
  volume: number;
  duck: boolean;
}
export interface MusicLibrary {
  moods: { id: string; label: string; hint: string; ready: boolean; url: string | null }[];
  uploads: { id: string; name: string; url: string | null }[];
  ai: { available: boolean; fake: boolean; ok: boolean | null; detail: string };
}

export interface ProjectOptions {
  platform: Platform;
  length: LengthPref;
  clipCount: number;
  layout: Layout;
  captionStyle: CaptionStyle;
  showHook: boolean;
  useAudienceData: boolean;
  language: string;
  focus: string;
  motion: Motion;
  music: string;
  musicVolume: number;
  ranges?: TimeRange[];
  joinRanges?: boolean;
}

export interface Rubric {
  hook: number;
  standalone: number;
  payoff: number;
  emotion: number;
  shareability: number;
  pacing: number;
  loop: number;
  lengthFit: number;
  trend: number;
}

export interface Clip {
  id: string;
  projectId: string;
  start: number;
  end: number;
  duration: number;
  title: string;
  hook: string;
  description: string;
  hashtags: string[];
  reason: string;
  category: string;
  rubric: Rubric | null;
  aiScore: number;
  audienceScore: number | null;
  peakScore: number;
  layout: Layout;
  appliedLayout: Exclude<Layout, 'auto'> | null;
  captionStyle: CaptionStyle;
  showHook: boolean;
  status: 'pending' | 'rendering' | 'ready' | 'failed';
  error: string | null;
  videoUrl: string | null;
  thumbUrl: string | null;
  version: number;
  segments: TimeRange[] | null;
  posts?: { id: string; platform: 'youtube' | 'instagram'; status: PostStatus; scheduledAt: number | null; remoteUrl: string | null; error: string | null }[];
  motion: Motion;
  music: MusicSettings;
  source: 'ai' | 'manual';
}

export interface Project {
  id: string;
  createdAt: number;
  sourceType: 'url' | 'upload';
  sourceUrl: string | null;
  title: string | null;
  channel: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  viewCount: number | null;
  status: 'queued' | 'processing' | 'done' | 'failed';
  stage: string | null;
  stageDetail: string | null;
  /** Set when PeakClip downloaded only the audio + clip parts instead of the whole video. */
  download?: { downloaded: number; full: number | null } | null;
  progress: number;
  error: string | null;
  options: ProjectOptions;
  thumbUrl: string | null;
  clipCount?: number;
  readyCount?: number;
  bestScore?: number | null;
  aiNotes?: string | null;
  signals?: {
    sources: string[];
    curve: number[];
    curveKind: 'audience' | 'energy' | 'none';
    hotspots: { start: number; end: number; value: number; source: string }[];
    chapters: { start_time: number; end_time: number; title: string }[];
    hasHeatmap: boolean;
  } | null;
  clips?: Clip[];
  /** the original video, when a full copy is stored (uploads, short links) */
  sourceVideoUrl?: string | null;
}

export type PostStatus = 'scheduled' | 'uploading' | 'processing' | 'published' | 'failed' | 'canceled';
export interface Account {
  id: string;
  platform: 'youtube' | 'instagram';
  name: string | null;
  handle: string | null;
  avatar: string | null;
  connectedAt: number;
  expiresAt: number | null;
}
export interface Connections {
  accounts: Account[];
  platforms: {
    youtube: { configured: boolean; redirectUri: string };
    instagram: { configured: boolean; redirectUri: string; needsHttps: boolean };
  };
}
export interface PostItem {
  id: string;
  clipId: string;
  connectionId: string;
  platform: 'youtube' | 'instagram';
  title: string | null;
  caption: string | null;
  privacy: string | null;
  scheduledAt: number | null;
  status: PostStatus;
  remoteUrl: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  account: { name: string | null; handle: string | null; avatar: string | null } | null;
  clip: { id: string; title: string; projectId: string; thumbUrl: string | null } | null;
}

export interface Health {
  ok: boolean;
  gemini: { ok: boolean; detail: string; project: string | null; location: string; model: string; fastModel: string; fake: boolean };
  gcsBucket: string | null;
  ffmpeg: string | null;
  ytdlp: string | null;
  ffmpegSource?: string;
  ffmpegStatus?: { state: 'ready' | 'installing' | 'error'; detail: string };
  captions?: boolean;
  ytdlpStatus?: { state: 'ready' | 'installing' | 'updating' | 'missing' | 'error'; source: string | null; detail: string; checkedAt: number | null };
}

export type ExploreKind = 'video' | 'short' | 'channel' | 'live' | 'vod' | 'clip';
export type ExploreSource = 'youtube' | 'twitch';
export interface ExploreItem {
  kind: ExploreKind;
  source: ExploreSource;
  id: string;
  url: string;
  title: string;
  channel?: string | null;
  channelUrl?: string | null;
  thumbnail?: string | null;
  duration?: number | null;
  views?: number | null;
  subscribers?: number | null;
  description?: string | null;
  uploaded?: string | null;
  isLive?: boolean;
  game?: string | null;
}
export interface ExploreChannel {
  source: ExploreSource;
  title: string;
  url: string;
  subscribers: number | null;
  avatar: string | null;
  banner: string | null;
  description: string | null;
}
export interface DiscoverSection {
  id: string;
  title: string;
  subtitle: string;
  items: ExploreItem[];
  see: { q: string; type: string; duration: string; sort: string; uploaded: string } | null;
}
export interface Peek {
  title: string;
  channel: string;
  channelUrl: string | null;
  duration: number;
  views: number | null;
  likes: number | null;
  uploadDate: string | null;
  thumbnail: string | null;
  url: string;
  isYouTube: boolean;
  isLive: boolean;
  description: string;
  chapters: { start_time: number; end_time: number; title: string }[];
  curve: number[] | null;
  hotspots: { start: number; end: number; value: number; source: string }[];
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  return body as T;
}
const json = (method: string, data: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

export const api = {
  health: (refresh = false) => req<Health>(`/api/health${refresh ? '?refresh=1' : ''}`),
  refreshTools: () => req<unknown>('/api/tools/refresh', { method: 'POST' }),
  projects: () => req<Project[]>('/api/projects'),
  project: (id: string) => req<Project>(`/api/projects/${id}`),
  createFromUrl: (url: string, options: ProjectOptions) => req<Project>('/api/projects', json('POST', { url, options })),
  retry: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}/retry`, { method: 'POST' }),
  remove: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
  updateClip: (id: string, patch: Partial<Pick<Clip, 'title' | 'hook' | 'description' | 'hashtags' | 'start' | 'end' | 'layout' | 'captionStyle' | 'showHook' | 'motion' | 'music'>>) =>
    req<Clip>(`/api/clips/${id}`, json('PATCH', patch)),
  connections: () => req<Connections>('/api/connections'),
  connectUrl: (platform: 'youtube' | 'instagram') => `/api/connect/${platform}/start`,
  disconnect: (id: string) => req<{ ok: boolean }>(`/api/connections/${id}`, { method: 'DELETE' }),
  createPosts: (body: { clipId: string; targets: { connectionId: string; title?: string; caption?: string; privacy?: 'public' | 'unlisted' | 'private' }[]; scheduledAt?: number | null }) =>
    req<PostItem[]>('/api/posts', json('POST', body)),
  posts: (clipId?: string) => req<PostItem[]>(`/api/posts${clipId ? `?clipId=${encodeURIComponent(clipId)}` : ''}`),
  retryPost: (id: string) => req<PostItem>(`/api/posts/${id}/retry`, { method: 'POST' }),
  cancelPost: (id: string) => req<PostItem>(`/api/posts/${id}/cancel`, { method: 'POST' }),
  addClips: (projectId: string, ranges: TimeRange[], join: boolean) => req<Clip[]>(`/api/projects/${projectId}/clips`, json('POST', { ranges, join })),
  music: () => req<MusicLibrary>('/api/music'),
  makeMood: (id: string, fresh = false) => req<MusicLibrary>(`/api/music/moods/${id}${fresh ? '?fresh=1' : ''}`, { method: 'POST' }),
  removeMusic: (id: string) => req<MusicLibrary>(`/api/music/uploads/${id}`, { method: 'DELETE' }),
  async uploadMusic(file: File): Promise<MusicLibrary & { added: string }> {
    const fd = new FormData();
    fd.append('file', file);
    return req<MusicLibrary & { added: string }>('/api/music/uploads', { method: 'POST', body: fd });
  },
  rerender: (id: string) => req<Clip>(`/api/clips/${id}/render`, { method: 'POST' }),
  variant: (id: string) => req<Clip>(`/api/clips/${id}/variant`, { method: 'POST' }),
  transcript: (id: string) =>
    req<{ start: number; end: number; duration: number; segments: { s: number; e: number; text: string; speaker?: string }[] }>(`/api/clips/${id}/transcript`),
  downloadUrl: (id: string) => `/api/clips/${id}/download`,
  exploreSearch: (p: Record<string, string>) => req<{ items: ExploreItem[]; twitchApi: boolean }>(`/api/explore/search?${new URLSearchParams(p)}`),
  exploreChannel: (url: string, tab: string) =>
    req<{ channel: ExploreChannel; items: ExploreItem[] }>(`/api/explore/channel?${new URLSearchParams({ url, tab })}`),
  peek: (url: string) => req<Peek>(`/api/explore/peek?${new URLSearchParams({ url })}`),
  exploreDiscover: (source: ExploreSource, category: string) =>
    req<{ sections: DiscoverSection[] }>(`/api/explore/discover?${new URLSearchParams({ source, category })}`),
  exploreCategories: () => req<{ youtube: { id: string; label: string }[]; twitch: string[] }>('/api/explore/categories'),

  /** Upload with progress (fetch has no upload progress, so XHR). */
  upload(file: File, options: ProjectOptions, onProgress: (pct: number, loaded: number, total: number) => void, signal?: AbortSignal): Promise<Project> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      signal?.addEventListener('abort', () => {
        xhr.abort();
        reject(new Error('Upload cancelled'));
      });
      const fd = new FormData();
      fd.append('options', JSON.stringify(options));
      fd.append('file', file);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress((e.loaded / e.total) * 100, e.loaded, e.total);
      xhr.onload = () => {
        let body: { error?: string } = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* ignore */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as Project);
        else reject(new Error(body.error || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Upload failed — is the PeakClip server running?'));
      xhr.open('POST', '/api/projects/upload');
      xhr.send(fd);
    });
  },
};

export const DEFAULT_OPTIONS: ProjectOptions = {
  platform: 'shorts',
  length: 'auto',
  clipCount: 8,
  layout: 'auto',
  captionStyle: 'pop',
  showHook: true,
  useAudienceData: true,
  language: 'auto',
  focus: '',
  motion: 'subtle',
  music: 'auto',
  musicVolume: 15,
};

export function fmtTime(sec: number | null | undefined) {
  if (sec == null || !Number.isFinite(sec)) return '–';
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export function fmtPrecise(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function fmtViews(n: number | null | undefined) {
  if (n == null) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B views`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M views`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K views`;
  return `${n} views`;
}

export function fmtCount(n: number | null | undefined, unit = '') {
  if (n == null) return '';
  const v = n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K` : `${n}`;
  return unit ? `${v} ${unit}` : v;
}

export function fmtDate(yyyymmdd: string | null | undefined) {
  if (!yyyymmdd) return '';
  const d = /^\d{8}$/.test(yyyymmdd) ? new Date(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`) : new Date(yyyymmdd);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function timeAgo(ms: number) {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}

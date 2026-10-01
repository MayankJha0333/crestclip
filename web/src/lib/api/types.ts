/** Shapes returned by the CrestClip API (see the presenters in server/src/modules). */
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
/** The logo stamped on every clip (set up once in Settings). */
export type WatermarkPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type WatermarkSize = 'small' | 'medium' | 'large';
export interface Watermark {
  enabled: boolean;
  logoUrl: string | null;
  name: string;
  position: WatermarkPosition;
  size: WatermarkSize;
  opacity: number; // 20-100 (%)
}
export type WatermarkPatch = Partial<Pick<Watermark, 'enabled' | 'position' | 'size' | 'opacity'>>;

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
  focus: string;
  motion: Motion;
  music: string;
  musicVolume: number;
  ranges?: TimeRange[];
  joinRanges?: boolean;
  /** "Instructions for the AI" (rules, length, tags, what to clip) */
  instructions?: string;
  /** set by the server after it reads the instructions */
  rules?: string[];
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
  /** in a multi-video project: which video (1, 2, …) the clip came from */
  part?: number;
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
  sourceType: 'url' | 'upload' | 'group';
  /** set on a video that belongs to a multi-video project */
  parentId?: string | null;
  /** multi-video project: how many videos, and each one */
  videoCount?: number;
  parts?: (Project & { index: number })[];
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
  /** Set when CrestClip downloaded only the audio + clip parts instead of the whole video. */
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
  /** set when Autopilot made this post */
  autopilotId?: string | null;
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

// ---------- Autopilot ----------
export interface AutopilotSource {
  kind: 'youtube_channel' | 'youtube_topic';
  value: string;
  channelId?: string | null;
  label?: string | null;
  region?: string | null;
}
export interface AutopilotConfig {
  sources: AutopilotSource[];
  filters: { minViews: number; minMinutes: number; maxMinutes: number; maxAgeDays: number; waitHours: number };
  options: Partial<ProjectOptions>;
  clipsPerVideo: number;
  times: string[];
  timezone: string;
  targets: { connectionId: string; privacy?: 'public' | 'unlisted' | 'private' }[];
  mode: 'review' | 'auto';
  caption: string;
  rightsConfirmed: boolean;
}
export interface ApClip {
  id: string;
  projectId: string;
  title: string;
  hook: string;
  score: number;
  duration: number;
  thumbUrl: string | null;
  videoUrl: string | null;
  source: { title: string | null; channel: string | null; url: string | null } | null;
}
export interface AutopilotSummary {
  id: string;
  name: string;
  status: 'active' | 'paused';
  config: AutopilotConfig;
  lastScanAt: number | null;
  lastError: string | null;
  createdAt: number;
  nextTime: number | null;
  nextPost: { at: number; clip: ApClip | null } | null;
  counts: { review: number; ready: number; scheduled: number; posted: number; clipping: number; waiting: number };
}
export interface ApSlot {
  key: string;
  at: number;
  date: string;
  time: string;
  skipped: boolean;
  apClipId: string | null;
  clip: ApClip | null;
  posts: { id: string; platform: 'youtube' | 'instagram'; status: PostStatus; error: string | null; remoteUrl: string | null; account: string | null }[];
}
export interface ApItem {
  id: string;
  status: string;
  slotKey: string | null;
  createdAt: number;
  clip: ApClip;
}
export interface ApVideo {
  id: string;
  videoId: string;
  url: string;
  title: string | null;
  channel: string | null;
  thumbnail: string | null;
  views: number | null;
  duration: number | null;
  publishedAt: number | null;
  status: 'waiting' | 'queued' | 'clipping' | 'done' | 'skipped' | 'failed';
  reason: string | null;
  projectId: string | null;
  foundAt: number;
}
export interface AutopilotDetail extends AutopilotSummary {
  schedule: ApSlot[];
  review: ApItem[];
  ready: ApItem[];
  videos: ApVideo[];
  history: PostItem[];
}
export interface SchedulerStatus {
  state: 'starting' | 'installing' | 'ready' | 'error' | 'off';
  source: 'env' | 'local' | 'managed' | null;
  detail: string;
  running: boolean;
}
export type AutopilotInput = AutopilotConfig & { name: string };

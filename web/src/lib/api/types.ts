/** Shapes returned by the CrestClip API (see the presenters in server/src/modules). */
export type Platform = 'shorts' | 'tiktok' | 'reels';
export type Layout = 'auto' | 'fill' | 'fit' | 'split';
export type CaptionStyle = 'pop' | 'clay' | 'neon' | 'comic' | 'minimal' | 'none';
export type LengthPref = 'auto' | 'short' | 'medium' | 'long';
export type Motion = 'none' | 'subtle' | 'dynamic';
/** Pause cutting: keep every pause, shorten long ones, or cut tight. */
export type Pace = 'off' | 'natural' | 'fast';
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
  /** a free spot (0-1 across / down the frame) instead of `position`'s corner — only on a project's own logo */
  x?: number;
  y?: number;
  /** every uploaded logo (the Settings one included), to pick one per project */
  logos: { id: string; name: string; url: string | null }[];
  /** which of `logos` is the Settings one */
  defaultLogoId: string | null;
  /** the plan doesn't include your own logo (Free clips carry the CrestClip mark) */
  locked: boolean;
}
export type WatermarkPatch = Partial<Pick<Watermark, 'enabled' | 'position' | 'size' | 'opacity'>>;
/** A project's own logo, picked in New clips. id null = no logo on these clips. */
export interface LogoChoice {
  id: string | null;
  x: number;
  y: number;
  size: WatermarkSize;
  opacity: number;
}

export interface MusicLibrary {
  moods: { id: string; label: string; hint: string; ready: boolean; url: string | null }[];
  uploads: { id: string; name: string; url: string | null }[];
  ai: { available: boolean; fake: boolean; ok: boolean | null; detail: string };
}

export type CaptionLanguage = 'auto' | 'roman' | 'english';

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
  pace: Pace;
  /** captions, hooks and titles: 'auto' = as spoken in its own script · 'roman' = as spoken in English letters (Hinglish) · 'english' = translated */
  captionLanguage?: CaptionLanguage;
  emoji: boolean;
  flashForward: boolean;
  ranges?: TimeRange[];
  joinRanges?: boolean;
  /** "Instructions for the AI" (rules, length, tags, what to clip) */
  instructions?: string;
  /** set by the server after it reads the instructions */
  rules?: string[];
  /** this project's logo; absent = the Settings watermark */
  logo?: LogoChoice;
}

/** New clips → a Google Drive folder link: what's inside (nothing is spent yet). */
export interface FolderPreview {
  name: string;
  /** videos found, one per take (copies of the same video counted once) */
  videos: number;
  duplicates: number;
  /** brief files the AI will read (Google Docs, PDFs, text) */
  docs: string[];
  images: number;
  other: number;
  subfolders: string[];
  sample: string[];
  /** the most videos the AI can pick: the plan's videos-per-project limit */
  willClip: number;
  max: number;
  truncated: boolean;
}

/** What happened when a Drive folder was clipped. */
export interface FolderResult {
  name: string;
  videos: number;
  duplicates: number;
  picked: { title: string; folder: string; reason: string }[];
  docsRead: string[];
  summary: string;
  limitedBy: 'credits' | 'plan' | null;
  readBy: 'ai' | 'plain';
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
  /** the judge's one line on what holds this clip back */
  weakest?: string | null;
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
  pace: Pace;
  /** emoji next to key words in the captions */
  emoji: boolean;
  /** open on a short tease of the best line (only possible when `hasTeaser`) */
  flashForward: boolean;
  hasTeaser: boolean;
  /** headline options written by the AI (the current one is `hook`) */
  hooks: string[];
  /** words shown bigger / coloured in the captions */
  keywords: { w: string; emoji?: string }[];
}

export interface Project {
  id: string;
  createdAt: number;
  /** when the project and its clips are deleted (storage time) */
  expiresAt?: number | null;
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
  /** queued: videos running before this one (0 = starting now); null = unknown */
  queueAhead?: number | null;
  progress: number;
  error: string | null;
  /** set when the person can fix the failure by upgrading or buying credits */
  errorCode?: 'credits' | 'plan_limit' | null;
  /** credits this video used */
  creditsCharged?: number;
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
    /** auditPassed: false = Google hasn't approved the app's YouTube API use yet, so YouTube keeps every upload private */
    youtube: { configured: boolean; redirectUri: string; auditPassed: boolean };
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
  ai: { ok: boolean; fake: boolean; checkedAt: number };
  /** YouTube PO-token helper: true/false, or null when not configured */
  potHelper?: boolean | null;
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

export interface PublicPeek {
  title: string;
  channel: string;
  duration: number;
  views: number | null;
  thumbnail: string | null;
  url: string;
  curve: number[] | null;
  /** the top replay peaks; `times` = how many times the video's average replay level */
  peaks: { start: number; end: number; times: number | null }[];
}

// ---------- Autopilot ----------
export interface AutopilotSource {
  kind: 'youtube_channel' | 'youtube_topic';
  value: string;
  channelId?: string | null;
  label?: string | null;
  region?: string | null;
  /** topics: trending (gaining views fastest), most viewed, or newest */
  sort?: 'trending' | 'views' | 'date' | null;
}
export interface AutopilotConfig {
  sources: AutopilotSource[];
  /** languages: spoken languages to keep ("en", "hi"…); empty = any */
  filters: {
    minViews: number;
    minMinutes: number;
    maxMinutes: number;
    maxAgeDays: number;
    waitHours: number;
    languages?: string[];
    /** skip videos whose title has any of these words */
    excludeWords?: string[];
    /** never clip these channels (names) */
    blockChannels?: string[];
  };
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
/** A clip that could take a booked time's place (in line, or a spare from the same videos). */
export interface ApAlternative {
  apClipId: string | null;
  inLine: boolean;
  clip: ApClip;
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
  /** the same clip posted (or booked) by the person themselves — Autopilot won't post it again on those accounts */
  byYou?: { id: string; platform: 'youtube' | 'instagram'; status: PostStatus; at: number; remoteUrl: string | null; account: string | null }[];
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

// ---------------- accounts, plans & credits ----------------
export type PlanId = 'free' | 'creator' | 'pro';
export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  /** monthly price in US dollars */
  price: number;
  currency: 'USD';
  /** credits added every month */
  credits: number;
  /** clips those credits make (credits ÷ credits per clip) */
  clips: number;
  rollover: boolean;
  maxVideoMinutes: number;
  maxVideosPerProject: number;
  crestclipWatermark: boolean;
  customLogo: boolean;
  exportHeight: number;
  scheduling: boolean;
  autopilot: boolean;
  /** can paste YouTube links and browse YouTube in Explore (Creator and Pro) */
  youtubeSource?: boolean;
  /** days a project and its clips are kept */
  storageDays?: number;
  points: string[];
}
export interface PlansInfo {
  currency: 'USD';
  creditsPerClip: number;
  plans: Plan[];
  topup: Topup;
  /** the billing promises shown on the pricing page */
  policy?: string[];
}
/** The one-off credit pack (price in US dollars). */
export interface Topup {
  credits: number;
  price: number;
  validDays: number;
}
export interface BillingAccount {
  plan: Plan;
  cycleStart: number | null;
  cycleEnd: number | null;
  cancelAtPeriodEnd: boolean;
  hasSubscription: boolean;
  /** who bills the plan: Dodo Payments, or Razorpay for people who subscribed before the move */
  billedBy: 'dodo' | 'razorpay' | null;
  /** a renewal payment failed — the plan stays a few days while the card / UPI is updated */
  paymentProblem: boolean;
  /** Dodo's customer portal is available (payment method, invoices) */
  canManageBilling: boolean;
  /** payments run in Dodo test mode (test cards only, no real money) */
  testMode: boolean;
  credits: { perClip: number; balance: number; monthly: number; usedThisMonth: number; grants: { source: 'plan' | 'topup' | 'bonus' | 'refund'; remaining: number; expiresAt: number }[] };
  paymentsReady: boolean;
}
export interface Me {
  user: { id: string; email: string; name: string | null; avatar: string | null; isAdmin: boolean; hasPassword: boolean; google: boolean };
  account: BillingAccount;
}
export interface CreditEvent {
  id: string;
  delta: number;
  kind: 'grant' | 'topup' | 'spend' | 'refund' | 'adjust';
  note: string | null;
  projectId: string | null;
  refunded: boolean;
  createdAt: number;
}
export interface Payment {
  id: string;
  kind: 'subscription' | 'topup';
  plan: string | null;
  amount: number | null;
  currency: string | null;
  /** who took the payment (old payments: Razorpay) */
  provider?: 'dodo' | 'razorpay';
  /** the official tax invoice (Dodo Payments) */
  invoiceUrl?: string | null;
  createdAt: number;
}
/** Everything a printable receipt shows. */
export interface Receipt {
  payment: Payment;
  item: string;
  customer: { name: string | null; email: string };
  seller: SiteInfo;
  provider: 'dodo' | 'razorpay';
}
export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  plan: PlanId;
  paying: boolean;
  balance: number;
  createdAt: number;
}
/** Starting a payment: open Dodo's checkout page (`url`), or it was done on the existing subscription (`changed`). */
export type CheckoutStart = { url: string } | { changed: true; pending: boolean };

/** Who runs CrestClip, for the About / Contact / policy pages. */
export interface SiteInfo {
  name: string;
  legalName: string;
  email: string | null;
  address: string | null;
  jurisdiction: string | null;
  /** when support answers */
  hours: string;
  /** who handles complaints */
  grievanceOfficer: string;
  url: string;
  currency: 'USD';
  retentionDays: number;
  creditsPerClip: number;
  topupValidMonths: number;
}

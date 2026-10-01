export type Platform = 'shorts' | 'tiktok' | 'reels';
export type Layout = 'auto' | 'fill' | 'fit' | 'split';
export type CaptionStyle = 'pop' | 'clay' | 'neon' | 'comic' | 'minimal' | 'none';
export type LengthPref = 'auto' | 'short' | 'medium' | 'long';
/** Editing motion: none, occasional punch-in zooms + smooth pans, or fast-paced zooms like a pro editor. */
export type Motion = 'none' | 'subtle' | 'dynamic';

export interface TimeRange {
  start: number;
  end: number;
}

/** Background music for a clip. track: 'none' | 'auto' (picked from the clip's mood) | a mood id | 'upload:<id>' */
export interface MusicSettings {
  track: string;
  volume: number; // 0-100, relative to the voice
  duck: boolean; // lower the music while people talk
}

export interface ProjectOptions {
  platform: Platform;
  length: LengthPref;
  clipCount: number;
  layout: Layout;
  captionStyle: CaptionStyle;
  showHook: boolean;
  useAudienceData: boolean;
  focus: string; // optional free text: "only funny moments", "product tips"...
  motion?: Motion;
  music?: string; // default track for new clips (see MusicSettings.track)
  musicVolume?: number;
  /** Clip exactly these parts (picked on the graph) instead of letting Gemini choose. */
  ranges?: TimeRange[];
  joinRanges?: boolean; // true = all ranges become ONE clip
  /** exact clip length rule (e.g. from a campaign brief); overrides `length` */
  minSeconds?: number;
  maxSeconds?: number;
  /** "Instructions for the AI" typed/pasted in New clips (rules, length, tags, what to clip) */
  instructions?: string;
  /** what CrestClip understood from them */
  rules?: string[];
  requiredHashtags?: string[];
  requiredMentions?: string[];
  requiredCaptionText?: string | null;
}

export interface Word {
  w: string;
  s: number;
  e: number;
}

export interface Segment {
  s: number;
  e: number;
  text: string;
  speaker?: string;
  words: Word[];
}

export interface HeatPoint {
  start_time: number;
  end_time: number;
  value: number;
}

export interface Signals {
  sources: string[]; // 'heatmap' | 'comments' | 'loudness' | 'chat'
  heatmap: HeatPoint[] | null;
  chapters: { start_time: number; end_time: number; title: string }[];
  commentBins: number[] | null; // 100 bins, 0..1
  loudnessBins: number[] | null; // 100 bins, 0..1
  curve: number[]; // 100 bins combined engagement 0..1
  curveKind: 'audience' | 'energy' | 'none';
  hotspots: { start: number; end: number; value: number; source: string }[];
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

export interface ClipCandidate {
  start: number;
  end: number;
  title: string;
  hook: string;
  description: string;
  hashtags: string[];
  reason: string;
  category: string;
  rubric: Rubric;
}

export interface CropHold {
  t: number; // seconds from clip start
  x: number; // normalized center 0..1
  cut?: boolean; // true = this hold starts at a camera cut (jump), false = same shot (can pan smoothly)
}

export interface ReframePlan {
  layout: Exclude<Layout, 'auto'>;
  holds: CropHold[];
  splitCenters?: [number, number];
  faceRatio: number;
  faceY?: number;
  suggested?: Exclude<Layout, 'auto'>;
  content?: string;
  start?: number; // clip range this plan was computed for
  end?: number;
  /** multi-part clips: one plan per part */
  parts?: ReframePlan[];
}

export type Platform = 'shorts' | 'tiktok' | 'reels';
export type Layout = 'auto' | 'fill' | 'fit' | 'split' | 'screencast';
export type CaptionStyle = 'pop' | 'clay' | 'neon' | 'comic' | 'minimal' | 'none';
export type LengthPref = 'auto' | 'short' | 'medium' | 'long';
/** Editing motion: none, occasional punch-in zooms + smooth pans, or fast-paced zooms like a pro editor. */
export type Motion = 'none' | 'subtle' | 'dynamic';
/** Pause cutting: keep every pause, shorten long ones (natural), or cut tight (fast). */
export type Pace = 'off' | 'natural' | 'fast';
/** A word the AI marked as important: shown bigger / coloured in captions, with an optional emoji. */
export interface Keyword {
  w: string;
  emoji?: string;
}

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

/** A project's own logo, picked in New clips: a library logo, anywhere on the frame (0-1 across / down). id null = no logo. */
export interface LogoChoice {
  id: string | null;
  x: number;
  y: number;
  size: 'small' | 'medium' | 'large';
  opacity: number; // 20-100 (%)
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
  focus: string; // optional free text: "only funny moments", "product tips"...
  motion?: Motion;
  music?: string; // default track for new clips (see MusicSettings.track)
  musicVolume?: number;
  pace?: Pace;
  /**
   * The language and script of captions, hooks and titles:
   *  'auto'    = as spoken, in its own script (Hindi in Devanagari)
   *  'roman'   = as spoken, in English letters (Hinglish — how people type in chat)
   *  'english' = translated into English
   */
  captionLanguage?: CaptionLanguage;
  emoji?: boolean; // emoji next to key words in captions
  flashForward?: boolean; // open on a short tease of the best line, then start the story
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
  /** this project's logo; absent = the Settings watermark */
  logo?: LogoChoice;
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
  /** word times taken from measured ones (the site's speech recognition), not estimated from the phrase */
  timed?: boolean;
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
  /** extra hook headlines to choose from (the first is `hook`) */
  hooks?: string[];
  keywords?: Keyword[];
  /** the punchiest 1–3 s inside the clip, for a flash-forward opening (absolute seconds) */
  teaser?: TimeRange | null;
  /** the judge's one line on what holds this clip back ("Why this score" shows it) */
  weakest?: string | null;
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
  /** Lowest useful source row when the original video has burned-in subtitles (0–1). */
  subtitleBottom?: number;
  /**
   * Rows of the source (0-1, top/bottom) that hold the picture inside the crop column. Set when the video has empty
   * dark borders above/below (letterbox, a face-cam circle on a plain background…), so "fill" zooms in to cut them
   * away. null = the picture fills the height (checked, nothing to cut); undefined = not checked yet.
   */
  band?: { top: number; bottom: number } | null;
  suggested?: Exclude<Layout, 'auto'>;
  content?: string;
  start?: number; // clip range this plan was computed for
  end?: number;
  /** multi-part clips: one plan per part */
  parts?: ReframePlan[];
}

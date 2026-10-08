import type { AutopilotInput, AutopilotSource } from '../../lib/api';

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};
export const allZones = (): string[] => {
  try {
    return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Asia/Kolkata', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo', 'Australia/Sydney'];
  }
};

/** "13:00" → "1:00 PM" */
export const prettyTime = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const todayIn = (tz: string, plusDays = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + plusDays * 86400_000));
export const dayName = (date: string, tz: string) => {
  if (date === todayIn(tz)) return 'Today';
  if (date === todayIn(tz, 1)) return 'Tomorrow';
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
};
export const compact = (n: number | null | undefined) => (n == null ? '—' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n));
export const mins = (s: number | null) => (s == null ? '' : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : `${Math.round(s / 60)} min`);

/** Spread `n` posting times nicely over the day. */
export function defaultTimes(n: number): string[] {
  const presets: Record<number, string[]> = {
    1: ['18:00'],
    2: ['13:00', '19:00'],
    3: ['12:00', '17:00', '21:00'],
    4: ['09:00', '13:00', '17:00', '21:00'],
    5: ['09:00', '12:00', '15:00', '18:00', '21:00'],
  };
  if (presets[n]) return presets[n];
  const start = 8 * 60;
  const end = 23 * 60;
  return Array.from({ length: n }, (_, i) => {
    const m = Math.round(start + ((end - start) * i) / (n - 1));
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor((m % 60) / 15) * 15).padStart(2, '0')}`;
  });
}

export const REGIONS: { code: string; label: string }[] = [
  { code: '', label: 'Anywhere' },
  { code: 'IN', label: 'India' },
  { code: 'US', label: 'United States' },
  { code: 'GB', label: 'United Kingdom' },
  { code: 'CA', label: 'Canada' },
  { code: 'AU', label: 'Australia' },
  { code: 'AE', label: 'UAE' },
  { code: 'SG', label: 'Singapore' },
  { code: 'DE', label: 'Germany' },
  { code: 'FR', label: 'France' },
  { code: 'BR', label: 'Brazil' },
  { code: 'JP', label: 'Japan' },
  { code: 'ID', label: 'Indonesia' },
  { code: 'PH', label: 'Philippines' },
];
const regionLabel = (c?: string | null) => REGIONS.find((r) => r.code === (c ?? ''))?.label ?? c ?? 'Anywhere';

const SORT_LABEL = { trending: '🔥 Trending', views: 'Most viewed', date: 'Newest' } as const;
export const sourceText = (s: AutopilotSource) =>
  s.kind === 'youtube_channel' ? s.label || s.value : `“${s.value}”${s.region ? ` · ${regionLabel(s.region)}` : ''}${s.sort && s.sort !== 'views' ? ` · ${SORT_LABEL[s.sort]}` : ''}`;

const DEFAULT_CAPTION = '{title}\n\n{hashtags}\n\n🎥 Credit: {channel}';

export const EMPTY_AUTOPILOT: AutopilotInput = {
  name: '',
  sources: [],
  filters: { minViews: 10_000, minMinutes: 5, maxMinutes: 180, maxAgeDays: 14, waitHours: 24, languages: [], excludeWords: [], blockChannels: [] },
  options: { platform: 'reels', captionStyle: 'pop', motion: 'subtle', music: 'auto', length: 'auto', layout: 'auto', showHook: true },
  clipsPerVideo: 2,
  times: defaultTimes(3),
  timezone: browserZone(),
  targets: [],
  mode: 'review',
  caption: DEFAULT_CAPTION,
  rightsConfirmed: false,
};

/**
 * The spoken languages most of a country's YouTube is in — a topic searched "in India" still turns up Spanish videos
 * (YouTube's region only leans the results), so picking a country also picks these unless languages are chosen.
 * Keep in sync with server/src/pipeline/language.ts (REGION_LANGUAGES).
 */
export const REGION_LANGUAGES: Record<string, string[]> = {
  IN: ['en', 'hi'],
  US: ['en'],
  GB: ['en'],
  CA: ['en', 'fr'],
  AU: ['en'],
  AE: ['ar', 'en'],
  SG: ['en'],
  DE: ['de'],
  FR: ['fr'],
  BR: ['pt'],
  JP: ['ja'],
  ID: ['id'],
  PH: ['en'],
};

/** What the server keeps to: the picked languages, or (none picked, only country topics) those countries' languages. */
export function effectiveLanguages(chosen: string[] | undefined, sources: AutopilotSource[]): { codes: string[]; fromCountry: boolean } | null {
  if (chosen?.length) return { codes: chosen, fromCountry: false };
  if (!sources.length || sources.some((s) => s.kind !== 'youtube_topic' || !s.region || !REGION_LANGUAGES[s.region])) return null;
  return { codes: [...new Set(sources.flatMap((s) => REGION_LANGUAGES[s.region!]))], fromCountry: true };
}

/** Ready-made starting points, so a new autopilot begins from something real instead of a blank form. */
export const AUTOPILOT_TEMPLATES: {
  id: string;
  title: string;
  blurb: string;
  icon: 'mic' | 'cpu' | 'trophy' | 'channel';
  apply: (base: AutopilotInput) => AutopilotInput;
}[] = [
  {
    id: 'own-channel',
    title: 'Your own channel',
    blurb: 'Every new long video you upload becomes Shorts and Reels — no clipping by hand.',
    icon: 'channel',
    apply: (b) => ({ ...b, name: 'My channel → Shorts', clipsPerVideo: 3, filters: { ...b.filters, minViews: 0, maxAgeDays: 30, waitHours: 24 } }),
  },
  {
    id: 'podcasts-in',
    title: 'Indian podcast clips',
    blurb: 'The most-watched new podcasts in India, in English or Hindi. 20 min and longer.',
    icon: 'mic',
    apply: (b) => ({
      ...b,
      name: 'Podcast clips · India',
      sources: [{ kind: 'youtube_topic', value: 'podcast', region: 'IN', label: 'podcast', sort: 'views' }],
      filters: { ...b.filters, languages: ['en', 'hi'], minMinutes: 20, minViews: 50_000 },
    }),
  },
  {
    id: 'ai-tech',
    title: 'AI & tech explainers',
    blurb: 'Trending English videos about AI and new tech, 8 minutes and up.',
    icon: 'cpu',
    apply: (b) => ({
      ...b,
      name: 'AI & tech · English',
      sources: [{ kind: 'youtube_topic', value: 'AI explained', region: 'US', label: 'AI explained', sort: 'trending' }],
      filters: { ...b.filters, languages: ['en'], minMinutes: 8, minViews: 20_000 },
    }),
  },
  {
    id: 'cricket-in',
    title: 'Cricket talk',
    blurb: 'Popular cricket analysis and interviews from India, in Hindi or English.',
    icon: 'trophy',
    apply: (b) => ({
      ...b,
      name: 'Cricket talk · India',
      sources: [{ kind: 'youtube_topic', value: 'cricket analysis', region: 'IN', label: 'cricket analysis', sort: 'trending' }],
      filters: { ...b.filters, languages: ['hi', 'en'], minMinutes: 8, minViews: 20_000 },
    }),
  },
];

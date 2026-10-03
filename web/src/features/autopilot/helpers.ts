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

export const sourceText = (s: AutopilotSource) => (s.kind === 'youtube_channel' ? s.label || s.value : `“${s.value}”${s.region ? ` · ${regionLabel(s.region)}` : ''}`);

const DEFAULT_CAPTION = '{title}\n\n{hashtags}\n\n🎥 Credit: {channel}';

export const EMPTY_AUTOPILOT: AutopilotInput = {
  name: '',
  sources: [],
  filters: { minViews: 10_000, minMinutes: 5, maxMinutes: 180, maxAgeDays: 14, waitHours: 24, languages: [] },
  options: { platform: 'reels', captionStyle: 'pop', motion: 'subtle', music: 'auto', length: 'auto', layout: 'auto', showHook: true },
  clipsPerVideo: 2,
  times: defaultTimes(3),
  timezone: browserZone(),
  targets: [],
  mode: 'review',
  caption: DEFAULT_CAPTION,
  rightsConfirmed: false,
};

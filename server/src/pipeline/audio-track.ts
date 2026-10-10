/** Minimal audio format metadata shared by the downloader paths. */
export interface AudioTrackMetadata {
  format_id?: string;
  language?: string | null;
  language_preference?: number | null;
  format_note?: string | null;
  acodec?: string | null;
  vcodec?: string | null;
  abr?: number | null;
  tbr?: number | null;
}

function normalizedLanguage(language: string | null | undefined): string | null {
  const value = language?.trim().replaceAll('_', '-').toLowerCase();
  return value && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(value) ? value : null;
}

function matchesLanguage(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a === b || a.split('-')[0] === b.split('-')[0];
}

/** The source language recorded by yt-dlp, when available. */
export function sourceLanguageFromInfo(info: unknown): string | null {
  if (!info || typeof info !== 'object') return null;
  const language = normalizedLanguage((info as { language?: string | null }).language);
  return language;
}

/**
 * Pick the original/source-language audio before considering bitrate. YouTube lists dubbed tracks beside the source
 * audio, and choosing the highest bitrate alone can silently select an auto-dub.
 */
export function bestAudioTrack<T extends AudioTrackMetadata>(formats: T[], sourceLanguage: string | null): T | null {
  const audio = formats.filter((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
  if (!audio.length) return null;
  const source = normalizedLanguage(sourceLanguage);
  const original = (f: T) => /\boriginal\b/i.test(f.format_note ?? '');
  const isDefault = (f: T) => /\bdefault\b/i.test(f.format_note ?? '');
  audio.sort((a, b) => {
    const byOriginal = Number(original(b)) - Number(original(a));
    if (byOriginal) return byOriginal;
    const byLanguage = Number(matchesLanguage(normalizedLanguage(b.language), source)) - Number(matchesLanguage(normalizedLanguage(a.language), source));
    if (byLanguage) return byLanguage;
    const byDefault = Number(isDefault(b)) - Number(isDefault(a));
    if (byDefault) return byDefault;
    const byPreference = (Number(b.language_preference) || 0) - (Number(a.language_preference) || 0);
    if (byPreference) return byPreference;
    return (Number(b.abr ?? b.tbr) || 0) - (Number(a.abr ?? a.tbr) || 0);
  });
  return audio[0];
}

/**
 * yt-dlp selector alternatives for an original track. Keep a generic fallback for sources that don't expose language
 * metadata, but only after trying explicit original/source-language tracks.
 */
export function audioFormatSelectors(sourceLanguage: string | null): string[] {
  const selectors = ['ba[format_note*=original][ext=m4a]', 'ba[format_note*=original]'];
  const source = normalizedLanguage(sourceLanguage);
  if (source) {
    for (const language of [...new Set([source, source.split('-')[0]])]) {
      selectors.push(`ba[language=${language}][ext=m4a]`, `ba[language=${language}]`);
    }
  }
  selectors.push('ba[format_note*=default][ext=m4a]', 'ba[format_note*=default]', 'ba[ext=m4a]', 'ba');
  return [...new Set(selectors)];
}

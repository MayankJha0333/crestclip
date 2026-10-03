/**
 * Spoken-language helpers for picking videos (Autopilot's "Language" filter).
 * The real answer comes from YouTube's auto-captions (they're made in the language people speak); before that is
 * known, a title written in a non-Latin script (Devanagari, Tamil, Arabic…) is a good early hint.
 */

/** Languages people can pick (ISO 639-1). Keep in sync with web/src/features/autopilot/languages.ts. */
export const LANGUAGES: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  es: 'Spanish',
  pt: 'Portuguese',
  fr: 'French',
  de: 'German',
  ar: 'Arabic',
  ur: 'Urdu',
  bn: 'Bengali',
  ta: 'Tamil',
  te: 'Telugu',
  mr: 'Marathi',
  gu: 'Gujarati',
  kn: 'Kannada',
  ml: 'Malayalam',
  pa: 'Punjabi',
  id: 'Indonesian',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  tr: 'Turkish',
  it: 'Italian',
};

export const languageName = (code: string) => LANGUAGES[baseLanguage(code)] ?? code.toUpperCase();

/** "en-US" → "en", "zh-Hans" → "zh" */
export const baseLanguage = (code: string) => code.toLowerCase().split(/[-_]/)[0];

/** Script → the languages it can be (only scripts that say something; Latin could be anything). */
const SCRIPTS: [RegExp, string[]][] = [
  [/[ऀ-ॿ]/, ['hi', 'mr']], // Devanagari
  [/[ঀ-৿]/, ['bn']],
  [/[஀-௿]/, ['ta']],
  [/[ఀ-౿]/, ['te']],
  [/[઀-૿]/, ['gu']],
  [/[ಀ-೿]/, ['kn']],
  [/[ഀ-ൿ]/, ['ml']],
  [/[਀-੿]/, ['pa']],
  [/[؀-ۿ]/, ['ar', 'ur']],
  [/[Ѐ-ӿ]/, ['ru']],
  [/[가-힯]/, ['ko']],
  [/[぀-ヿ]/, ['ja']],
  [/[一-鿿]/, ['zh', 'ja']],
];

/** Languages a title's script points to, or null when it can't tell (e.g. plain Latin letters). */
export function scriptLanguages(text: string): string[] | null {
  const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, '');
  if (!letters) return null;
  for (const [re, langs] of SCRIPTS) {
    const hits = (letters.match(new RegExp(re.source, 'g')) ?? []).length;
    if (hits / letters.length >= 0.3) return langs;
  }
  return null;
}

/**
 * Does a video fit the chosen languages? `spoken` = YouTube's auto-caption language when known.
 * Returns null when it fits (or can't be told yet), or a short reason to skip it.
 */
export function languageMismatch(chosen: string[] | undefined, spoken: string | null, title: string): string | null {
  if (!chosen?.length) return null;
  const want = new Set(chosen.map(baseLanguage));
  const names = chosen.map(languageName).join(', ');
  if (spoken) return want.has(baseLanguage(spoken)) ? null : `Spoken in ${languageName(spoken)} — you chose ${names}`;
  const guess = scriptLanguages(title);
  if (guess && !guess.some((g) => want.has(g))) return `Title is in ${languageName(guess[0])} — you chose ${names}`;
  return null;
}

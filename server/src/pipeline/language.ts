import { config } from '../config.js';
import { generateJson, part } from './gemini.js';

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

// ---------------- a country picked for a topic → the languages people there watch ----------------

/**
 * The spoken languages most of a country's YouTube is in (codes from LANGUAGES). A topic searched "in India" still
 * turns up Spanish or Portuguese videos — YouTube's region setting only leans the results — so when someone picks a
 * country and no language, these are the languages kept. Keep in sync with web/src/features/autopilot/helpers.ts.
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

/**
 * The languages an autopilot keeps to: the ones picked; or, with none picked and every source a topic in a country,
 * those countries' languages. Undefined = any language (a channel source means "this creator's videos, whatever
 * language").
 */
export function effectiveLanguages(chosen: string[] | undefined, sources: { kind: string; region?: string | null }[]): string[] | undefined {
  if (chosen?.length) return chosen;
  if (!sources.length || sources.some((s) => s.kind !== 'youtube_topic' || !s.region || !REGION_LANGUAGES[s.region])) return undefined;
  return [...new Set(sources.flatMap((s) => REGION_LANGUAGES[s.region!]))];
}

// ---------------- when YouTube has no captions: ask the AI from the words ----------------

const guesses = new Map<string, { lang: string | null; sure: boolean }>();

/**
 * The language a video is most likely spoken in, from its title and description — used only when YouTube has no
 * auto-captions to tell us (a Spanish title in Latin letters looks like English to the script check above).
 * One tiny call to the fast model, remembered per video. Returns null when it can't tell with confidence.
 */
export async function guessSpokenLanguage(title: string, description: string): Promise<string | null> {
  const text = `${title}\n${description.slice(0, 600)}`.trim();
  if (text.length < 4 || config.fakeAi) return null;
  const key = text.slice(0, 200);
  const hit = guesses.get(key);
  if (hit) return hit.sure ? hit.lang : null;
  try {
    const raw = await generateJson<{ language?: string; confidence?: number }>({
      model: config.fastModel,
      system:
        'You tell which language a YouTube video is SPOKEN in, from its title and description. Answer with the ISO 639-1 code (en, hi, es, pt…) and how sure you are, 0–1. Creator names, hashtags and brand names say nothing; the sentences do. Hinglish (Hindi written in Latin letters) is "hi".',
      parts: [part.text(text)],
      schema: { type: 'object', properties: { language: { type: 'string' }, confidence: { type: 'number' } }, required: ['language', 'confidence'] },
      maxOutputTokens: 100,
      timeoutMs: 20_000,
      label: 'guess the spoken language',
    });
    const lang = raw.language ? baseLanguage(String(raw.language)) : null;
    const sure = Boolean(lang && /^[a-z]{2}$/.test(lang) && (Number(raw.confidence) || 0) >= 0.7);
    guesses.set(key, { lang, sure });
    if (guesses.size > 2000) for (const k of [...guesses.keys()].slice(0, 500)) guesses.delete(k);
    return sure ? lang : null;
  } catch (e) {
    console.warn('[language] guess failed:', (e as Error).message);
    return null;
  }
}

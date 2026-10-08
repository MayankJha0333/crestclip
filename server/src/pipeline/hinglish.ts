/**
 * Hindi in Devanagari → Hinglish (Hindi in English letters, the way people type it in chat: "kya baat hai").
 *
 * The AI writes Hinglish itself when it transcribes or writes hooks; this is the safety net for text that reaches a
 * clip still in Devanagari — the site's own captions used as they are (when a clip's own transcription was too slow),
 * a hook or keyword the AI left in Devanagari. Plain rules, no AI call, so it can't be slow or fail.
 *
 * Spelling follows chat habits rather than a formal standard: the silent "a" is dropped as Hindi speakers drop it
 * ("samajhna", not "samajhana"), long vowels are mostly written short ("rakhi", "biwi", "malik" — but "baat",
 * "kaam" in one-syllable words), व is "w" ("wala"), ड़ is "d" ("chhod do"), nasal vowels end in "n" ("main", "hoon").
 */

const VOWELS: Record<string, string> = {
  'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o', 'ऍ': 'e',
};
const SIGNS: Record<string, string> = {
  'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e',
};
const CONSONANTS: Record<string, string> = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n', 'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh',
  'ष': 'sh', 'स': 's', 'ह': 'h', 'ळ': 'l',
  // with a nukta, as one character
  'क़': 'q', 'ख़': 'kh', 'ग़': 'gh', 'ज़': 'z', 'ड़': 'd', 'ढ़': 'dh', 'फ़': 'f', 'य़': 'y',
};
// with a nukta written as two characters
// (ड़ is "d" as typed in chat: "chhod do", "kapde", "karod")
const NUKTA: Record<string, string> = { 'क': 'q', 'ख': 'kh', 'ग': 'gh', 'ज': 'z', 'ड': 'd', 'ढ': 'dh', 'फ': 'f' };
const VIRAMA = '्';
const ANUSVARA = 'ं';
const CHANDRABINDU = 'ँ';
const VISARGA = 'ः';
const NUKTA_SIGN = '़';
const DIGITS = '०१२३४५६७८९';

const DEVANAGARI = /[ऀ-ॿ]/;
export const hasDevanagari = (s: string) => DEVANAGARI.test(s);

/** One unit of a word: a consonant (with its vowel, or none after a virama) or a standalone vowel. */
interface Unit {
  c: string | null; // consonant, romanised
  v: string | null; // vowel: a sign, the inherent "a" ('A' marks it until schwa deletion), or null (virama)
  nasal: boolean;
  visarga: boolean;
}

function romanizeWord(word: string): string {
  const units: Unit[] = [];
  const chars = [...word];
  let out = '';
  const flush = () => {
    if (!units.length) return;
    // the silent "a": from the right, an inherent a is dropped at the end of a word (after more than one unit), and
    // in the middle when a vowel comes before it and the next consonant carries a vowel of its own
    for (let i = units.length - 1; i >= 1; i--) {
      const u = units[i];
      if (u.v !== 'A' || u.nasal) continue;
      const prev = units[i - 1];
      if (i === units.length - 1) {
        // kept after a cluster ending in r/y/w/l ("mitra", "satya"), dropped after any other ("dost", "rost")
        if (prev.v !== null || !/^(r|y|v|l)$/.test(u.c ?? '')) u.v = '';
        continue;
      }
      const next = units[i + 1];
      // kept after a nasal: dropping it would stack three consonants ("zindagi", not "zindgi")
      if (prev.v !== null && prev.v !== '' && !prev.nasal && next.c && next.v !== null && next.v !== '') u.v = '';
    }
    const syllables = units.filter((u) => u.v !== null && u.v !== '').length;
    units.forEach((u, i) => {
      let v = u.v === 'A' ? 'a' : (u.v ?? '');
      const last = i === units.length - 1;
      const nextVowel = units[i + 1] && !units[i + 1].c;
      // chat spelling: long ā is "aa" only in one-syllable words ("baat", "kaam", "aaj"), else "a" ("rakhi", "malik");
      // ī is "i" ("biwi", "nahi"); ū is "oo" in one-syllable words ("hoon"), else "u"
      if (v === 'aa' && (syllables > 1 || last || nextVowel)) v = 'a';
      if (v === 'ee') v = 'i';
      if (v === 'oo' && syllables > 1) v = 'u';
      // व is "w" ("wala", "sawant", "biwi"), but "v" at the start before i ("vishwas")
      let c = u.c ?? '';
      if (c === 'v' && !(i === 0 && /^(i|ee)$/.test(u.v ?? ''))) c = 'w';
      out += c + v;
      if (u.nasal) {
        const next = units[i + 1]?.c ?? '';
        out += /^(p|b|bh|m)$/.test(next) ? 'm' : 'n';
      }
      if (u.visarga) out += 'h';
    });
    units.length = 0;
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (CONSONANTS[ch] !== undefined) {
      let c = CONSONANTS[ch];
      if (chars[i + 1] === NUKTA_SIGN) {
        c = NUKTA[ch] ?? c;
        i++;
      }
      units.push({ c, v: 'A', nasal: false, visarga: false });
    } else if (VOWELS[ch] !== undefined) {
      units.push({ c: null, v: VOWELS[ch], nasal: false, visarga: false });
    } else if (SIGNS[ch] !== undefined && units.length) {
      units[units.length - 1].v = SIGNS[ch];
    } else if (ch === VIRAMA && units.length) {
      units[units.length - 1].v = null;
    } else if ((ch === ANUSVARA || ch === CHANDRABINDU) && units.length) {
      const u = units[units.length - 1];
      if (u.v === 'A') u.v = 'a';
      u.nasal = true;
    } else if (ch === VISARGA && units.length) {
      units[units.length - 1].visarga = true;
    } else if (DIGITS.includes(ch)) {
      flush();
      out += String(DIGITS.indexOf(ch));
    } else if (ch === '।' || ch === '॥') {
      flush();
      out += '.';
    } else {
      flush();
      out += ch;
    }
  }
  flush();
  return out;
}

/** Devanagari words in `text` written in Hinglish; everything else (English words, numbers, emoji) left as it is. */
export function toHinglish(text: string): string {
  if (!hasDevanagari(text)) return text;
  return text.replace(/[ऀ-ॿ]+/g, (w) => romanizeWord(w));
}

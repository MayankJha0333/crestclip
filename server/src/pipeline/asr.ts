import type { Segment } from '../types.js';
import type { TimedWord } from './ytdlp.js';

/**
 * "Captions first": the video site's own speech recognition (YouTube's automatic captions) as the first transcript.
 *
 * It arrives in one small request and already says when every word is spoken, so the moments of a 2-hour video can
 * be found without downloading its audio or transcribing it. The words have no punctuation or speaker labels, which
 * is fine for finding moments; the clip parts are transcribed properly (clean phrasing, the chosen script) just
 * before they're rendered, and their words snap back onto these measured times.
 */

const GAP = 0.6; // a pause this long ends a phrase
const MAX_WORDS = 8;
const SILENCE = 0.5; // a gap between words this long counts as a pause (for snapping clip edges to pauses)

/** Phrases from the timed words. */
export function draftTranscript(words: TimedWord[], duration: number): { segments: Segment[]; silences: { s: number; e: number }[] } {
  const segments: Segment[] = [];
  let cur: TimedWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((w) => w.w).join(' ');
    segments.push({
      s: +cur[0].s.toFixed(3),
      e: +cur[cur.length - 1].e.toFixed(3),
      text: text.charAt(0).toUpperCase() + text.slice(1),
      words: cur.map((w) => ({ w: w.w, s: +w.s.toFixed(3), e: +w.e.toFixed(3) })),
      timed: true,
    });
    cur = [];
  };
  for (const w of words) {
    if (!w.w || w.s > duration) continue;
    const prev = cur[cur.length - 1];
    if (prev && (w.s - prev.e >= GAP || cur.length >= MAX_WORDS)) flush();
    cur.push({ ...w, e: Math.min(w.e, duration) });
  }
  flush();

  const silences: { s: number; e: number }[] = [];
  let t = 0;
  for (const w of words) {
    if (w.s - t >= SILENCE) silences.push({ s: +t.toFixed(3), e: +w.s.toFixed(3) });
    t = Math.max(t, w.e);
  }
  if (duration - t >= SILENCE) silences.push({ s: +t.toFixed(3), e: +duration.toFixed(3) });
  return { segments, silences };
}

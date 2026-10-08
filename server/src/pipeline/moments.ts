import { config } from '../config.js';
import { scriptLanguages } from './language.js';
import { generateJson, part } from './gemini.js';
import { formatTime, rangeScore } from './signals.js';
import type { ClipCandidate, Keyword, LengthPref, ProjectOptions, Rubric, Segment, Signals, TimeRange } from '../types.js';
import type { Part } from '@google/genai';

/** Scoring rubric distilled from platform docs + creator data (see docs/RESEARCH.md). */
export const RUBRIC_WEIGHTS: Rubric = {
  hook: 0.2,
  standalone: 0.15,
  payoff: 0.15,
  emotion: 0.15,
  shareability: 0.1,
  pacing: 0.1,
  loop: 0.05,
  lengthFit: 0.05,
  trend: 0.05,
};

/** The length rule for a project: an exact min/max (campaign briefs) wins over the general preference. */
export function rangeFor(o: Pick<ProjectOptions, 'length' | 'minSeconds' | 'maxSeconds'>) {
  if (o.minSeconds && o.maxSeconds && o.maxSeconds > o.minSeconds) return { min: o.minSeconds, max: o.maxSeconds, label: `${o.minSeconds}–${o.maxSeconds} seconds (required by the campaign)` };
  return lengthRange(o.length);
}

/**
 * Clip length for each choice. Auto aims for 20–45 s, where short clips keep the most viewers to the end
 * (third-party TikTok data: 21–34 s clips finish ~62% vs ~48% for 60 s+), and only runs longer when the story needs it.
 */
function lengthRange(pref: LengthPref): { min: number; max: number; label: string } {
  if (pref === 'short') return { min: 12, max: 30, label: '12–30 seconds' };
  if (pref === 'medium') return { min: 30, max: 60, label: '30–60 seconds' };
  if (pref === 'long') return { min: 60, max: 150, label: '60–150 seconds' };
  return { min: 18, max: 60, label: '20–45 seconds — short clips keep the most viewers to the end. Go up to 60 seconds ONLY when the story truly needs it' };
}

const clipSchema = {
  type: 'object',
  properties: {
    notes: { type: 'string', description: 'one or two sentences about what this video is and where its best moments are' },
    video_title: { type: 'string', description: 'a natural title for the whole video, as its creator might name it, in English (<= 70 chars, no hashtags)' },
    clips: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number', description: 'seconds; must be the start of the first word of the hook sentence' },
          end: { type: 'number', description: 'seconds; right after the payoff lands' },
          title: { type: 'string', description: 'post title in English (always English, whatever is spoken), <= 70 chars, curiosity-driven, no clickbait lies' },
          hook: { type: 'string', description: 'the best on-screen headline for the first 3 seconds, <= 8 words' },
          hooks: { type: 'array', items: { type: 'string' }, description: 'exactly 3 different headline options (<= 8 words each), each from a different angle; the first equals `hook`' },
          keywords: {
            type: 'array',
            description: '3-8 single words spoken in this clip that carry its meaning, in the order they are said, each with one fitting emoji',
            items: { type: 'object', properties: { w: { type: 'string' }, emoji: { type: 'string' } }, required: ['w', 'emoji'] },
          },
          teaser_start: { type: 'number', description: 'seconds; start of the cold-open tease line, or -1' },
          teaser_end: { type: 'number', description: 'seconds; end of the cold-open tease line, or -1' },
          description: { type: 'string', description: '1-2 sentence post caption with a question or CTA to drive comments' },
          hashtags: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string', description: 'why this will hold attention and get shared, in plain words (<= 30 words)' },
          category: { type: 'string', enum: ['humor', 'insight', 'story', 'controversy', 'emotional', 'educational', 'surprising', 'relatable'] },
          hook_s: { type: 'number' },
          standalone: { type: 'number' },
          payoff: { type: 'number' },
          emotion: { type: 'number' },
          shareability: { type: 'number' },
          pacing: { type: 'number' },
          loop: { type: 'number' },
          length_fit: { type: 'number' },
          trend: { type: 'number' },
        },
        required: [
          'start',
          'end',
          'title',
          'hook',
          'hooks',
          'keywords',
          'teaser_start',
          'teaser_end',
          'description',
          'hashtags',
          'reason',
          'category',
          'hook_s',
          'standalone',
          'payoff',
          'emotion',
          'shareability',
          'pacing',
          'loop',
          'length_fit',
          'trend',
        ],
      },
    },
  },
  required: ['clips'],
};

const SYSTEM = `You are CrestClip, a world-class short-form video editor who has cut thousands of viral clips from podcasts, interviews, streams and talks for TikTok, YouTube Shorts and Instagram Reels.

Your job: find the moments that will make strangers STOP scrolling, WATCH to the end, REWATCH, and SEND the clip to a friend.
Platforms rank short videos mainly by watch time / completion / replays and by shares ("sends"). Plain re-uploads are penalized, so each clip must stand on its own as a complete mini-story.

Rules for every clip:
1. START on the hook — the most intense, surprising or curiosity-creating sentence. Never start on setup, greetings, "so", "um", or mid-sentence.
2. It must make sense to someone who never saw the full video. Avoid clips that depend on "as I said earlier", or unresolved "he/they/that".
3. One idea, one payoff (punchline, reveal, strong opinion, useful takeaway). END right after the payoff lands — never mid-sentence, never trailing into a new topic.
4. Prefer moments with emotion: laughter, disagreement, surprise, vulnerability, a bold claim, a counter-intuitive fact, a relatable struggle.
5. Clips must not overlap each other by more than a few seconds. Spread across the whole video.
6. Use ONLY timestamps that exist in the transcript. Start/end should line up with the transcript line boundaries.

PACKAGING for every clip:
- hooks: 3 on-screen headlines from different angles (curiosity gap, bold claim, direct question). Short, concrete, no clickbait lies, no hashtags. The first one is your best and equals "hook".
- keywords: 3-8 words the speaker actually SAYS in the clip that carry the meaning — numbers, names, strong verbs and adjectives ("failed", "$10,000", "fired"). Never filler ("the", "really", "like"). One emoji each that fits the word.
- teaser (cold open): the single punchiest line INSIDE the clip — the punchline, reveal or most shocking sentence, 1-3 seconds, ideally from the second half — to flash for ~1.5 s before the clip starts, so viewers stay to see how it happens. It must be a complete phrase that makes people curious, not confused. Use -1 for teaser_start and teaser_end when no line works as a tease.

AUDIENCE DATA: when "audience hotspots" are given, they come from YouTube's "Most replayed" graph and viewers' timestamp comments — these are moments real viewers re-watched. Strongly prefer clips that contain a hotspot, but still apply the rules above (a hotspot is where to look, not an exact cut).

Score each clip 0-10 on:
- hook_s: does the first ~3 s contain a claim, question, conflict, surprising fact or open loop?
- standalone: understandable with zero context?
- payoff: clear punchline / reveal / takeaway that lands before the end?
- emotion: intensity of the strongest emotional moment?
- shareability: would someone DM this to a friend (hot take, useful insight, relatable, quotable)?
- pacing: no dead air or slow wind-up; something new every few seconds?
- loop: ends cleanly or flows back into the start?
- length_fit: ends at its natural finish within the requested length?
- trend: touches a current topic, well-known person, or searchable keyword?
Be a harsh, honest critic: average moments score 4-6; only truly great ones get 8+.`;

function transcriptForPrompt(segs: Segment[]): string {
  // group phrases into readable lines (~ sentence) with timestamps
  const lines: string[] = [];
  let cur: Segment[] = [];
  const flush = () => {
    if (!cur.length) return;
    const s = cur[0].s;
    const e = cur[cur.length - 1].e;
    const sp = cur[0].speaker ? `${cur[0].speaker}: ` : '';
    lines.push(`[${s.toFixed(1)}-${e.toFixed(1)}] ${sp}${cur.map((c) => c.text).join(' ')}`);
    cur = [];
  };
  for (const seg of segs) {
    if (cur.length && (seg.speaker !== cur[0].speaker || seg.e - cur[0].s > 14)) flush();
    cur.push(seg);
    if (/[.!?…]["')\]]?$/.test(seg.text)) flush();
  }
  flush();
  return lines.join('\n');
}

/**
 * How the AI should write titles, hooks and descriptions for this project. Titles (the clip's label in the app, and
 * the video's name) are always English, whatever is spoken; the hook on the video and the post description follow
 * the caption-language choice, so they match what viewers hear.
 */
const ENGLISH_TITLES =
  'WRITE every title (and video_title) in English, always — even when the video is in Hindi or any other language: say the idea in plain English and keep names as they are (no Devanagari or other scripts in titles).';
export function wordingRule(o: Pick<ProjectOptions, 'captionLanguage'>): string {
  const c = o.captionLanguage ?? 'auto';
  if (c === 'english') return 'WRITE title, video_title, hook, hooks and description in English, whatever language is spoken.';
  if (c === 'roman')
    return `${ENGLISH_TITLES} WRITE hook, hooks and description in the language the video is spoken in, but in Latin (English) letters — Hinglish for Hindi ("Ye sach hai?"), the way people type in chat. keywords are copied from the transcript as written there.`;
  return `${ENGLISH_TITLES} WRITE hook, hooks and description in the language the video is spoken in, in its own script (a Hindi video gets Devanagari hooks; an English video English ones). keywords are copied from the transcript as written there.`;
}

/**
 * Safety net for the "titles are always English" rule: any title the AI still wrote in another script (Devanagari,
 * Tamil, Arabic…) is translated to a short English title in one small call. Titles already in Latin letters are left
 * alone. On any error the titles stay as they were.
 */
export async function englishTitles<T extends { title: string }>(items: T[]): Promise<T[]> {
  const todo = items.map((c, i) => ({ i, title: c.title })).filter((x) => x.title && scriptLanguages(x.title));
  if (!todo.length || config.fakeAi) return items;
  try {
    const raw = await generateJson<{ titles: { index: number; title: string }[] }>({
      model: config.fastModel,
      system: 'You translate short video titles into natural, catchy English (<= 70 characters). Keep names of people, shows and places as they are, in Latin letters. Return only English.',
      parts: [part.text(todo.map((x) => `${x.i}: ${x.title}`).join('\n'))],
      schema: {
        type: 'object',
        properties: { titles: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, title: { type: 'string' } }, required: ['index', 'title'] } } },
        required: ['titles'],
      },
      thinking: 'MINIMAL',
      maxOutputTokens: 2000,
      label: 'english titles',
    });
    const byIndex = new Map(
      (raw.titles ?? []).map((t) => [
        Number(t.index),
        String(t.title || '')
          .trim()
          .slice(0, 100),
      ]),
    );
    return items.map((c, i) => {
      const t = byIndex.get(i);
      return t && !scriptLanguages(t) ? { ...c, title: t } : c;
    });
  } catch (e) {
    console.warn('[english titles]', (e as Error).message);
    return items;
  }
}

export async function findMoments(input: {
  segments: Segment[];
  duration: number;
  title: string;
  channel: string;
  description: string;
  signals: Signals | null;
  options: ProjectOptions;
  videoPart: Part | null;
  /** a long video is searched in parallel, one stretch per request: only this stretch's transcript is given */
  window?: { start: number; end: number } | null;
}): Promise<{ clips: ClipCandidate[]; notes: string; videoTitle: string | null }> {
  const { options, duration } = input;
  const range = rangeFor(options);
  const want = Math.max(1, Math.min(30, options.clipCount));
  const ask = Math.min(40, Math.ceil(want * 1.6) + 2);

  if (config.fakeAi) return { clips: fakeMoments(input.segments, duration, range, ask), notes: 'Fake AI mode — clips are placeholders.', videoTitle: null };

  const hot = input.signals?.hotspots?.length
    ? input.signals.hotspots
        .map((h) => `- ${formatTime(h.start)}–${formatTime(h.end)} (${h.start.toFixed(0)}s–${h.end.toFixed(0)}s), strength ${(h.value * 100).toFixed(0)}%, from ${h.source}`)
        .join('\n')
    : 'none available';
  const chapters = input.signals?.chapters?.length ? input.signals.chapters.map((c) => `- ${c.start_time.toFixed(0)}s: ${c.title}`).join('\n') : 'none';

  const prompt = `VIDEO: "${input.title}"${input.channel ? ` by ${input.channel}` : ''}
Duration: ${formatTime(duration)} (${duration.toFixed(0)} s)${input.window ? `\nThis request covers ONLY ${formatTime(input.window.start)}–${formatTime(input.window.end)} of it (the other stretches are searched separately): pick from this stretch, with its real timestamps.` : ''}
Clips are posted to TikTok, YouTube Shorts and Instagram Reels.
Target clip length: ${range.label}. Hard limits: ${range.min}–${range.max} s.
Return the ${ask} best clip candidates, best first.
${wordingRule(options)}
${options.focus ? `Creator's focus request: "${options.focus}" — prioritize moments that match it.` : ''}
${options.rules?.length ? `\nTHE CREATOR'S RULES — every clip MUST follow these (skip moments that would break them):\n${options.rules.map((r) => `- ${r}`).join('\n')}` : ''}
${options.instructions && !options.rules?.length ? `\nTHE CREATOR'S INSTRUCTIONS (follow them):\n${options.instructions.slice(0, 2500)}` : ''}
${input.signals?.curveKind === 'audience' ? `\nAUDIENCE HOTSPOTS (most re-watched moments, strongest first). The first one is THE most re-watched moment of the whole video: one of your clips MUST contain it.\n${hot}` : input.signals?.curveKind === 'energy' ? `\nAUDIO ENERGY SPIKES (laughter/shouting/excitement, weaker signal):\n${hot}` : ''}
\nCHAPTERS:\n${chapters}
${input.description ? `\nVIDEO DESCRIPTION (for context only):\n${input.description.slice(0, 1500)}` : ''}

TRANSCRIPT (format: [start-end seconds] speaker: text):
${transcriptForPrompt(input.segments)}`;

  const parts: Part[] = [];
  if (input.videoPart) parts.push(input.videoPart);
  parts.push(part.text(prompt));

  type Raw = { notes?: string; video_title?: string; clips: (Omit<ClipCandidate, 'rubric'> & Record<string, number>)[] };
  let raw: Raw;
  try {
    raw = await generateJson<Raw>({ system: SYSTEM, parts, schema: clipSchema, thinking: config.momentsThinking, lowMediaRes: true, maxOutputTokens: 40000, label: 'find viral moments' });
  } catch (e) {
    if (!input.videoPart) throw e;
    // Video input can fail (size limits, preview YouTube support) — fall back to transcript + signals only.
    raw = await generateJson<Raw>({ system: SYSTEM, parts: [part.text(prompt)], schema: clipSchema, thinking: config.momentsThinking, maxOutputTokens: 40000, label: 'find viral moments' });
  }

  const clips = parseClips(raw.clips);
  const [named, videoTitle] = await Promise.all([englishTitles(clips), englishTitles([{ title: cleanTitle(raw.video_title) ?? '' }])]);
  return { clips: named, notes: raw.notes ?? '', videoTitle: videoTitle[0].title || null };
}

/**
 * The most re-watched moment must come out as a clip candidate. The picker treats hotspots as hints, so now and then
 * it skips the tallest peak and the person sees their best moment missing from the graph. A small focused call cuts
 * one clip around the #1 audience peak from just that part of the transcript — started alongside the main search,
 * so it costs no extra time — and ensurePeakCandidate adds it when no candidate covers the peak.
 */
export async function startPeakClip(input: {
  segments: Segment[];
  duration: number;
  title: string;
  channel: string;
  signals: Signals | null;
  options: ProjectOptions;
}): Promise<ClipCandidate | null> {
  const { segments, duration, signals, options } = input;
  if (config.fakeAi || !signals || signals.curveKind !== 'audience' || !signals.hotspots.length || !segments.length) return null;
  const top = signals.hotspots[0];
  const mid = (top.start + top.end) / 2;

  const range = rangeFor(options);
  const pad = Math.max(range.max * 1.5, 60);
  const around = segments.filter((s) => s.e >= top.start - pad && s.s <= top.end + pad);
  if (around.length < 2) return null;
  const prompt = `VIDEO: "${input.title}"${input.channel ? ` by ${input.channel}` : ''}
Duration: ${formatTime(duration)} (${duration.toFixed(0)} s)
Clips are posted to TikTok, YouTube Shorts and Instagram Reels.
Target clip length: ${range.label}. Hard limits: ${range.min}–${range.max} s.

THE MOST RE-WATCHED MOMENT of this video, by its own viewers, is ${formatTime(top.start)}–${formatTime(top.end)} (${top.start.toFixed(0)}s–${top.end.toFixed(0)}s).
Return exactly 1 clip. It MUST contain that moment (or at least the second ${mid.toFixed(0)}s), start on the hook that sets it up and end right after it pays off. Follow every rule above about edges.
${wordingRule(options)}
${options.rules?.length ? `\nTHE CREATOR'S RULES — the clip MUST follow these:\n${options.rules.map((r) => `- ${r}`).join('\n')}` : ''}

TRANSCRIPT AROUND IT (format: [start-end seconds] speaker: text):
${transcriptForPrompt(around)}`;
  type Raw = { notes?: string; clips: (Omit<ClipCandidate, 'rubric'> & Record<string, number>)[] };
  try {
    const raw = await generateJson<Raw>({
      system: SYSTEM,
      parts: [part.text(prompt)],
      schema: clipSchema,
      thinking: 'LOW',
      maxOutputTokens: 6000,
      timeoutMs: 2 * 60_000,
      label: 'clip the top replay peak',
    });
    const got = parseClips(raw.clips).filter((c) => c.end > c.start && c.start <= top.end && c.end >= top.start);
    if (!got.length) return null;
    return { ...got[0], reason: `The most re-watched moment of the video. ${got[0].reason}`.trim() };
  } catch (e) {
    console.warn('[moments] clipping the top replay peak failed:', (e as Error).message);
    return null;
  }
}

/** The candidates, plus the peak clip (see startPeakClip) when none of them covers the #1 audience peak. */
export function ensurePeakCandidate(clips: ClipCandidate[], peak: ClipCandidate | null, signals: Signals | null): ClipCandidate[] {
  if (!peak || !signals?.hotspots.length) return clips;
  const top = signals.hotspots[0];
  if (clips.some((c) => c.start <= top.end && c.end >= top.start && c.end - c.start > 0)) return clips;
  console.log(`[moments] top replay peak ${formatTime(top.start)}–${formatTime(top.end)} had no candidate — added ${formatTime(peak.start)}–${formatTime(peak.end)}`);
  return [peak, ...clips];
}

function parseClips(list: (Omit<ClipCandidate, 'rubric'> & Record<string, number>)[] | undefined): ClipCandidate[] {
  return (list || []).map((c) => ({
    start: Number(c.start) || 0,
    end: Number(c.end) || 0,
    title: String(c.title || '').slice(0, 100),
    hook: String(c.hook || '').slice(0, 80),
    hooks: parseHooks(c.hook, c.hooks),
    keywords: parseKeywords(c.keywords),
    teaser: Number(c.teaser_start) >= 0 && Number(c.teaser_end) > Number(c.teaser_start) ? { start: Number(c.teaser_start), end: Number(c.teaser_end) } : null,
    description: String(c.description || ''),
    hashtags: (Array.isArray(c.hashtags) ? c.hashtags : []).map((h) => '#' + String(h).replace(/^#+/, '').replace(/\s+/g, '')).slice(0, 6),
    reason: String(c.reason || ''),
    category: String(c.category || 'insight'),
    rubric: {
      hook: clamp10(c.hook_s),
      standalone: clamp10(c.standalone),
      payoff: clamp10(c.payoff),
      emotion: clamp10(c.emotion),
      shareability: clamp10(c.shareability),
      pacing: clamp10(c.pacing),
      loop: clamp10(c.loop),
      lengthFit: clamp10(c.length_fit),
      trend: clamp10(c.trend),
    },
  }));
}

/** The AI's title for the whole video, tidied (null when it gave none). */
export const cleanTitle = (t: unknown): string | null => {
  const s = String(t ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^["“”']+|["“”']+$/g, '')
    .trim();
  return s.length >= 4 ? s.slice(0, 90) : null;
};

/**
 * Is this title just a file name's junk (an upload called "6AA26DA6 8EC2 404C…", "IMG 4021", "video")? Then the AI's
 * title for the video is better.
 */
export function junkTitle(t: string | null | undefined): boolean {
  const s = (t ?? '').trim();
  if (s.length < 4) return true;
  if (/^[0-9a-f\s_-]{12,}$/i.test(s)) return true; // hex ids, uuids
  if (/^(img|vid|video|mov|dsc|pxl|screen ?recording|untitled|source|download|final|export|clip|render)[\s_\d.-]*$/i.test(s)) return true;
  if (/^[\d\s._:-]+$/.test(s)) return true; // "2026 10 06 14 20 11"
  return false;
}

const clamp10 = (v: unknown) => Math.max(0, Math.min(10, Number(v) || 0));

/** Up to 3 distinct headline options, the main hook first. */
function parseHooks(hook: unknown, hooks: unknown): string[] {
  const list = [hook, ...(Array.isArray(hooks) ? hooks : [])]
    .map((h) =>
      String(h ?? '')
        .trim()
        .slice(0, 80),
    )
    .filter(Boolean);
  return [...new Map(list.map((h) => [h.toLowerCase(), h])).values()].slice(0, 3);
}

/** Key words: one word each (lower-case, no punctuation), one short emoji, no repeats, at most 8. */
function parseKeywords(v: unknown): Keyword[] {
  const out: Keyword[] = [];
  for (const k of Array.isArray(v) ? v : []) {
    const w = String((k as Keyword)?.w ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}$%'-]/gu, '');
    const emoji = [...String((k as Keyword)?.emoji ?? '').trim()].slice(0, 2).join('');
    if (w.length < 2 || out.some((x) => x.w === w)) continue;
    out.push(emoji ? { w, emoji } : { w });
  }
  return out.slice(0, 8);
}

/**
 * Check and tidy the AI's tease line against the final clip: it must sit inside the clip (not at its very start,
 * which would just repeat the opening), last 0.8–3.5 s, and end in a real pause so no word is cut off.
 */
function fitTeaser(t: TimeRange | null | undefined, start: number, end: number, silences: { s: number; e: number }[]): TimeRange | null {
  if (!t) return null;
  let s = Math.max(start, t.start - 0.1);
  if (s < start + 2.5 || s > end - 0.8) return null;
  const pause = silences.find((x) => x.s >= s + 0.8 && x.s <= s + 3.5 && x.s >= t.end - 0.6);
  const e = pause ? pause.s + 0.1 : Math.min(t.end + 0.15, end);
  if (e - s < 0.8 || e - s > 3.6) return null;
  s = +s.toFixed(3);
  return { start: s, end: +e.toFixed(3) };
}

export function aiScore(r: Rubric): number {
  let s = 0;
  for (const k of Object.keys(RUBRIC_WEIGHTS) as (keyof Rubric)[]) s += r[k] * RUBRIC_WEIGHTS[k];
  return Math.round(s * 10);
}

/** A clip with its final times and scores. */
export type ScoredClip = ClipCandidate & { aiScore: number; audienceScore: number | null; peakScore: number };

/**
 * Final edges for each candidate: on sentence boundaries (never mid-word), inside the length range. Drops ones that
 * can't fit. Then the judge re-grades them, and rankClips scores, de-duplicates and keeps the best N.
 */
export function snapClips(cands: ClipCandidate[], segs: Segment[], silences: { s: number; e: number }[], duration: number, options: ProjectOptions): ClipCandidate[] {
  const range = rangeFor(options);
  const minLen = Math.max(5, range.min * 0.8);
  const maxLen = range.max * 1.15;
  const out: ClipCandidate[] = [];
  for (const c of cands) {
    if (!(c.end > c.start) || c.start >= duration) continue;
    let { start, end } = snap(c.start, c.end, segs, silences, duration);
    if (end - start > maxLen) end = snapEnd(start + maxLen, segs, silences, duration, start);
    if (end - start < minLen) end = snapEnd(Math.min(duration, start + minLen), segs, silences, duration, start);
    if (end - start < 3) continue;
    if (end - start < minLen * 0.75 && duration > minLen * 1.5) continue; // too short to stand alone
    if (end - start > maxLen + 4) end = start + maxLen;
    out.push({ ...c, start: +start.toFixed(3), end: +end.toFixed(3), teaser: fitTeaser(c.teaser, start, end, silences) });
  }
  return out;
}

/** Score from the rubric (+ audience data), drop overlapping picks (the higher score stays), keep the best N. */
export function rankClips(clips: ClipCandidate[], signals: Signals | null, duration: number, options: ProjectOptions): ScoredClip[] {
  const out: ScoredClip[] = clips.map((c) => {
    const ai = aiScore(c.rubric);
    const aud = rangeScore(signals, duration, c.start, c.end);
    const isAudience = signals?.curveKind === 'audience';
    const peak = aud == null ? ai : isAudience ? Math.round(ai * 0.6 + aud * 0.4) : Math.round(ai * 0.88 + aud * 0.12);
    return { ...c, aiScore: ai, audienceScore: aud, peakScore: peak };
  });
  out.sort((a, b) => b.peakScore - a.peakScore);
  const kept: ScoredClip[] = [];
  for (const c of out) {
    const clash = kept.some((k) => overlap(k, c) > 0.35 * Math.min(k.end - k.start, c.end - c.start));
    if (!clash) kept.push(c);
  }
  return kept.slice(0, Math.max(1, options.clipCount));
}

function overlap(a: { start: number; end: number }, b: { start: number; end: number }) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/** Snap a hand-picked range to real sentence edges (never starts or ends mid-word). */
export function snapRange(start: number, end: number, segs: Segment[], silences: { s: number; e: number }[], duration: number) {
  return snap(start, end, segs, silences, duration);
}

function snap(start: number, end: number, segs: Segment[], silences: { s: number; e: number }[], duration: number) {
  // START: the segment whose start is closest to the proposed start (within 2.5 s)
  let bestStart = start;
  let bd = Infinity;
  for (const s of segs) {
    const d = Math.abs(s.s - start);
    if (d < bd && d <= 2.5) {
      bd = d;
      bestStart = s.s;
    }
  }
  // lead-in: start a hair before the first word, but inside the preceding pause if there is one
  const pause = silences.find((x) => x.e >= bestStart - 0.6 && x.e <= bestStart + 0.15);
  const s0 = Math.max(0, pause ? Math.max(pause.s, bestStart - 0.25) : bestStart - 0.12);
  return { start: s0, end: snapEnd(end, segs, silences, duration, s0) };
}

function snapEnd(end: number, segs: Segment[], silences: { s: number; e: number }[], duration: number, start: number) {
  let best = end;
  let bd = Infinity;
  for (const s of segs) {
    if (s.e <= start + 2) continue;
    const d = Math.abs(s.e - end);
    // prefer sentence endings
    const penalty = /[.!?…]["')\]]?$/.test(s.text) ? 0 : 0.8;
    if (d + penalty < bd && d <= 3) {
      bd = d + penalty;
      best = s.e;
    }
  }
  const nextWord = segs.find((s) => s.s > best - 0.01);
  const tail = Math.min(best + 0.35, nextWord ? Math.max(best, nextWord.s - 0.05) : best + 0.35);
  const pause = silences.find((x) => x.s <= best + 0.2 && x.e >= best);
  return Math.min(duration, pause ? Math.min(pause.e, best + 0.45) : tail);
}

function fakeMoments(segs: Segment[], duration: number, range: { min: number; max: number }, n: number): ClipCandidate[] {
  const len = Math.min((range.min + range.max) / 2, duration * 0.8);
  const res: ClipCandidate[] = [];
  const step = Math.max(len + 1, (duration - len) / Math.max(1, n));
  for (let t = 0.5, i = 0; t + Math.min(len, 6) <= duration && i < n; t += step, i++) {
    const seg = segs.find((s) => s.s >= t) ?? segs[0];
    const r = (k: number) => 4 + ((i * 7 + k * 3) % 6);
    res.push({
      start: seg?.s ?? t,
      end: Math.min(duration, (seg?.s ?? t) + len),
      title: ['The one tweet that changed everything', 'Why ads failed us (and what worked)', 'Stop selling, start teaching'][i % 3],
      hook: ['Nobody tells you this', 'Ads completely failed us', 'The whole secret'][i % 3],
      hooks: [
        ['Nobody tells you this', 'The startup truth nobody shares', 'Why are the first users so hard?'],
        ['Ads completely failed us', 'We burned our ad budget', 'Do ads even work anymore?'],
        ['The whole secret', 'Stop selling. Start teaching.', 'What actually grew us?'],
      ][i % 3],
      keywords: [
        { w: 'failed', emoji: '💀' },
        { w: 'tweet', emoji: '🐦' },
        { w: 'numbers', emoji: '📈' },
        { w: 'teaching', emoji: '📚' },
        { w: 'secret', emoji: '🤫' },
      ],
      teaser: (() => {
        const s0 = seg?.s ?? t;
        const late = segs.find((x) => x.s > s0 + len * 0.55 && x.e < s0 + len - 0.5);
        return late ? { start: late.s, end: Math.min(late.e, late.s + 2.8) } : null;
      })(),
      description: 'Would you try this? Tell me below 👇',
      hashtags: ['#startup', '#growth', '#founder'],
      reason: 'Strong opening claim, clear payoff, relatable founder struggle.',
      category: 'insight',
      rubric: { hook: r(1), standalone: r(2), payoff: r(3), emotion: r(4), shareability: r(5), pacing: r(6), loop: r(7), lengthFit: 8, trend: r(8) },
    });
  }
  return res;
}

// ---------------- clips the user picked by hand ----------------
const describeSchema = {
  type: 'object',
  properties: {
    clips: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          title: clipSchema.properties.clips.items.properties.title,
          hook: clipSchema.properties.clips.items.properties.hook,
          hooks: clipSchema.properties.clips.items.properties.hooks,
          keywords: clipSchema.properties.clips.items.properties.keywords,
          description: clipSchema.properties.clips.items.properties.description,
          hashtags: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string', description: 'what makes this moment work (or what would make it stronger), plain words, <= 30 words' },
          category: clipSchema.properties.clips.items.properties.category,
          hook_s: { type: 'number' },
          standalone: { type: 'number' },
          payoff: { type: 'number' },
          emotion: { type: 'number' },
          shareability: { type: 'number' },
          pacing: { type: 'number' },
          loop: { type: 'number' },
          length_fit: { type: 'number' },
          trend: { type: 'number' },
        },
        required: [
          'index',
          'title',
          'hook',
          'hooks',
          'keywords',
          'description',
          'hashtags',
          'reason',
          'category',
          'hook_s',
          'standalone',
          'payoff',
          'emotion',
          'shareability',
          'pacing',
          'loop',
          'length_fit',
          'trend',
        ],
      },
    },
  },
  required: ['clips'],
};

type Described = Pick<ClipCandidate, 'title' | 'hook' | 'hooks' | 'keywords' | 'description' | 'hashtags' | 'reason' | 'category' | 'rubric'>;

/** Titles, hooks, hashtags and an honest score for clips the user picked on the graph (Gemini, fast model). */
export async function describeClips(input: {
  title: string;
  channel: string;
  options: ProjectOptions;
  clips: { parts: { start: number; end: number }[]; segments: Segment[] }[];
}): Promise<Described[]> {
  const fallback = (i: number): Described => ({
    title: `Your pick #${i + 1}`,
    hook: '',
    description: '',
    hashtags: [],
    reason: 'Picked by you on the graph.',
    category: 'insight',
    rubric: { hook: 5, standalone: 5, payoff: 5, emotion: 5, shareability: 5, pacing: 5, loop: 5, lengthFit: 5, trend: 5 },
  });
  if (config.fakeAi) return input.clips.map((_, i) => ({ ...fallback(i), title: `Hand-picked moment #${i + 1}`, hook: 'Wait for it', hashtags: ['#clip'] }));
  const blocks = input.clips
    .map((c, i) => {
      const where = c.parts.map((p) => `${formatTime(p.start)}–${formatTime(p.end)}`).join(' + ');
      const text = c.segments
        .map((s) => s.text)
        .join(' ')
        .slice(0, 6000);
      return `CLIP ${i}${c.parts.length > 1 ? ` (joined from ${c.parts.length} parts)` : ''} · ${where}\n${text || '(no speech)'}`;
    })
    .join('\n\n');
  const prompt = `VIDEO: "${input.title}"${input.channel ? ` by ${input.channel}` : ''}
Clips are posted to TikTok, YouTube Shorts and Instagram Reels.
The creator hand-picked these moments. Write the packaging for each one (post title, hook options, key words, caption, hashtags) and score it honestly with the rubric. Use "index" = the CLIP number. Set teaser_start and teaser_end to -1 (no teaser for hand-picked clips).
${wordingRule(input.options)}

${blocks}`;
  try {
    const raw = await generateJson<{ clips: (Record<string, unknown> & { index: number })[] }>({
      model: config.fastModel,
      system: SYSTEM,
      parts: [part.text(prompt)],
      schema: describeSchema,
      thinking: 'LOW',
      maxOutputTokens: 12000,
      label: 'write titles for picked clips',
    });
    const described = input.clips.map((_, i) => {
      const c = raw.clips?.find((x) => Number(x.index) === i) ?? raw.clips?.[i];
      if (!c) return fallback(i);
      return {
        title: String(c.title || fallback(i).title).slice(0, 100),
        hook: String(c.hook || '').slice(0, 80),
        hooks: parseHooks(c.hook, c.hooks),
        keywords: parseKeywords(c.keywords),
        description: String(c.description || ''),
        hashtags: (Array.isArray(c.hashtags) ? c.hashtags : []).map((h) => '#' + String(h).replace(/^#+/, '').replace(/\s+/g, '')).slice(0, 6),
        reason: String(c.reason || ''),
        category: String(c.category || 'insight'),
        rubric: {
          hook: clamp10(c.hook_s),
          standalone: clamp10(c.standalone),
          payoff: clamp10(c.payoff),
          emotion: clamp10(c.emotion),
          shareability: clamp10(c.shareability),
          pacing: clamp10(c.pacing),
          loop: clamp10(c.loop),
          lengthFit: clamp10(c.length_fit),
          trend: clamp10(c.trend),
        },
      };
    });
    return await englishTitles(described);
  } catch (e) {
    console.warn('[describe clips]', (e as Error).message);
    return input.clips.map((_, i) => fallback(i));
  }
}

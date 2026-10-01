import { config } from '../config.js';
import { generateJson, part } from './gemini.js';
import { formatTime, rangeScore } from './signals.js';
import type { ClipCandidate, LengthPref, Platform, ProjectOptions, Rubric, Segment, Signals } from '../types.js';
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

export function lengthRange(platform: Platform, pref: LengthPref): { min: number; max: number; label: string } {
  if (pref === 'short') return { min: 12, max: 30, label: '12–30 seconds' };
  if (pref === 'medium') return { min: 30, max: 60, label: '30–60 seconds' };
  if (pref === 'long') return { min: 60, max: 150, label: '60–150 seconds' };
  if (platform === 'shorts') return { min: 18, max: 55, label: '20–50 seconds (YouTube Shorts sweet spot)' };
  if (platform === 'reels') return { min: 25, max: 65, label: '30–60 seconds (Reels sweet spot)' };
  return { min: 30, max: 95, label: '30–90 seconds (TikTok; 60s+ qualifies for Creator Rewards)' };
}

const clipSchema = {
  type: 'object',
  properties: {
    notes: { type: 'string', description: 'one or two sentences about what this video is and where its best moments are' },
    clips: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number', description: 'seconds; must be the start of the first word of the hook sentence' },
          end: { type: 'number', description: 'seconds; right after the payoff lands' },
          title: { type: 'string', description: 'post title, <= 70 chars, curiosity-driven, no clickbait lies' },
          hook: { type: 'string', description: 'on-screen headline shown in the first 3 seconds, <= 8 words' },
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
        required: ['start', 'end', 'title', 'hook', 'description', 'hashtags', 'reason', 'category', 'hook_s', 'standalone', 'payoff', 'emotion', 'shareability', 'pacing', 'loop', 'length_fit', 'trend'],
      },
    },
  },
  required: ['clips'],
};

const SYSTEM = `You are PeakClip, a world-class short-form video editor who has cut thousands of viral clips from podcasts, interviews, streams and talks for TikTok, YouTube Shorts and Instagram Reels.

Your job: find the moments that will make strangers STOP scrolling, WATCH to the end, REWATCH, and SEND the clip to a friend.
Platforms rank short videos mainly by watch time / completion / replays and by shares ("sends"). Plain re-uploads are penalized, so each clip must stand on its own as a complete mini-story.

Rules for every clip:
1. START on the hook — the most intense, surprising or curiosity-creating sentence. Never start on setup, greetings, "so", "um", or mid-sentence.
2. It must make sense to someone who never saw the full video. Avoid clips that depend on "as I said earlier", or unresolved "he/they/that".
3. One idea, one payoff (punchline, reveal, strong opinion, useful takeaway). END right after the payoff lands — never mid-sentence, never trailing into a new topic.
4. Prefer moments with emotion: laughter, disagreement, surprise, vulnerability, a bold claim, a counter-intuitive fact, a relatable struggle.
5. Clips must not overlap each other by more than a few seconds. Spread across the whole video.
6. Use ONLY timestamps that exist in the transcript. Start/end should line up with the transcript line boundaries.

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

export async function findMoments(input: {
  segments: Segment[];
  duration: number;
  title: string;
  channel: string;
  description: string;
  signals: Signals | null;
  options: ProjectOptions;
  videoPart: Part | null;
}): Promise<{ clips: ClipCandidate[]; notes: string }> {
  const { options, duration } = input;
  const range = lengthRange(options.platform, options.length);
  const want = Math.max(1, Math.min(30, options.clipCount));
  const ask = Math.min(40, Math.ceil(want * 1.6) + 2);

  if (config.fakeAi) return { clips: fakeMoments(input.segments, duration, range, ask), notes: 'Fake AI mode — clips are placeholders.' };

  const hot = input.signals?.hotspots?.length
    ? input.signals.hotspots
        .map((h) => `- ${formatTime(h.start)}–${formatTime(h.end)} (${h.start.toFixed(0)}s–${h.end.toFixed(0)}s), strength ${(h.value * 100).toFixed(0)}%, from ${h.source}`)
        .join('\n')
    : 'none available';
  const chapters = input.signals?.chapters?.length
    ? input.signals.chapters.map((c) => `- ${c.start_time.toFixed(0)}s: ${c.title}`).join('\n')
    : 'none';

  const prompt = `VIDEO: "${input.title}"${input.channel ? ` by ${input.channel}` : ''}
Duration: ${formatTime(duration)} (${duration.toFixed(0)} s)
Target platform: ${options.platform === 'shorts' ? 'YouTube Shorts' : options.platform === 'reels' ? 'Instagram Reels' : 'TikTok'}
Target clip length: ${range.label}. Hard limits: ${range.min}–${range.max} s.
Return the ${ask} best clip candidates, best first.
${options.focus ? `Creator's focus request: "${options.focus}" — prioritize moments that match it.` : ''}
${input.signals?.curveKind === 'audience' ? `\nAUDIENCE HOTSPOTS (most re-watched moments):\n${hot}` : input.signals?.curveKind === 'energy' ? `\nAUDIO ENERGY SPIKES (laughter/shouting/excitement, weaker signal):\n${hot}` : ''}
\nCHAPTERS:\n${chapters}
${input.description ? `\nVIDEO DESCRIPTION (for context only):\n${input.description.slice(0, 1500)}` : ''}

TRANSCRIPT (format: [start-end seconds] speaker: text):
${transcriptForPrompt(input.segments)}`;

  const parts: Part[] = [];
  if (input.videoPart) parts.push(input.videoPart);
  parts.push(part.text(prompt));

  type Raw = { notes?: string; clips: (Omit<ClipCandidate, 'rubric'> & Record<string, number>)[] };
  let raw: Raw;
  try {
    raw = await generateJson<Raw>({ system: SYSTEM, parts, schema: clipSchema, thinking: 'MEDIUM', lowMediaRes: true, maxOutputTokens: 40000, label: 'find viral moments' });
  } catch (e) {
    if (!input.videoPart) throw e;
    // Video input can fail (size limits, preview YouTube support) — fall back to transcript + signals only.
    raw = await generateJson<Raw>({ system: SYSTEM, parts: [part.text(prompt)], schema: clipSchema, thinking: 'MEDIUM', maxOutputTokens: 40000, label: 'find viral moments' });
  }

  const clips: ClipCandidate[] = (raw.clips || []).map((c) => ({
    start: Number(c.start) || 0,
    end: Number(c.end) || 0,
    title: String(c.title || '').slice(0, 100),
    hook: String(c.hook || '').slice(0, 80),
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
  return { clips, notes: raw.notes ?? '' };
}

const clamp10 = (v: unknown) => Math.max(0, Math.min(10, Number(v) || 0));

export function aiScore(r: Rubric): number {
  let s = 0;
  for (const k of Object.keys(RUBRIC_WEIGHTS) as (keyof Rubric)[]) s += r[k] * RUBRIC_WEIGHTS[k];
  return Math.round(s * 10);
}

/**
 * Snap clip edges to real speech boundaries so clips never start or end mid-word,
 * enforce the length range, score, de-duplicate and keep the best N.
 */
export function finalizeClips(
  cands: ClipCandidate[],
  segs: Segment[],
  silences: { s: number; e: number }[],
  duration: number,
  signals: Signals | null,
  options: ProjectOptions,
) {
  const range = lengthRange(options.platform, options.length);
  const minLen = Math.max(5, range.min * 0.8);
  const maxLen = range.max * 1.15;
  const out: (ClipCandidate & { aiScore: number; audienceScore: number | null; peakScore: number })[] = [];

  for (const c of cands) {
    if (!(c.end > c.start) || c.start >= duration) continue;
    let { start, end } = snap(c.start, c.end, segs, silences, duration);
    if (end - start > maxLen) end = snapEnd(start + maxLen, segs, silences, duration, start);
    if (end - start < minLen) end = snapEnd(Math.min(duration, start + minLen), segs, silences, duration, start);
    if (end - start < 3) continue;
    if (end - start < minLen * 0.75 && duration > minLen * 1.5) continue; // too short to stand alone
    if (end - start > maxLen + 4) end = start + maxLen;

    const ai = aiScore(c.rubric);
    const aud = rangeScore(signals, duration, start, end);
    const isAudience = signals?.curveKind === 'audience';
    const peak = aud == null ? ai : isAudience ? Math.round(ai * 0.6 + aud * 0.4) : Math.round(ai * 0.88 + aud * 0.12);
    out.push({ ...c, start: +start.toFixed(3), end: +end.toFixed(3), aiScore: ai, audienceScore: aud, peakScore: peak });
  }

  // de-duplicate overlapping picks (keep the higher score)
  out.sort((a, b) => b.peakScore - a.peakScore);
  const kept: typeof out = [];
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
        required: ['index', 'title', 'hook', 'description', 'hashtags', 'reason', 'category', 'hook_s', 'standalone', 'payoff', 'emotion', 'shareability', 'pacing', 'loop', 'length_fit', 'trend'],
      },
    },
  },
  required: ['clips'],
};

export type Described = Pick<ClipCandidate, 'title' | 'hook' | 'description' | 'hashtags' | 'reason' | 'category' | 'rubric'>;

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
      const text = c.segments.map((s) => s.text).join(' ').slice(0, 6000);
      return `CLIP ${i}${c.parts.length > 1 ? ` (joined from ${c.parts.length} parts)` : ''} · ${where}\n${text || '(no speech)'}`;
    })
    .join('\n\n');
  const prompt = `VIDEO: "${input.title}"${input.channel ? ` by ${input.channel}` : ''}
Platform: ${input.options.platform === 'shorts' ? 'YouTube Shorts' : input.options.platform === 'reels' ? 'Instagram Reels' : 'TikTok'}
The creator hand-picked these moments. Write the packaging for each one (post title, on-screen hook, caption, hashtags) and score it honestly with the rubric. Use "index" = the CLIP number.

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
    return input.clips.map((_, i) => {
      const c = raw.clips?.find((x) => Number(x.index) === i) ?? raw.clips?.[i];
      if (!c) return fallback(i);
      return {
        title: String(c.title || fallback(i).title).slice(0, 100),
        hook: String(c.hook || '').slice(0, 80),
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
  } catch (e) {
    console.warn('[describe clips]', (e as Error).message);
    return input.clips.map((_, i) => fallback(i));
  }
}

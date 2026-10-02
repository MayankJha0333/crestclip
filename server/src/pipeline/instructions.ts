import { config } from '../config.js';
import { generateJson, part } from './gemini.js';
import { classifyFileLink } from './filelink.js';
import type { ProjectOptions } from '../types.js';

/**
 * Turns clipping instructions (your own notes, or a campaign brief copied from e.g. Whop Content Rewards) into clear rules:
 * pay rate, platforms, clip length, required tags, do's and don'ts, and the source videos to clip.
 * Gemini reads it; a simple text-based reader is the backup (and the demo-mode version).
 */

type CampaignPlatform = 'tiktok' | 'instagram' | 'youtube' | 'x' | 'facebook';
interface CampaignBrief {
  name: string;
  brand: string;
  summary: string;
  ratePer1k: number | null;
  currency: string;
  maxPayoutPerPost: number | null;
  minViewsForPayout: number | null;
  budget: string | null;
  platforms: CampaignPlatform[];
  contentType: string;
  minSeconds: number | null;
  maxSeconds: number | null;
  requiredHashtags: string[];
  requiredMentions: string[];
  requiredCaptionText: string | null;
  rules: string[];
  donts: string[];
  clipFocus: string;
  sourceLinks: { url: string; label: string }[];
}

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'campaign title' },
    brand: { type: 'string', description: 'brand / creator / company running the campaign' },
    summary: { type: 'string', description: 'one plain-English sentence: what to make and where to post it' },
    ratePer1k: { type: 'number', nullable: true, description: 'payout per 1,000 views as a number (e.g. 1.5 for "$1.50 per 1K views"); null if not stated' },
    currency: { type: 'string', description: 'currency code, e.g. USD' },
    maxPayoutPerPost: { type: 'number', nullable: true, description: 'maximum payout for one post/video, if stated' },
    minViewsForPayout: { type: 'number', nullable: true, description: 'minimum views a post needs before it pays, if stated' },
    budget: { type: 'string', nullable: true, description: 'total budget / paid-out text if stated, e.g. "$5,000 budget"' },
    platforms: { type: 'array', items: { type: 'string', enum: ['tiktok', 'instagram', 'youtube', 'x', 'facebook'] }, description: 'platforms where posts are accepted' },
    contentType: { type: 'string', description: 'e.g. clipping, UGC, faceless, slideshow, logo/music' },
    minSeconds: { type: 'number', nullable: true, description: 'minimum clip length in seconds, if stated' },
    maxSeconds: { type: 'number', nullable: true, description: 'maximum clip length in seconds, if stated' },
    requiredHashtags: { type: 'array', items: { type: 'string' }, description: 'hashtags that MUST be in the caption, with #' },
    requiredMentions: { type: 'array', items: { type: 'string' }, description: '@accounts that MUST be tagged, with @' },
    requiredCaptionText: { type: 'string', nullable: true, description: 'exact text/link that must be in the caption or bio, if any' },
    rules: { type: 'array', items: { type: 'string' }, description: 'every requirement, short and in plain words (max ~14 words each)' },
    donts: { type: 'array', items: { type: 'string' }, description: 'every thing that is NOT allowed / gets a submission rejected' },
    clipFocus: { type: 'string', description: 'instruction for an AI video clipper: which kinds of moments to pick from the source videos, tone, what to avoid. 1–3 sentences.' },
    sourceLinks: {
      type: 'array',
      items: { type: 'object', properties: { url: { type: 'string' }, label: { type: 'string' } }, required: ['url', 'label'] },
      description: 'links to the SOURCE videos/footage to clip (YouTube, Google Drive, Dropbox, Twitch, etc.). Not links to rules pages, Discord, or the brand website.',
    },
  },
  required: ['name', 'brand', 'summary', 'platforms', 'contentType', 'requiredHashtags', 'requiredMentions', 'rules', 'donts', 'clipFocus', 'sourceLinks'],
};

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;
const VIDEO_HOST =
  /(youtube\.com|youtu\.be|drive\.google\.com|docs\.google\.com\/file|dropbox\.com|1drv\.ms|onedrive\.live\.com|sharepoint\.com|twitch\.tv|kick\.com|vimeo\.com|streamable\.com|rumble\.com|x\.com\/\w+\/status|twitter\.com\/\w+\/status|tiktok\.com\/@[^/]+\/video|instagram\.com\/(reel|p)\/)/i;
const clean = (u: string) => u.replace(/[.,;:!?]+$/, '');

/** Every link in the text that looks like video/footage to clip. */
function videoLinks(text: string): { url: string; label: string }[] {
  const out: { url: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const url = clean(m[0]);
    if (seen.has(url)) continue;
    seen.add(url);
    const file = classifyFileLink(url);
    if (VIDEO_HOST.test(url) || (file && !('error' in file))) {
      // the words just before the link usually say what it is ("Podcast ep 12: https://…")
      const before = text
        .slice(Math.max(0, (m.index ?? 0) - 60), m.index)
        .split('\n')
        .pop()
        ?.replace(/[:\-–—|•]+\s*$/, '')
        .trim();
      out.push({ url, label: before && before.length > 2 ? before.slice(-60) : new URL(url).hostname.replace(/^www\./, '') });
    }
  }
  return out;
}

const money = (s: string) => Number(s.replace(/,/g, ''));
const uniq = (a: string[]) => [...new Set(a.map((x) => x.trim()).filter(Boolean))];

/** The backup reader: patterns only, no AI. */
function readBriefPlain(text: string): CampaignBrief {
  const t = text.replace(/\r/g, '');
  const lines = t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const rate = t.match(/\$\s?([\d.,]+)\s*(?:\/|per)\s*(?:1\s?k|1,?000|thousand)\s*views?/i) ?? t.match(/([\d.,]+)\s*(?:USD|\$)\s*(?:\/|per)\s*(?:1\s?k|1,?000)/i) ?? t.match(/\$\s?([\d.,]+)\s*cpm/i);
  const maxPay = t.match(/max(?:imum)?\s*(?:payout|earnings?)?\s*(?:per\s*(?:post|video|submission))?\s*[:\-]?\s*\$\s?([\d.,]+)/i);
  const minV = t.match(/min(?:imum)?\s*(?:of\s*)?([\d.,]+)\s*(k)?\s*views/i);
  const secs = t.match(/(\d{1,3})\s*(?:-|–|to)\s*(\d{1,3})\s*(?:s\b|sec|seconds)/i);
  const maxS = t.match(/(?:max(?:imum)?|under|less than|no longer than)\s*(\d{1,3})\s*(?:s\b|sec|seconds)/i);
  const minS = t.match(/(?:min(?:imum)?|at least|longer than)\s*(\d{1,3})\s*(?:s\b|sec|seconds)/i);
  const platforms = (['tiktok', 'instagram', 'youtube', 'x', 'facebook'] as const).filter((p) =>
    p === 'x' ? /\b(twitter|x\.com|\bX\b)/.test(t) : p === 'youtube' ? /youtube|shorts/i.test(t) : p === 'instagram' ? /instagram|reels/i.test(t) : new RegExp(p, 'i').test(t),
  );
  const bullet = (l: string) => l.replace(/^[-•*✅❌✔✖️🚫⛔\d.)\s]+/, '').trim();
  // judge each sentence on its own: "Only the funny parts. No swearing." is one rule + one don't
  const sentences = lines
    .flatMap((l) => l.split(/(?<=[.!?])\s+(?=[A-Z❌✅🚫⛔•\-])/))
    .map((x) => x.trim())
    .filter(Boolean);
  const NEG = /^(❌|🚫|⛔|✖)|\b(don'?t|do not|not allowed|never|avoid|prohibited|will be (rejected|denied))\b|^no\b/i;
  const donts = sentences.filter((l) => NEG.test(l)).map(bullet);
  const isFact = (l: string) => /^https?:\/\//.test(l) || /^\$?[\d.,]+\s*(\/|per)/.test(l) || l.length < 6;
  const rules = sentences
    .filter((l) => !NEG.test(l) && !isFact(l) && /^(✅|✔|-|•|\*|\d+[.)])|\b(must|required|need to|make sure|include|tag|use|only|keep|add|clips?|captions?|focus)\b/i.test(l))
    .map(bullet);
  const name = lines.find((l) => l.length > 4 && l.length < 80 && !/^https?:/.test(l)) ?? 'Campaign';
  return {
    name,
    brand: name,
    summary: 'Clip the source videos and post them on the allowed platforms following the rules.',
    ratePer1k: rate ? money(rate[1]) : null,
    currency: 'USD',
    maxPayoutPerPost: maxPay ? money(maxPay[1]) : null,
    minViewsForPayout: minV ? money(minV[1]) * (minV[2] ? 1000 : 1) : null,
    budget: t.match(/(\$[\d.,]+\s*\/\s*\$[\d.,]+\s*paid out)/i)?.[1] ?? t.match(/(\$[\d.,]+\s*[kKmM]?\s*(?:budget|total|pool))/i)?.[1] ?? null,
    platforms: platforms.length ? [...platforms] : ['tiktok', 'instagram', 'youtube'],
    contentType: /ugc/i.test(t) ? 'UGC' : /faceless/i.test(t) ? 'faceless' : 'clipping',
    minSeconds: secs ? Number(secs[1]) : minS ? Number(minS[1]) : null,
    maxSeconds: secs ? Number(secs[2]) : maxS ? Number(maxS[1]) : null,
    requiredHashtags: uniq(t.match(/#[\p{L}\p{N}_]{2,40}/gu) ?? []).slice(0, 12),
    requiredMentions: uniq((t.match(/(?:^|\s)@[\w.]{2,30}/g) ?? []).map((m) => m.trim().replace(/\.+$/, ''))).slice(0, 8),
    requiredCaptionText: null,
    rules: uniq(rules).slice(0, 20),
    donts: uniq(donts).slice(0, 20),
    clipFocus: 'Pick the most engaging, self-contained moments that fit the campaign rules.',
    sourceLinks: videoLinks(t),
  };
}

const tag = (x: string, ch: '#' | '@') => (x.startsWith(ch) ? x : `${ch}${x}`).replace(/\s+/g, '');

/** Read a campaign brief. Never throws for normal text — falls back to the plain reader. */
async function readBrief(text: string, url?: string | null): Promise<CampaignBrief & { readBy: 'ai' | 'plain' }> {
  const plain = readBriefPlain(text);
  if (config.fakeAi || !config.gcpProject) return { ...plain, readBy: 'plain' };
  try {
    const b = await generateJson<CampaignBrief>({
      model: config.fastModel,
      label: 'campaign brief',
      thinking: 'LOW',
      system:
        'You read clipping-campaign briefs (e.g. Whop Content Rewards) for a clipper. Extract the facts exactly as written — never invent rates, rules or links. Keep rules short and plain. If something is not stated, use null or an empty list.',
      parts: [part.text(`${url ? `Campaign page: ${url}\n\n` : ''}Campaign text (copied from the page):\n"""\n${text.slice(0, 30_000)}\n"""`)],
      schema,
      maxOutputTokens: 4000,
    });
    // links Gemini mentions must really be in the text; add any video links it missed
    const inText = new Set([...text.matchAll(URL_RE)].map((m) => clean(m[0])));
    const links = [...(b.sourceLinks ?? []).filter((l) => inText.has(clean(l.url))), ...plain.sourceLinks];
    const seen = new Set<string>();
    return {
      ...plain,
      ...b,
      platforms: b.platforms?.length ? b.platforms : plain.platforms,
      requiredHashtags: uniq((b.requiredHashtags ?? []).map((x) => tag(x, '#'))),
      requiredMentions: uniq((b.requiredMentions ?? []).map((x) => tag(x, '@'))),
      sourceLinks: links.filter((l) => !seen.has(clean(l.url)) && seen.add(clean(l.url))).map((l) => ({ url: clean(l.url), label: l.label || 'Source video' })),
      minSeconds: b.minSeconds && b.minSeconds > 0 ? Math.round(b.minSeconds) : null,
      maxSeconds: b.maxSeconds && b.maxSeconds > 0 ? Math.round(b.maxSeconds) : null,
      readBy: 'ai',
    };
  } catch (e) {
    console.warn('[instructions] AI brief reading failed, using the plain reader:', (e as Error).message);
    return { ...plain, readBy: 'plain' };
  }
}

const unique = (a: string[]) => [...new Set(a.map((x) => x.trim()).filter(Boolean))];

/**
 * New clips → "Instructions for the AI": read them once and turn them into project options —
 * the length rule, what to look for, and tags every clip's caption must carry.
 */
export async function applyInstructions(options: ProjectOptions): Promise<ProjectOptions> {
  const text = (options.instructions ?? '').trim();
  if (!text) return options;
  const b = await readBrief(text);
  const out: ProjectOptions = { ...options, instructions: text.slice(0, 4000) };
  if (b.minSeconds || b.maxSeconds) {
    let min = b.minSeconds ?? Math.max(5, Math.min(15, (b.maxSeconds ?? 60) - 10));
    let max = b.maxSeconds ?? Math.max(min + 30, 60);
    if (max <= min) max = min + 15;
    out.minSeconds = Math.round(min);
    out.maxSeconds = Math.round(max);
  }
  out.requiredHashtags = unique([...(b.requiredHashtags ?? [])]).slice(0, 15);
  out.requiredMentions = unique([...(b.requiredMentions ?? [])]).slice(0, 10);
  out.requiredCaptionText = b.requiredCaptionText ?? null;
  const focus = [options.focus, b.readBy === 'ai' ? b.clipFocus : ''].filter(Boolean).join(' ');
  out.focus = focus.slice(0, 600);
  out.rules = unique([...(b.rules ?? []), ...(b.donts ?? []).map((d) => (/^(no|don|never|avoid)/i.test(d) ? d : `Not allowed: ${d}`))]).slice(0, 25);
  return out;
}

/** Put the required tags first on a clip (no duplicates). */
export function withRequiredTags(tags: string[], o: Pick<ProjectOptions, 'requiredHashtags' | 'requiredMentions'>): string[] {
  const req = [...(o.requiredMentions ?? []), ...(o.requiredHashtags ?? [])];
  if (!req.length) return tags;
  const norm = (t: string) => t.replace(/^#/, '').toLowerCase();
  return [...req, ...tags.filter((t) => !req.some((r) => norm(r) === norm(t)))];
}

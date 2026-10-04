import type { Part } from '@google/genai';
import { config } from '../config.js';
import { generateJson, part } from './gemini.js';
import type { DriveEntry, DriveFolder, ReadDoc } from './drivefolder.js';

/**
 * A shared Drive folder → a clipping plan: what the content is about (guides the moment finder), the rules written
 * in any brief files, and WHICH videos to clip — duplicates and off-brief videos left out, at most `max`.
 * The AI reads the folder (names, subfolders, briefs, PDFs) plus the person's own instructions;
 * a simple name-based picker is the backup (and the demo-mode version).
 */

export interface FolderPick {
  file: DriveEntry;
  reason: string;
}
export interface FolderPlan {
  picks: FolderPick[];
  /** what the folder's content is and what the clips should do — added to the moment finder's focus */
  summary: string;
  /** rules found in the brief files, as plain lines (fed through the normal instructions reader) */
  brief: string;
  /** videos found in the folder (after leaving out exact duplicates) */
  videos: number;
  duplicates: number;
  readBy: 'ai' | 'plain';
}

const fmtMb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
const fmtLen = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const pathOf = (f: DriveEntry) => (f.folder ? `${f.folder}/${f.name}` : f.name);

/**
 * The same take saved more than once: "take.mov" + "take.mp4", "take (1).mp4", "Copy of take.mp4", or one take
 * exported in several shapes ("take 16x9 RAW.mp4" + "take 9x16.mov"). Only within the same subfolder.
 */
export function sameVideoKey(f: Pick<DriveEntry, 'folder' | 'name'>) {
  return `${f.folder}|${f.name
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/, '')
    .replace(/^copy of\s+/, '')
    .replace(/\s*\(\d+\)$/, '')
    .replace(/\b\d{1,2}\s*[x×:]\s*\d{1,2}\b/g, ' ') // 16x9, 9x16, 4x5, 1:1
    .replace(/\b(raw|final|edited|edit)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()}`;
}

const VERTICAL = /\b9\s*[x×:]\s*16\b/i;
/** Which copy to keep: the vertical one (no cropping needed), then the bigger file, then the first listed. */
const better = (a: DriveEntry, b: DriveEntry) => {
  const va = VERTICAL.test(a.name);
  if (va !== VERTICAL.test(b.name)) return va;
  return (a.size ?? 0) > (b.size ?? 0);
};

/** One file per take. */
export function dedupeVideos(files: DriveEntry[]): { videos: DriveEntry[]; duplicates: number } {
  const all = files.filter((x) => x.kind === 'video');
  const best = new Map<string, DriveEntry>();
  for (const f of all) {
    const k = sameVideoKey(f);
    const had = best.get(k);
    if (!had || better(f, had)) best.set(k, f);
  }
  const keep = new Set(best.values());
  return { videos: all.filter((f) => keep.has(f)), duplicates: all.length - keep.size };
}

const schema = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description:
        '2-3 plain sentences: what this footage is (brand, product, campaign, people, style) and what the short clips should achieve. Used to guide which moments get clipped.',
    },
    brief: {
      type: 'string',
      description:
        'The rules and requirements written in the brief files (clip length, platforms, hashtags, @mentions, logo, dos and don’ts, key messages), copied faithfully, one per line. Empty string if there are no brief files or they state no rules. Never invent rules.',
    },
    picks: {
      type: 'array',
      description: 'the videos to clip, best first',
      items: {
        type: 'object',
        properties: { n: { type: 'integer', description: 'the video number from the list' }, reason: { type: 'string', description: 'why, in under 15 words' } },
        required: ['n', 'reason'],
      },
    },
  },
  required: ['summary', 'brief', 'picks'],
};

function plainPlan(videos: DriveEntry[], duplicates: number, max: number, folder: DriveFolder, docs: ReadDoc[]): FolderPlan {
  // longest first when lengths are known (more to clip from), else the folder's order
  const order = videos.some((v) => v.seconds) ? [...videos].sort((a, b) => (b.seconds ?? 0) - (a.seconds ?? 0)) : videos;
  return {
    picks: order.slice(0, max).map((file) => ({ file, reason: 'From the shared folder' })),
    summary: `Footage from the shared Google Drive folder “${folder.name}”.`,
    brief: docs
      .map((d) => d.text ?? '')
      .join('\n\n')
      .slice(0, 5000),
    videos: videos.length,
    duplicates,
    readBy: 'plain',
  };
}

/** The AI's picks, checked: real numbers from the list, no repeats (of a number or a take), at most `max`. */
export function keepValidPicks(videos: DriveEntry[], raw: { n: number; reason: string }[] | undefined, max: number): FolderPick[] {
  const seen = new Set<string>();
  const picks: FolderPick[] = [];
  for (const p of raw ?? []) {
    const i = Math.round(Number(p?.n)) - 1;
    if (!Number.isFinite(i) || i < 0 || i >= videos.length || seen.has(sameVideoKey(videos[i]))) continue;
    seen.add(sameVideoKey(videos[i]));
    picks.push({ file: videos[i], reason: String(p.reason || 'Picked by the AI').slice(0, 120) });
    if (picks.length >= max) break;
  }
  return picks;
}

export async function planFolder(c: { folder: DriveFolder; docs: ReadDoc[]; instructions: string; max: number; lengthHint: string }): Promise<FolderPlan> {
  const { folder, docs, max } = c;
  const { videos, duplicates } = dedupeVideos(folder.files);
  if (!videos.length) throw new Error('There are no videos in this Google Drive folder (or its subfolders).');
  const plain = plainPlan(videos, duplicates, max, folder, docs);
  if (config.fakeAi || !(config.gcpProject || config.vertexApiKey)) return plain;

  const list = videos
    .map((f, i) => [`${i + 1}. ${pathOf(f)}`, f.size ? fmtMb(f.size) : '', f.seconds ? fmtLen(f.seconds) : ''].filter(Boolean).join(' · '))
    .join('\n');
  const others = folder.files.filter((f) => f.kind === 'image' || f.kind === 'other').map(pathOf);
  const texts = docs.filter((d) => d.text).map((d) => `--- ${pathOf(d.file)} ---\n${d.text}`);
  const pdfs = docs.filter((d) => d.pdf);
  const parts: Part[] = [
    part.text(
      [
        `Shared folder: “${folder.name}”`,
        c.instructions.trim() ? `The clipper's own instructions (these win over the brief files):\n"""\n${c.instructions.trim().slice(0, 4000)}\n"""` : 'The clipper gave no instructions of their own.',
        `Clip length they want: ${c.lengthHint}.`,
        `VIDEOS (${videos.length}):\n${list}`,
        others.length ? `Other files (not videos, for context only): ${others.slice(0, 40).join(', ')}${others.length > 40 ? ` … +${others.length - 40} more` : ''}` : '',
        texts.length ? `BRIEF FILES:\n${texts.join('\n\n').slice(0, 40_000)}` : pdfs.length ? '' : 'There are no brief files in the folder.',
        pdfs.length ? `The attached PDF${pdfs.length > 1 ? 's are' : ' is'} also from the folder: ${pdfs.map((d) => pathOf(d.file)).join(', ')}.` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    ),
    ...pdfs.map((d): Part => ({ inlineData: { mimeType: 'application/pdf', data: d.pdf!.toString('base64') } })),
  ];

  try {
    const r = await generateJson<{ summary: string; brief: string; picks: { n: number; reason: string }[] }>({
      model: config.fastModel,
      label: 'drive folder',
      thinking: 'LOW',
      system: [
        'You plan a clipping job: someone shared a Google Drive folder of footage (plus maybe a brief) and wants short vertical clips (Shorts, Reels, TikTok) cut from it.',
        `Pick the videos worth clipping — at most ${max}, best first. Use the folder and file names, the brief and the clipper's instructions to understand the campaign.`,
        'Rules: pick only ONE copy of the same take (the same video saved as .mov and .mp4, as a "(1)" copy, or exported in different shapes like 16x9 and 9x16 — prefer the 9x16 one). Leave out videos the instructions or brief exclude.',
        'Prefer raw or longer footage that has several good moments over videos that look like they are already a finished short ad, unless that is all there is.',
        `If more than ${max} videos fit, spread the picks across the different creators, products and subfolders instead of taking near-identical videos.`,
        'Never invent facts, rules, hashtags or links that are not in the text.',
      ].join(' '),
      parts,
      schema,
      maxOutputTokens: 6000,
      timeoutMs: 90_000,
    });
    const picks = keepValidPicks(videos, r.picks, max);
    if (!picks.length) return plain;
    return {
      picks,
      summary: (r.summary || plain.summary).trim().slice(0, 500),
      // the AI read the PDFs too; keep the plain text as a backup when it found nothing
      brief: (r.brief?.trim() || (pdfs.length ? '' : plain.brief)).slice(0, 5000),
      videos: videos.length,
      duplicates,
      readBy: 'ai',
    };
  } catch (e) {
    console.warn('[folder] AI planning failed, picking by name:', (e as Error).message);
    return plain;
  }
}

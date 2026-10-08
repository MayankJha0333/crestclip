import { classifyFileLink, fileLinkLabel } from './filelink.js';
import type { SourceInfo } from './ytdlp.js';

/**
 * Where a video comes from, and the best way to get each thing out of it.
 *
 * Every source is handled the same way — read it, get a transcript, find the moments, fetch the clip parts, render —
 * but the fastest way to do each step depends on the site. This is the one place that says what to try, in order,
 * for each kind of source; the steps themselves (process.ts, footage.ts, fastparts.ts) just follow the plan and fall
 * through to the next option when one doesn't work out. The server log says which option each step ended up using.
 *
 *   YouTube        the video's own word-timed captions stand in for the transcript (no download, no transcription);
 *                  the clip parts come by byte range from its DASH files (seconds); replay graph + comments say
 *                  where viewers rewatch
 *   Twitch         no captions → the sound track is fetched 16 pieces at a time and transcribed; the clip parts are
 *                  just the HLS pieces they need; loudness stands in for audience data
 *   other sites    whatever yt-dlp reports: captions when the site has them, DASH or HLS parts when it serves them,
 *                  yt-dlp's own cut otherwise
 *   file links     Google Drive, Dropbox, OneDrive, a direct .mp4: one file, fetched in parallel pieces when the
 *                  host allows ranges (several times faster than one stream), then treated like an upload
 *   uploads        the file is already here
 */

export type SourceKind = 'youtube' | 'twitch' | 'site' | 'gdrive' | 'dropbox' | 'onedrive' | 'direct' | 'upload';

export interface SourcePlan {
  kind: SourceKind;
  /** for the page and the log: "YouTube", "Google Drive"… */
  label: string;
  /** the site's own captions may stand in for the transcript (YouTube's are word-timed; others phrase-timed) */
  captions: boolean;
  /** fetch only the clip parts (section mode) rather than the whole video, for long videos */
  parts: boolean;
  /** where "most watched" can come from, best first */
  audience: ('heatmap' | 'comments' | 'chapters' | 'reactions' | 'loudness')[];
  /** how the sound track is fetched when the video has to be transcribed, best first */
  audio: ('hls-pieces' | 'ytdlp')[];
  /** how a clip's part of the video is fetched, best first */
  footage: ('dash-ranges' | 'hls-pieces' | 'ytdlp-cut' | 'whole-file')[];
}

/** What kind of source a project is, from its link (or its lack of one). */
export function sourceKindOf(sourceType: 'url' | 'upload' | 'group', sourceUrl: string | null | undefined, info?: Pick<SourceInfo, 'isYouTube' | 'extractor'> | null): SourceKind {
  if (sourceType === 'upload' && !sourceUrl) return 'upload';
  if (sourceType === 'upload' && sourceUrl) {
    const link = classifyFileLink(sourceUrl);
    return link && !('error' in link) ? link.kind : 'direct';
  }
  if (info?.isYouTube || /youtu\.?be/i.test(sourceUrl ?? '')) return 'youtube';
  if (/twitch/i.test(info?.extractor ?? '') || /twitch\.tv/i.test(sourceUrl ?? '')) return 'twitch';
  return 'site';
}

export function planFor(kind: SourceKind, info?: Pick<SourceInfo, 'heatmap' | 'chapters'> | null): SourcePlan {
  switch (kind) {
    case 'youtube':
      return {
        kind,
        label: 'YouTube',
        captions: true,
        parts: true,
        audience: [...(info?.heatmap?.length ? ['heatmap' as const] : []), 'comments', 'chapters', 'reactions'],
        audio: ['ytdlp'],
        footage: ['dash-ranges', 'ytdlp-cut'],
      };
    case 'twitch':
      return { kind, label: 'Twitch', captions: false, parts: true, audience: ['loudness'], audio: ['hls-pieces', 'ytdlp'], footage: ['hls-pieces', 'ytdlp-cut'] };
    case 'site':
      return { kind, label: 'the link', captions: true, parts: true, audience: ['chapters', 'loudness'], audio: ['hls-pieces', 'ytdlp'], footage: ['dash-ranges', 'hls-pieces', 'ytdlp-cut', 'whole-file'] };
    case 'upload':
      return { kind, label: 'your upload', captions: false, parts: false, audience: ['loudness'], audio: [], footage: ['whole-file'] };
    default:
      return { kind, label: fileLinkLabel[kind], captions: false, parts: false, audience: ['loudness'], audio: [], footage: ['whole-file'] };
  }
}

/**
 * Try each way in turn and keep the first that works; the log says which one it was and why the others didn't.
 * `null` from a step means "not for this video" (quietly on to the next); a throw is a real failure (logged).
 */
export async function firstThatWorks<T>(
  what: string,
  ways: { name: string; run: () => Promise<T | null> }[],
  log: (line: string) => void = (l) => console.log(l),
): Promise<{ name: string; value: T } | null> {
  const tried: string[] = [];
  for (const way of ways) {
    const t0 = Date.now();
    try {
      const value = await way.run();
      if (value === null) {
        tried.push(`${way.name}: not for this video`);
        continue;
      }
      log(`${what} via ${way.name}${tried.length ? ` (after ${tried.join('; ')})` : ''} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return { name: way.name, value };
    } catch (e) {
      tried.push(`${way.name}: ${(e as Error).message.slice(0, 140)}`);
    }
  }
  log(`${what}: no way worked — ${tried.join('; ')}`);
  return null;
}

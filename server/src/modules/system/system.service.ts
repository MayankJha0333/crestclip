import { config } from '../../config.js';
import { ensureFfmpeg, ensureYtdlp, ffStatus, ytStatus } from '../../infra/tools.js';
import { checkGemini } from '../../pipeline/gemini.js';
import { ffmpegVersion, hasLibass } from '../../pipeline/media.js';
import { lengthRange, RUBRIC_WEIGHTS } from '../../pipeline/moments.js';

// Asking Gemini costs a request, so the answer is reused for 10 minutes (unless a refresh is asked for).
let geminiStatus: { ok: boolean; detail: string; checkedAt: number } | null = null;

export async function health(refresh: boolean) {
  if (!geminiStatus || refresh || Date.now() - geminiStatus.checkedAt > 10 * 60 * 1000) {
    geminiStatus = { ...(await checkGemini()), checkedAt: Date.now() };
  }
  const [ff, captions] = await Promise.all([ffmpegVersion(), hasLibass()]);
  return {
    ok: Boolean(ff) && geminiStatus.ok,
    gemini: { ...geminiStatus, project: config.gcpProject || null, location: config.gcpLocation, model: config.model, fastModel: config.fastModel, fake: config.fakeAi },
    gcsBucket: config.gcsBucket || null,
    ffmpeg: ff,
    ffmpegSource: config.ffmpegSource,
    ffmpegStatus: { ...ffStatus },
    captions,
    ytdlp: ytStatus.version,
    ytdlpStatus: { state: ytStatus.state, source: ytStatus.source, detail: ytStatus.detail, checkedAt: ytStatus.checkedAt },
    rubricWeights: RUBRIC_WEIGHTS,
  };
}

/** Re-check / repair the managed video tools (the app's "Try again" button). */
export async function refreshTools() {
  await Promise.all([ensureYtdlp(true), ensureFfmpeg()]);
  return { ytdlp: ytStatus, ffmpeg: ffStatus };
}

/** Clip length ranges for every platform × length choice (shown in the New clips form). */
export function meta() {
  return {
    lengths: Object.fromEntries(
      (['shorts', 'tiktok', 'reels'] as const).map((pl) => [pl, Object.fromEntries((['auto', 'short', 'medium', 'long'] as const).map((l) => [l, lengthRange(pl, l)]))]),
    ),
  };
}

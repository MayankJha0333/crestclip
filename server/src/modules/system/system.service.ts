import { config } from '../../config.js';
import { ensureFfmpeg, ensureYtdlp, ffStatus, ytStatus } from '../../infra/tools.js';
import { checkGemini } from '../../pipeline/gemini.js';
import { ffmpegVersion, hasLibass } from '../../pipeline/media.js';
import { RUBRIC_WEIGHTS } from '../../pipeline/moments.js';
import { potHelperStatus } from '../../pipeline/ytdlp.js';
import { CREDITS_PER_CLIP, CURRENCY, TOPUP } from '../billing/plans.js';

// Asking Gemini costs a request, so the answer is reused for 10 minutes (unless a refresh is asked for).
let geminiStatus: { ok: boolean; detail: string; checkedAt: number } | null = null;

export async function health(refresh: boolean) {
  if (!geminiStatus || refresh || Date.now() - geminiStatus.checkedAt > 10 * 60 * 1000) {
    geminiStatus = { ...(await checkGemini()), checkedAt: Date.now() };
  }
  const [ff, captions, pot] = await Promise.all([ffmpegVersion(), hasLibass(), potHelperStatus()]);
  return {
    ok: Boolean(ff) && geminiStatus.ok,
    // only whether the AI works: the app never names the provider, model or cloud project
    ai: { ok: geminiStatus.ok, fake: config.fakeAi, checkedAt: geminiStatus.checkedAt },
    gcsBucket: config.gcsBucket || null,
    ffmpeg: ff,
    ffmpegSource: config.ffmpegSource,
    ffmpegStatus: { ...ffStatus },
    captions,
    ytdlp: ytStatus.version,
    ytdlpStatus: { state: ytStatus.state, source: ytStatus.source, detail: ytStatus.detail, checkedAt: ytStatus.checkedAt },
    /** YouTube PO-token helper: null = not configured */
    potHelper: pot.url ? pot.ok : null,
    rubricWeights: RUBRIC_WEIGHTS,
  };
}

/** Re-check / repair the managed video tools (the app's "Try again" button). */
export async function refreshTools() {
  await Promise.all([ensureYtdlp(true), ensureFfmpeg()]);
  return { ytdlp: ytStatus, ffmpeg: ffStatus };
}

/** For the About / Contact / Terms / Privacy / Refund pages. */
export function site() {
  const b = config.business;
  return {
    name: b.name,
    legalName: b.legalName || b.name,
    email: b.email || null,
    address: b.address || null,
    jurisdiction: b.jurisdiction || null,
    hours: b.hours,
    grievanceOfficer: b.grievanceOfficer || b.legalName || b.name,
    url: config.publicUrl,
    currency: CURRENCY,
    retentionDays: config.retentionDays,
    creditsPerClip: CREDITS_PER_CLIP,
    topupValidMonths: Math.round(TOPUP.validDays / 30),
  };
}

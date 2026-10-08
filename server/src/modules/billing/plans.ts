import { config } from '../../config.js';
import type { PlanId } from '../../db/index.js';

/**
 * Plans, prices and limits — the one place to change them.
 *
 * Prices are in US dollars. Paid plans and the top-up are products in Dodo Payments (DODO_PRODUCT_* in the
 * settings); if you change a dollar price here, change the matching Dodo product to the same amount. India has its own
 * rupee prices (priceInr): the app adds them to the Dodo products itself as an "India" price (see ensureIndiaPrices),
 * so Indian buyers are charged exactly that, plus GST.
 *
 * Credits are spent per clip: every clip CrestClip makes costs CREDITS_PER_CLIP. A video asked for 8 clips takes
 * 40 credits up front; if fewer clips come out, the difference goes back. Editing and re-rendering clips is always
 * free, and a video that fails to process gives all its credits back. Video length is capped per plan instead.
 */

/** The only currency CrestClip charges in. */
export const CURRENCY = 'USD';

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  /** monthly price in US dollars (everywhere except India) */
  price: number;
  /** monthly price in India, in rupees before GST (Dodo charges this exact amount to Indian billing addresses) */
  priceInr: number;
  /** credits added every month (÷ CREDITS_PER_CLIP = clips a month) */
  credits: number;
  /** unused monthly credits stay usable for one more month */
  rollover: boolean;
  maxVideoMinutes: number;
  maxVideosPerProject: number;
  /** clips carry a small CrestClip mark */
  crestclipWatermark: boolean;
  /** your own logo as the watermark (Settings → Watermark) */
  customLogo: boolean;
  /** height of exported clips (1920 = full HD vertical) */
  exportHeight: 1280 | 1920;
  scheduling: boolean;
  autopilot: boolean;
  /** clip YouTube videos: paste YouTube links in New clips and browse YouTube in Explore */
  youtubeSource: boolean;
  /** days a project and its clips are kept (RETENTION_DAYS on Free; paid plans keep them a month) */
  storageDays: number;
  /** the list on the pricing cards (built from the limits above, so it never goes out of date) */
  points: string[];
}

/** What one clip costs. */
export const CREDITS_PER_CLIP = 5;

/** Credits for making `clips` clips. */
export const creditsForClips = (clips: number) => Math.max(0, Math.round(clips)) * CREDITS_PER_CLIP;

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    tagline: 'For trying CrestClip on a few videos.',
    price: 0,
    priceInr: 0,
    credits: 60,
    rollover: false,
    maxVideoMinutes: 30,
    maxVideosPerProject: 3,
    crestclipWatermark: true,
    customLogo: false,
    exportHeight: 1280,
    scheduling: false,
    autopilot: false,
    youtubeSource: true,
    storageDays: config.retentionDays,
    points: [], // filled in below from the limits
  },
  creator: {
    id: 'creator',
    name: 'Creator',
    tagline: 'For creators posting clips every week.',
    price: 15,
    priceInr: 999,
    credits: 400,
    rollover: true,
    maxVideoMinutes: 120,
    maxVideosPerProject: 15,
    crestclipWatermark: false,
    customLogo: true,
    exportHeight: 1920,
    scheduling: true,
    autopilot: false,
    youtubeSource: true,
    storageDays: Math.max(30, config.retentionDays),
    points: [],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    tagline: 'For clippers, agencies and long streams.',
    price: 29,
    priceInr: 1999,
    credits: 1000,
    rollover: true,
    maxVideoMinutes: 180,
    maxVideosPerProject: 15,
    crestclipWatermark: false,
    customLogo: true,
    exportHeight: 1920,
    scheduling: true,
    autopilot: true,
    youtubeSource: true,
    storageDays: Math.max(30, config.retentionDays),
    points: [],
  },
};

/** Most clips one video can be asked for (the New clips form allows up to this). */
const MAX_CLIPS_PER_VIDEO = 20;

/** The pricing-card list for a plan — every line is a real limit. */
function cardPoints(p: Plan): string[] {
  const length = p.maxVideoMinutes >= 60 ? `${p.maxVideoMinutes / 60} Hours` : `${p.maxVideoMinutes} Min`;
  return [
    `${Math.floor(p.credits / CREDITS_PER_CLIP)} Clips / Month`,
    `${p.maxVideosPerProject} Videos per Batch`,
    `Videos up to ${length}`,
    `Up to ${MAX_CLIPS_PER_VIDEO} Clips per Video`,
    `${Math.round(config.maxUploadMb / 1024)} GB Max Upload`,
    `${p.storageDays}-Day Clip Storage`,
    p.exportHeight >= 1920 ? '1080p Full HD Export' : '720p Export',
    p.crestclipWatermark ? 'Small CrestClip Watermark' : 'No Watermark · Add Your Own Logo',
    p.scheduling ? 'Post or Schedule to YouTube & Instagram' : 'Post to YouTube & Instagram',
    ...(p.autopilot ? ['Autopilot: Finds, Clips & Posts for You'] : []),
    ...(p.rollover ? ['Unused Clips Roll Over 1 Month'] : []),
    'Animated Captions, Emoji & AI Hooks',
  ];
}
for (const p of Object.values(PLANS)) p.points = cardPoints(p);

export const PLAN_ORDER: PlanId[] = ['free', 'creator', 'pro'];

/** The billing promises, said out loud on the pricing page (each one answers a common complaint about clipping tools). */
export const POLICY_LINES = [
  'Pay per clip, not per minute of video',
  'Clips that fail or don’t come out are refunded',
  'Edits and re-renders are always free',
  'Cancel any time and keep your files',
];

/** One-off credit pack (US dollars; rupees before GST in India), for when the month's credits run out. */
export const TOPUP = { credits: 100, price: 5, priceInr: 399, validDays: 365 };

/** Indian prices are shown before GST; checkout adds it. */
export const INDIA_GST_PERCENT = 18;

export const planOf = (id: string | null | undefined): Plan => PLANS[(id as PlanId) in PLANS ? (id as PlanId) : 'free'];

import { config } from '../../config.js';
import type { PlanId } from '../../db/index.js';

/**
 * Plans, prices and limits — the one place to change them.
 *
 * Credits are spent per clip: every clip CrestClip makes costs CREDITS_PER_CLIP (5). A video asked for 8 clips takes
 * 40 credits up front; if fewer clips come out, the difference goes back. Editing and re-rendering clips is always
 * free, and a video that fails to process gives all its credits back. Video length is capped per plan instead.
 *
 * Paid plans are Razorpay subscriptions: create a monthly plan in the Razorpay Dashboard for each paid plan here
 * (same price and currency as PRICES below) and put its id in .env (RAZORPAY_PLAN_CREATOR / RAZORPAY_PLAN_PRO).
 */

/**
 * Prices per billing currency (BILLING_CURRENCY in .env). Razorpay plans can't change their amount later, so if you
 * change a price here, create a new plan in Razorpay with the same amount and update its id in .env.
 * INR is what an Indian Razorpay account can charge without "International Payments" turned on.
 */
const PRICES: Record<string, { creator: number; pro: number; topup: number }> = {
  USD: { creator: 15, pro: 29, topup: 5 },
  INR: { creator: 1299, pro: 2499, topup: 449 },
};
const price = PRICES[config.currency] ?? PRICES.USD;
export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  /** monthly price in the billing currency's main unit (e.g. dollars) */
  price: number;
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
    credits: 60,
    rollover: false,
    maxVideoMinutes: 30,
    maxVideosPerProject: 3,
    crestclipWatermark: true,
    customLogo: false,
    exportHeight: 1280,
    scheduling: false,
    autopilot: false,
    points: [], // filled in below from the limits
  },
  creator: {
    id: 'creator',
    name: 'Creator',
    tagline: 'For creators posting clips every week.',
    price: price.creator,
    credits: 400,
    rollover: true,
    maxVideoMinutes: 120,
    maxVideosPerProject: 15,
    crestclipWatermark: false,
    customLogo: true,
    exportHeight: 1920,
    scheduling: true,
    autopilot: false,
    points: [],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    tagline: 'For clippers, agencies and long streams.',
    price: price.pro,
    credits: 1000,
    rollover: true,
    maxVideoMinutes: 180,
    maxVideosPerProject: 15,
    crestclipWatermark: false,
    customLogo: true,
    exportHeight: 1920,
    scheduling: true,
    autopilot: true,
    points: [],
  },
};

/** Most clips one video can be asked for (the New clips form allows up to this). */
export const MAX_CLIPS_PER_VIDEO = 20;

/** The pricing-card list for a plan — every line is a real limit. */
function cardPoints(p: Plan): string[] {
  const length = p.maxVideoMinutes >= 60 ? `${p.maxVideoMinutes / 60} Hours` : `${p.maxVideoMinutes} Min`;
  return [
    `${Math.floor(p.credits / CREDITS_PER_CLIP)} Clips / Month`,
    `${p.maxVideosPerProject} Videos per Batch`,
    `Videos up to ${length}`,
    `Up to ${MAX_CLIPS_PER_VIDEO} Clips per Video`,
    `${Math.round(config.maxUploadMb / 1024)} GB Max Upload`,
    `${config.retentionDays}-Day Clip Storage`,
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

/** One-off credit pack, for when the month's credits run out. */
export const TOPUP = { credits: 100, price: price.topup, validDays: 365 };

export const planOf = (id: string | null | undefined): Plan => PLANS[(id as PlanId) in PLANS ? (id as PlanId) : 'free'];

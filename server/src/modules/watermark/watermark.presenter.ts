import type { UserRow } from '../../db/index.js';
import { toMediaUrl } from '../../lib/paths.js';
import { readWatermark } from '../../pipeline/watermark.js';
import { planOf } from '../billing/plans.js';

/** The person's watermark as the web app sees it (a URL for the logo instead of a file path). */
export function publicWatermark(user: UserRow) {
  const { file, ...rest } = readWatermark(user.id);
  // locked = the plan doesn't include your own logo (Free clips carry the CrestClip mark instead)
  return { ...rest, logoUrl: toMediaUrl(file), locked: !planOf(user.plan).customLogo };
}

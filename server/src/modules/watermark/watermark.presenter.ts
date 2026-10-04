import type { UserRow } from '../../db/index.js';
import { toMediaUrl } from '../../lib/paths.js';
import { defaultLogoId, listLogos, readWatermark } from '../../pipeline/watermark.js';
import { planOf } from '../billing/plans.js';

/** The person's watermark as the web app sees it (URLs for the logos instead of file paths). */
export function publicWatermark(user: UserRow) {
  const w = readWatermark(user.id);
  const { file, ...rest } = w;
  return {
    ...rest,
    logoUrl: toMediaUrl(file),
    defaultLogoId: defaultLogoId(w),
    logos: listLogos(user.id).map((l) => ({ id: l.id, name: l.name, url: toMediaUrl(l.file) })),
    // locked = the plan doesn't include your own logo (Free clips carry the CrestClip mark instead)
    locked: !planOf(user.plan).customLogo,
  };
}

import type { ClipRow } from '../../db/index.js';
import { renderRules } from '../billing/billing.service.js';

/** After a Free → paid upgrade, return the saved clean master instead of the old CrestClip-stamped file. */
export async function clipOutputForUser(clip: ClipRow, userId: string | null) {
  const rules = await renderRules(userId);
  return !rules.crestclipWatermark && clip.cleanPath ? clip.cleanPath : clip.filePath;
}

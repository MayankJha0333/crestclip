import { toMediaUrl } from '../../lib/paths.js';
import { readWatermark } from '../../pipeline/watermark.js';

/** The watermark as the web app sees it (a URL for the logo instead of a file path). */
export function publicWatermark() {
  const { file, ...rest } = readWatermark();
  return { ...rest, logoUrl: toMediaUrl(file) };
}

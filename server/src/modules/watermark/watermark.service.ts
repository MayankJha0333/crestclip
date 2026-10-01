import fs from 'node:fs';
import { HttpError } from '../../lib/http.js';
import { setWatermarkLogo } from '../../pipeline/watermark.js';

export { removeWatermarkLogo, updateWatermark } from '../../pipeline/watermark.js';

const IMAGE = /^image\/(png|jpe?g|webp)$/;

/** Turn an uploaded image into the watermark logo. */
export async function uploadLogo(file: { path: string; originalname: string; mimetype: string }) {
  if (!IMAGE.test(file.mimetype)) {
    fs.rmSync(file.path, { force: true });
    throw new HttpError(400, 'Use a PNG, JPG or WebP image. A PNG with a see-through background looks best.');
  }
  try {
    return await setWatermarkLogo(file.path, file.originalname);
  } catch {
    throw new HttpError(400, 'That image couldn’t be read. Try saving it again as a PNG.');
  }
}

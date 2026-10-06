import fs from 'node:fs';
import { HttpError } from '../../lib/http.js';
import { addLogo, setWatermarkLogo } from '../../pipeline/watermark.js';

export { removeLogo, removeWatermarkLogo, setDefaultLogo, updateWatermark } from '../../pipeline/watermark.js';

const IMAGE = /^image\/(png|jpe?g|webp)$/;

/**
 * Turn an uploaded image into a logo: the Settings one (`library` false), or one more in the library,
 * to pick for a single project in New clips.
 */
export async function uploadLogo(userId: string, file: { path: string; originalname: string; mimetype: string }, library = false) {
  if (!IMAGE.test(file.mimetype)) {
    fs.rmSync(file.path, { force: true });
    throw new HttpError(400, 'Use a PNG, JPG or WebP image. A PNG with a see-through background looks best.');
  }
  try {
    return library ? await addLogo(userId, file.path, file.originalname) : await setWatermarkLogo(userId, file.path, file.originalname);
  } catch {
    throw new HttpError(400, 'That image couldn’t be read. Try saving it again as a PNG.');
  }
}

/** An upload that won't be used. */
export const discardUpload = (p: string) => fs.rmSync(p, { force: true });

import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { asyncHandler, HttpError, validate } from '../../lib/http.js';
import { uploadTmpDir } from '../../lib/paths.js';
import { publicWatermark } from './watermark.presenter.js';
import { updateWatermarkSchema } from './watermark.schemas.js';
import * as service from './watermark.service.js';

export const watermarkRouter = Router();

const MAX_MB = 5;
const logoUpload: RequestHandler = (req, res, next) =>
  multer({ dest: uploadTmpDir, limits: { fileSize: MAX_MB * 1024 * 1024 } }).single('file')(req, res, (err: unknown) =>
    next((err as { code?: string })?.code === 'LIMIT_FILE_SIZE' ? new HttpError(413, `The logo must be under ${MAX_MB} MB.`) : err),
  );

watermarkRouter.get('/watermark', (_req, res) => res.json(publicWatermark()));

watermarkRouter.put('/watermark', (req, res) => {
  service.updateWatermark(validate(updateWatermarkSchema, req.body, 'Those watermark settings aren’t valid.'));
  res.json(publicWatermark());
});

watermarkRouter.post(
  '/watermark/logo',
  logoUpload,
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Choose an image for your logo.');
    await service.uploadLogo(req.file);
    res.json(publicWatermark());
  }),
);

watermarkRouter.delete('/watermark/logo', (_req, res) => {
  service.removeWatermarkLogo();
  res.json(publicWatermark());
});

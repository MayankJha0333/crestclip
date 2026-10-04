import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { asyncHandler, HttpError, validate } from '../../lib/http.js';
import { uploadTmpDir } from '../../lib/paths.js';
import { me } from '../auth/auth.middleware.js';
import { assertCustomLogo } from '../billing/billing.service.js';
import { publicWatermark } from './watermark.presenter.js';
import { updateWatermarkSchema } from './watermark.schemas.js';
import * as service from './watermark.service.js';

export const watermarkRouter = Router();

const MAX_MB = 5;
const logoUpload: RequestHandler = (req, res, next) =>
  multer({ dest: uploadTmpDir, limits: { fileSize: MAX_MB * 1024 * 1024 } }).single('file')(req, res, (err: unknown) =>
    next((err as { code?: string })?.code === 'LIMIT_FILE_SIZE' ? new HttpError(413, `The logo must be under ${MAX_MB} MB.`) : err),
  );

watermarkRouter.get('/watermark', (req, res) => res.json(publicWatermark(me(req))));

watermarkRouter.put('/watermark', (req, res) => {
  assertCustomLogo(me(req));
  service.updateWatermark(me(req).id, validate(updateWatermarkSchema, req.body, 'Those watermark settings aren’t valid.'));
  res.json(publicWatermark(me(req)));
});

/** POST /watermark/logo replaces the Settings logo; POST /watermark/logos adds one to the library (answers with its id). */
const saveUpload = (library: boolean): RequestHandler =>
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Choose an image for your logo.');
    try {
      assertCustomLogo(me(req));
    } catch (e) {
      service.discardUpload(req.file.path);
      throw e;
    }
    const saved = await service.uploadLogo(me(req).id, req.file, library);
    res.json({ ...publicWatermark(me(req)), ...(library && 'id' in saved ? { added: saved.id } : {}) });
  });

watermarkRouter.post('/watermark/logo', logoUpload, saveUpload(false));
watermarkRouter.post('/watermark/logos', logoUpload, saveUpload(true));

watermarkRouter.delete('/watermark/logo', (req, res) => {
  service.removeWatermarkLogo(me(req).id);
  res.json(publicWatermark(me(req)));
});

watermarkRouter.delete('/watermark/logos/:id', (req, res) => {
  service.removeLogo(me(req).id, req.params.id);
  res.json(publicWatermark(me(req)));
});

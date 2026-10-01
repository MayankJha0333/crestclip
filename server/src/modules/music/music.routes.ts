import { Router } from 'express';
import multer from 'multer';
import { asyncHandler, HttpError } from '../../lib/http.js';
import { uploadTmpDir } from '../../lib/paths.js';
import { publicMusic } from './music.presenter.js';
import * as service from './music.service.js';

export const musicRouter = Router();

const musicUpload = multer({ dest: uploadTmpDir, limits: { fileSize: 60 * 1024 * 1024 } });

musicRouter.get('/music', (_req, res) => res.json(publicMusic()));

musicRouter.post(
  '/music/moods/:id',
  asyncHandler(async (req, res) => {
    await service.makeMoodTrack(req.params.id, req.query.fresh === '1');
    res.json(publicMusic());
  }),
);

musicRouter.post(
  '/music/uploads',
  musicUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Choose an audio file.');
    const added = await service.addMusicUpload(req.file);
    res.status(201).json({ ...publicMusic(), added });
  }),
);

musicRouter.delete('/music/uploads/:id', (req, res) => {
  service.removeMusicUpload(req.params.id);
  res.json(publicMusic());
});

import { Router } from 'express';
import { asyncHandler, validate } from '../../lib/http.js';
import { publicClip } from './clips.presenter.js';
import { clipPatchSchema } from './clips.schemas.js';
import { me } from '../auth/auth.middleware.js';
import * as service from './clips.service.js';

export const clipsRouter = Router();

clipsRouter.get('/clips/:id/transcript', (req, res) => {
  res.json(service.clipTranscript(req.params.id, me(req)));
});

clipsRouter.patch('/clips/:id', (req, res) => {
  const { clip, project } = service.getClipWithProject(req.params.id, me(req));
  const edit = validate(clipPatchSchema, req.body, (issue) => issue ?? 'Invalid edit');
  res.json(publicClip(service.updateClip(clip, project, edit)));
});

clipsRouter.post('/clips/:id/render', (req, res) => {
  res.json(publicClip(service.rerenderClip(req.params.id, me(req))));
});

clipsRouter.post('/clips/:id/variant', (req, res) => {
  res.status(201).json(publicClip(service.createVariant(req.params.id, me(req))));
});

clipsRouter.get(
  '/clips/:id/download',
  asyncHandler(async (req, res) => {
    const { file, name } = await service.clipDownload(req.params.id, me(req));
    res.download(file, name);
  }),
);

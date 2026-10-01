import { Router } from 'express';
import { validate } from '../../lib/http.js';
import { publicClip } from './clips.presenter.js';
import { clipPatchSchema } from './clips.schemas.js';
import * as service from './clips.service.js';

export const clipsRouter = Router();

clipsRouter.get('/clips/:id/transcript', (req, res) => {
  res.json(service.clipTranscript(req.params.id));
});

clipsRouter.patch('/clips/:id', (req, res) => {
  const { clip, project } = service.getClipWithProject(req.params.id);
  const edit = validate(clipPatchSchema, req.body, (issue) => issue ?? 'Invalid edit');
  res.json(publicClip(service.updateClip(clip, project, edit)));
});

clipsRouter.post('/clips/:id/render', (req, res) => {
  res.json(publicClip(service.rerenderClip(req.params.id)));
});

clipsRouter.post('/clips/:id/variant', (req, res) => {
  res.status(201).json(publicClip(service.createVariant(req.params.id)));
});

clipsRouter.get('/clips/:id/download', (req, res) => {
  const { file, name } = service.clipDownload(req.params.id);
  res.download(file, name);
});

import { Router } from 'express';
import { asyncHandler, validate } from '../../lib/http.js';
import { publicClip } from './clips.presenter.js';
import { clipPatchSchema } from './clips.schemas.js';
import { me } from '../auth/auth.middleware.js';
import * as service from './clips.service.js';

export const clipsRouter = Router();

clipsRouter.get(
  '/clips/:id/transcript',
  asyncHandler(async (req, res) => {
    res.json(await service.clipTranscript(req.params.id, me(req)));
  }),
);

clipsRouter.patch(
  '/clips/:id',
  asyncHandler(async (req, res) => {
    const { clip, project } = await service.getClipWithProject(req.params.id, me(req));
    const edit = validate(clipPatchSchema, req.body, (issue) => issue ?? 'Invalid edit');
    res.json(await publicClip(await service.updateClip(clip, project, edit)));
  }),
);

clipsRouter.post(
  '/clips/:id/render',
  asyncHandler(async (req, res) => {
    res.json(await publicClip(await service.rerenderClip(req.params.id, me(req))));
  }),
);

clipsRouter.post(
  '/clips/:id/variant',
  asyncHandler(async (req, res) => {
    res.status(201).json(await publicClip(await service.createVariant(req.params.id, me(req))));
  }),
);

clipsRouter.get(
  '/clips/:id/download',
  asyncHandler(async (req, res) => {
    const { file, name } = await service.clipDownload(req.params.id, me(req));
    res.download(file, name);
  }),
);

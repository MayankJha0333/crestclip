import { Router } from 'express';
import { asyncHandler, validate } from '../../lib/http.js';
import { publicConnections, publicPost } from './publishing.presenter.js';
import { createPostsSchema } from './publishing.schemas.js';
import * as service from './publishing.service.js';
import type { Platform } from './providers/index.js';

export const publishingRouter = Router();

publishingRouter.get('/connections', (_req, res) => {
  res.json(publicConnections());
});

publishingRouter.get('/connect/:platform/start', (req, res) => {
  const platform = req.params.platform;
  if (!service.isPlatform(platform)) return res.status(404).send('Unknown platform');
  res.redirect(service.connectUrl(platform));
});

publishingRouter.get(
  '/connect/:platform/callback',
  asyncHandler(async (req, res) => {
    res.redirect(await service.finishConnect(req.params.platform as Platform, req.query));
  }),
);

publishingRouter.delete(
  '/connections/:id',
  asyncHandler(async (req, res) => {
    await service.disconnect(req.params.id);
    res.json({ ok: true });
  }),
);

publishingRouter.post('/posts', (req, res) => {
  const body = validate(createPostsSchema, req.body, 'Choose at least one account.');
  res.status(201).json(service.createPosts(body).map(publicPost));
});

publishingRouter.get('/posts', (req, res) => {
  const clipId = typeof req.query.clipId === 'string' ? req.query.clipId : undefined;
  res.json(service.listPosts(clipId).map(publicPost));
});

publishingRouter.post('/posts/:id/retry', (req, res) => {
  res.json(publicPost(service.retryPost(req.params.id)));
});

publishingRouter.post('/posts/:id/cancel', (req, res) => {
  res.json(publicPost(service.cancelPost(req.params.id)));
});

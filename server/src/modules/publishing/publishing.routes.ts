import { Router } from 'express';
import { asyncHandler, validate } from '../../lib/http.js';
import { publicConnections, publicPost, publicPosts } from './publishing.presenter.js';
import { createPostsSchema } from './publishing.schemas.js';
import * as service from './publishing.service.js';
import type { Platform } from './providers/index.js';
import { me } from '../auth/auth.middleware.js';

export const publishingRouter = Router();

publishingRouter.get(
  '/connections',
  asyncHandler(async (req, res) => {
    res.json(await publicConnections(me(req)));
  }),
);

publishingRouter.get('/connect/:platform/start', (req, res) => {
  const platform = req.params.platform;
  if (!service.isPlatform(platform)) return res.status(404).send('Unknown platform');
  res.redirect(service.connectUrl(platform, me(req)));
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
    await service.disconnect(req.params.id, me(req));
    res.json({ ok: true });
  }),
);

publishingRouter.post(
  '/posts',
  asyncHandler(async (req, res) => {
    const body = validate(createPostsSchema, req.body, 'Choose at least one account.');
    res.status(201).json(await publicPosts(await service.createPosts(body, me(req))));
  }),
);

publishingRouter.get(
  '/posts',
  asyncHandler(async (req, res) => {
    const clipId = typeof req.query.clipId === 'string' ? req.query.clipId : undefined;
    res.json(await publicPosts(await service.listPosts(me(req), clipId)));
  }),
);

publishingRouter.post(
  '/posts/:id/retry',
  asyncHandler(async (req, res) => {
    res.json(await publicPost(await service.retryPost(req.params.id, me(req))));
  }),
);

publishingRouter.post(
  '/posts/:id/cancel',
  asyncHandler(async (req, res) => {
    res.json(await publicPost(await service.cancelPost(req.params.id, me(req))));
  }),
);

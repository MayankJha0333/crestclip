import { Router } from 'express';
import { asyncHandler } from '../../lib/http.js';
import { pingDb } from '../../db/index.js';
import * as service from './system.service.js';

export const systemRouter = Router();

systemRouter.get(
  '/health',
  asyncHandler(async (req, res) => {
    res.json(await service.health(Boolean(req.query.refresh)));
  }),
);

systemRouter.post(
  '/tools/refresh',
  asyncHandler(async (_req, res) => {
    res.json(await service.refreshTools());
  }),
);

/** Public: who runs CrestClip and the numbers the policy pages quote. */
systemRouter.get('/site', (_req, res) => {
  res.json(service.site());
});

/** Public: the server is running and can reach the database, and which version it is (the git commit). Deploys wait for this. */
systemRouter.get(
  '/live',
  asyncHandler(async (_req, res) => {
    await pingDb();
    res.json({ ok: true, version: process.env.APP_VERSION ?? 'dev' });
  }),
);

import { Router } from 'express';
import { asyncHandler } from '../../lib/http.js';
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

systemRouter.get('/meta', (_req, res) => {
  res.json(service.meta());
});

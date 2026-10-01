import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, validate } from '../../lib/http.js';
import { channelQuerySchema, searchQuerySchema } from './explore.schemas.js';
import * as service from './explore.service.js';

export const exploreRouter = Router();

/** A missing yt-dlp is our problem (503); anything else is the platform failing (502). */
const sourceFailed = (e: unknown): never => {
  const msg = (e as Error).message || 'Something went wrong';
  throw new HttpError(/not installed|Could not start/.test(msg) ? 503 : 502, msg);
};

exploreRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const q = validate(searchQuerySchema, req.query, 'Type something to search for.');
    res.json(await service.search(q).catch(sourceFailed));
  }),
);

exploreRouter.get(
  '/channel',
  asyncHandler(async (req, res) => {
    const q = validate(channelQuerySchema, req.query, 'Missing channel.');
    res.json(await service.channel(q).catch(sourceFailed));
  }),
);

exploreRouter.get(
  '/peek',
  asyncHandler(async (req, res) => {
    const url = validate(z.string().url(), req.query.url, 'Bad link');
    res.json(await service.preview(url).catch(sourceFailed));
  }),
);

exploreRouter.get('/meta', (_req, res) => res.json(service.meta()));

exploreRouter.get('/categories', (_req, res) => res.json(service.categories()));

exploreRouter.get(
  '/discover',
  asyncHandler(async (req, res) => {
    const source = req.query.source === 'twitch' ? 'twitch' : 'youtube';
    res.json(await service.discoverFeed(source, req.query.category).catch(sourceFailed));
  }),
);

import { Router } from 'express';
import { z } from 'zod';
import { assertPublicUrl } from '../../lib/net.js';
import { asyncHandler, HttpError, validate } from '../../lib/http.js';
import { isYouTubeUrl } from '../../pipeline/ytweb.js';
import { me } from '../auth/auth.middleware.js';
import { assertYoutubeSource } from '../billing/billing.service.js';
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
    if (q.source === 'youtube') assertYoutubeSource(me(req)); // YouTube in Explore is on Creator and Pro
    res.json(await service.search(q).catch(sourceFailed));
  }),
);

exploreRouter.get(
  '/channel',
  asyncHandler(async (req, res) => {
    const q = validate(channelQuerySchema, req.query, 'Missing channel.');
    if (!/twitch\.tv/i.test(q.url)) assertYoutubeSource(me(req)); // anything that isn't Twitch is a YouTube channel here
    if (/^https?:\/\//i.test(q.url)) await assertPublicUrl(q.url);
    res.json(await service.channel(q).catch(sourceFailed));
  }),
);

exploreRouter.get(
  '/peek',
  asyncHandler(async (req, res) => {
    const url = validate(z.string().url(), req.query.url, 'Bad link');
    if (isYouTubeUrl(url)) assertYoutubeSource(me(req));
    await assertPublicUrl(url);
    res.json(await service.preview(url).catch(sourceFailed));
  }),
);

exploreRouter.get('/categories', (_req, res) => res.json(service.categories()));

exploreRouter.get(
  '/discover',
  asyncHandler(async (req, res) => {
    const source = req.query.source === 'twitch' ? 'twitch' : 'youtube';
    if (source === 'youtube') assertYoutubeSource(me(req));
    res.json(await service.discoverFeed(source, req.query.category).catch(sourceFailed));
  }),
);

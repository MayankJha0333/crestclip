import { Router } from 'express';
import { z } from 'zod';
import { assertPublicUrl } from '../../lib/net.js';
import { asyncHandler, HttpError, validate } from '../../lib/http.js';
import { isYouTubeUrl, youtubeId } from '../../pipeline/ytweb.js';
import { rateLimit } from '../auth/auth.service.js';
import { me } from '../auth/auth.middleware.js';
import { assertYoutubeExplore, assertYoutubeSource } from '../billing/billing.service.js';
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
    if (q.source === 'youtube') assertYoutubeExplore(me(req)); // browsing YouTube: Creator and Pro
    res.json(await service.search(q).catch(sourceFailed));
  }),
);

exploreRouter.get(
  '/channel',
  asyncHandler(async (req, res) => {
    const q = validate(channelQuerySchema, req.query, 'Missing channel.');
    if (!/twitch\.tv/i.test(q.url)) assertYoutubeExplore(me(req)); // anything that isn't Twitch is a YouTube channel here
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
    if (source === 'youtube') assertYoutubeExplore(me(req));
    res.json(await service.discoverFeed(source, req.query.category).catch(sourceFailed));
  }),
);

/**
 * The landing page's "see the peaks before you sign up": title, thumbnail, length and the "Most replayed" graph with
 * the top peaks, for one YouTube link, with no account. Read from YouTube's own page (no AI, no download), cached
 * per video, and limited per visitor so it can't be used to hammer YouTube.
 */
exploreRouter.get(
  '/public-peek',
  asyncHandler(async (req, res) => {
    const url = validate(z.string().url(), req.query.url, 'Paste a full YouTube link.');
    if (!youtubeId(url)) throw new HttpError(400, 'The free preview works with YouTube links. Sign up to clip podcasts, Twitch and your own files.');
    await rateLimit(`peek:${req.ip}`, 30, 60 * 60_000, 'That’s a lot of previews — sign up to keep going, or try again in an hour.');
    await assertPublicUrl(url);
    const p = await service.preview(url).catch(sourceFailed);
    const avg = p.curve?.length ? p.curve.reduce((a, b) => a + b, 0) / p.curve.length : 0;
    res.json({
      title: p.title,
      channel: p.channel,
      duration: p.duration,
      views: p.views,
      thumbnail: p.thumbnail,
      url: p.url,
      curve: p.curve,
      peaks: p.hotspots.slice(0, 3).map((h) => ({ start: h.start, end: h.end, times: avg > 0 ? +(h.value / avg).toFixed(1) : null })),
    });
  }),
);

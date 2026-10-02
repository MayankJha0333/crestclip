import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import { projects } from './db/index.js';
import { fetchFromCloud } from './infra/cloudStore.js';
import { asyncMiddleware, errorHandler, HttpError } from './lib/http.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { attachUser, requireUser } from './modules/auth/auth.middleware.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { autopilotRouter } from './modules/autopilot/autopilot.routes.js';
import { billingRouter } from './modules/billing/billing.routes.js';
import { clipsRouter } from './modules/clips/clips.routes.js';
import { exploreRouter } from './modules/explore/explore.routes.js';
import { musicRouter } from './modules/music/music.routes.js';
import { projectsRouter } from './modules/projects/projects.routes.js';
import { publishingRouter } from './modules/publishing/publishing.routes.js';
import { systemRouter } from './modules/system/system.routes.js';
import { watermarkRouter } from './modules/watermark/watermark.routes.js';

/** API routes anyone can call (everything else needs a signed-in person). */
const PUBLIC_API = [/^\/auth\//, /^\/billing\/(plans|webhook)$/, /^\/connect\/[a-z]+\/callback$/, /^\/site$/];

/**
 * Files under /media: only the owner's projects, watermark and music (plus shared mood tracks, emoji and the
 * CrestClip mark). Nothing else in the data folder (database, keys, logs) is ever served.
 */
const mediaAccess = asyncMiddleware(async (req, _res, next) => {
  const user = req.user;
  if (!user) return next(new HttpError(401, 'Please log in.'));
  const parts = decodeURIComponent(req.path).split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p.startsWith('.'))) return next(new HttpError(404, 'Not found'));
  const [top, a, b] = parts;
  const ok =
    (top === 'projects' && (await projects.get(a ?? ''))?.userId === user.id) ||
    (top === 'brand' && (a === user.id || a === 'crestclip-mark.png')) ||
    (top === 'music' && (a === 'ai' || (a === 'uploads' && b === user.id))) ||
    top === 'emoji';
  next(ok ? undefined : new HttpError(404, 'Not found'));
});

/** A project file that isn't on this disk (new server, cleaned disk): bring it back from the cloud bucket first. */
function fromCloud(req: Request, _res: Response, next: NextFunction) {
  const parts = decodeURIComponent(req.path).split('/').filter(Boolean);
  if (parts[0] !== 'projects') return next();
  const abs = path.join(config.dataDir, ...parts);
  if (fs.existsSync(abs)) return next();
  fetchFromCloud(abs).then(
    () => next(),
    () => next(),
  );
}

/** The HTTP app: JSON API under /api, rendered files under /media, and the built web app for everything else. */
export function createApp() {
  const app = express();
  app.set('trust proxy', 'loopback'); // real client IPs behind a local reverse proxy (rate limits)
  // keep the raw bytes too: Razorpay webhooks are signed over the exact body
  app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => ((req as Request).rawBody = Buffer.from(buf)) }));
  app.use(attachUser);

  app.use('/api', (req, res, next) => (PUBLIC_API.some((r) => r.test(req.path)) ? next() : requireUser(req, res, next)));
  app.use('/api', authRouter);
  app.use('/api', billingRouter);
  app.use('/api', adminRouter);
  app.use('/api', systemRouter);
  app.use('/api', projectsRouter);
  app.use('/api', clipsRouter);
  app.use('/api', musicRouter);
  app.use('/api', watermarkRouter);
  app.use('/api/explore', exploreRouter);
  app.use('/api', publishingRouter);
  app.use('/api', autopilotRouter);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  app.use('/media', mediaAccess, fromCloud, express.static(config.dataDir, { fallthrough: false, maxAge: '1h', index: false, dotfiles: 'deny' }));
  if (fs.existsSync(config.webDist)) {
    app.use(express.static(config.webDist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api|media).*/, (_req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}

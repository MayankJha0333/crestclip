import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { errorHandler, HttpError } from './lib/http.js';
import { autopilotRouter } from './modules/autopilot/autopilot.routes.js';
import { clipsRouter } from './modules/clips/clips.routes.js';
import { exploreRouter } from './modules/explore/explore.routes.js';
import { musicRouter } from './modules/music/music.routes.js';
import { projectsRouter } from './modules/projects/projects.routes.js';
import { publishingRouter } from './modules/publishing/publishing.routes.js';
import { systemRouter } from './modules/system/system.routes.js';

/** The HTTP app: JSON API under /api, rendered files under /media, and the built web app for everything else. */
export function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.use('/api', systemRouter);
  app.use('/api', projectsRouter);
  app.use('/api', clipsRouter);
  app.use('/api', musicRouter);
  app.use('/api/explore', exploreRouter);
  app.use('/api', publishingRouter);
  app.use('/api', autopilotRouter);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  app.use('/media', express.static(config.dataDir, { fallthrough: false, maxAge: '1h', index: false, dotfiles: 'deny' }));
  if (fs.existsSync(config.webDist)) {
    app.use(express.static(config.webDist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api|media).*/, (_req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}

import { Router } from 'express';
import { autopilots } from '../../db/index.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { alternativesView, autopilotDetail, autopilotStatus, autopilotSummary } from './autopilot.presenter.js';
import { autopilotSchema } from './autopilot.schemas.js';
import { me } from '../auth/auth.middleware.js';
import * as service from './autopilot.service.js';
import { searchChannels, suggestTopics, topicStats } from './autopilot.sources.js';
import { toHttpError } from '../../lib/http.js';

export const autopilotRouter = Router();

const formError = (issue: string | undefined) => issue ?? 'Check the form';

// suggestions while typing a source in the editor
autopilotRouter.get(
  '/autopilot/suggest/channels',
  asyncHandler(async (req, res) => {
    res.json(await searchChannels(String(req.query.q ?? '')).catch(toHttpError(502)));
  }),
);
autopilotRouter.get(
  '/autopilot/suggest/topics',
  asyncHandler(async (req, res) => {
    const region = req.query.region ? String(req.query.region).slice(0, 4) : null;
    res.json(await suggestTopics(String(req.query.q ?? ''), region).catch(toHttpError(502)));
  }),
);
autopilotRouter.get(
  '/autopilot/suggest/topic-stats',
  asyncHandler(async (req, res) => {
    const region = req.query.region ? String(req.query.region).slice(0, 4) : null;
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 14));
    res.json(await topicStats(String(req.query.q ?? '').slice(0, 120), region, days).catch(toHttpError(502)));
  }),
);

autopilotRouter.get('/autopilot/status', (_req, res) => {
  res.json(autopilotStatus());
});

autopilotRouter.post(
  '/autopilot/resolve-channel',
  asyncHandler(async (req, res) => {
    res.json(await service.findChannel(req.body?.input));
  }),
);

autopilotRouter.post(
  '/autopilot/preview-source',
  asyncHandler(async (req, res) => {
    res.json(await service.previewSource(req.body));
  }),
);

autopilotRouter.get(
  '/autopilots',
  asyncHandler(async (req, res) => {
    res.json(await Promise.all((await autopilots.list(me(req).id)).map(autopilotSummary)));
  }),
);

autopilotRouter.post(
  '/autopilots',
  asyncHandler(async (req, res) => {
    const form = validate(autopilotSchema, req.body, formError);
    res.status(201).json(await autopilotSummary(await service.createAutopilot(me(req), form)));
  }),
);

autopilotRouter.get(
  '/autopilots/:id',
  asyncHandler(async (req, res) => {
    res.json(await autopilotDetail(await service.getAutopilot(req.params.id, me(req))));
  }),
);

autopilotRouter.put(
  '/autopilots/:id',
  asyncHandler(async (req, res) => {
    const ap = await service.getAutopilot(req.params.id, me(req));
    const form = validate(autopilotSchema, req.body, formError);
    res.json(await autopilotSummary(await service.updateAutopilot(me(req), ap, form)));
  }),
);

autopilotRouter.post(
  '/autopilots/:id/pause',
  asyncHandler(async (req, res) => {
    res.json(await autopilotSummary(await service.pauseAutopilot(req.params.id, me(req))));
  }),
);

autopilotRouter.post(
  '/autopilots/:id/resume',
  asyncHandler(async (req, res) => {
    res.json(await autopilotSummary(await service.resumeAutopilot(req.params.id, me(req))));
  }),
);

autopilotRouter.post(
  '/autopilots/:id/scan',
  asyncHandler(async (req, res) => {
    await service.scanAutopilot(req.params.id, me(req));
    res.json({ ok: true });
  }),
);

autopilotRouter.delete(
  '/autopilots/:id',
  asyncHandler(async (req, res) => {
    await service.deleteAutopilot(req.params.id, me(req));
    res.json({ ok: true });
  }),
);

autopilotRouter.post(
  '/autopilots/:id/slots/:key/skip',
  asyncHandler(async (req, res) => {
    await service.skipAutopilotSlot(req.params.id, me(req), req.params.key);
    res.json({ ok: true });
  }),
);

autopilotRouter.get(
  '/autopilots/:id/alternatives',
  asyncHandler(async (req, res) => {
    res.json(await alternativesView(await service.slotAlternatives(req.params.id, me(req))));
  }),
);

autopilotRouter.post(
  '/autopilots/:id/slots/:key/swap',
  asyncHandler(async (req, res) => {
    await service.swapAutopilotSlot(req.params.id, me(req), req.params.key, req.body);
    res.json({ ok: true });
  }),
);

autopilotRouter.post(
  '/autopilots/:id/slots/:key/restore',
  asyncHandler(async (req, res) => {
    await service.restoreAutopilotSlot(req.params.id, me(req), req.params.key);
    res.json({ ok: true });
  }),
);

autopilotRouter.post(
  '/autopilots/:id/clips/:itemId/:action',
  asyncHandler(async (req, res) => {
    await service.reviewClip(req.params.id, me(req), req.params.itemId, req.params.action);
    res.json({ ok: true });
  }),
);

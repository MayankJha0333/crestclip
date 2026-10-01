import { Router } from 'express';
import { autopilots } from '../../db/index.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { autopilotDetail, autopilotStatus, autopilotSummary } from './autopilot.presenter.js';
import { autopilotSchema } from './autopilot.schemas.js';
import * as service from './autopilot.service.js';

export const autopilotRouter = Router();

const formError = (issue: string | undefined) => issue ?? 'Check the form';

autopilotRouter.get('/autopilot/status', (_req, res) => {
  res.json(autopilotStatus());
});

autopilotRouter.post(
  '/autopilot/resolve-channel',
  asyncHandler(async (req, res) => {
    res.json(await service.findChannel(req.body?.input));
  }),
);

autopilotRouter.post('/autopilot/preview-times', (req, res) => {
  res.json(service.previewTimes(req.body));
});

autopilotRouter.post(
  '/autopilot/preview-source',
  asyncHandler(async (req, res) => {
    res.json(await service.previewSource(req.body));
  }),
);

autopilotRouter.get('/autopilots', (_req, res) => {
  res.json(autopilots.list().map(autopilotSummary));
});

autopilotRouter.post(
  '/autopilots',
  asyncHandler(async (req, res) => {
    const form = validate(autopilotSchema, req.body, formError);
    res.status(201).json(autopilotSummary(await service.createAutopilot(form)));
  }),
);

autopilotRouter.get('/autopilots/:id', (req, res) => {
  res.json(autopilotDetail(service.getAutopilot(req.params.id)));
});

autopilotRouter.put(
  '/autopilots/:id',
  asyncHandler(async (req, res) => {
    const ap = service.getAutopilot(req.params.id);
    const form = validate(autopilotSchema, req.body, formError);
    res.json(autopilotSummary(await service.updateAutopilot(ap, form)));
  }),
);

autopilotRouter.post(
  '/autopilots/:id/pause',
  asyncHandler(async (req, res) => {
    res.json(autopilotSummary(await service.pauseAutopilot(req.params.id)));
  }),
);

autopilotRouter.post(
  '/autopilots/:id/resume',
  asyncHandler(async (req, res) => {
    res.json(autopilotSummary(await service.resumeAutopilot(req.params.id)));
  }),
);

autopilotRouter.post(
  '/autopilots/:id/scan',
  asyncHandler(async (req, res) => {
    await service.scanAutopilot(req.params.id);
    res.json({ ok: true });
  }),
);

autopilotRouter.delete(
  '/autopilots/:id',
  asyncHandler(async (req, res) => {
    await service.deleteAutopilot(req.params.id);
    res.json({ ok: true });
  }),
);

autopilotRouter.post(
  '/autopilots/:id/slots/:key/skip',
  asyncHandler(async (req, res) => {
    await service.skipAutopilotSlot(req.params.id, req.params.key);
    res.json({ ok: true });
  }),
);

autopilotRouter.post(
  '/autopilots/:id/slots/:key/restore',
  asyncHandler(async (req, res) => {
    await service.restoreAutopilotSlot(req.params.id, req.params.key);
    res.json({ ok: true });
  }),
);

autopilotRouter.post(
  '/autopilots/:id/clips/:itemId/:action',
  asyncHandler(async (req, res) => {
    await service.reviewClip(req.params.id, req.params.itemId, req.params.action);
    res.json({ ok: true });
  }),
);

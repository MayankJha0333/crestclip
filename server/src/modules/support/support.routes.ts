import { Router } from 'express';
import { z } from 'zod';
import { TICKET_CATEGORIES, TICKET_STATUSES } from '../../db/index.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { me, requireAdmin, requireUser } from '../auth/auth.middleware.js';
import * as service from './support.service.js';

/** Help requests: the person's side under /support, the team's side under /admin/tickets. */
export const supportRouter = Router();

const message = z.string().trim().min(2, 'Write a little more.').max(5000, 'That’s a bit long — 5,000 characters at most.');

supportRouter.get(
  '/support/tickets',
  requireUser,
  asyncHandler(async (req, res) => {
    res.json(await service.myTickets(me(req)));
  }),
);

supportRouter.post(
  '/support/tickets',
  requireUser,
  asyncHandler(async (req, res) => {
    const body = validate(
      z.object({
        category: z.enum(TICKET_CATEGORIES),
        subject: z.string().trim().min(3, 'Add a short subject.').max(120, 'Keep the subject under 120 characters.'),
        message,
        projectId: z.string().max(40).nullish(),
        page: z.string().max(300).nullish(),
      }),
      req.body,
      (i) => i ?? 'Fill in the subject and the message.',
    );
    res.json(await service.createTicket(me(req), body, String(req.headers['user-agent'] ?? '') || null));
  }),
);

supportRouter.get(
  '/support/tickets/:id',
  requireUser,
  asyncHandler(async (req, res) => {
    res.json(await service.myTicket(me(req), String(req.params.id)));
  }),
);

supportRouter.post(
  '/support/tickets/:id/messages',
  requireUser,
  asyncHandler(async (req, res) => {
    const { body } = validate(z.object({ body: message }), req.body, (i) => i ?? 'Write a message.');
    res.json(await service.userReply(me(req), String(req.params.id), body));
  }),
);

supportRouter.post(
  '/support/tickets/:id/close',
  requireUser,
  asyncHandler(async (req, res) => {
    res.json(await service.userClose(me(req), String(req.params.id)));
  }),
);

// ---------------- admins ----------------

supportRouter.get(
  '/admin/tickets',
  requireUser,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const q = validate(
      z.object({
        status: z.enum([...TICKET_STATUSES, 'active', 'all']).default('active'),
        category: z.enum(TICKET_CATEGORIES).optional(),
        q: z.string().max(80).optional(),
      }),
      req.query,
      'Bad filter.',
    );
    res.json(await service.adminList(q));
  }),
);

supportRouter.get(
  '/admin/tickets/:id',
  requireUser,
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await service.adminTicket(String(req.params.id)));
  }),
);

supportRouter.post(
  '/admin/tickets/:id/messages',
  requireUser,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = validate(z.object({ body: message, status: z.enum(TICKET_STATUSES).optional() }), req.body, (i) => i ?? 'Write a reply.');
    res.json(await service.adminReply(me(req), String(req.params.id), b.body, b.status));
  }),
);

supportRouter.patch(
  '/admin/tickets/:id',
  requireUser,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = validate(
      z.object({ status: z.enum(TICKET_STATUSES).optional(), priority: z.enum(['normal', 'high', 'urgent']).optional(), unread: z.boolean().optional() }),
      req.body,
      'Nothing to change.',
    );
    res.json(await service.adminUpdate(String(req.params.id), b));
  }),
);

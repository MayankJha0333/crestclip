import { Router } from 'express';
import { z } from 'zod';
import { credits, users } from '../../db/index.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { requireAdmin, requireUser } from '../auth/auth.middleware.js';
import { adminAdjustCredits, adminSetPlan } from '../billing/billing.service.js';
import { planOf } from '../billing/plans.js';

/** Admins: see every account, give a plan (e.g. to a friend or a tester), add or remove credits. */
export const adminRouter = Router();
adminRouter.use('/admin', requireUser, requireAdmin);

const row = (id: string) => {
  const u = users.get(id)!;
  return { id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin, plan: planOf(u.plan).id, paying: Boolean(u.rzSubscriptionId), balance: credits.balance(u.id), createdAt: u.createdAt };
};

adminRouter.get('/admin/users', (_req, res) => {
  res.json(users.list().map((u) => row(u.id)));
});

adminRouter.post(
  '/admin/users/:id/plan',
  asyncHandler(async (req, res) => {
    const { plan } = validate(z.object({ plan: z.enum(['free', 'creator', 'pro']) }), req.body, 'Pick a plan.');
    await adminSetPlan(req.params.id, plan);
    res.json(row(req.params.id));
  }),
);

adminRouter.post('/admin/users/:id/credits', (req, res) => {
  const body = validate(
    z.object({
      delta: z
        .number()
        .int()
        .min(-100000)
        .max(100000)
        .refine((n) => n !== 0, 'Enter a number other than 0.'),
      note: z.string().max(120).default(''),
    }),
    req.body,
    (i) => i ?? 'Enter how many credits.',
  );
  adminAdjustCredits(req.params.id, body.delta, body.note);
  res.json(row(req.params.id));
});

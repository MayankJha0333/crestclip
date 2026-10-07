import { Router } from 'express';
import { z } from 'zod';
import { clips, credits, projects, users, type UserRow } from '../../db/index.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { requireAdmin, requireUser } from '../auth/auth.middleware.js';
import { adminAdjustCredits, adminSetPlan } from '../billing/billing.service.js';
import { planOf } from '../billing/plans.js';

/** Admins: see every account, give a plan (e.g. to a friend or a tester), add or remove credits. */
export const adminRouter = Router();
adminRouter.use('/admin', requireUser, requireAdmin);

const toRow = async (u: UserRow) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  isAdmin: u.isAdmin,
  plan: planOf(u.plan).id,
  paying: Boolean(u.dodoSubscriptionId || u.rzSubscriptionId),
  balance: await credits.balance(u.id),
  createdAt: u.createdAt,
});
const row = async (id: string) => toRow((await users.get(id))!);

adminRouter.get(
  '/admin/users',
  asyncHandler(async (_req, res) => {
    res.json(await Promise.all((await users.list()).map(toRow)));
  }),
);

adminRouter.post(
  '/admin/users/:id/plan',
  asyncHandler(async (req, res) => {
    const { plan } = validate(z.object({ plan: z.enum(['free', 'creator', 'pro']) }), req.body, 'Pick a plan.');
    await adminSetPlan(req.params.id, plan);
    res.json(await row(req.params.id));
  }),
);

adminRouter.post(
  '/admin/users/:id/credits',
  asyncHandler(async (req, res) => {
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
    await adminAdjustCredits(req.params.id, body.delta, body.note);
    res.json(await row(req.params.id));
  }),
);

/** Admins: what a project cost in AI tokens (saved when it finished), to put a price on a clip. */
adminRouter.get(
  '/admin/projects/:id/usage',
  asyncHandler(async (req, res) => {
    const p = await projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const clipCount = (await clips.forProject(p.id)).length;
    res.json({ id: p.id, title: p.title, duration: p.duration, clipCount, aiUsage: p.aiUsage ?? null });
  }),
);

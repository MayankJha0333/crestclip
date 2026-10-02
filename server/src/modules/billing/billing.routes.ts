import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '../../lib/http.js';
import { me, requireUser } from '../auth/auth.middleware.js';
import * as service from './billing.service.js';
import { CREDITS_PER_CLIP, PLAN_ORDER, PLANS } from './plans.js';
import { currencyHint, shownCurrency } from './currency.js';

export const billingRouter = Router();

/** Public: the pricing table (landing page + Plan page). */
billingRouter.get('/billing/plans', (req, res) => {
  // prices in the visitor's currency (₹ in India, $ elsewhere; a signed-in payer always sees what they pay in)
  const shown = shownCurrency(req.user, currencyHint(req));
  res.json({ currency: shown, creditsPerClip: CREDITS_PER_CLIP, plans: PLAN_ORDER.map((id) => service.publicPlan(PLANS[id], shown)), topup: service.publicTopup(shown) });
});

/** Razorpay calls this on renewals and payments (signature-checked, no login). */
billingRouter.post(
  '/billing/webhook',
  asyncHandler(async (req, res) => {
    await service.handleWebhook(req.rawBody, String(req.headers['x-razorpay-signature'] ?? ''));
    res.json({ ok: true });
  }),
);

billingRouter.get(
  '/billing/account',
  requireUser,
  asyncHandler(async (req, res) => {
    // catch up with Razorpay first: an upgrade paid for but never confirmed becomes active here
    const user = await service.refreshAccount(await service.reconcileSubscriptions(me(req), { scan: true }));
    res.json({ ...service.accountSummary(user, currencyHint(req)), history: service.creditHistory(user), payments: service.paymentHistory(user) });
  }),
);

billingRouter.post(
  '/billing/subscribe',
  requireUser,
  asyncHandler(async (req, res) => {
    const { plan } = validate(z.object({ plan: z.enum(['creator', 'pro']) }), req.body, 'Pick a plan.');
    res.json(await service.startSubscription(me(req), plan, currencyHint(req)));
  }),
);

billingRouter.post(
  '/billing/subscribe/confirm',
  requireUser,
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ paymentId: z.string().min(1), subscriptionId: z.string().min(1), signature: z.string().min(1) }), req.body, 'Missing payment details.');
    const { user, pending } = await service.confirmSubscription(me(req), body);
    res.json({ ...service.accountSummary(user, currencyHint(req)), pending });
  }),
);

billingRouter.post(
  '/billing/topup',
  requireUser,
  asyncHandler(async (req, res) => {
    res.json(await service.startTopup(me(req), currencyHint(req)));
  }),
);

billingRouter.post(
  '/billing/topup/confirm',
  requireUser,
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ orderId: z.string().min(1), paymentId: z.string().min(1), signature: z.string().min(1) }), req.body, 'Missing payment details.');
    const user = await service.confirmTopup(me(req), body);
    res.json(service.accountSummary(user, currencyHint(req)));
  }),
);

billingRouter.post(
  '/billing/cancel',
  requireUser,
  asyncHandler(async (req, res) => {
    res.json(service.accountSummary(await service.cancelPlan(me(req)), currencyHint(req)));
  }),
);

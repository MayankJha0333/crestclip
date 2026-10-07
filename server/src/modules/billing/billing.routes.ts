import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '../../lib/http.js';
import { me, requireUser } from '../auth/auth.middleware.js';
import * as service from './billing.service.js';

export const billingRouter = Router();

/** Public: the pricing table (landing page + Plan page). */
billingRouter.get('/billing/plans', (_req, res) => {
  res.json(service.plansInfo());
});

/** Dodo Payments calls this on payments, renewals, failed renewals and cancellations (signature-checked, no login). */
billingRouter.post(
  '/billing/dodo/webhook',
  asyncHandler(async (req, res) => {
    const h = (k: string) => String(req.headers[k] ?? '');
    await service.handleDodoWebhook(req.rawBody, { id: h('webhook-id'), timestamp: h('webhook-timestamp'), signature: h('webhook-signature') });
    res.json({ ok: true });
  }),
);

/** Legacy: Razorpay calls this for subscriptions made before the move to Dodo (signature-checked, no login). */
billingRouter.post(
  '/billing/webhook',
  asyncHandler(async (req, res) => {
    await service.handleRazorpayWebhook(req.rawBody, String(req.headers['x-razorpay-signature'] ?? ''));
    res.json({ ok: true });
  }),
);

billingRouter.get(
  '/billing/account',
  requireUser,
  asyncHandler(async (req, res) => {
    // catch up with Dodo first: a payment whose webhook hasn't arrived (or never will, e.g. running locally) counts here
    const user = await service.refreshAccount(await service.reconcileSubscriptions(me(req), { soon: req.query.sync === '1' }));
    res.json({ ...(await service.accountSummary(user)), history: await service.creditHistory(user), payments: await service.paymentHistory(user) });
  }),
);

billingRouter.get(
  '/billing/payments/:id/receipt',
  requireUser,
  asyncHandler(async (req, res) => {
    res.json(await service.receipt(me(req), String(req.params.id)));
  }),
);

/** → { url } (open Dodo's checkout page) or { changed, pending } (an upgrade done on the existing subscription) */
billingRouter.post(
  '/billing/subscribe',
  requireUser,
  asyncHandler(async (req, res) => {
    const { plan } = validate(z.object({ plan: z.enum(['creator', 'pro']) }), req.body, 'Pick a plan.');
    res.json(await service.startSubscription(me(req), plan));
  }),
);

billingRouter.post(
  '/billing/topup',
  requireUser,
  asyncHandler(async (req, res) => {
    res.json(await service.startTopup(me(req)));
  }),
);

/** Back from Dodo's checkout page with ?subscription_id / ?payment_id: apply it (checked with Dodo, not trusted). */
billingRouter.post(
  '/billing/checkout/confirm',
  requireUser,
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ subscriptionId: z.string().min(1).max(100).optional(), paymentId: z.string().min(1).max(100).optional() }), req.body, 'Missing payment details.');
    const { user, pending } = await service.confirmCheckout(me(req), body);
    res.json({ ...(await service.accountSummary(await service.refreshAccount(user))), pending });
  }),
);

billingRouter.post(
  '/billing/cancel',
  requireUser,
  asyncHandler(async (req, res) => {
    res.json(await service.accountSummary(await service.cancelPlan(me(req))));
  }),
);

billingRouter.post(
  '/billing/resume',
  requireUser,
  asyncHandler(async (req, res) => {
    res.json(await service.accountSummary(await service.resumePlan(me(req))));
  }),
);

/** → { url } of Dodo's customer portal (card / UPI mandate, invoices) */
billingRouter.post(
  '/billing/portal',
  requireUser,
  asyncHandler(async (req, res) => {
    res.json(await service.billingPortal(me(req)));
  }),
);

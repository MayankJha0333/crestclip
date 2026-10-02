import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { users } from '../../db/index.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { accountSummary, reconcileSubscriptions, refreshAccount } from '../billing/billing.service.js';
import { clearSessionCookie, me, requireUser, setSessionCookie } from './auth.middleware.js';
import * as service from './auth.service.js';

export const authRouter = Router();

const email = z.string().trim().toLowerCase().email().max(200);
const password = z.string().min(8, 'Use at least 8 characters for the password.').max(200);

/** What the sign-in page can offer. */
authRouter.get(
  '/auth/config',
  asyncHandler(async (_req, res) => {
    res.json({ google: service.googleLoginReady(), signups: config.allowSignups || (await users.count()) === 0, firstAccount: (await users.count()) === 0 });
  }),
);

authRouter.post(
  '/auth/signup',
  asyncHandler(async (req, res) => {
    // free credits come with every account, so cap new accounts per network (not on a local dev setup)
    if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(config.publicUrl)) service.rateLimit(`signup:${req.ip}`, 5, 24 * 3600_000, 'Too many new accounts from this network today. Try again tomorrow.');
    const body = validate(z.object({ email, password, name: z.string().max(80).optional() }), req.body, (i) => i ?? 'Check your email and password.');
    const user = await service.signUp(body);
    const s = await service.startSession(user.id);
    setSessionCookie(res, s.token, s.expiresAt);
    res.status(201).json({ ok: true });
  }),
);

authRouter.post(
  '/auth/login',
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ email, password: z.string().min(1).max(200) }), req.body, 'Enter your email and password.');
    service.rateLimit(`login:${req.ip}:${body.email}`, 10, 15 * 60_000, 'Too many tries. Wait 15 minutes and try again.');
    const user = await service.logIn(body);
    const s = await service.startSession(user.id);
    setSessionCookie(res, s.token, s.expiresAt);
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/auth/logout',
  asyncHandler(async (req, res) => {
    if (req.sessionToken) await service.endSession(req.sessionToken);
    clearSessionCookie(res);
    res.json({ ok: true });
  }),
);

/** The signed-in person, their plan and credits (401 when nobody is signed in). */
authRouter.get(
  '/auth/me',
  requireUser,
  asyncHandler(async (req, res) => {
    // right after Checkout, a plan whose payment hasn't been confirmed yet is checked with Razorpay
    const signedIn = me(req);
    const user = await refreshAccount(signedIn.pendingSubscriptionId ? await reconcileSubscriptions(signedIn) : signedIn);
    res.json({
      user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar, isAdmin: user.isAdmin, hasPassword: Boolean(user.passwordHash), google: Boolean(user.googleSub) },
      account: await accountSummary(user),
    });
  }),
);

authRouter.post(
  '/auth/password',
  requireUser,
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ current: z.string().max(200).default(''), next: password }), req.body, (i) => i ?? 'Check the passwords.');
    service.rateLimit(`pw:${me(req).id}`, 10, 15 * 60_000, 'Too many tries. Wait 15 minutes.');
    await service.changePassword(me(req), body.current, body.next);
    res.json({ ok: true });
  }),
);

authRouter.get('/auth/google/start', (req, res) => {
  if (!service.googleLoginReady()) return res.redirect(`${config.publicUrl}/login?error=${encodeURIComponent('Google sign-in isn’t set up on this server.')}`);
  res.redirect(service.googleStartUrl(req.query.next));
});

authRouter.get('/auth/google/callback', async (req, res) => {
  try {
    const { user, next } = await service.googleFinish(req.query);
    const s = await service.startSession(user.id);
    setSessionCookie(res, s.token, s.expiresAt);
    res.redirect(`${config.publicUrl}${next}`);
  } catch (e) {
    res.redirect(`${config.publicUrl}/login?error=${encodeURIComponent((e as Error).message)}`);
  }
});

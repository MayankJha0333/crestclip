import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { users, tickets } from '../../db/index.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { accountSummary, refreshAccount } from '../billing/billing.service.js';
import { clearSessionCookie, me, requireUser, setSessionCookie } from './auth.middleware.js';
import * as service from './auth.service.js';
import { deleteAccount } from './account-deletion.js';

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

/**
 * Email + password log-in. There is no public sign-up or log-in form any more — everyone joins with Google.
 * This stays only for accounts the owner gave a password (e.g. the Meta / Google app-review test account,
 * see `npm run set-password -w server`), reached at /login?with=email.
 */
authRouter.post(
  '/auth/login',
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ email, password: z.string().min(1).max(200) }), req.body, 'Enter your email and password.');
    await service.rateLimit(`login:${req.ip}:${body.email}`, 10, 15 * 60_000, 'Too many tries. Wait 15 minutes and try again.');
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

/** The signed-in person, their plan and credits — `{ user: null }` when nobody is signed in (not an error). */
authRouter.get(
  '/auth/me',
  asyncHandler(async (req, res) => {
    if (!req.user) return res.json({ user: null, account: null });
    const user = await refreshAccount(me(req));
    res.json({
      user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar, isAdmin: user.isAdmin, hasPassword: Boolean(user.passwordHash), google: Boolean(user.googleSub) },
      account: await accountSummary(user),
      // Help: answers they haven't read · Admin: requests waiting for the team
      support: { unread: await tickets.unreadFor(user.id), ...(user.isAdmin ? { adminUnread: await tickets.adminUnread() } : {}) },
    });
  }),
);

authRouter.post(
  '/auth/password',
  requireUser,
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ current: z.string().max(200).default(''), next: password }), req.body, (i) => i ?? 'Check the passwords.');
    await service.rateLimit(`pw:${me(req).id}`, 10, 15 * 60_000, 'Too many tries. Wait 15 minutes.');
    await service.changePassword(me(req), body.current, body.next);
    res.json({ ok: true });
  }),
);

/** Delete my account and everything in it (type your email to confirm). Payment records are kept for tax law. */
authRouter.post(
  '/auth/delete-account',
  requireUser,
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ email: z.string().max(200) }), req.body, 'Type your email address to confirm.');
    await service.rateLimit(`delete:${me(req).id}`, 5, 15 * 60_000, 'Too many tries. Wait 15 minutes.');
    await deleteAccount(me(req), body.email);
    clearSessionCookie(res);
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/auth/google/start',
  asyncHandler(async (req, res) => {
    if (!service.googleLoginReady()) return res.redirect(`${config.publicUrl}/login?error=${encodeURIComponent('Google sign-in isn’t set up on this server.')}`);
    res.redirect(await service.googleStartUrl(req.query.next));
  }),
);

authRouter.get('/auth/google/callback', async (req, res) => {
  try {
    const { user, next, isNew, foundingOfferApplied } = await service.googleFinish(req.query);
    const s = await service.startSession(user.id);
    setSessionCookie(res, s.token, s.expiresAt);
    // a brand-new account: the page counts it as a sign-up for the visitor stats (see web/src/lib/analytics.ts)
    const destination = foundingOfferApplied ? '/app/billing?welcome=creator' : next;
    const [path, hash = ''] = destination.split('#');
    res.redirect(`${config.publicUrl}${isNew ? `${path}${path.includes('?') ? '&' : '?'}joined=google${hash ? `#${hash}` : ''}` : next}`);
  } catch (e) {
    res.redirect(`${config.publicUrl}/login?error=${encodeURIComponent((e as Error).message)}`);
  }
});

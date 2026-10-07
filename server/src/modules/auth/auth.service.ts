import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../../config.js';
import { sessions, users, type UserRow } from '../../db/index.js';
import { HttpError } from '../../lib/http.js';
import { refreshAccount } from '../billing/billing.service.js';
import { hitShared, putShared, takeShared } from '../../infra/shared.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1 };

/** "scrypt$N$r$p$salt$hash" — salted, slow on purpose, compared in constant time. */
export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function checkPassword(pw: string, stored: string | null): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = (stored ?? '').split('$');
  if (kind !== 'scrypt' || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), want.length, { N: Number(n), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(want, got);
}

// ---------------- rate limits (shared by every app copy through Redis) ----------------
/** Allow `max` attempts per `windowMs` for this key; throws 429 after that. */
export async function rateLimit(key: string, max: number, windowMs: number, message: string) {
  if ((await hitShared(`rl:${key}`, windowMs)) > max) throw new HttpError(429, message);
}

// ---------------- accounts ----------------

/** New account. The first one ever is the owner: an admin on Pro. */
async function createUser(u: { email: string; name: string | null; passwordHash?: string | null; googleSub?: string | null; avatar?: string | null }): Promise<UserRow> {
  const first = (await users.count()) === 0;
  if (!first && !config.allowSignups) throw new HttpError(403, 'Sign-ups are closed right now.');
  const email = u.email.toLowerCase();
  const user = await users.create({ ...u, email, isAdmin: first || config.adminEmails.includes(email), plan: first ? 'pro' : 'free' });
  return refreshAccount(user); // adds the first month's credits
}

export async function logIn(r: { email: string; password: string }) {
  const user = await users.byEmail(r.email);
  // same message and similar time whether the email exists or not
  const ok = await checkPassword(r.password, user?.passwordHash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
  if (!user || !ok) throw new HttpError(401, user && !user.passwordHash ? 'This account uses “Continue with Google”.' : 'Wrong email or password.');
  return user;
}

export async function changePassword(user: UserRow, current: string, next: string) {
  // Google-only accounts can't add a password (there's no email log-in for them)
  if (!user.passwordHash) throw new HttpError(400, 'This account signs in with Google.');
  if (!(await checkPassword(current, user.passwordHash))) throw new HttpError(400, 'Your current password is wrong.');
  await users.update(user.id, { passwordHash: await hashPassword(next) });
}

/** A new log-in. Someone listed in ADMIN_EMAILS becomes an admin when they sign in (not only when the account is made). */
export async function startSession(userId: string) {
  const u = await users.get(userId);
  if (u && !u.isAdmin && config.adminEmails.includes(u.email.toLowerCase())) {
    await users.update(u.id, { isAdmin: true });
    console.log(`[auth] ${u.email} is an admin now (ADMIN_EMAILS)`);
  }
  return await sessions.create(userId);
}
export const endSession = async (token: string) => await sessions.remove(token);

// ---------------- Continue with Google (OpenID Connect) ----------------

export const googleLoginReady = () => Boolean(config.googleLoginClientId && config.googleLoginClientSecret);
const googleRedirect = () => `${config.publicUrl}/api/auth/google/callback`;

/** Only send people back inside the app. */
const safeNext = (n: unknown) => (typeof n === 'string' && /^\/app(\/|$|\?)/.test(n) ? n : '/app');

export async function googleStartUrl(next: unknown): Promise<string> {
  const state = crypto.randomBytes(16).toString('hex');
  // kept in Redis, so the sign-in finishes even when Google's reply reaches the other app copy
  await putShared(`google-login:${state}`, { next: safeNext(next) }, 600_000);
  return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: config.googleLoginClientId,
    redirect_uri: googleRedirect(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  })}`;
}

/** Google sent the person back: find or make their account. Returns the account and where to go next. */
export async function googleFinish(q: Record<string, unknown>): Promise<{ user: UserRow; next: string; isNew: boolean }> {
  const p = q.state ? await takeShared<{ next: string }>(`google-login:${String(q.state)}`) : null;
  if (q.error) throw new HttpError(400, String(q.error_description ?? q.error));
  if (!p) throw new HttpError(400, 'That sign-in link expired. Please try again.');
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: String(q.code ?? ''),
      client_id: config.googleLoginClientId,
      client_secret: config.googleLoginClientSecret,
      redirect_uri: googleRedirect(),
      grant_type: 'authorization_code',
    }),
  });
  const tok = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!tok.access_token) throw new HttpError(400, `Google sign-in failed: ${tok.error_description ?? tokenRes.status}`);
  const info = (await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } })).json()) as {
    sub: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };
  if (!info.sub || !info.email || !info.email_verified) throw new HttpError(400, 'Google didn’t share a verified email for this account.');
  let user = await users.byGoogle(info.sub);
  let isNew = false;
  if (!user) {
    const byEmail = await users.byEmail(info.email);
    if (byEmail) {
      await users.update(byEmail.id, { googleSub: info.sub, avatar: byEmail.avatar ?? info.picture ?? null });
      user = (await users.get(byEmail.id))!;
    } else {
      user = await createUser({ email: info.email, name: info.name ?? null, googleSub: info.sub, avatar: info.picture ?? null });
      isNew = true;
    }
  }
  return { user, next: p.next, isNew };
}

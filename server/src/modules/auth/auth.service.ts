import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../../config.js';
import { sessions, users, type UserRow } from '../../db/index.js';
import { HttpError } from '../../lib/http.js';
import { refreshAccount } from '../billing/billing.service.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1 };

/** "scrypt$N$r$p$salt$hash" — salted, slow on purpose, compared in constant time. */
async function hashPassword(pw: string): Promise<string> {
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

// ---------------- simple in-memory rate limits (per server process) ----------------
const hits = new Map<string, number[]>();
/** Allow `max` attempts per `windowMs` for this key; throws 429 after that. */
export function rateLimit(key: string, max: number, windowMs: number, message: string) {
  const t = Date.now();
  const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
  if (list.length >= max) throw new HttpError(429, message);
  list.push(t);
  hits.set(key, list);
}

// ---------------- accounts ----------------

/** New account. The first one ever is the owner: an admin on Pro. */
async function createUser(u: { email: string; name: string | null; passwordHash?: string | null; googleSub?: string | null; avatar?: string | null }): Promise<UserRow> {
  const first = users.count() === 0;
  if (!first && !config.allowSignups) throw new HttpError(403, 'Sign-ups are closed right now.');
  const email = u.email.toLowerCase();
  const user = users.create({ ...u, email, isAdmin: first || config.adminEmails.includes(email), plan: first ? 'pro' : 'free' });
  return refreshAccount(user); // adds the first month's credits
}

export async function signUp(r: { email: string; password: string; name?: string }) {
  if (users.byEmail(r.email)) throw new HttpError(409, 'An account with this email already exists. Log in instead.');
  return createUser({ email: r.email, name: r.name?.trim() || r.email.split('@')[0], passwordHash: await hashPassword(r.password) });
}

export async function logIn(r: { email: string; password: string }) {
  const user = users.byEmail(r.email);
  // same message and similar time whether the email exists or not
  const ok = await checkPassword(r.password, user?.passwordHash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
  if (!user || !ok) throw new HttpError(401, user && !user.passwordHash ? 'This account uses “Continue with Google”.' : 'Wrong email or password.');
  return user;
}

export async function changePassword(user: UserRow, current: string, next: string) {
  if (user.passwordHash && !(await checkPassword(current, user.passwordHash))) throw new HttpError(400, 'Your current password is wrong.');
  users.update(user.id, { passwordHash: await hashPassword(next) });
}

export const startSession = (userId: string) => sessions.create(userId);
export const endSession = (token: string) => sessions.remove(token);

// ---------------- Continue with Google (OpenID Connect) ----------------

export const googleLoginReady = () => Boolean(config.googleLoginClientId && config.googleLoginClientSecret);
const googleRedirect = () => `${config.publicUrl}/api/auth/google/callback`;
const pending = new Map<string, { next: string; at: number }>();

/** Only send people back inside the app. */
const safeNext = (n: unknown) => (typeof n === 'string' && /^\/app(\/|$|\?)/.test(n) ? n : '/app');

export function googleStartUrl(next: unknown): string {
  const state = crypto.randomBytes(16).toString('hex');
  pending.set(state, { next: safeNext(next), at: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.at > 600_000) pending.delete(k);
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
export async function googleFinish(q: Record<string, unknown>): Promise<{ user: UserRow; next: string }> {
  const p = pending.get(String(q.state ?? ''));
  pending.delete(String(q.state ?? ''));
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
  let user = users.byGoogle(info.sub);
  if (!user) {
    const byEmail = users.byEmail(info.email);
    if (byEmail) {
      users.update(byEmail.id, { googleSub: info.sub, avatar: byEmail.avatar ?? info.picture ?? null });
      user = users.get(byEmail.id)!;
    } else {
      user = await createUser({ email: info.email, name: info.name ?? null, googleSub: info.sub, avatar: info.picture ?? null });
    }
  }
  return { user, next: p.next };
}

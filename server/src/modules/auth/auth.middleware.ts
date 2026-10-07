import type { NextFunction, Request, Response } from 'express';
import { config } from '../../config.js';
import { sessions, type UserRow } from '../../db/index.js';
import { asyncMiddleware, HttpError } from '../../lib/http.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** the signed-in person (set from the session cookie) */
      user?: UserRow;
      sessionToken?: string;
      /** the exact request bytes (needed to check Dodo / Razorpay webhook signatures) */
      rawBody?: Buffer;
    }
  }
}

const SESSION_COOKIE = 'cc_session';

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Every request: who is it? (no error when nobody is signed in) */
export const attachUser = asyncMiddleware(async (req, _res, next) => {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) {
    const u = await sessions.user(token);
    if (u) {
      req.user = u;
      req.sessionToken = token;
    }
  }
  next();
});

/** Routes that need a signed-in person. */
export function requireUser(req: Request, _res: Response, next: NextFunction) {
  next(req.user ? undefined : new HttpError(401, 'Please log in.'));
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  next(req.user?.isAdmin ? undefined : new HttpError(403, 'Admins only.'));
}

/** The signed-in person (only use behind requireUser). */
export const me = (req: Request): UserRow => {
  if (!req.user) throw new HttpError(401, 'Please log in.');
  return req.user;
};

const secure = () => config.publicUrl.startsWith('https://');

export function setSessionCookie(res: Response, token: string, expiresAt: number) {
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: secure(), path: '/', expires: new Date(expiresAt) });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: secure(), path: '/' });
}

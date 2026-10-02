import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType, ZodTypeDef } from 'zod';
import { config } from '../config.js';

/** An error with a status code and a message that is safe to show to the person using the app. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** For `.catch()`: turn any failure into an HttpError with this status, keeping its message. */
export const toHttpError =
  (status: number) =>
  (e: unknown): never => {
    throw new HttpError(status, (e as Error).message);
  };

/** Express 4 doesn't catch rejected promises — pass them to the error handler. */
export const asyncHandler =
  (fn: (req: Request, res: Response) => unknown): RequestHandler =>
  (req, res, next) =>
    Promise.resolve()
      .then(() => fn(req, res))
      .catch(next);

/** The same for middleware (handlers that call `next`). */
export const asyncMiddleware =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/**
 * Parse `data` with `schema`. On failure throw a 400 with `message`
 * (or, when `message` is a function, with whatever it builds from the first problem zod found).
 */
export function validate<T>(schema: ZodType<T, ZodTypeDef, unknown>, data: unknown, message: string | ((issue: string | undefined) => string)): T {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  throw new HttpError(400, typeof message === 'string' ? message : message(r.error.issues[0]?.message));
}

/** Last stop for errors: known ones keep their status + message, anything else is a 500 (and is logged). */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if ((err as { code?: string }).code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File is larger than ${config.maxUploadMb} MB.` });
  // errors from Express itself (bad JSON body, missing static file) carry their own 4xx status
  const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode;
  if (status && status >= 400 && status < 500) {
    return res.status(status).json({ error: status === 404 ? 'Not found' : (err as { type?: string }).type === 'entity.parse.failed' ? 'The request body is not valid JSON.' : err.message });
  }
  console.error(err);
  res.status(500).json({ error: err.message || 'Something went wrong' });
}

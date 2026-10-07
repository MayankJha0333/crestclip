import crypto from 'node:crypto';
import { config } from '../../config.js';
import type { PlanId } from '../../db/index.js';

/**
 * Razorpay — only for people who subscribed BEFORE CrestClip moved to Dodo Payments. New plans and top-ups go
 * through Dodo (dodo.ts). An old Razorpay subscription keeps renewing there until it's cancelled, so this keeps
 * just enough to follow it: read it, cancel it, and check Razorpay's webhooks. Once nobody pays through Razorpay any
 * more, remove the RAZORPAY_* settings and this file.
 */

export const razorpayReady = () => Boolean(config.razorpayKeyId && config.razorpayKeySecret);

/** Which CrestClip plan a Razorpay plan id is. */
export const planForRazorpayPlan = (planId: string): PlanId | null => (planId && planId === config.razorpayPlanCreator ? 'creator' : planId && planId === config.razorpayPlanPro ? 'pro' : null);

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${config.razorpayKeyId}:${config.razorpayKeySecret}`).toString('base64')}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { description?: string } };
  if (!res.ok) throw new Error(`Razorpay: ${data.error?.description || `request failed (${res.status})`}`);
  return data;
}

export interface RzSubscription {
  id: string;
  plan_id: string;
  status: 'created' | 'authenticated' | 'active' | 'pending' | 'halted' | 'cancelled' | 'completed' | 'expired' | 'paused';
  current_start: number | null; // unix seconds
  current_end: number | null;
  paid_count: number;
  created_at?: number; // unix seconds
  notes?: Record<string, string>;
}
export interface RzPayment {
  id: string;
  order_id?: string | null;
  subscription_id?: string | null;
  amount: number;
  currency: string;
  status: string;
  notes?: Record<string, string>;
}

export const razorpay = {
  subscription: (id: string) => call<RzSubscription>('GET', `/subscriptions/${encodeURIComponent(id)}`),
  /** atEnd = keep the plan until the paid month runs out */
  cancelSubscription: (id: string, atEnd: boolean) => call<RzSubscription>('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: atEnd ? 1 : 0 }),
};

const hmac = (secret: string, data: string | Buffer) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const same = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Webhook: X-Razorpay-Signature = HMAC(webhook secret, raw request body). */
export const validWebhook = (rawBody: Buffer, signature: string) => Boolean(config.razorpayWebhookSecret) && same(hmac(config.razorpayWebhookSecret, rawBody), signature);

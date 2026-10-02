import crypto from 'node:crypto';
import { config } from '../../config.js';
import type { PlanId } from '../../db/index.js';

/**
 * A thin client for the Razorpay REST API (subscriptions for plans, orders for one-off top-ups) and the
 * signature checks that prove a payment or a webhook really came from Razorpay.
 * Docs: https://razorpay.com/docs/api/payments/subscriptions/ · https://razorpay.com/docs/api/orders/
 */

export const razorpayReady = () => Boolean(config.razorpayKeyId && config.razorpayKeySecret);
export const razorpayPlanId = (plan: PlanId) => (plan === 'creator' ? config.razorpayPlanCreator : plan === 'pro' ? config.razorpayPlanPro : '');

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${config.razorpayKeyId}:${config.razorpayKeySecret}`).toString('base64')}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
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
  short_url?: string;
  notes?: Record<string, string>;
}
export interface RzOrder {
  id: string;
  amount: number;
  currency: string;
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
  /** A monthly subscription (renews until cancelled). The person pays for it in Razorpay Checkout. */
  createSubscription: (planId: string, notes: Record<string, string>) => call<RzSubscription>('POST', '/subscriptions', { plan_id: planId, total_count: 120, quantity: 1, customer_notify: 1, notes }),
  subscription: (id: string) => call<RzSubscription>('GET', `/subscriptions/${encodeURIComponent(id)}`),
  /** the newest subscriptions on the account (to find one whose payment never reported back) */
  recentSubscriptions: (count = 100) => call<{ items: RzSubscription[] }>('GET', `/subscriptions?count=${count}`).then((r) => r.items ?? []),
  /** the payment behind a subscription's latest paid invoice */
  lastPaymentOf: (subId: string) =>
    call<{ items: { payment_id?: string | null; status?: string; amount?: number; currency?: string; paid_at?: number | null }[] }>(
      'GET',
      `/invoices?subscription_id=${encodeURIComponent(subId)}&count=10`,
    ).then((r) => (r.items ?? []).filter((i) => i.status === 'paid' && i.payment_id).sort((a, b) => (b.paid_at ?? 0) - (a.paid_at ?? 0))[0] ?? null),
  /** atEnd = keep the plan until the paid month runs out */
  cancelSubscription: (id: string, atEnd: boolean) => call<RzSubscription>('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: atEnd ? 1 : 0 }),
  /** amount in the smallest currency unit (cents / paise) */
  createOrder: (amount: number, currency: string, receipt: string, notes: Record<string, string>) => call<RzOrder>('POST', '/orders', { amount, currency, receipt, notes }),
  payment: (id: string) => call<RzPayment>('GET', `/payments/${encodeURIComponent(id)}`),
};

const hmac = (secret: string, data: string | Buffer) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const same = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Checkout success for a subscription: signature = HMAC(payment_id + "|" + subscription_id). */
export const validSubscriptionPayment = (paymentId: string, subscriptionId: string, signature: string) => same(hmac(config.razorpayKeySecret, `${paymentId}|${subscriptionId}`), signature);

/** Checkout success for an order: signature = HMAC(order_id + "|" + payment_id). */
export const validOrderPayment = (orderId: string, paymentId: string, signature: string) => same(hmac(config.razorpayKeySecret, `${orderId}|${paymentId}`), signature);

/** Webhook: X-Razorpay-Signature = HMAC(webhook secret, raw request body). */
export const validWebhook = (rawBody: Buffer, signature: string) => Boolean(config.razorpayWebhookSecret) && same(hmac(config.razorpayWebhookSecret, rawBody), signature);

/** Price in the smallest currency unit (Razorpay amounts). */
export const minorUnits = (price: number) => Math.round(price * 100);

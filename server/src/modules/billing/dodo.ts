import crypto from 'node:crypto';
import { config } from '../../config.js';
import type { PlanId } from '../../db/index.js';

/**
 * A thin client for the Dodo Payments REST API and the check that proves a webhook really came from Dodo.
 *
 * Dodo is the "merchant of record": it runs the checkout page, charges the card / UPI, adds the right tax (GST in
 * India, sales tax in the US…), sends the invoice and handles renewals. Prices are in US dollars; with Adaptive
 * Currency switched on in the Dodo dashboard, a buyer in India sees and pays rupees (₹) and can use UPI.
 *
 * Docs: https://docs.dodopayments.com/api-reference
 */

const BASE = () => (config.dodoApiUrl || (config.dodoMode === 'live' ? 'https://live.dodopayments.com' : 'https://test.dodopayments.com')).replace(/\/$/, '');

/** Payments work when the API key and the three products are set. */
export const dodoReady = () => Boolean(config.dodoApiKey && config.dodoProductCreator && config.dodoProductPro && config.dodoProductTopup);

/** The Dodo product behind a paid plan. */
export const productForPlan = (plan: PlanId) => (plan === 'creator' ? config.dodoProductCreator : plan === 'pro' ? config.dodoProductPro : '');

/** Which plan a Dodo product is (null for the top-up or an unknown product). */
export const planForProduct = (productId: string | null | undefined): PlanId | null =>
  productId && productId === config.dodoProductCreator ? 'creator' : productId && productId === config.dodoProductPro ? 'pro' : null;

export class DodoError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

async function call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE()}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.dodoApiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = (data ?? {}) as { message?: string; code?: string };
    throw new DodoError(res.status, `Dodo Payments: ${d.message || `request failed (${res.status})`}`, d.code);
  }
  return data as T;
}

const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v));
  return s.toString();
};

export type DodoSubscriptionStatus = 'pending' | 'active' | 'on_hold' | 'paused' | 'cancelled' | 'failed' | 'expired' | 'past_due';

export interface DodoCustomer {
  customer_id: string;
  email: string;
  name?: string | null;
}

export interface DodoSubscription {
  subscription_id: string;
  status: DodoSubscriptionStatus;
  product_id: string;
  customer: DodoCustomer;
  metadata?: Record<string, string> | null;
  /** ISO dates */
  created_at: string;
  previous_billing_date: string;
  next_billing_date: string;
  cancel_at_next_billing_date: boolean;
  cancelled_at?: string | null;
  currency?: string;
  recurring_pre_tax_amount?: number;
}

export interface DodoPayment {
  payment_id: string;
  status: string | null;
  /** smallest unit of `currency` (cents, paise), tax included */
  total_amount: number;
  currency: string;
  subscription_id?: string | null;
  customer: DodoCustomer;
  metadata?: Record<string, string> | null;
  created_at: string;
  invoice_url?: string | null;
  /** a zero-amount check when someone only changed their card */
  is_update_payment_method?: boolean;
  /** set once (part of) the payment was refunded */
  refund_status?: string | null;
  product_cart?: { product_id: string; quantity: number }[] | null;
}

export interface DodoLocalizedPrice {
  id: string;
  currency: string;
  /** smallest unit (paise for INR) */
  amount: number;
  country_code?: string | null;
  archived?: boolean;
}

export const dodo = {
  /** A customer for this email (Dodo returns the existing one when the email is already known). */
  createCustomer: (email: string, name: string | null, metadata: Record<string, string>) => call<DodoCustomer>('POST', '/customers', { email, name: name || email.split('@')[0], metadata }),

  /** A hosted checkout page. `returnUrl` gets ?payment_id=…&status=… (and subscription_id=… for a plan) added. */
  createCheckout: (o: { productId: string; customerId: string; returnUrl: string; metadata: Record<string, string> }) =>
    call<{ session_id: string; checkout_url: string }>('POST', '/checkouts', {
      product_cart: [{ product_id: o.productId, quantity: 1 }],
      customer: { customer_id: o.customerId },
      return_url: o.returnUrl,
      metadata: o.metadata,
    }),

  subscription: (id: string) => call<DodoSubscription>('GET', `/subscriptions/${encodeURIComponent(id)}`),
  subscriptionsOf: (customerId: string) =>
    call<{ items: DodoSubscription[] }>('GET', `/subscriptions?${q({ customer_id: customerId, page_size: 50 })}`).then((r) => r.items ?? []),
  updateSubscription: (id: string, patch: { cancel_at_next_billing_date?: boolean; status?: 'cancelled' }) => call<DodoSubscription>('PATCH', `/subscriptions/${encodeURIComponent(id)}`, patch),
  /**
   * Move a subscription to another product now. `prorated_immediately` charges (or credits) the difference for the
   * rest of the month to the saved card / mandate; with `prevent_change` the plan only changes if that payment works.
   */
  changePlan: (id: string, productId: string) =>
    call<unknown>('POST', `/subscriptions/${encodeURIComponent(id)}/change-plan`, {
      product_id: productId,
      quantity: 1,
      proration_billing_mode: 'prorated_immediately',
      on_payment_failure: 'prevent_change',
      effective_at: 'immediately',
    }),

  payment: (id: string) => call<DodoPayment>('GET', `/payments/${encodeURIComponent(id)}`),
  paymentsOf: (filter: { customer_id?: string; subscription_id?: string }) =>
    call<{ items: DodoPayment[] }>('GET', `/payments?${q({ ...filter, status: 'succeeded', page_size: 100 })}`).then((r) => r.items ?? []),

  /**
   * Fixed prices for some countries on a product ("localized pricing"): a buyer whose billing country matches pays
   * that amount, in that currency, unchanged. https://docs.dodopayments.com/features/localized-pricing
   */
  localizedPrices: (productId: string) =>
    call<{ items?: DodoLocalizedPrice[] } | DodoLocalizedPrice[]>('GET', `/products/${encodeURIComponent(productId)}/localized-prices`).then((r) => (Array.isArray(r) ? r : (r.items ?? []))),
  usePricesByCountry: (productId: string) => call<unknown>('PATCH', `/products/${encodeURIComponent(productId)}`, { pricing_mode: 'by_country' }),
  addLocalizedPrice: (productId: string, p: { currency: string; country_code: string; amount: number }) =>
    call<DodoLocalizedPrice>('POST', `/products/${encodeURIComponent(productId)}/localized-prices`, p),
  updateLocalizedPrice: (productId: string, priceId: string, amount: number) =>
    call<DodoLocalizedPrice>('PATCH', `/products/${encodeURIComponent(productId)}/localized-prices/${encodeURIComponent(priceId)}`, { amount }),

  /** A link to Dodo's customer portal: change card / UPI mandate, see invoices, cancel. */
  portal: (customerId: string) => call<{ link: string }>('POST', `/customers/${encodeURIComponent(customerId)}/customer-portal/session`).then((r) => r.link),
};

// ---------------- webhooks (Standard Webhooks signatures) ----------------

/** How old a webhook may be (its timestamp is signed, so a replayed old one is refused). */
const TOLERANCE_S = 5 * 60;

/**
 * Dodo signs every webhook: webhook-signature = "v1,<base64 HMAC-SHA256(secret, `${id}.${timestamp}.${body}`)>",
 * where the secret is the base64 part of "whsec_…". Several signatures may be listed (space-separated) while the
 * secret is being rotated.
 */
export function validDodoWebhook(rawBody: Buffer, headers: { id: string; timestamp: string; signature: string }, secret = config.dodoWebhookSecret, nowS = Date.now() / 1000) {
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowS - ts) > TOLERANCE_S) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${headers.id}.${headers.timestamp}.`).update(rawBody).digest();
  return headers.signature.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const given = Buffer.from(sig, 'base64');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

/** Sign a body the way Dodo does (tests and the local webhook simulator). */
export function signDodoWebhook(rawBody: string, id: string, timestamp: number, secret: string) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64')}`;
}

export interface DodoEvent {
  business_id: string;
  type: string;
  timestamp: string;
  data: { payload_type?: 'Payment' | 'Subscription' | 'Refund' | 'Dispute' | 'LicenseKey' | string } & Record<string, unknown>;
}

/** ISO date → ms (null when missing). */
export const ms = (iso: string | null | undefined) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

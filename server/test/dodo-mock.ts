import http from 'node:http';
import crypto from 'node:crypto';

/**
 * A stand-in for the Dodo Payments API (the endpoints CrestClip uses), with the same response shapes as the real
 * test-mode API. The test suite drives it like a buyer would: pay a checkout, renew, fail a renewal, cancel — and it
 * sends signed webhooks to the app the way Dodo does.
 */

type Json = Record<string, unknown>;
const id = (p: string) => `${p}_${crypto.randomBytes(9).toString('base64url')}`;
const iso = (t: number) => new Date(t).toISOString();
const MONTH = 30 * 86400_000;

export interface Product {
  product_id: string;
  price: number;
  recurring: boolean;
}
export interface Sub {
  subscription_id: string;
  status: string;
  product_id: string;
  customer: { customer_id: string; email: string; name: string };
  metadata: Record<string, string>;
  created_at: string;
  previous_billing_date: string;
  next_billing_date: string;
  cancel_at_next_billing_date: boolean;
  cancelled_at: string | null;
  currency: string;
  recurring_pre_tax_amount: number;
  quantity: number;
  payment_frequency_interval: string;
  payment_frequency_count: number;
}
export interface Pay {
  payment_id: string;
  status: string;
  total_amount: number;
  currency: string;
  subscription_id: string | null;
  customer: { customer_id: string; email: string; name: string };
  metadata: Record<string, string>;
  created_at: string;
  invoice_url: string;
  product_cart: { product_id: string; quantity: number }[];
}

export function startMockDodo(opts: { apiKey: string; products: Product[] }) {
  const customers = new Map<string, { customer_id: string; email: string; name: string; metadata: Json; created_at: string }>();
  const checkouts = new Map<string, { session_id: string; product_id: string; customer_id: string; metadata: Record<string, string>; return_url: string }>();
  const subs = new Map<string, Sub>();
  const pays = new Map<string, Pay>();
  const calls: { method: string; path: string; body: Json | null }[] = [];
  const product = (pid: string) => opts.products.find((p) => p.product_id === pid);

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const body = raw ? (JSON.parse(raw) as Json) : null;
      calls.push({ method: req.method ?? '', path: url.pathname + url.search, body });
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.headers.authorization !== `Bearer ${opts.apiKey}`) return send(401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });
      const parts = url.pathname.split('/').filter(Boolean);
      const m = req.method;

      if (m === 'POST' && url.pathname === '/customers') {
        const c = { customer_id: id('cus'), email: String(body?.email), name: String(body?.name), metadata: (body?.metadata as Json) ?? {}, created_at: iso(Date.now()), business_id: 'bus_mock', phone_number: null };
        customers.set(c.customer_id, c);
        return send(200, c);
      }
      if (m === 'POST' && parts[0] === 'customers' && parts[2] === 'customer-portal') {
        if (!customers.has(parts[1])) return send(404, { code: 'NOT_FOUND', message: 'Customer not found' });
        return send(200, { link: `https://customer.dodopayments.test/portal/${parts[1]}` });
      }
      if (m === 'POST' && url.pathname === '/checkouts') {
        const cart = body?.product_cart as { product_id: string }[];
        const customer = body?.customer as { customer_id?: string };
        if (!cart?.[0] || !product(cart[0].product_id)) return send(422, { code: 'INVALID_REQUEST', message: 'Unknown product' });
        if (!customer?.customer_id || !customers.has(customer.customer_id)) return send(422, { code: 'INVALID_REQUEST', message: 'Unknown customer' });
        const session_id = id('cks');
        checkouts.set(session_id, { session_id, product_id: cart[0].product_id, customer_id: customer.customer_id, metadata: (body?.metadata as Record<string, string>) ?? {}, return_url: String(body?.return_url) });
        return send(200, { session_id, checkout_url: `https://test.checkout.dodopayments.com/session/${session_id}` });
      }
      if (parts[0] === 'subscriptions' && parts.length === 1 && m === 'GET') {
        const cid = url.searchParams.get('customer_id');
        return send(200, { items: [...subs.values()].filter((s) => !cid || s.customer.customer_id === cid) });
      }
      if (parts[0] === 'subscriptions' && parts[1]) {
        const s = subs.get(parts[1]);
        if (!s) return send(404, { code: 'NOT_FOUND', message: 'Subscription not found' });
        if (m === 'GET' && parts.length === 2) return send(200, s);
        if (m === 'PATCH' && parts.length === 2) {
          if (typeof body?.cancel_at_next_billing_date === 'boolean') s.cancel_at_next_billing_date = body.cancel_at_next_billing_date;
          if (body?.status === 'cancelled') {
            s.status = 'cancelled';
            s.cancelled_at = iso(Date.now());
          }
          return send(200, s);
        }
        if (m === 'POST' && parts[2] === 'change-plan') {
          const to = product(String(body?.product_id));
          if (!to?.recurring) return send(422, { code: 'INVALID_REQUEST', message: 'Not a subscription product' });
          if (mock.failNextPlanChange) {
            mock.failNextPlanChange = false;
            return send(200, { payment_id: null, payment_link: null, client_secret: null, expires_on: null }); // prevent_change: payment failed, nothing changes
          }
          const from = product(s.product_id)!;
          const left = Math.max(0, Date.parse(s.next_billing_date) - Date.now()) / MONTH;
          s.product_id = to.product_id;
          s.recurring_pre_tax_amount = to.price;
          const diff = Math.round((to.price - from.price) * left);
          if (diff > 0) mock.addPayment(s, diff);
          return send(200, { payment_id: null, payment_link: null, client_secret: null, expires_on: null });
        }
      }
      if (parts[0] === 'payments' && parts.length === 1 && m === 'GET') {
        const cid = url.searchParams.get('customer_id');
        const sid = url.searchParams.get('subscription_id');
        const st = url.searchParams.get('status');
        return send(200, { items: [...pays.values()].filter((p) => (!cid || p.customer.customer_id === cid) && (!sid || p.subscription_id === sid) && (!st || p.status === st)) });
      }
      if (parts[0] === 'payments' && parts[1] && m === 'GET') {
        const p = pays.get(parts[1]);
        return p ? send(200, p) : send(404, { code: 'NOT_FOUND', message: 'Payment not found' });
      }
      send(404, { code: 'NOT_FOUND', message: `No mock for ${m} ${url.pathname}` });
    });
  });

  const mock = {
    server,
    calls,
    subs,
    pays,
    customers,
    failNextPlanChange: false,
    url: '',
    async listen() {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      mock.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      return mock;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),

    addPayment(s: Sub, amount: number, currency = s.currency, status = 'succeeded') {
      const p: Pay = {
        payment_id: id('pay'),
        status,
        total_amount: amount,
        currency,
        subscription_id: s.subscription_id,
        customer: s.customer,
        metadata: s.metadata,
        created_at: iso(Date.now()),
        invoice_url: `https://test.dodopayments.com/invoices/payments/${'x'}`,
        product_cart: [{ product_id: s.product_id, quantity: 1 }],
      };
      p.invoice_url = `https://test.dodopayments.com/invoices/payments/${p.payment_id}`;
      pays.set(p.payment_id, p);
      return p;
    },

    /** The buyer pays a checkout. Returns what Dodo adds to the return link, plus the objects made. */
    pay(checkoutUrl: string, o: { currency?: string; amount?: number; status?: 'active' | 'pending' } = {}) {
      const session = checkouts.get(checkoutUrl.split('/').pop()!)!;
      const prod = product(session.product_id)!;
      const c = customers.get(session.customer_id)!;
      const customer = { customer_id: c.customer_id, email: c.email, name: c.name };
      const currency = o.currency ?? 'USD';
      const amount = o.amount ?? prod.price;
      if (prod.recurring) {
        const now = Date.now();
        const s: Sub = {
          subscription_id: id('sub'),
          status: o.status ?? 'active',
          product_id: prod.product_id,
          customer,
          metadata: session.metadata,
          created_at: iso(now),
          previous_billing_date: iso(now),
          next_billing_date: iso(now + MONTH),
          cancel_at_next_billing_date: false,
          cancelled_at: null,
          currency,
          recurring_pre_tax_amount: prod.price,
          quantity: 1,
          payment_frequency_interval: 'Month',
          payment_frequency_count: 1,
        };
        subs.set(s.subscription_id, s);
        const p = o.status === 'pending' ? null : mock.addPayment(s, amount, currency);
        return { sub: s, pay: p, returnQuery: `subscription_id=${s.subscription_id}&status=${s.status}`, returnUrl: session.return_url };
      }
      const p: Pay = {
        payment_id: id('pay'),
        status: 'succeeded',
        total_amount: amount,
        currency,
        subscription_id: null,
        customer,
        metadata: session.metadata,
        created_at: iso(Date.now()),
        invoice_url: '',
        product_cart: [{ product_id: prod.product_id, quantity: 1 }],
      };
      p.invoice_url = `https://test.dodopayments.com/invoices/payments/${p.payment_id}`;
      pays.set(p.payment_id, p);
      return { sub: null, pay: p, returnQuery: `payment_id=${p.payment_id}&status=succeeded`, returnUrl: session.return_url };
    },

    /** A month later: the subscription renews (a new payment, dates move on). */
    renew(s: Sub) {
      const prev = Date.parse(s.next_billing_date);
      s.previous_billing_date = iso(prev);
      s.next_billing_date = iso(prev + MONTH);
      s.status = 'active';
      return mock.addPayment(s, product(s.product_id)!.price);
    },
  };
  return mock;
}

/** Sign like Dodo (Standard Webhooks). Kept separate from the app's code on purpose: the test checks the app against this. */
function signDodoWebhook(body: string, msgId: string, ts: number, secret: string) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${crypto.createHmac('sha256', key).update(`${msgId}.${ts}.${body}`).digest('base64')}`;
}

/** Send a webhook to the app the way Dodo does (Standard Webhooks headers, signed). */
export async function sendWebhook(appUrl: string, secret: string, type: string, data: Json, o: { id?: string; timestamp?: number; badSignature?: boolean } = {}) {
  const body = JSON.stringify({ business_id: 'bus_mock', type, timestamp: new Date().toISOString(), data });
  const whId = o.id ?? id('msg');
  const ts = o.timestamp ?? Math.floor(Date.now() / 1000);
  const sig = o.badSignature ? 'v1,' + Buffer.from('nope').toString('base64') : signDodoWebhook(body, whId, ts, secret);
  const res = await fetch(`${appUrl}/api/billing/dodo/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'webhook-id': whId, 'webhook-timestamp': String(ts), 'webhook-signature': sig },
    body,
  });
  return { status: res.status, id: whId, body, ts };
}

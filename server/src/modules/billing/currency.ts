import type { Request } from 'express';
import type { UserRow } from '../../db/index.js';
import { CURRENCIES, HOME_CURRENCY } from './plans.js';
import { canChargeIn } from './razorpay.js';

/**
 * Which currency someone sees and pays in:
 *  · after their first payment: the currency they paid in (so a plan never flips currency later)
 *  · before that: where they are — the browser says (x-cc-currency: INR in India, USD everywhere else)
 * Shown prices are always in that currency. Charging needs Razorpay plans in it; until then (e.g. USD before
 * International Payments is approved) the charge is made in BILLING_CURRENCY and the price there is shown too.
 */

/** The browser's hint (from its time zone). */
export function currencyHint(req: Request): string | null {
  const h = String(req.headers['x-cc-currency'] ?? '')
    .trim()
    .toUpperCase();
  return CURRENCIES.includes(h) ? h : null;
}

/** The currency prices are shown in. */
export function shownCurrency(user: UserRow | null | undefined, hint: string | null): string {
  if (user?.billingCurrency && CURRENCIES.includes(user.billingCurrency)) return user.billingCurrency;
  return hint ?? HOME_CURRENCY;
}

/** The currency a payment is actually made in (the shown one when Razorpay can charge it). */
export function chargeCurrency(shown: string): string {
  return shown === HOME_CURRENCY || canChargeIn(shown) ? shown : HOME_CURRENCY;
}

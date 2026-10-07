/**
 * Paying happens on Dodo Payments' own checkout page (cards, UPI, wallets — prices in ₹ for India, $ elsewhere).
 * The browser goes there and comes back to /app/billing?checkout=plan|topup with Dodo's subscription_id /
 * payment_id and status added; the Plan page then asks the server to apply it.
 */

/** Go to the checkout page (this page unloads). */
export function goToCheckout(url: string) {
  window.location.assign(url);
}

/** What Dodo put on the return link, or null when this page wasn't opened from a checkout. */
export function checkoutReturn(search: string) {
  const q = new URLSearchParams(search);
  const kind = q.get('checkout');
  if (kind !== 'plan' && kind !== 'topup') return null;
  return {
    kind,
    subscriptionId: q.get('subscription_id') || undefined,
    paymentId: q.get('payment_id') || undefined,
    /** Dodo's word for how it went: succeeded / active, processing, failed, cancelled … */
    status: (q.get('status') || '').toLowerCase(),
  } as const;
}

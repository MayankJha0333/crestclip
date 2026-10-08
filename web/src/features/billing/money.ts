import { useEffect, useState } from 'react';

/** "$15", "$4.99" — whole amounts without decimals, always the plain "$" (never "US$"). */
export function money(amount: number, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: amount % 1 ? 2 : 0,
      maximumFractionDigits: amount % 1 ? 2 : 0,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** "3 Nov" (with the year when it isn't this year: "2 Oct 2027") */
export const shortDate = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(new Date(ms).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });

/**
 * Is this person in India? Told by the device's time zone (India has one: Asia/Kolkata). Used only to SHOW rupee
 * prices; what's charged is decided by Dodo from the billing address at checkout — the same rupee prices for India.
 */
export function inIndia() {
  try {
    return ['Asia/Kolkata', 'Asia/Calcutta'].includes(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return false;
  }
}

/** inIndia(), read after the first render so server-rendered pages (in dollars) hydrate cleanly, then switch. */
export function useIndia() {
  const [india, setIndia] = useState(false);
  useEffect(() => setIndia(inIndia()), []);
  return india;
}

/** A plan's or the top-up's price for this visitor: "₹999" in India (before GST), "$15" elsewhere. */
export const priceText = (p: { price: number; priceInr?: number }, india: boolean) => (india && p.priceInr != null ? money(p.priceInr, 'INR') : money(p.price));
/** The currency and number for analytics. */
export const priceValue = (p: { price: number; priceInr?: number }, india: boolean) => (india && p.priceInr ? { currency: 'INR', value: p.priceInr } : { currency: 'USD', value: p.price });

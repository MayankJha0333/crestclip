/** "$15", "₹1,299" — whole amounts without decimals; always the plain symbol ("$", never "US$"). */
export function money(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
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

/** When the charge is made in another currency than shown: "Charged as ₹1,299 for now" (else null). */
export function chargedAs(p: { chargePrice?: number; chargeCurrency?: string }) {
  return p.chargePrice != null && p.chargeCurrency ? `Charged as ${money(p.chargePrice, p.chargeCurrency)} for now` : null;
}

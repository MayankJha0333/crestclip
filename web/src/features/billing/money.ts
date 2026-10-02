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

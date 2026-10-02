import type { CheckoutStart } from '../../lib/api';

/** Razorpay Checkout (their hosted payment window). Loaded only when someone pays. */
interface RazorpayResponse {
  razorpay_payment_id: string;
  razorpay_signature: string;
  razorpay_subscription_id?: string;
  razorpay_order_id?: string;
}
interface RazorpayInstance {
  open(): void;
  on(event: 'payment.failed', cb: (r: { error: { description?: string } }) => void): void;
}
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

let loading: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error('Couldn’t load the Razorpay payment window. Check your connection and try again.'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** Thrown when the person closes the payment window without paying. */
export class CheckoutClosed extends Error {}

/** Open Checkout for a subscription or a one-off order. Resolves with Razorpay's proof of payment. */
export async function openCheckout(start: CheckoutStart, who: { name: string | null; email: string }): Promise<RazorpayResponse> {
  await loadScript();
  return new Promise((resolve, reject) => {
    const rzp = new window.Razorpay!({
      key: start.key,
      ...('subscriptionId' in start ? { subscription_id: start.subscriptionId } : { order_id: start.orderId, amount: start.amount, currency: start.currency }),
      name: 'CrestClip',
      description: start.description,
      prefill: { name: who.name ?? '', email: who.email },
      theme: { color: '#FF8A5B' },
      handler: (r: RazorpayResponse) => resolve(r),
      modal: { ondismiss: () => reject(new CheckoutClosed('Payment window closed')) },
    });
    rzp.on('payment.failed', (r) => reject(new Error(r.error.description || 'The payment didn’t go through.')));
    rzp.open();
  });
}

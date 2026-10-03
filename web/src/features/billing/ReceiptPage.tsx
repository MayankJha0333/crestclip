import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Printer } from 'lucide-react';
import { api, type Receipt } from '../../lib/api';
import { Button, Spinner } from '../../components/ui';
import { Logo } from '../../components/brand/Logo';
import { money } from './money';

const longDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });

/** A printable receipt for one payment (Print → Save as PDF gives the customer a file). */
export function ReceiptPage() {
  const { id = '' } = useParams();
  const [r, setR] = useState<Receipt | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api
      .receipt(id)
      .then((x) => {
        setR(x);
        document.title = `Receipt ${x.payment.id} — ${x.seller.name}`;
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (error)
    return (
      <div className="mx-auto max-w-[720px] px-4 py-16 text-center">
        <p className="text-lg">{error}</p>
        <Link to="/app/billing" className="mt-4 inline-block font-bold">
          Back to Plan & credits
        </Link>
      </div>
    );
  if (!r)
    return (
      <div className="flex justify-center py-24">
        <Spinner />
      </div>
    );

  const { payment: p, seller: s } = r;
  const amount = p.amount != null && p.currency ? money(p.amount / 100, p.currency) : '—';
  return (
    <div className="mx-auto max-w-[760px] px-4 py-6 print:max-w-none print:p-0">
      <div className="mb-5 flex items-center justify-between gap-3 print:hidden">
        <Link to="/app/billing" className="inline-flex items-center gap-1.5 text-sm font-bold text-ink-3 no-underline hover:text-ink">
          <ArrowLeft size={16} /> Plan & credits
        </Link>
        <Button onClick={() => window.print()}>
          <Printer size={17} /> Print or save as PDF
        </Button>
      </div>

      <article data-clarity-mask="true" className="rounded-[28px] bg-white p-8 text-[15px] leading-relaxed text-[#1d1a17] shadow-clay print:rounded-none print:shadow-none sm:p-10">
        <header className="flex flex-wrap items-start justify-between gap-6">
          <Logo size={34} />
          <div className="text-right">
            <h1 className="text-3xl font-bold tracking-tight">Receipt</h1>
            <p className="mt-1 text-sm text-[#6b625a]">Paid · {longDate(p.createdAt)}</p>
          </div>
        </header>

        <dl className="mt-8 grid gap-6 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-extrabold tracking-wider text-[#6b625a] uppercase">From</dt>
            <dd className="mt-1.5">
              <b>{s.legalName}</b>
              {s.legalName !== s.name && <> (trading as {s.name})</>}
              {s.address && <div>{s.address}</div>}
              {s.email && <div>{s.email}</div>}
              {s.phone && <div>{s.phone}</div>}
              <div>{s.url.replace(/^https?:\/\//, '')}</div>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-extrabold tracking-wider text-[#6b625a] uppercase">Billed to</dt>
            <dd className="mt-1.5">
              {r.customer.name && <b className="block">{r.customer.name}</b>}
              <div>{r.customer.email}</div>
            </dd>
          </div>
        </dl>

        <dl className="mt-8 grid gap-x-6 gap-y-2 rounded-2xl bg-[#f6f2ec] p-5 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="font-bold text-[#6b625a]">Receipt number</dt>
          <dd className="font-mono break-all">{p.id}</dd>
          <dt className="font-bold text-[#6b625a]">Date paid</dt>
          <dd>{longDate(p.createdAt)}</dd>
          <dt className="font-bold text-[#6b625a]">Payment method</dt>
          <dd>Card, via Razorpay</dd>
        </dl>

        <table className="mt-8 w-full border-collapse text-left">
          <thead>
            <tr className="border-b-2 border-[#1d1a17] text-xs tracking-wider uppercase">
              <th className="py-2 font-extrabold">Description</th>
              <th className="py-2 text-right font-extrabold">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-[#e5ded5]">
              <td className="py-3 pr-4">{r.item}</td>
              <td className="py-3 text-right tabular-nums">{amount}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td className="pt-4 text-right font-bold">Total paid {p.currency ? `(${p.currency})` : ''}</td>
              <td className="pt-4 text-right font-display text-xl font-bold tabular-nums">{amount}</td>
            </tr>
          </tfoot>
        </table>

        <p className="mt-10 text-sm text-[#6b625a]">
          Thank you for using {s.name}. Questions about this payment? Write to {s.email ?? 'us'} and include the receipt number. Refunds follow our policy at {s.url.replace(/^https?:\/\//, '')}
          /refunds.
        </p>
      </article>
    </div>
  );
}

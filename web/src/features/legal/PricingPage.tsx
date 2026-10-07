import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type PlansInfo } from '../../lib/api';
import { Check } from 'lucide-react';
import { buttonClass } from '../../components/ui';
import { PlanCards } from '../billing/PlanCards';
import { money } from '../billing/money';
import { useBusiness } from './business';
import { initialPlans } from '../../lib/initialData';
import { ContactDetails, LegalLayout, Section } from './LegalLayout';

/** Public pricing page: every plan and the top-up in US dollars, plus how billing works (payment providers check this page). */
export function PricingPage() {
  const b = useBusiness();
  const [pricing, setPricing] = useState<PlansInfo | null>(initialPlans);
  useEffect(() => {
    api
      .plans()
      .then(setPricing)
      .catch(() => {});
  }, []);
  const paid = pricing?.plans.filter((p) => p.price > 0) ?? [];

  return (
    <LegalLayout title="Pricing" wide intro="Simple monthly plans in US dollars. Start free — no card needed." business={b}>
      {pricing ? (
        <PlanCards
          plans={pricing.plans}
          action={(p) => (
            <Link to={p.id === 'free' ? '/signup' : '/signup?next=%2Fapp%2Fbilling'} className={buttonClass(p.id === 'creator' ? 'primary' : 'secondary', 'md', 'w-full')}>
              {p.id === 'free' ? 'Start free' : `Start with ${p.name}`}
            </Link>
          )}
        />
      ) : (
        <div className="h-96" />
      )}
          {pricing?.policy?.length ? (
            <ul className="mx-auto mt-6 grid max-w-3xl gap-2.5 sm:grid-cols-2">
              {pricing.policy.map((line) => (
                <li key={line} className="flex items-start gap-2.5 rounded-2xl bg-surface px-4 py-3 font-bold shadow-clay-sm">
                  <Check size={18} className="mt-0.5 shrink-0 text-mint-d" /> {line}
                </li>
              ))}
            </ul>
          ) : null}

      <Section title="All prices">
        <ul>
          {pricing?.plans.map((p) => (
            <li key={p.id}>
              <strong>{p.name}:</strong> {p.price > 0 ? `${money(p.price)} per month` : 'free'} — {p.clips} clips ({p.credits} credits) every month.
            </li>
          ))}
          {pricing && (
            <li>
              <strong>Credit top-up:</strong> {money(pricing.topup.price)} one-time for {pricing.topup.credits} credits ({Math.floor(pricing.topup.credits / pricing.creditsPerClip)} clips), usable
              for {b.topupMonths} months, on any plan.
            </li>
          )}
        </ul>
      </Section>

      <Section title="How billing works">
        <ul>
          <li>Prices are in US dollars (USD). In India you pay the same price in rupees (₹) by UPI or card; elsewhere checkout shows your local currency where it can. Taxes such as GST or sales tax are added at checkout where they apply.</li>
          <li>Payments are processed securely by Dodo Payments, our online reseller and merchant of record, who also issues your invoice.</li>
          {paid.length > 0 && <li>Paid plans renew automatically every month on the day you subscribed, until you cancel.</li>}
          <li>Cancel any time on the Plan & credits page in the app. Your plan stays until the end of the month you paid for, and you aren’t charged again.</li>
          <li>
            Every clip uses {pricing?.creditsPerClip ?? b.creditsPerClip} credits. Editing, re-rendering and variants are free, and clips that don’t come out give their credits back
            automatically.
          </li>
          <li>The price shown is the price you’re charged — no hidden fees. Your bank may show the amount in your own currency and may add its own conversion fee.</li>
          <li>
            Projects and their clips are kept for {pricing?.plans.find((p) => p.id === 'free')?.storageDays ?? 7} days on Free and {pricing?.plans.find((p) => p.id === 'pro')?.storageDays ?? 30} days on
            paid plans. Download or post a clip to keep it for good — exports are yours.
          </li>
          <li>
            You get a receipt for every payment on the Plan & credits page. Refunds follow our <Link to="/refunds">Refunds & cancellation policy</Link>; nothing is shipped — see{' '}
            <Link to="/shipping">Delivery of digital goods</Link>.
          </li>
        </ul>
      </Section>

      <Section title="Questions about pricing">
        <ContactDetails business={b} />
      </Section>
    </LegalLayout>
  );
}

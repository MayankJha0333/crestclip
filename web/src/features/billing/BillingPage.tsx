import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, CalendarClock, CreditCard, History, Receipt, ShoppingBag, Sparkles } from 'lucide-react';
import { api, type BillingAccount, type CreditEvent, type Payment, type Plan, type PlanId, type PlansInfo } from '../../lib/api';
import { CreditEventRow } from './CreditEventRow';
import { toast } from '../../lib/toast';
import { Badge, Button, Card, CardHeader, ConfirmDialog, PageHeader, Skeleton } from '../../components/ui';
import { useAuth } from '../auth/auth';
import { checkoutReturn, goToCheckout } from './checkout';
import { money, priceText, priceValue, shortDate, useIndia } from './money';
import { PlanCards } from './PlanCards';
import { track } from '../../lib/analytics';

/** Plan & credits: what you have, what it costs, upgrade / top up / cancel, and the history. */
export function BillingPage() {
  const india = useIndia();
  const { me, refresh } = useAuth();
  const [info, setInfo] = useState<PlansInfo | null>(null);
  const [data, setData] = useState<(BillingAccount & { history: CreditEvent[]; payments: Payment[] }) | null>(null);
  const [busy, setBusy] = useState<PlanId | 'topup' | 'cancel' | 'resume' | 'portal' | 'return' | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const load = useCallback(async () => {
    const [p, b] = await Promise.all([api.plans(), api.billing()]);
    setInfo(p);
    setData(b);
  }, []);
  useEffect(() => {
    // the server checks with Dodo while loading; refresh the sidebar too in case the plan changed meanwhile
    load()
      .then(() => refresh())
      .catch((e) => toast((e as Error).message, 'error'));
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back-button from the checkout page restores this page from the browser's cache: un-stick the busy button.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => e.persisted && setBusy(null);
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  const after = async (msg: string) => {
    await Promise.all([load(), refresh()]);
    toast(msg);
  };

  /** Ask the server a few times whether the plan switched (an upgrade's payment can take a moment). */
  const waitForPlan = async (plan: Plan, tries: number) => {
    for (let i = 0; i < tries; i++) {
      const b = await api.billing(true).catch(() => null);
      if (b?.plan.id === plan.id) {
        await after(`You’re on ${plan.name} — ${plan.clips.toLocaleString()} clips a month`);
        return true;
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
    await Promise.all([load(), refresh()]);
    return false;
  };

  /**
   * Back from Dodo's checkout page (?checkout=plan|topup&subscription_id=…&payment_id=…&status=…): the server checks
   * the payment with Dodo and applies it. A UPI payment can still be "processing" — then it's asked again a few times
   * (the webhook finishes it anyway).
   */
  const location = useLocation();
  const navigate = useNavigate();
  const handled = useRef(false);
  useEffect(() => {
    const ret = checkoutReturn(location.search);
    if (!ret || handled.current) return;
    handled.current = true;
    navigate('/app/billing', { replace: true }); // a reload shouldn't apply it twice
    if (['failed', 'cancelled', 'canceled', 'expired'].includes(ret.status)) {
      track('checkout_failed', { kind: ret.kind, status: ret.status });
      toast('The payment didn’t go through, so nothing was charged. You can try again with another card or UPI app.', 'error');
      return;
    }
    if (!ret.subscriptionId && !ret.paymentId) return;
    setBusy('return');
    (async () => {
      try {
        for (let i = 0; i < 8; i++) {
          const res = await api.confirmCheckout({ subscriptionId: ret.subscriptionId, paymentId: ret.paymentId });
          if (!res.pending) {
            track('purchase', { kind: ret.kind === 'plan' ? 'subscription' : 'topup', plan: ret.kind === 'plan' ? res.plan.id : 'topup', transaction_id: ret.paymentId ?? ret.subscriptionId });
            await after(ret.kind === 'plan' ? `You’re on ${res.plan.name} — ${res.plan.clips.toLocaleString()} clips a month` : 'Credits added — thank you!');
            return;
          }
          if (i === 0) toast('Payment received — finishing up…');
          await new Promise((r) => setTimeout(r, 4000));
        }
        await Promise.all([load(), refresh()]);
        toast('Your payment is still being confirmed (UPI can take a few minutes). It’s added automatically — reopen this page in a bit.', 'error');
      } catch (e) {
        toast((e as Error).message, 'error');
      } finally {
        setBusy(null);
      }
    })();
  }, [location.search, navigate]); // eslint-disable-line react-hooks/exhaustive-deps

  const subscribe = async (plan: Plan) => {
    if (!me) return;
    setBusy(plan.id);
    try {
      const start = await api.subscribe(plan.id);
      if ('url' in start) {
        track('begin_checkout', { ...priceValue(plan, india), plan: plan.id });
        goToCheckout(start.url); // keeps "busy" while the page changes
        return;
      }
      // an upgrade on the existing subscription (only the difference for this month is charged)
      track('purchase', { currency: 'USD', plan: plan.id, kind: 'upgrade' });
      if (!start.pending) await after(`You’re on ${plan.name} — ${plan.clips.toLocaleString()} clips a month`);
      else {
        toast(`Switching you to ${plan.name}…`);
        if (!(await waitForPlan(plan, 8))) toast(`The upgrade is waiting for the payment to go through. ${plan.name} switches on by itself once it does — reopen this page to check.`, 'error');
      }
      setBusy(null);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(null);
    }
  };

  const topup = async () => {
    if (!me || !info) return;
    setBusy('topup');
    try {
      const start = await api.buyTopup();
      if (!('url' in start)) throw new Error('Unexpected checkout');
      track('begin_checkout', { ...priceValue(info.topup, india), plan: 'topup' });
      goToCheckout(start.url);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(null);
    }
  };

  const cancel = async () => {
    setBusy('cancel');
    try {
      await api.cancelPlan();
      track('cancel_plan', { plan: me?.account.plan.id });
      setConfirmCancel(false);
      await after('Your plan won’t renew. It stays active until the end of this month.');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const resume = async () => {
    setBusy('resume');
    try {
      await api.resumePlan();
      track('resume_plan', { plan: me?.account.plan.id });
      await after('Your plan will keep renewing.');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  /** Dodo's customer portal: change card / UPI, download invoices. */
  const manage = async () => {
    setBusy('portal');
    try {
      const { url } = await api.billingPortal();
      window.location.assign(url);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(null);
    }
  };

  if (!info || !data || !me) {
    return (
      <>
        <PageHeader title="Plan & credits" />
        <div className="grid gap-5 md:grid-cols-3">
          <Skeleton className="h-52" />
          <Skeleton className="h-52" />
          <Skeleton className="h-52" />
        </div>
      </>
    );
  }

  const plan = data.plan;
  const paid = plan.id !== 'free';
  const foundingOffer = Boolean(data.foundingOfferEndsAt && plan.id === 'creator');
  const welcomeOffer = new URLSearchParams(location.search).get('welcome') === 'creator';
  // the plan's price in the currency they actually pay (their last plan payment), else by where they are
  const lastPlanPay = data.payments.find((x) => x.kind === 'subscription' && x.currency);
  const paysInr = lastPlanPay ? lastPlanPay.currency?.toUpperCase() === 'INR' : india;
  const usedPct = Math.min(100, (data.credits.usedThisMonth / Math.max(1, data.credits.monthly)) * 100);
  const rank = (id: PlanId) => info.plans.findIndex((p) => p.id === id);
  const noPay = !data.paymentsReady;

  return (
    <>
      <PageHeader
        title="Plan & credits"
        description={`Every clip CrestClip makes uses ${data.credits.perClip} credits. Editing and re-rendering clips is free, and clips that don’t come out give their credits back.`}
      />

      {noPay && (
        <p className="mb-6 rounded-[22px] bg-warn-bg px-5 py-4 text-sm font-semibold text-warn-ink">
          Payments aren’t set up on this server yet, so upgrades and top-ups are off. (Owner: add the Dodo Payments settings — see README → “Plans, credits & payments”.)
        </p>
      )}
      {data.testMode && (
        <p className="mb-6 rounded-[22px] bg-warn-bg px-5 py-4 text-sm font-semibold text-warn-ink">
          Test mode: checkouts take test cards only (4242 4242 4242 4242, any future date, any CVV) or UPI <code>success@upi</code>. No real money moves.
        </p>
      )}
      {welcomeOffer && foundingOffer && (
        <div className="mb-6 rounded-[22px] bg-mint/50 px-5 py-4 text-sm text-ink">
          <p className="font-display text-lg font-bold">Your free Creator month is active</p>
          <p className="mt-1 text-ink-2">
            You have {data.credits.monthly.toLocaleString()} Creator credits ({Math.floor(data.credits.monthly / data.credits.perClip)} clips) through {shortDate(data.foundingOfferEndsAt!)}. No card is attached and no automatic charge will happen; after the offer, your account returns to Free.
          </p>
        </div>
      )}
      {data.paymentProblem && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-[22px] bg-warn-bg px-5 py-4 text-sm font-semibold text-warn-ink">
          <span>Your last renewal payment didn’t go through. Update your card or UPI within a few days to keep {plan.name} — your credits stay either way.</span>
          <Button size="sm" onClick={manage} loading={busy === 'portal'}>
            Update payment
          </Button>
        </div>
      )}
      {busy === 'return' && <p className="mb-6 rounded-[22px] bg-sunken px-5 py-4 text-sm font-semibold text-ink-2">Checking your payment…</p>}

      <div className="grid gap-5 lg:grid-cols-3">
        {/* plan */}
        <Card className="flex flex-col p-6">
          <span className="text-xs font-extrabold tracking-wider text-ink-3 uppercase">Your plan</span>
          <span className="mt-1 flex items-center gap-2">
            <b className="font-display text-3xl">{plan.name}</b>
            {data.paymentProblem ? <Badge tone="warn">Payment failed</Badge> : foundingOffer ? <Badge tone="good">Free month</Badge> : data.cancelAtPeriodEnd ? <Badge tone="warn">Ending</Badge> : paid ? <Badge tone="good">Active</Badge> : null}
          </span>
          <span className="text-sm text-ink-3">
            {foundingOffer ? 'Founding customer offer · free Creator access' : paid ? `${priceText(plan, paysInr)} / month${paysInr ? ' + GST' : ''}` : 'Free forever'}
          </span>
          <p className="mt-4 flex items-center gap-2 text-sm text-ink-2">
            <CalendarClock size={15} className="shrink-0 text-accent" />
            {data.cycleEnd
              ? foundingOffer
                ? `Free Creator month ends ${shortDate(data.foundingOfferEndsAt!)} — then Free`
                : data.cancelAtPeriodEnd
                ? `Ends ${shortDate(data.cycleEnd)} — then you’re on Free`
                : `${paid && data.hasSubscription ? 'Renews' : 'New credits'} on ${shortDate(data.cycleEnd)}`
              : '—'}
          </p>
          {foundingOffer && <p className="mt-2 text-sm text-ink-3">No paid subscription or payment method is attached. This offer ends automatically and won’t charge you.</p>}
          {data.lastPlanChange && (
            // when the plan last changed: "Pro cancelled on 8 Oct", "Pro ended on 8 Oct", "Upgraded to Pro on 8 Oct"
            <p className="mt-2 flex items-center gap-2 text-sm text-ink-3">
              <History size={15} className="shrink-0" />
              <span>
                {data.lastPlanChange.what} on {shortDate(data.lastPlanChange.at)}
                <Link to="/app/billing/history?type=plan" className="ml-1.5 font-bold text-accent no-underline hover:underline">
                  History
                </Link>
              </span>
            </p>
          )}
          <div className="mt-auto flex flex-wrap items-center gap-2 pt-5">
            {paid && data.cancelAtPeriodEnd && data.billedBy === 'dodo' ? (
              <Button size="sm" onClick={resume} loading={busy === 'resume'} disabled={noPay}>
                Keep my plan
              </Button>
            ) : paid && !data.cancelAtPeriodEnd ? (
              <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(true)} disabled={noPay && data.billedBy === 'dodo'}>
                Cancel plan
              </Button>
            ) : !paid ? (
              <a href="#plans" className="text-sm font-bold text-accent">
                Compare plans ↓
              </a>
            ) : null}
            {data.canManageBilling && (
              <Button size="sm" variant="ghost" onClick={manage} loading={busy === 'portal'}>
                {busy !== 'portal' && <CreditCard size={15} />} Manage billing
              </Button>
            )}
          </div>
        </Card>

        {/* credits */}
        <Card className="p-6">
          <span className="text-xs font-extrabold tracking-wider text-ink-3 uppercase">Credits</span>
          <p className="mt-1 flex items-baseline gap-2">
            <b className="font-display text-4xl tabular-nums">{data.credits.balance.toLocaleString()}</b>
            <span className="text-ink-3">left</span>
          </p>
          <p className="text-sm text-ink-3">≈ {Math.floor(data.credits.balance / data.credits.perClip).toLocaleString()} clips</p>
          <div className="mt-4">
            <span className="flex justify-between text-xs font-bold text-ink-3">
              <span>Used this month</span>
              <span className="tabular-nums">
                {data.credits.usedThisMonth.toLocaleString()} / {data.credits.monthly.toLocaleString()}
              </span>
            </span>
            <span className="mt-1.5 block h-2 overflow-hidden rounded-full bg-sunken shadow-well">
              <span className="block h-full rounded-full bg-tangerine" style={{ width: `${usedPct}%` }} />
            </span>
          </div>
          <Link to="/app/billing/history" className="mt-5 inline-flex items-center gap-1 text-sm font-bold text-accent no-underline hover:underline">
            See where they went <ArrowRight size={14} />
          </Link>
        </Card>

        {/* top-up */}
        <Card className="flex flex-col p-6">
          <span className="text-xs font-extrabold tracking-wider text-ink-3 uppercase">Need more now?</span>
          <b className="mt-1 font-display text-2xl">{info.topup.credits} credits</b>
          <span className="text-sm text-ink-3">
            {priceText(info.topup, india)}
            {india ? ' + GST' : ''} once · use within {Math.round(info.topup.validDays / 30)} months
          </span>
          <p className="mt-4 text-sm text-ink-2">Adds to your balance right away — handy when you have a big batch this month. Works on any plan.</p>
          <div className="mt-auto pt-5">
            <Button variant="primary" onClick={topup} loading={busy === 'topup'} disabled={noPay || (busy !== null && busy !== 'topup')}>
              {busy !== 'topup' && <ShoppingBag size={16} />} Buy {info.topup.credits} credits
            </Button>
          </div>
        </Card>
      </div>

      {/* plans */}
      <section id="plans" className="mt-12 scroll-mt-6">
        <h2 className="mb-1 text-2xl">Plans</h2>
        <p className="mb-6 text-ink-2">
          Monthly credits refill on your renewal date. On paid plans, unused credits carry over one more month.
          {data.billedBy === 'dodo' && plan.id !== 'pro' && ' Upgrading starts your new plan today with its full monthly credits; you pay its price minus what’s left of your current month.'}
        </p>
        <PlanCards
          note={false}
          plans={info.plans}
          current={plan.id}
          action={(p) =>
            p.id === plan.id ? (
              <Button disabled className="w-full">
                Current plan
              </Button>
            ) : rank(p.id) < rank(plan.id) ? (
              // Only upgrades are offered — a lower plan is already part of yours.
              <p className="rounded-full bg-sunken py-2.5 text-center text-sm font-bold text-ink-3">Included in {plan.name}</p>
            ) : (
              <Button className="w-full" loading={busy === p.id} disabled={noPay || busy !== null} onClick={() => subscribe(p)}>
                {busy !== p.id && <Sparkles size={16} />} Upgrade to {p.name}
              </Button>
            )
          }
        />
        <p className="mt-4 text-center text-xs text-ink-3">
          {india
            ? 'Prices in rupees (₹) for India — pay by UPI or card; 18% GST is added at checkout.'
            : 'Prices in US dollars (USD); checkout shows your local currency where it can, and adds sales tax or VAT where it applies. In India, plans have their own rupee prices.'}{' '}
          Payments are handled by Dodo Payments, our merchant of record. The credits you already have stay until they expire.
        </p>
      </section>

      {/* history */}
      <div className="mt-12 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card className="p-5 sm:p-6">
          <CardHeader
            title="Credit history"
            icon={<History size={18} />}
            description="Latest activity — credits added and used, and plan changes."
            actions={
              <Link to="/app/billing/history" className="inline-flex items-center gap-1 text-sm font-bold text-accent no-underline hover:underline">
                See all <ArrowRight size={14} />
              </Link>
            }
          />
          {data.history.length === 0 ? (
            <p className="text-sm text-ink-3">Nothing yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.history.map((e) => (
                <CreditEventRow key={e.id} e={e} />
              ))}
            </ul>
          )}
        </Card>
        <Card className="p-5 sm:p-6">
          <CardHeader title="Payments" icon={<Receipt size={18} />} />
          {data.payments.length === 0 ? (
            <p className="text-sm text-ink-3">No payments yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.payments.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="block font-semibold">{p.kind === 'topup' ? 'Credit top-up' : `${info.plans.find((x) => x.id === p.plan)?.name ?? ''} plan`}</span>
                    <span className="text-xs text-ink-3">
                      {shortDate(p.createdAt)} · {p.id}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <b className="font-display tabular-nums">{p.amount != null && p.currency ? money(p.amount / 100, p.currency) : '—'}</b>
                    <Link to={`/receipt/${encodeURIComponent(p.id)}`} className="text-xs font-bold text-accent">
                      Receipt
                    </Link>
                    {p.invoiceUrl && (
                      <a href={p.invoiceUrl} target="_blank" rel="noreferrer" className="text-xs font-bold text-accent">
                        Invoice
                      </a>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <ConfirmDialog open={confirmCancel} title="Cancel your plan?" confirmLabel="Cancel plan" busy={busy === 'cancel'} onCancel={() => setConfirmCancel(false)} onConfirm={cancel}>
        {data.cycleEnd
          ? `${plan.name} stays active until ${shortDate(data.cycleEnd)}. After that you’re on Free (60 credits a month). Credits you already have stay until they expire.`
          : 'You’ll move to Free.'}
      </ConfirmDialog>
    </>
  );
}

import { Link } from 'react-router-dom';
import { useBusiness } from './business';
import { ContactDetails, LegalLayout, Section, SupportEmail } from './LegalLayout';

export function RefundsPage() {
  const b = useBusiness();
  return (
    <LegalLayout title="Refunds & cancellation" policy intro={`How to cancel a ${b.name} plan, and when you can get your money back.`} business={b}>
      <Section title="Cancelling your plan">
        <ul>
          <li>
            Cancel any time on the <strong>Plan & credits</strong> page in the app — no emails or calls needed.
          </li>
          <li>Your plan stays active until the end of the month you’ve already paid for. After that you move to the Free plan and aren’t charged again.</li>
          <li>Credits you already have stay usable until they expire.</li>
        </ul>
      </Section>

      <Section title="When you get a full refund">
        <ul>
          <li>
            <strong>First payment for a plan:</strong> ask within <strong>7 days</strong>, and we refund it in full if you’ve made no more than 5 clips since paying.
          </li>
          <li>
            <strong>Forgot to cancel:</strong> ask within <strong>48 hours</strong> of an automatic renewal, and we refund it if you haven’t made any clips since.
          </li>
          <li>
            <strong>Top-up credits:</strong> ask within 7 days, and we refund them if none of those credits have been used.
          </li>
          <li>
            <strong>Charged twice, or charged but the plan didn’t start:</strong> always refunded in full.
          </li>
        </ul>
      </Section>

      <Section title="When we don’t refund">
        <ul>
          <li>Months that have already been used, and the rest of a month after you cancel.</li>
          <li>Credits that have been used to make clips.</li>
          <li>
            Accounts closed for breaking our <Link to="/terms">Terms of service</Link>.
          </li>
        </ul>
      </Section>

      <Section title="Credits for failed clips come back by themselves">
        <p>If a video fails, or fewer clips come out than you asked for, the unused credits go back to your balance automatically. You don’t need to ask — this is separate from money refunds.</p>
      </Section>

      <Section title="How refunds are paid">
        <ul>
          <li>
            Email <SupportEmail business={b} /> from your account email with the <strong>payment ID</strong> (it starts with <code>pay_</code>). We reply within 2 working days.
          </li>
          <li>
            Approved refunds go back to the original card or account through Razorpay within <strong>5–7 working days</strong>. Your bank may take a few more days to show it.
          </li>
          <li>Refunds are made in US dollars, the currency you paid in. If your bank converted the payment, the amount you see in your own currency may differ because of exchange rates.</li>
        </ul>
      </Section>

      <Section title="Contact">
        <ContactDetails business={b} />
      </Section>
    </LegalLayout>
  );
}

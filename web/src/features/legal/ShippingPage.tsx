import { Link } from 'react-router-dom';
import { useBusiness } from './business';
import { ContactDetails, LegalLayout, Section, SupportEmail } from './LegalLayout';

export function ShippingPage() {
  const b = useBusiness();
  return (
    <LegalLayout title="Delivery of digital goods" policy intro={`${b.name} is an online service — nothing is shipped to you.`} business={b}>
      <Section title="How you receive what you buy">
        <ul>
          <li>
            <strong>Plans:</strong> your new plan and its credits start as soon as your payment goes through — usually within seconds.
          </li>
          <li>
            <strong>Top-up credits:</strong> added to your balance as soon as the payment goes through.
          </li>
          <li>
            <strong>Clips:</strong> made and shown in the app, usually within minutes of adding a video. You can download them or post them straight to YouTube and Instagram.
          </li>
        </ul>
      </Section>

      <Section title="No shipping charges">
        <p>There are no physical products, no shipping and no delivery charges. You only pay the price shown at checkout (in rupees in India, otherwise your local currency or US dollars), plus taxes where they apply.</p>
      </Section>

      <Section title="If something didn’t arrive">
        <p>
          If your plan or credits don’t appear within 30 minutes of paying, open the <strong>Plan & credits</strong> page (it re-checks your payment). If it’s still missing, email{' '}
          <SupportEmail business={b} /> with your payment ID. If we can’t fix it, we refund you in full — see <Link to="/refunds">Refunds & cancellation</Link>.
        </p>
      </Section>

      <Section title="Contact">
        <ContactDetails business={b} />
      </Section>
    </LegalLayout>
  );
}

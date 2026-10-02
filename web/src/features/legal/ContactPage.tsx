import { Link } from 'react-router-dom';
import { useBusiness } from './business';
import { ContactDetails, LegalLayout, Section, SupportEmail } from './LegalLayout';

export function ContactPage() {
  const b = useBusiness();
  return (
    <LegalLayout title="Contact us" intro="We read every message and usually reply within 2 working days." business={b}>
      <Section title="How to reach us">
        <ContactDetails business={b} />
      </Section>

      <Section title="To get help faster">
        <ul>
          <li>Write from the email you use for your CrestClip account.</li>
          <li>
            For a payment, include the <strong>payment ID</strong> — it starts with <code>pay_</code> and is on your Razorpay receipt and on the Plan & credits page.
          </li>
          <li>For a clip or project, include its link from your browser’s address bar.</li>
        </ul>
      </Section>

      <Section title="Billing, refunds and cancellations">
        <p>
          You can cancel your plan yourself any time on the <strong>Plan & credits</strong> page in the app. For money back, see our <Link to="/refunds">Refunds & cancellation policy</Link>.
        </p>
      </Section>

      <Section title="Complaints (grievance officer)">
        <p>
          For a complaint about the service, a payment or how we handle your personal data, write to our grievance officer, <strong>{b.site?.grievanceOfficer ?? b.owner}</strong>, at{' '}
          <SupportEmail business={b} /> with the subject “Grievance”. We acknowledge it within 48 hours and resolve it within 30 days.
        </p>
      </Section>

      <Section title="Privacy requests">
        <p>
          To see, correct or delete your personal data, email <SupportEmail business={b} /> with the subject “Privacy request”. See our <Link to="/privacy">Privacy policy</Link> for details.
        </p>
      </Section>
    </LegalLayout>
  );
}

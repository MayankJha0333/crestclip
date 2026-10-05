import { Link } from 'react-router-dom';
import { useBusiness } from './business';
import { ContactDetails, LegalLayout, Section, SupportEmail } from './LegalLayout';

const ext = { target: '_blank', rel: 'noreferrer' } as const;

/**
 * How to delete your data — the "data deletion instructions" page Meta (Instagram) asks for, and what Google's
 * YouTube rules expect: removing access and deleting stored data are both in the person's hands.
 */
export function DataDeletionPage() {
  const b = useBusiness();
  return (
    <LegalLayout title="Delete your data" policy intro={`How to remove ${b.name}’s access to your YouTube or Instagram account, and how to delete your ${b.name} account and everything in it.`} business={b}>
      <Section title="1. Delete your whole account (fastest)">
        <ol>
          <li>
            Log in and open <Link to="/app/settings">Settings</Link>.
          </li>
          <li>
            Under <strong>Your account</strong>, choose <strong>Delete my account…</strong>, type your email address and confirm.
          </li>
        </ol>
        <p>This deletes, straight away and for good:</p>
        <ul>
          <li>your projects — the videos, transcripts, clips and edits — on our servers and in cloud storage;</li>
          <li>your scheduled and past posts, and your Autopilots;</li>
          <li>your connected YouTube and Instagram accounts and their access keys (we also tell Google and Instagram to cancel our access);</li>
          <li>your credits, uploaded logos and music, and every log-in;</li>
          <li>your account itself (name, email, password).</li>
        </ul>
        <p>
          We keep payment records (amounts, dates and payment IDs — never card details) because tax law requires it. If you’re on a paid plan, cancel it first on{' '}
          <Link to="/app/billing">Plan & credits</Link> so you aren’t charged again.
        </p>
      </Section>

      <Section title="2. Only disconnect YouTube or Instagram">
        <p>
          In <Link to="/app/settings">Settings</Link>, press <strong>Disconnect</strong> next to the account. We delete its access keys and its posts in {b.name}, and cancel our access with
          Google or Instagram. Your {b.name} account and projects stay.
        </p>
        <p>You can also remove our access from the other side at any time:</p>
        <ul>
          <li>
            <strong>YouTube / Google:</strong> open{' '}
            <a href="https://myaccount.google.com/connections" {...ext}>
              your Google account’s third-party connections
            </a>{' '}
            and remove {b.name}.
          </li>
          <li>
            <strong>Instagram:</strong> in the Instagram app, go to <strong>Settings → Apps and websites</strong> (or Accounts Center → Your information and permissions), and remove {b.name}.
          </li>
        </ul>
        <p>
          Once access is removed on their side, {b.name} can no longer read your account or post for you — the keys we stored stop working. To remove those keys from {b.name} too, press
          Disconnect in Settings or delete your account.
        </p>
      </Section>

      <Section title="3. Ask us to do it">
        <p>
          Email <SupportEmail business={b} /> from the address on your account with the subject “Delete my data”. We confirm and delete everything listed above within 30 days, and reply when
          it’s done.
        </p>
      </Section>

      <Section title="4. Projects delete themselves anyway">
        <p>
          Even if you do nothing, every project — its video, clips and work files — is deleted automatically {b.retentionDays} days after you create it. See the{' '}
          <Link to="/privacy">privacy policy</Link> for everything we keep and why.
        </p>
      </Section>

      <Section title="Contact">
        <ContactDetails business={b} />
      </Section>
    </LegalLayout>
  );
}

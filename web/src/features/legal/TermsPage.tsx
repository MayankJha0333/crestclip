import { Link } from 'react-router-dom';
import { useBusiness } from './business';
import { ContactDetails, LegalLayout, Section } from './LegalLayout';

export function TermsPage() {
  const b = useBusiness();
  return (
    <LegalLayout
      title="Terms of service"
      policy
      intro={`These terms are the agreement between you and ${b.owner} for using ${b.name}. By creating an account or using ${b.name}, you agree to them.`}
      business={b}
    >
      <Section title="1. Who we are">
        <p>
          {b.name} (“we”, “us”) is run by {b.owner}
          {b.site?.address ? `, ${b.site.address}` : ''}. Our details are on the <Link to="/contact">Contact page</Link>.
        </p>
      </Section>

      <Section title="2. Your account">
        <ul>
          <li>You must be at least 18 years old to use {b.name}.</li>
          <li>Give us accurate details and keep your password safe. You’re responsible for what happens in your account.</li>
          <li>One person, one free account. Creating extra accounts to get more free credits isn’t allowed.</li>
          <li>You can delete your account any time in Settings, or by emailing us — see <Link to="/data-deletion">Delete your data</Link>.</li>
        </ul>
      </Section>

      <Section title="3. What the service does">
        <p>
          {b.name} takes a video you link to or upload, finds its strongest moments with AI, and turns them into short vertical clips with captions that you can edit, download and post
          to YouTube or Instagram. We keep improving the service, so features may change.
        </p>
      </Section>

      <Section title="4. Your videos and clips">
        <ul>
          <li>
            <strong>You keep ownership</strong> of the videos you bring and the clips made from them.
          </li>
          <li>You let us store, copy and process your videos only to run the service for you — to transcribe them, find moments, make clips and post them where you ask.</li>
          <li>
            <strong>You must have the right to use every video you clip</strong>: it’s yours, the owner allowed it, or the law allows your use. You’re responsible for copyright and for the rules of
            the platforms you post to. Crediting a creator doesn’t by itself make reposting their work legal.
          </li>
          <li>We may remove content and suspend accounts after a valid copyright complaint, or when content breaks the law.</li>
        </ul>
      </Section>

      <Section title="5. Things you may not do">
        <ul>
          <li>Upload or create anything illegal, sexual content involving minors, hate speech, harassment, or content that infringes someone else’s rights.</li>
          <li>Try to break, overload, copy or reverse-engineer the service, or get around plan limits.</li>
          <li>Resell or share access to {b.name} without our written permission.</li>
          <li>Use the service to send spam or to mislead people about who made a video.</li>
        </ul>
      </Section>

      <Section title="6. AI results">
        <p>
          Clips, titles, captions and scores are made by AI and can be wrong — a caption may mishear a word, or a “strong” moment may not perform. Please check every clip before you post it. You’re
          responsible for what you publish.
        </p>
      </Section>

      <Section title="7. Plans, prices and payments">
        <ul>
          <li>
            <strong>All prices are in US dollars (USD)</strong> and are shown on the Pricing page and at checkout. Taxes may apply. If your card or bank uses another currency, your bank converts the
            amount and may add its own fee.
          </li>
          <li>
            <strong>Free plan:</strong> a monthly amount of credits with lower limits. No card needed.
          </li>
          <li>
            <strong>Paid plans</strong> are monthly subscriptions, charged in advance through our payment partner Razorpay. They <strong>renew automatically every month</strong> until you cancel.
          </li>
          <li>If we change prices, we’ll tell you before your next renewal, and you can cancel before the new price applies.</li>
        </ul>
      </Section>

      <Section title="8. Credits">
        <ul>
          <li>
            Every clip {b.name} makes uses {b.creditsPerClip} credits. If fewer clips come out than you asked for, or a video fails, those credits come back automatically. Editing and re-rendering
            clips is free.
          </li>
          <li>Monthly credits on paid plans can be used in that month and the next one; on the Free plan, only in the current month. Top-up credits can be used for {b.topupMonths} months.</li>
          <li>Credits have no cash value and can’t be transferred, sold or exchanged for money.</li>
        </ul>
      </Section>

      <Section title="9. Cancelling and refunds">
        <p>
          You can cancel any time on the Plan & credits page. Your plan stays active until the end of the month you’ve paid for, and you won’t be charged again. Refunds follow our{' '}
          <Link to="/refunds">Refunds & cancellation policy</Link>.
        </p>
      </Section>

      <Section title="10. Storage time">
        <p>
          Each project — the original video, its clips and edits — is kept for <strong>{b.retentionDays} days</strong> after you create it, then deleted automatically. Please download or post your
          clips before then.
        </p>
      </Section>

      <Section title="11. Connected YouTube and Instagram accounts">
        <p>
          When you connect an account, you allow {b.name} to upload the clips you choose, when you choose (or when your Autopilot settings say). You can disconnect any time in Settings. {b.name} uses
          YouTube API Services, so connecting YouTube also means you agree to the{' '}
          <a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">
            YouTube Terms of Service
          </a>
          .
        </p>
      </Section>

      <Section title="12. Services we rely on">
        <p>
          {b.name} uses Google Cloud (hosting, storage and AI), Razorpay (payments), YouTube and Instagram. Their own terms apply to what they do, and we can’t control when they’re unavailable.
        </p>
      </Section>

      <Section title="13. Suspension and closing accounts">
        <p>
          We may suspend or close an account that breaks these terms, puts the service or other people at risk, or doesn’t pay. If we close a paid account that didn’t break these terms, we refund the
          unused part of the current month.
        </p>
      </Section>

      <Section title="14. No guarantees">
        <p>We work hard to keep {b.name} running well, but it’s provided “as is”. We don’t promise it will always be available or error-free, or that clips will reach a certain number of views.</p>
      </Section>

      <Section title="15. Limit of our responsibility">
        <p>
          As far as the law allows, we’re not responsible for indirect losses (such as lost profits, views or followers), and our total responsibility for any claim is limited to what you paid us in
          the 3 months before it. Nothing here limits rights that consumer law gives you.
        </p>
      </Section>

      <Section title="16. Law and disputes">
        <p>These terms are governed by the laws of India, and disputes are handled by the courts in {b.jurisdiction}. Please contact us first — most problems can be solved by email.</p>
      </Section>

      <Section title="17. Changes to these terms">
        <p>We may update these terms. If a change matters, we’ll tell you by email or in the app before it applies. The date at the top shows the latest version.</p>
      </Section>

      <Section title="18. Contact">
        <ContactDetails business={b} />
      </Section>
    </LegalLayout>
  );
}

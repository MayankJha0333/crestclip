import { Link } from 'react-router-dom';
import { useBusiness } from './business';
import { ContactDetails, LegalLayout, Section, SupportEmail } from './LegalLayout';

const ext = { target: '_blank', rel: 'noreferrer' } as const;

export function PrivacyPage() {
  const b = useBusiness();
  return (
    <LegalLayout
      title="Privacy policy"
      policy
      intro={`What personal data ${b.name} collects, why, who it’s shared with, how long we keep it, and your choices. We don’t sell your data and we don’t show ads.`}
      business={b}
    >
      <Section title="1. Who is responsible">
        <p>
          {b.owner}
          {b.site?.address ? `, ${b.site.address}` : ''}, runs {b.name} and decides how your personal data is used — the “data fiduciary” under India’s Digital Personal Data Protection Act, 2023.
        </p>
      </Section>

      <Section title="2. What we collect">
        <ul>
          <li>
            <strong>Account:</strong> your Google name, email and profile picture (you sign in with Google). Older accounts made with an email may also have a scrambled (hashed) password.
          </li>
          <li>
            <strong>Payments:</strong> your plan, amounts, dates and payment IDs. Card and bank details go straight to Razorpay; we never see or store them.
          </li>
          <li>
            <strong>Your content:</strong> the video links and files you add, their transcripts, the clips and edits you make, and any logo or music you upload.
          </li>
          <li>
            <strong>Connected accounts:</strong> if you connect YouTube or Instagram, the account name and picture, and the access keys (stored encrypted) that let us post for you.
          </li>
          <li>
            <strong>Technical:</strong> your IP address (to keep accounts safe and limit abuse) and error logs.
          </li>
          <li>
            <strong>Cookies and usage:</strong> one cookie that keeps you signed in. If you accept on the cookie banner, Google Analytics and Microsoft Clarity also set cookies to measure visits —
            which pages you open, what you click, roughly where you are (country/city), your device and browser — and Clarity records anonymised screen sessions and heatmaps. Text you type into forms
            is hidden from those recordings. We link visits to a random account ID, never your email. No advertising cookies.
          </li>
        </ul>
      </Section>

      <Section title="3. Why we use it">
        <ul>
          <li>To run {b.name}: process your videos, make clips, store them and post them where you ask.</li>
          <li>To manage your plan, credits and payments.</li>
          <li>To keep the service secure and prevent abuse, such as more than one free account per person.</li>
          <li>To answer your messages and send important service emails.</li>
          <li>To meet legal duties, such as keeping tax records.</li>
        </ul>
        <p>We use your data because you asked for the service (your consent and our agreement with you) and, for records, because the law requires it.</p>
      </Section>

      <Section title="4. AI processing">
        <p>
          Your videos’ audio, transcript and, for some videos, frames are sent to AI services on Google Cloud to find moments and write titles and captions. Under Google Cloud’s
          terms, this data isn’t used to train Google’s models, and we don’t use your videos to train any AI either.
        </p>
      </Section>

      <Section title="5. Who we share it with">
        <ul>
          <li>
            <strong>Google Cloud</strong> — hosting, file storage and AI processing.
          </li>
          <li>
            <strong>Razorpay</strong> — payments and subscriptions.
          </li>
          <li>
            <strong>Google Analytics and Microsoft Clarity</strong> — visit statistics, recordings and heatmaps, only if you accept analytics cookies. You can change your mind any time by clearing
            this site’s data in your browser; the banner then asks again.
          </li>
          <li>
            <strong>YouTube and Instagram</strong> — only the clips and text you choose to post, when you post them.
          </li>
          <li>Authorities, when the law requires it.</li>
        </ul>
        <p>These companies only get what they need to do their job for us. We never sell or rent your personal data.</p>
      </Section>

      <Section title="6. YouTube, Google and Instagram data">
        <p>
          {b.name} uses YouTube API Services to post clips to your channel when you connect it. Google’s{' '}
          <a href="https://policies.google.com/privacy" {...ext}>
            Privacy Policy
          </a>{' '}
          applies to that data, and you can remove {b.name}’s access any time in{' '}
          <a href="https://security.google.com/settings/security/permissions" {...ext}>
            your Google account’s security settings
          </a>{' '}
          or by disconnecting in Settings. Our use of information from Google APIs follows the{' '}
          <a href="https://developers.google.com/terms/api-services-user-data-policy" {...ext}>
            Google API Services User Data Policy
          </a>
          , including its Limited Use rules.
        </p>
        <p>
          If you connect Instagram, {b.name} uses Instagram’s API (by Meta) to read your account’s name, username and picture, and to publish the clips you choose — nothing else. Meta’s{' '}
          <a href="https://privacycenter.instagram.com/policy" {...ext}>
            Privacy Policy
          </a>{' '}
          applies to that data. You can remove our access in Instagram’s <strong>Settings → Apps and websites</strong>, or by disconnecting in Settings.
        </p>
        <p>
          We use data from YouTube and Instagram only to show you which account is connected and to post what you ask us to post. We don’t sell it, use it for ads, or share it with anyone
          else. To delete it, see <Link to="/data-deletion">Delete your data</Link>.
        </p>
      </Section>

      <Section title="7. Where it’s stored">
        <p>On Google Cloud, which may be in the United States or other countries, and on our servers. When data leaves India, we only use providers that protect it under their contracts with us.</p>
      </Section>

      <Section title="8. How long we keep it">
        <ul>
          <li>
            <strong>Projects</strong> (original video, transcript, clips, edits): {b.retentionDays} days after you create them, then deleted automatically — on our servers and in cloud storage.
          </li>
          <li>
            <strong>Your account:</strong> until you delete it (Settings → Your account → Delete my account) or ask us to — see <Link to="/data-deletion">Delete your data</Link>.
          </li>
          <li>
            <strong>Payment records:</strong> as long as tax law requires (in India, usually up to 8 years).
          </li>
          <li>
            <strong>Security logs:</strong> usually no more than 90 days.
          </li>
        </ul>
      </Section>

      <Section title="9. How we protect it">
        <p>
          Connections are encrypted, passwords are hashed, access keys for your social accounts are encrypted, and only you can open your projects. No system is perfectly secure, but if a breach
          affects you, we’ll tell you and the authorities as the law requires.
        </p>
      </Section>

      <Section title="10. Your rights">
        <p>You can ask us to:</p>
        <ul>
          <li>tell you what personal data we hold about you and who we’ve shared it with;</li>
          <li>correct or update it;</li>
          <li>delete it, along with your account;</li>
          <li>stop using it (withdraw consent) — some features then stop working;</li>
          <li>let someone else act for you if you can’t.</li>
        </ul>
        <p>
          Email <SupportEmail business={b} /> with the subject “Privacy request”. We reply within 30 days. If you’re not happy with our answer, you can complain to the Data Protection Board of India.
        </p>
      </Section>

      <Section title="11. Children">
        <p>{b.name} is not meant for anyone under 18, and we don’t knowingly collect their data. If you think a child has an account, contact us and we’ll delete it.</p>
      </Section>

      <Section title="12. Changes">
        <p>We’ll update this policy when our practices change, and tell you by email or in the app if a change matters. The date at the top shows the latest version.</p>
      </Section>

      <Section title="13. Contact and grievance officer">
        <ContactDetails business={b} grievance />
      </Section>
    </LegalLayout>
  );
}

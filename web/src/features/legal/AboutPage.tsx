import { Link } from 'react-router-dom';
import { useBusiness } from './business';
import { ContactDetails, LegalLayout, Section } from './LegalLayout';

export function AboutPage() {
  const b = useBusiness();
  return (
    <LegalLayout title={`About ${b.name}`} intro="CrestClip (formerly PeakClip) turns long videos into short, ready-to-post clips — starting from the moments viewers actually rewatch." business={b}>
      <Section title="What we do">
        <p>
          Paste a link to a podcast, stream or interview, or upload a video. CrestClip reads YouTube’s “most replayed” graph, timestamped comments and the energy in the audio, then uses AI to find the
          strongest moments. It cuts them into vertical clips with captions, a hook and a score, ready for YouTube Shorts and Instagram Reels in minutes instead of hours.
        </p>
      </Section>

      <Section title="Who it’s for">
        <ul>
          <li>Creators who want more reach from the long videos they already make.</li>
          <li>Clippers and agencies who post clips for other channels every day.</li>
          <li>Podcasters, streamers and educators who don’t have time to edit shorts by hand.</li>
        </ul>
      </Section>

      <Section title="Who runs CrestClip">
        <p>
          {b.name} is run by <strong>{b.owner}</strong>
          {b.site?.address ? `, based in ${b.site.address}` : ''}. We build and operate the product, take payments through Razorpay and run the AI on Google Cloud.
        </p>
      </Section>

      <Section title="Pricing">
        <p>
          There’s a free plan, and monthly plans in US dollars for people who clip more. Every clip uses {b.creditsPerClip} credits, and editing clips is always free. See{' '}
          <a href="/#pricing">Pricing</a> for the current plans.
        </p>
      </Section>

      <Section title="Talk to us">
        <ContactDetails business={b} />
        <p>
          Questions, feedback or partnership ideas? <Link to="/contact">Get in touch</Link>.
        </p>
      </Section>
    </LegalLayout>
  );
}

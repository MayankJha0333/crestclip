import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { buttonClass } from '../../components/ui';
import { Logo } from '../../components/brand/Logo';
import { SiteFooter } from '../../components/SiteFooter';
import { useAuth } from '../auth/auth';
import type { Business } from './business';

/** When the policy text last changed (shown at the top of each policy page). */
const POLICY_UPDATED = '3 October 2026';

/** A public page: header, a readable column of text, and the footer with every policy link. */
export function LegalLayout({ title, intro, policy, business, children }: { title: string; intro: ReactNode; policy?: boolean; business: Business; children: ReactNode }) {
  const { me } = useAuth();
  useEffect(() => {
    document.title = `${title} — CrestClip`;
    window.scrollTo(0, 0);
    return () => {
      document.title = 'CrestClip — clip the moment everyone rewatches';
    };
  }, [title]);
  return (
    <div className="mx-auto max-w-[1080px] px-4 pt-3 pb-8 sm:px-6 sm:pt-5">
      <header className="flex items-center justify-between gap-4 rounded-full bg-surface py-3 pr-3.5 pl-4 shadow-clay sm:pl-5">
        <Link to="/" className="no-underline">
          <Logo size={34} />
        </Link>
        <Link to={me ? '/app' : '/signup'} className={buttonClass('ink', 'sm')}>
          {me ? 'Open app' : 'Start free'}
        </Link>
      </header>

      <main className="mx-auto mt-10 max-w-[760px]">
        <Link to="/" className="inline-flex items-center gap-1.5 text-sm font-bold text-ink-3 no-underline hover:text-ink">
          <ArrowLeft size={16} /> Home
        </Link>
        <h1 className="mt-4 text-[clamp(34px,5vw,52px)] font-bold tracking-tight">{title}</h1>
        {policy && <p className="mt-2 text-sm font-bold text-ink-3">Last updated: {POLICY_UPDATED}</p>}
        <p className="mt-5 text-lg text-ink-2">{intro}</p>
        <article className="mt-8 flex flex-col gap-8 rounded-[28px] bg-surface p-6 text-[16px] leading-relaxed shadow-clay sm:p-9">{children}</article>
      </main>

      <div className="mt-14">
        <SiteFooter owner={business.owner} />
      </div>
    </div>
  );
}

/** One part of a page, with its heading. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[22px] font-bold">{title}</h2>
      <div className="flex flex-col gap-3 text-ink-2 [&_a]:font-bold [&_a]:text-accent [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-ink">{children}</div>
    </section>
  );
}

/** The support email as a link (or a link to the Contact page until one is set). */
export function SupportEmail({ business }: { business: Business }) {
  return business.email ? <a href={`mailto:${business.email}`}>{business.email}</a> : <Link to="/contact">the email on our Contact page</Link>;
}

/** Who to contact: business, email, phone, address, hours (only the lines that are set). */
export function ContactDetails({ business, grievance }: { business: Business; grievance?: boolean }) {
  const s = business.site;
  if (!s) return null;
  return (
    <ul className="flex flex-col gap-1.5">
      <li>
        <strong>Business:</strong> {s.legalName}
        {s.legalName !== s.name ? ` (trading as ${s.name})` : ''}
      </li>
      {grievance && (
        <li>
          <strong>Grievance officer:</strong> {s.grievanceOfficer}
        </li>
      )}
      {s.email && (
        <li>
          <strong>Email:</strong> <a href={`mailto:${s.email}`}>{s.email}</a>
        </li>
      )}
      {s.phone && (
        <li>
          <strong>Phone:</strong> <a href={`tel:${s.phone.replace(/\s+/g, '')}`}>{s.phone}</a>
        </li>
      )}
      {s.address && (
        <li>
          <strong>Address:</strong> {s.address}
        </li>
      )}
      <li>
        <strong>Support hours:</strong> {s.hours}
      </li>
    </ul>
  );
}

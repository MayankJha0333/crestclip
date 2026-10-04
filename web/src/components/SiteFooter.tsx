import { Link } from 'react-router-dom';
import { Logo } from './brand/Logo';

/** The links every public page shows — Razorpay and Google check that these pages are easy to find. */
export const LEGAL_LINKS = [
  { to: '/about', label: 'About' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/contact', label: 'Contact' },
  { to: '/terms', label: 'Terms' },
  { to: '/privacy', label: 'Privacy' },
  { to: '/refunds', label: 'Refunds & cancellation' },
  { to: '/shipping', label: 'Shipping & delivery' },
  { to: '/crayo-alternative', label: 'CrestClip vs Crayo' },
];

export function SiteFooter({ owner }: { owner?: string }) {
  return (
    <footer className="mt-10 flex flex-col gap-5 border-t border-line px-1 pt-7 pb-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Link to="/" className="no-underline">
          <Logo size={30} />
        </Link>
        <nav aria-label="Company and policies" className="flex flex-wrap gap-x-5 gap-y-2">
          {LEGAL_LINKS.map((l) =>
            l.to.includes('#') ? (
              <a key={l.to} href={l.to} className="text-sm font-bold text-ink-2 no-underline hover:text-ink">
                {l.label}
              </a>
            ) : (
              <Link key={l.to} to={l.to} className="text-sm font-bold text-ink-2 no-underline hover:text-ink">
                {l.label}
              </Link>
            ),
          )}
        </nav>
      </div>
      <p className="text-sm text-ink-3">
        © {new Date().getFullYear()} {owner || 'CrestClip'} · Made for creators and clippers
      </p>
    </footer>
  );
}

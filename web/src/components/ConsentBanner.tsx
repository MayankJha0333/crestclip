import { useState } from 'react';
import { analyticsEnabled, setConsent, storedConsent, type Consent } from '../lib/analytics';
import { Button } from './ui';

/** (Sits outside the router, so it uses a plain link.) A small card at the bottom asking whether visit tracking (Google Analytics, Microsoft Clarity) is OK. Asked once. */
export function ConsentBanner() {
  const [open, setOpen] = useState(() => analyticsEnabled() && storedConsent() === null);
  if (!open) return null;
  const answer = (c: Consent) => {
    setConsent(c);
    setOpen(false);
  };
  return (
    <div role="region" aria-label="Cookie choice" className="fixed inset-x-3 bottom-3 z-50 sm:inset-x-auto sm:right-5 sm:bottom-5 sm:max-w-[400px] print:hidden">
      <div className="flex flex-col gap-3 rounded-[22px] bg-surface p-4 text-sm leading-relaxed text-ink-2 shadow-clay">
        <p>
          We use cookies from Google Analytics and Microsoft Clarity to see how people use CrestClip, so we can make it better. No ads.{' '}
          <a href="/privacy" className="font-bold text-accent">
            Privacy policy
          </a>
        </p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => answer('denied')}>
            Decline
          </Button>
          <Button size="sm" variant="ink" onClick={() => answer('granted')}>
            Accept
          </Button>
        </div>
      </div>
    </div>
  );
}

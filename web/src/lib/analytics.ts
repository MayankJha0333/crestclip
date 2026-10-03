/**
 * Visitor tracking: Google Analytics 4 (how many people come, from where, what they do) and Microsoft Clarity
 * (screen recordings and heatmaps). The server puts the IDs on the page (GA_MEASUREMENT_ID, CLARITY_PROJECT_ID in
 * .env); with no IDs — e.g. local development — nothing loads and track() does nothing.
 *
 * Consent: visitors in the EU, UK and Switzerland are tracked only after they press "Accept" on the cookie banner
 * (Google's consent mode handles that by region). Anyone who presses "Decline" is not tracked with cookies.
 */

declare global {
  interface Window {
    __CC_ANALYTICS__?: { ga?: string; clarity?: string };
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    clarity?: (...args: unknown[]) => void;
  }
}

export type Consent = 'granted' | 'denied';
const CONSENT_KEY = 'crestclip-analytics-consent';

/** EU, EEA, UK and Switzerland: no analytics cookies until the visitor accepts. */
const CONSENT_REGIONS = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
  'IS',
  'LI',
  'NO',
  'GB',
  'CH',
];

const ids = () => (typeof window === 'undefined' ? {} : (window.__CC_ANALYTICS__ ?? {}));
/** true when the server set at least one tracker */
export const analyticsEnabled = () => Boolean(ids().ga || ids().clarity);

export function storedConsent(): Consent | null {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    return v === 'granted' || v === 'denied' ? v : null;
  } catch {
    return null;
  }
}

function loadScript(src: string) {
  const s = document.createElement('script');
  s.async = true;
  s.src = src;
  document.head.appendChild(s);
}

let started = false;

/** Load the trackers once, as early as possible. */
export function initAnalytics() {
  if (started || !analyticsEnabled()) return;
  started = true;
  const { ga, clarity } = ids();
  const choice = storedConsent();

  if (ga) {
    window.dataLayer = window.dataLayer || [];
    // gtag must push the `arguments` object itself (not an array) — that's what Google's script reads
    window.gtag = function gtag() {
      // eslint-disable-next-line prefer-rest-params
      window.dataLayer!.push(arguments);
    };
    const ads = { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' };
    window.gtag('consent', 'default', { ...ads, analytics_storage: 'denied', region: CONSENT_REGIONS, wait_for_update: 500 });
    window.gtag('consent', 'default', { ...ads, analytics_storage: 'granted' });
    if (choice) window.gtag('consent', 'update', { analytics_storage: choice });
    window.gtag('js', new Date());
    // page views — including moves between pages inside the app — are recorded by GA's "enhanced measurement"
    window.gtag('config', ga);
    loadScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ga)}`);
  }

  if (clarity) {
    const c = function clarityQueue() {
      // eslint-disable-next-line prefer-rest-params
      ((c as unknown as { q?: unknown[] }).q ??= []).push(arguments);
    };
    window.clarity = window.clarity || c;
    if (choice) window.clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: choice });
    loadScript(`https://www.clarity.ms/tag/${encodeURIComponent(clarity)}`);
  }

  // came back from "Continue with Google" as a brand-new account (the server adds ?joined=google)
  const url = new URL(window.location.href);
  if (url.searchParams.get('joined') === 'google') {
    track('sign_up', { method: 'google' });
    url.searchParams.delete('joined');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }
}

/** The visitor's answer on the cookie banner. */
export function setConsent(choice: Consent) {
  try {
    localStorage.setItem(CONSENT_KEY, choice);
  } catch {
    /* private window: the choice lasts for this visit */
  }
  window.gtag?.('consent', 'update', { analytics_storage: choice });
  window.clarity?.('consentv2', { ad_Storage: 'denied', analytics_Storage: choice });
}

/**
 * Tie visits to the signed-in account (by its random ID — never the email), so one person on phone and laptop
 * counts once, and add their plan so reports can be split by Free / Creator / Pro.
 */
export function identify(userId: string, plan: string) {
  window.gtag?.('set', { user_id: userId });
  window.gtag?.('set', 'user_properties', { plan });
  window.clarity?.('identify', userId);
  window.clarity?.('set', 'plan', plan);
}

/** Record something a person did (shows in GA4 → Reports → Engagement → Events, and as a Clarity filter). */
export function track(name: string, params: Record<string, string | number | boolean | undefined> = {}) {
  try {
    window.gtag?.('event', name, params);
    window.clarity?.('event', name);
  } catch {
    /* tracking must never break the app */
  }
}

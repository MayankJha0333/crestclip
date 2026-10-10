import type { FoundingCreatorOfferInfo, PlansInfo, SiteInfo } from './api';

/**
 * Data the server puts into the page (window.__CC_DATA__) so public pages show prices and business details on the
 * very first paint — no empty box that fills in a second later. The server's pre-built HTML uses the same data, so
 * the page React draws matches it exactly.
 */
export interface InitialData {
  plans?: PlansInfo;
  foundingCreatorOffer?: FoundingCreatorOfferInfo;
  site?: SiteInfo;
  /** each public page's title and description (the same ones the server writes into the page for Google) */
  pages?: Record<string, { title: string; description: string }>;
}

declare global {
  interface Window {
    __CC_DATA__?: InitialData;
  }
}

/** set by the server while it builds a page (entry-server.tsx) */
let serverData: InitialData | null = null;
export const setServerData = (d: InitialData | null) => {
  serverData = d;
};

const data = (): InitialData => (typeof window === 'undefined' ? (serverData ?? {}) : (window.__CC_DATA__ ?? {}));
export const initialPlans = () => data().plans ?? null;
export const initialFoundingCreatorOffer = () => data().foundingCreatorOffer ?? null;
export const initialSite = () => data().site ?? null;
export const pageMeta = (path: string) => data().pages?.[path.length > 1 ? path.replace(/\/+$/, '') : '/'] ?? null;

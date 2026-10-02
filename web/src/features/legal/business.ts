import { useEffect, useState } from 'react';
import { api, type SiteInfo } from '../../lib/api';

/**
 * Who runs CrestClip and the numbers the policy pages quote — from the server (.env BUSINESS_* / SUPPORT_* and the
 * app's own settings), so the pages always match the real business and how the app really works.
 */
export interface Business {
  /** null until loaded */
  site: SiteInfo | null;
  name: string;
  /** legal name (person or company) */
  owner: string;
  email: string | null;
  retentionDays: number;
  creditsPerClip: number;
  topupMonths: number;
  jurisdiction: string;
}

export function useBusiness(): Business {
  const [site, setSite] = useState<SiteInfo | null>(null);
  useEffect(() => {
    api
      .site()
      .then(setSite)
      .catch(() => {});
  }, []);
  const name = site?.name ?? 'CrestClip';
  return {
    site,
    name,
    owner: site?.legalName ?? name,
    email: site?.email ?? null,
    retentionDays: site?.retentionDays ?? 7,
    creditsPerClip: site?.creditsPerClip ?? 5,
    topupMonths: site?.topupValidMonths ?? 12,
    jurisdiction: site?.jurisdiction ?? 'the city where our business is registered',
  };
}

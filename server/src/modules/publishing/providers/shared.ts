import { config } from '../../../config.js';

export type Platform = 'youtube' | 'instagram';

/** OAuth tokens as stored (sealed) in the database. */
export interface Tokens {
  access: string;
  refresh?: string | null;
  expiresAt: number; // ms
}

export const platformName = (p: Platform) => (p === 'youtube' ? 'YouTube' : 'Instagram');

/** Where the platform sends people back after sign-in. Instagram only accepts https links. */
export const redirectUri = (p: Platform) => `${p === 'instagram' ? config.instagramRedirectBase : config.publicUrl}/api/connect/${p}/callback`;

/** True when the app keys for this platform are in .env. */
export const isConfigured = (p: Platform) =>
  p === 'youtube' ? Boolean(config.youtubeClientId && config.youtubeClientSecret) : Boolean(config.instagramAppId && config.instagramAppSecret);

/** fetch + JSON, throwing the platform's own error message on failure. */
export async function jsonFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(60_000) });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const b = body as { error?: { message?: string; error_user_msg?: string } | string; error_description?: string; error_message?: string };
    const msg =
      (typeof b?.error === 'object' && (b.error.error_user_msg || b.error.message)) || b?.error_description || b?.error_message || (typeof b?.error === 'string' ? b.error : '') || String(text).slice(0, 300);
    throw new Error(`${res.status}: ${msg}`);
  }
  return body as T;
}

import fs from 'node:fs';
import { config } from '../../../config.js';
import type { PostRow } from '../../../db/index.js';
import { jsonFetch, redirectUri, type Tokens } from './shared.js';

/**
 * Instagram (Reels): "Instagram API with Instagram Login" (professional accounts). Instagram has no scheduling
 * in its API, so CrestClip's scheduler publishes at the chosen time (CrestClip must be running).
 */

const IG_SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'];
const ig = (p: string) => `https://graph.instagram.com/${config.instagramApiVersion}${p}`;

export const instagram = {
  authUrl(state: string) {
    const q = new URLSearchParams({
      client_id: config.instagramAppId,
      redirect_uri: redirectUri('instagram'),
      response_type: 'code',
      scope: IG_SCOPES.join(','),
      state,
    });
    return `https://www.instagram.com/oauth/authorize?${q}`;
  },
  async exchange(code: string) {
    const short = await jsonFetch<{ access_token: string; user_id: number | string }>('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.instagramAppId, client_secret: config.instagramAppSecret, grant_type: 'authorization_code', redirect_uri: redirectUri('instagram'), code: code.replace(/#_$/, '') }),
    });
    // swap the 1-hour token for a 60-day one
    const long = await jsonFetch<{ access_token: string; expires_in: number }>(
      `https://graph.instagram.com/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: config.instagramAppSecret, access_token: short.access_token })}`,
    );
    const tokens: Tokens = { access: long.access_token, refresh: null, expiresAt: Date.now() + long.expires_in * 1000 };
    const me = await jsonFetch<{ user_id?: string; id: string; username: string; name?: string; profile_picture_url?: string; account_type?: string }>(
      `${ig('/me')}?${new URLSearchParams({ fields: 'user_id,username,name,profile_picture_url,account_type', access_token: tokens.access })}`,
    );
    return { tokens, accountId: String(me.user_id ?? me.id), name: me.name || me.username, handle: `@${me.username}`, avatar: me.profile_picture_url ?? null };
  },
  /** Long-lived tokens last 60 days and can be refreshed (after they're 24 h old). */
  async refresh(t: Tokens): Promise<Tokens> {
    const r = await jsonFetch<{ access_token: string; expires_in: number }>(
      `https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: t.access })}`,
    );
    return { access: r.access_token, refresh: null, expiresAt: Date.now() + r.expires_in * 1000 };
  },
  async revoke() {
    /* Instagram has no token-revoke endpoint; removing it here is enough (users can also remove the app in Instagram settings) */
  },
  /** Reel via resumable upload (no public video URL needed): container → upload bytes → wait → publish. */
  async publish(token: string, accountId: string, post: PostRow, file: string): Promise<{ id: string; url: string }> {
    const size = fs.statSync(file).size;
    const caption = (post.caption || '').slice(0, 2200);
    const container = await jsonFetch<{ id: string; uri?: string }>(ig(`/${accountId}/media`), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ media_type: 'REELS', upload_type: 'resumable', caption, share_to_feed: true }),
    });
    const uploadUri = container.uri ?? `https://rupload.facebook.com/ig-api-upload/${config.instagramApiVersion}/${container.id}`;
    const up = await fetch(uploadUri, {
      method: 'POST',
      headers: { authorization: `OAuth ${token}`, offset: '0', file_size: String(size), 'content-type': 'application/octet-stream' },
      body: fs.readFileSync(file),
      signal: AbortSignal.timeout(30 * 60_000),
    });
    if (!up.ok) throw new Error(`Instagram upload failed (${up.status}): ${(await up.text()).slice(0, 300)}`);
    // Instagram processes the video before it can be published
    const started = Date.now();
    for (;;) {
      const st = await jsonFetch<{ status_code?: string; status?: string }>(`${ig(`/${container.id}`)}?${new URLSearchParams({ fields: 'status_code,status', access_token: token })}`);
      if (st.status_code === 'FINISHED') break;
      if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error(`Instagram couldn’t process the video: ${st.status ?? st.status_code}`);
      if (Date.now() - started > 15 * 60_000) throw new Error('Instagram took too long to process the video. Try again later.');
      await new Promise((r) => setTimeout(r, 5000));
    }
    const pub = await jsonFetch<{ id: string }>(ig(`/${accountId}/media_publish`), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ creation_id: container.id }),
    });
    const info = await jsonFetch<{ permalink?: string }>(`${ig(`/${pub.id}`)}?${new URLSearchParams({ fields: 'permalink', access_token: token })}`).catch(() => ({ permalink: undefined }));
    return { id: pub.id, url: info.permalink ?? 'https://www.instagram.com/' };
  },
};

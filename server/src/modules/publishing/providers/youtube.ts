import fs from 'node:fs';
import { config } from '../../../config.js';
import type { PostRow } from '../../../db/index.js';
import { jsonFetch, redirectUri, type Tokens } from './shared.js';

/**
 * YouTube (Shorts): Google OAuth + YouTube Data API v3 (resumable upload). Scheduling uses YouTube's own
 * `publishAt`, so a scheduled Short goes live even if CrestClip is off.
 */

const YT_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];

export const youtube = {
  authUrl(state: string) {
    const q = new URLSearchParams({
      client_id: config.youtubeClientId,
      redirect_uri: redirectUri('youtube'),
      response_type: 'code',
      scope: YT_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent', // always return a refresh token
      include_granted_scopes: 'true',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  },
  async exchange(code: string) {
    const t = await jsonFetch<{ access_token: string; refresh_token?: string; expires_in: number }>('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: config.youtubeClientId, client_secret: config.youtubeClientSecret, redirect_uri: redirectUri('youtube'), grant_type: 'authorization_code' }),
    });
    const tokens: Tokens = { access: t.access_token, refresh: t.refresh_token ?? null, expiresAt: Date.now() + t.expires_in * 1000 };
    const me = await jsonFetch<{ items?: { id: string; snippet: { title: string; customUrl?: string; thumbnails?: { default?: { url: string } } } }[] }>(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
      { headers: { authorization: `Bearer ${tokens.access}` } },
    );
    const ch = me.items?.[0];
    if (!ch) throw new Error('This Google account has no YouTube channel yet. Create one on youtube.com, then connect again.');
    return { tokens, accountId: ch.id, name: ch.snippet.title, handle: ch.snippet.customUrl ?? null, avatar: ch.snippet.thumbnails?.default?.url ?? null };
  },
  async refresh(t: Tokens): Promise<Tokens> {
    if (!t.refresh) throw new Error('YouTube access expired — reconnect the account.');
    const r = await jsonFetch<{ access_token: string; expires_in: number }>('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.youtubeClientId, client_secret: config.youtubeClientSecret, refresh_token: t.refresh, grant_type: 'refresh_token' }),
    });
    return { ...t, access: r.access_token, expiresAt: Date.now() + r.expires_in * 1000 };
  },
  async revoke(t: Tokens) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refresh || t.access)}`, { method: 'POST' }).catch(() => {});
  },
  /** Resumable upload. Scheduled posts are uploaded right away as private with publishAt — YouTube makes them public on time. */
  async publish(token: string, post: PostRow, file: string): Promise<{ id: string; url: string; note?: string }> {
    const size = fs.statSync(file).size;
    const title = (post.title || 'New Short').slice(0, 100);
    const description = (post.caption || '').slice(0, 5000);
    const tags = [...description.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]).slice(0, 15);
    const scheduled = post.scheduledAt && post.scheduledAt > Date.now() + 60_000;
    const status: Record<string, unknown> = {
      privacyStatus: scheduled ? 'private' : post.privacy || 'public',
      selfDeclaredMadeForKids: false,
      ...(scheduled ? { publishAt: new Date(post.scheduledAt!).toISOString() } : {}),
    };
    const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': 'video/mp4',
        'x-upload-content-length': String(size),
      },
      body: JSON.stringify({ snippet: { title, description, tags, categoryId: '22' }, status }),
    });
    if (!init.ok) throw new Error(`YouTube refused the upload (${init.status}): ${(await init.text()).slice(0, 300)}`);
    const uploadUrl = init.headers.get('location');
    if (!uploadUrl) throw new Error('YouTube did not return an upload address');
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'video/mp4', 'content-length': String(size) },
      body: fs.readFileSync(file),
      signal: AbortSignal.timeout(30 * 60_000),
    });
    const body = (await put.json().catch(() => ({}))) as { id?: string; status?: { privacyStatus?: string }; error?: { message?: string } };
    if (!put.ok || !body.id) throw new Error(`YouTube upload failed (${put.status}): ${body.error?.message ?? 'no video id'}`);
    const lockedPrivate = !scheduled && (post.privacy || 'public') !== 'private' && body.status?.privacyStatus === 'private';
    return {
      id: body.id,
      url: `https://www.youtube.com/shorts/${body.id}`,
      note: lockedPrivate ? 'YouTube kept this video private: apps that haven’t passed YouTube’s API audit can only upload private videos.' : undefined,
    };
  },
};

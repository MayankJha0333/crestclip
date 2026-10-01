import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from './config.js';
import { clips, connections, posts, type ConnectionRow, type PostRow } from './db.js';

/**
 * Publishing connectors — post clips to YouTube (Shorts) and Instagram (Reels), now or on a schedule.
 *
 *  • YouTube:   Google OAuth + YouTube Data API v3 (resumable upload). Scheduling uses YouTube's own
 *               `publishAt`, so a scheduled Short goes live even if CrestClip is off.
 *  • Instagram: "Instagram API with Instagram Login" (professional accounts). Instagram has no scheduling
 *               in its API, so CrestClip's scheduler publishes at the chosen time (CrestClip must be running).
 *
 * Tokens are stored encrypted (AES-256-GCM) in the local database.
 */

// ---------------- token encryption ----------------
function key(): Buffer {
  if (config.secretKey) return crypto.createHash('sha256').update(config.secretKey).digest();
  const file = path.join(config.dataDir, 'secret.key');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}
interface Tokens {
  access: string;
  refresh?: string | null;
  expiresAt: number; // ms
}
export const seal = (t: Tokens) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(t), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
};
const open = (s: string): Tokens => {
  const [iv, tag, enc] = s.split('.').map((b) => Buffer.from(b, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString('utf8'));
};

// ---------------- helpers ----------------
type Platform = 'youtube' | 'instagram';
const redirectUri = (p: Platform) => `${p === 'instagram' ? config.instagramRedirectBase : config.publicUrl}/api/connect/${p}/callback`;
export const configured = (p: Platform) => (p === 'youtube' ? Boolean(config.youtubeClientId && config.youtubeClientSecret) : Boolean(config.instagramAppId && config.instagramAppSecret));

async function jsonFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
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

// pending OAuth "state" values (CSRF protection), 10 min lifetime
const states = new Map<string, { platform: Platform; at: number }>();
function newState(platform: Platform) {
  const s = crypto.randomBytes(16).toString('hex');
  states.set(s, { platform, at: Date.now() });
  for (const [k, v] of states) if (Date.now() - v.at > 600_000) states.delete(k);
  return s;
}

// ================= YouTube =================
const YT_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];

const youtube = {
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

// ================= Instagram =================
const IG_SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'];
const ig = (p: string) => `https://graph.instagram.com/${config.instagramApiVersion}${p}`;

const instagram = {
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

const providers = { youtube, instagram };

/** A fresh access token for this connection (refreshes and saves it when needed). */
async function accessToken(c: ConnectionRow): Promise<string> {
  let t = open(c.tokens);
  const soon = t.expiresAt - Date.now() < (c.platform === 'instagram' ? 7 * 86400_000 : 120_000);
  if (soon) {
    try {
      t = await providers[c.platform].refresh(t);
      connections.setTokens(c.id, seal(t));
    } catch (e) {
      if (t.expiresAt < Date.now()) throw new Error(`${c.platform === 'youtube' ? 'YouTube' : 'Instagram'} access expired — reconnect ${c.name ?? 'the account'}. (${(e as Error).message})`);
    }
  }
  return t.access;
}

// ---------------- publishing + scheduler ----------------
const running = new Set<string>();

export async function runPost(postId: string) {
  if (running.has(postId)) return;
  running.add(postId);
  try {
    const post = posts.get(postId);
    if (!post || post.status !== 'scheduled') return;
    const conn = connections.get(post.connectionId);
    const clip = clips.get(post.clipId);
    if (!conn) return posts.update(post.id, { status: 'failed', error: 'The account was disconnected.' });
    if (!clip?.filePath || !fs.existsSync(clip.filePath)) return posts.update(post.id, { status: 'failed', error: 'The clip isn’t rendered (or was deleted). Re-render it and try again.' });
    posts.update(post.id, { status: 'uploading', attempts: post.attempts + 1, error: null });
    const token = await accessToken(conn);
    const res: { id: string; url: string; note?: string } =
      conn.platform === 'youtube' ? await youtube.publish(token, post, clip.filePath) : await instagram.publish(token, conn.accountId, post, clip.filePath);
    // YouTube schedules are "published" to YouTube now and go live at publishAt; the UI shows them as scheduled until then
    posts.update(post.id, { status: 'published', remoteId: res.id, remoteUrl: res.url, error: res.note ?? null });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    console.warn(`[publish ${postId}]`, msg);
    posts.update(postId, { status: 'failed', error: friendly(msg) });
  } finally {
    running.delete(postId);
  }
}

function friendly(msg: string) {
  if (/quotaExceeded|uploadLimitExceeded/i.test(msg)) return 'YouTube’s daily upload limit for this app was reached. Try again tomorrow.';
  if (/insufficient|scope/i.test(msg)) return 'CrestClip doesn’t have upload permission for this account. Disconnect and connect it again.';
  if (/invalid_grant|expired|OAuthException/i.test(msg)) return `The account login expired — reconnect it. (${msg.slice(0, 160)})`;
  if (/application request limit|rate limit|too many/i.test(msg)) return 'The platform is rate-limiting posts right now. Try again in a little while.';
  return msg.slice(0, 400);
}

/** Every 30 s: publish anything that's due. Also resumes posts interrupted by a restart. */
export function startScheduler() {
  for (const p of posts.stuck()) posts.update(p.id, { status: 'scheduled', error: 'Restarted after an interruption' });
  const tick = () => {
    for (const p of posts.due()) runPost(p.id);
  };
  setTimeout(tick, 5000);
  setInterval(tick, 30_000).unref();
}

// ---------------- API ----------------
export function publicConnection(c: ConnectionRow) {
  let expiresAt: number | null = null;
  try {
    expiresAt = open(c.tokens).expiresAt;
  } catch {
    /* unreadable (key changed) */
  }
  return { id: c.id, platform: c.platform, name: c.name, handle: c.handle, avatar: c.avatar, connectedAt: c.createdAt, expiresAt };
}
export function publicPost(p: PostRow) {
  const c = connections.get(p.connectionId);
  const clip = clips.get(p.clipId);
  return {
    ...p,
    account: c ? { name: c.name, handle: c.handle, avatar: c.avatar } : null,
    clip: clip ? { id: clip.id, title: clip.title, projectId: clip.projectId, thumbUrl: clip.thumbPath ? `/media/${path.relative(config.dataDir, clip.thumbPath).split(path.sep).map(encodeURIComponent).join('/')}` : null } : null,
  };
}

export const publishRouter = Router();

publishRouter.get('/connections', (_req, res) => {
  res.json({
    accounts: connections.list().map(publicConnection),
    platforms: {
      youtube: { configured: configured('youtube'), redirectUri: redirectUri('youtube') },
      instagram: { configured: configured('instagram'), redirectUri: redirectUri('instagram'), needsHttps: !redirectUri('instagram').startsWith('https://') },
    },
  });
});

publishRouter.get('/connect/:platform/start', (req: Request, res: Response) => {
  const platform = req.params.platform as Platform;
  if (platform !== 'youtube' && platform !== 'instagram') return res.status(404).send('Unknown platform');
  if (!configured(platform)) return res.redirect(`${config.publicUrl}/app/accounts?error=${encodeURIComponent(`${platform === 'youtube' ? 'YouTube' : 'Instagram'} isn’t set up yet — add its app keys to .env (see the setup steps).`)}`);
  res.redirect(providers[platform].authUrl(newState(platform)));
});

publishRouter.get('/connect/:platform/callback', async (req: Request, res: Response) => {
  const platform = req.params.platform as Platform;
  const back = (q: Record<string, string>) => res.redirect(`${config.publicUrl}/app/accounts?${new URLSearchParams(q)}`);
  const state = String(req.query.state ?? '');
  const pending = states.get(state);
  states.delete(state);
  if (req.query.error) return back({ error: String(req.query.error_description ?? req.query.error_reason ?? req.query.error) });
  if (!pending || pending.platform !== platform) return back({ error: 'That sign-in link expired. Please try connecting again.' });
  try {
    const r = await providers[platform].exchange(String(req.query.code ?? ''));
    const c = connections.upsert({ platform, accountId: r.accountId, name: r.name, handle: r.handle, avatar: r.avatar, tokens: seal(r.tokens) });
    back({ connected: platform, name: c.name ?? '' });
  } catch (e) {
    back({ error: `Couldn’t connect: ${(e as Error).message}` });
  }
});

publishRouter.delete('/connections/:id', async (req, res) => {
  const c = connections.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  try {
    await providers[c.platform].revoke(open(c.tokens));
  } catch {
    /* best effort */
  }
  connections.remove(c.id);
  res.json({ ok: true });
});

const postBody = z.object({
  clipId: z.string(),
  targets: z
    .array(
      z.object({
        connectionId: z.string(),
        title: z.string().max(100).optional(),
        caption: z.string().max(5000).optional(),
        privacy: z.enum(['public', 'unlisted', 'private']).optional(),
      }),
    )
    .min(1),
  scheduledAt: z.number().int().nullable().optional(), // ms; null/omitted = now
});

publishRouter.post('/posts', (req, res) => {
  const b = postBody.safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: 'Choose at least one account.' });
  const clip = clips.get(b.data.clipId);
  if (!clip) return res.status(404).json({ error: 'Clip not found' });
  if (clip.status !== 'ready' || !clip.filePath) return res.status(409).json({ error: 'Wait for the clip to finish rendering first.' });
  const when = b.data.scheduledAt ?? null;
  if (when && when < Date.now() - 60_000) return res.status(400).json({ error: 'That time is in the past.' });
  const made: PostRow[] = [];
  for (const t of b.data.targets) {
    const c = connections.get(t.connectionId);
    if (!c) return res.status(400).json({ error: 'One of the accounts is no longer connected.' });
    made.push(
      posts.create({
        clipId: clip.id,
        connectionId: c.id,
        platform: c.platform,
        title: c.platform === 'youtube' ? (t.title ?? clip.title).slice(0, 100) : null,
        caption: t.caption ?? `${clip.description}\n\n${clip.hashtags.join(' ')}`.trim(),
        privacy: c.platform === 'youtube' ? (t.privacy ?? 'public') : null,
        scheduledAt: when,
      }),
    );
  }
  // "Post now", and YouTube schedules (YouTube holds them until publishAt), start right away
  for (const p of made) if (!p.scheduledAt || p.platform === 'youtube') runPost(p.id);
  res.status(201).json(made.map((p) => publicPost(posts.get(p.id)!)));
});

publishRouter.get('/posts', (req, res) => {
  const list = typeof req.query.clipId === 'string' ? posts.forClip(req.query.clipId) : posts.list();
  res.json(list.map(publicPost));
});

publishRouter.post('/posts/:id/retry', (req, res) => {
  const p = posts.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.status !== 'failed' && p.status !== 'canceled') return res.status(409).json({ error: 'Only failed or canceled posts can be retried.' });
  const keepTime = p.scheduledAt && p.scheduledAt > Date.now() + 60_000 ? p.scheduledAt : null;
  posts.update(p.id, { status: 'scheduled', error: null, scheduledAt: keepTime });
  if (!keepTime || p.platform === 'youtube') runPost(p.id);
  res.json(publicPost(posts.get(p.id)!));
});

publishRouter.post('/posts/:id/cancel', (req, res) => {
  const p = posts.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.status !== 'scheduled') return res.status(409).json({ error: p.platform === 'youtube' && p.status === 'published' ? 'Already on YouTube — change or delete it in YouTube Studio.' : 'This post already started.' });
  posts.update(p.id, { status: 'canceled' });
  res.json(publicPost(posts.get(p.id)!));
});

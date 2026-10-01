import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from '../../config.js';
import { clips, connections, posts, type ConnectionRow, type PostRow } from '../../db/index.js';
import { HttpError } from '../../lib/http.js';
import { open, seal } from '../../lib/secrets.js';
import type { CreatePosts } from './publishing.schemas.js';
import { instagram, isConfigured, platformName, providers, youtube, type Platform, type Tokens } from './providers/index.js';

/**
 * Publishing — post clips to YouTube (Shorts) and Instagram (Reels), now or on a schedule.
 * Account tokens are stored encrypted in the local database.
 */

// ---------------- connecting accounts (OAuth) ----------------
// pending OAuth "state" values (CSRF protection), 10 min lifetime
const states = new Map<string, { platform: Platform; at: number }>();
function newState(platform: Platform) {
  const s = crypto.randomBytes(16).toString('hex');
  states.set(s, { platform, at: Date.now() });
  for (const [k, v] of states) if (Date.now() - v.at > 600_000) states.delete(k);
  return s;
}

export const isPlatform = (p: string): p is Platform => p === 'youtube' || p === 'instagram';

/** The app's Settings page, where accounts are connected. */
const settingsPage = `${config.publicUrl}/app/settings`;
/** Settings, with the outcome of a connect attempt in the query. */
const settingsUrl = (q: Record<string, string>) => `${settingsPage}?${new URLSearchParams(q)}`;

/** Where to send the browser to start connecting an account. */
export function connectUrl(platform: Platform): string {
  if (!isConfigured(platform)) return `${settingsPage}?error=${encodeURIComponent(`${platformName(platform)} isn’t set up yet — add its app keys to .env (see the setup steps).`)}`;
  return providers[platform].authUrl(newState(platform));
}

/** The platform sent the person back: save the account. Returns where to send the browser next. */
export async function finishConnect(platform: Platform, query: Record<string, unknown>): Promise<string> {
  const state = String(query.state ?? '');
  const pending = states.get(state);
  states.delete(state);
  if (query.error) return settingsUrl({ error: String(query.error_description ?? query.error_reason ?? query.error) });
  if (!pending || pending.platform !== platform) return settingsUrl({ error: 'That sign-in link expired. Please try connecting again.' });
  try {
    const r = await providers[platform].exchange(String(query.code ?? ''));
    const c = connections.upsert({ platform, accountId: r.accountId, name: r.name, handle: r.handle, avatar: r.avatar, tokens: seal(r.tokens) });
    return settingsUrl({ connected: platform, name: c.name ?? '' });
  } catch (e) {
    return settingsUrl({ error: `Couldn’t connect: ${(e as Error).message}` });
  }
}

export async function disconnect(id: string) {
  const c = connections.get(id);
  if (!c) throw new HttpError(404, 'Not found');
  try {
    await providers[c.platform].revoke(open<Tokens>(c.tokens));
  } catch {
    /* best effort */
  }
  connections.remove(c.id);
}

/** A fresh access token for this connection (refreshes and saves it when needed). */
async function accessToken(c: ConnectionRow): Promise<string> {
  let t = open<Tokens>(c.tokens);
  const soon = t.expiresAt - Date.now() < (c.platform === 'instagram' ? 7 * 86400_000 : 120_000);
  if (soon) {
    try {
      t = await providers[c.platform].refresh(t);
      connections.setTokens(c.id, seal(t));
    } catch (e) {
      if (t.expiresAt < Date.now()) throw new Error(`${platformName(c.platform)} access expired — reconnect ${c.name ?? 'the account'}. (${(e as Error).message})`);
    }
  }
  return t.access;
}

/** When the token runs out, or null if it can't be read (the secret key changed). */
export function tokenExpiry(c: ConnectionRow): number | null {
  try {
    return open<Tokens>(c.tokens).expiresAt;
  } catch {
    return null;
  }
}

// ---------------- posting ----------------
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

/** "Post now" and YouTube schedules (YouTube holds them until publishAt) start right away; the scheduler does the rest. */
const startsNow = (p: Pick<PostRow, 'scheduledAt' | 'platform'>) => !p.scheduledAt || p.platform === 'youtube';

/** One post per chosen account. */
export function createPosts(r: CreatePosts): PostRow[] {
  const clip = clips.get(r.clipId);
  if (!clip) throw new HttpError(404, 'Clip not found');
  if (clip.status !== 'ready' || !clip.filePath) throw new HttpError(409, 'Wait for the clip to finish rendering first.');
  const when = r.scheduledAt ?? null;
  if (when && when < Date.now() - 60_000) throw new HttpError(400, 'That time is in the past.');
  const made: PostRow[] = [];
  for (const t of r.targets) {
    const c = connections.get(t.connectionId);
    if (!c) throw new HttpError(400, 'One of the accounts is no longer connected.');
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
  for (const p of made) if (startsNow(p)) runPost(p.id);
  return made.map((p) => posts.get(p.id)!);
}

export const listPosts = (clipId?: string) => (clipId !== undefined ? posts.forClip(clipId) : posts.list());

function getPost(id: string): PostRow {
  const p = posts.get(id);
  if (!p) throw new HttpError(404, 'Not found');
  return p;
}

export function retryPost(id: string): PostRow {
  const p = getPost(id);
  if (p.status !== 'failed' && p.status !== 'canceled') throw new HttpError(409, 'Only failed or canceled posts can be retried.');
  const keepTime = p.scheduledAt && p.scheduledAt > Date.now() + 60_000 ? p.scheduledAt : null;
  posts.update(p.id, { status: 'scheduled', error: null, scheduledAt: keepTime });
  if (startsNow({ scheduledAt: keepTime, platform: p.platform })) runPost(p.id);
  return posts.get(p.id)!;
}

export function cancelPost(id: string): PostRow {
  const p = getPost(id);
  if (p.status !== 'scheduled')
    throw new HttpError(409, p.platform === 'youtube' && p.status === 'published' ? 'Already on YouTube — change or delete it in YouTube Studio.' : 'This post already started.');
  posts.update(p.id, { status: 'canceled' });
  return posts.get(p.id)!;
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

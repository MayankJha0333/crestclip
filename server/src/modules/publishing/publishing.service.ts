import crypto from 'node:crypto';
import { config } from '../../config.js';
import { clips, connections, posts, projects, type ConnectionRow, type PostRow, type UserRow } from '../../db/index.js';
import { assertCanSchedule } from '../billing/billing.service.js';
import { ensureLocal } from '../../infra/cloudStore.js';
import { HttpError } from '../../lib/http.js';
import { open, seal, sign, verify } from '../../lib/secrets.js';
import type { CreatePosts } from './publishing.schemas.js';
import { instagram, isConfigured, platformName, providers, youtube, type Platform, type Tokens } from './providers/index.js';
import { putShared, takeShared } from '../../infra/shared.js';

/**
 * Publishing — post clips to YouTube (Shorts) and Instagram (Reels), now or on a schedule.
 * Account tokens are stored encrypted in the local database.
 */

// ---------------- connecting accounts (OAuth) ----------------
// pending OAuth "state" values (CSRF protection), 10 min lifetime — in Redis, so any app copy can finish the connect
async function newState(platform: Platform, userId: string) {
  const s = crypto.randomBytes(16).toString('hex');
  await putShared(`connect:${s}`, { platform, userId }, 600_000);
  return s;
}

export const isPlatform = (p: string): p is Platform => p === 'youtube' || p === 'instagram';

/** The app's Settings page, where accounts are connected. */
const settingsPage = `${config.publicUrl}/app/settings`;
/** Settings, with the outcome of a connect attempt in the query. */
const settingsUrl = (q: Record<string, string>) => `${settingsPage}?${new URLSearchParams(q)}`;

/** Where to send the browser to start connecting an account. */
export async function connectUrl(platform: Platform, user: UserRow): Promise<string> {
  if (!isConfigured(platform)) return `${settingsPage}?error=${encodeURIComponent(`${platformName(platform)} isn’t set up yet — add its app keys to .env (see the setup steps).`)}`;
  return providers[platform].authUrl(await newState(platform, user.id));
}

/** The platform sent the person back: save the account. Returns where to send the browser next. */
export async function finishConnect(platform: Platform, query: Record<string, unknown>): Promise<string> {
  const state = String(query.state ?? '');
  const pending = state ? await takeShared<{ platform: Platform; userId: string }>(`connect:${state}`) : null;
  if (query.error) return settingsUrl({ error: String(query.error_description ?? query.error_reason ?? query.error) });
  if (!pending || pending.platform !== platform) return settingsUrl({ error: 'That sign-in link expired. Please try connecting again.' });
  try {
    const r = await providers[platform].exchange(String(query.code ?? ''));
    const c = await connections.upsert({ userId: pending.userId, platform, accountId: r.accountId, name: r.name, handle: r.handle, avatar: r.avatar, tokens: seal(r.tokens) });
    return settingsUrl({ connected: platform, name: c.name ?? '' });
  } catch (e) {
    return settingsUrl({ error: `Couldn’t connect: ${(e as Error).message}` });
  }
}

/** A connected account the person owns (404 otherwise). */
async function ownConnection(id: string, user: UserRow): Promise<ConnectionRow> {
  const c = await connections.get(id);
  if (!c || c.userId !== user.id) throw new HttpError(404, 'Not found');
  return c;
}

export async function disconnect(id: string, user: UserRow) {
  const c = await ownConnection(id, user);
  try {
    await providers[c.platform].revoke(open<Tokens>(c.tokens));
  } catch {
    /* best effort */
  }
  await connections.remove(c.id);
}

/** A fresh access token for this connection (refreshes and saves it when needed). */
async function accessToken(c: ConnectionRow): Promise<string> {
  let t = open<Tokens>(c.tokens);
  const soon = t.expiresAt - Date.now() < (c.platform === 'instagram' ? 7 * 86400_000 : 120_000);
  if (soon) {
    try {
      t = await providers[c.platform].refresh(t);
      await connections.setTokens(c.id, seal(t));
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

/**
 * Instagram (with Instagram Login) can't take the video bytes directly — it downloads the video from a public link.
 * Each post gets its own signed link that works for 2 hours and only while that post is uploading.
 */
const LINK_HOURS = 2;
function videoLink(postId: string): string {
  if (!config.publicUrl.startsWith('https://'))
    throw new Error('Instagram downloads the clip from a public https link, so posting to Instagram only works when CrestClip runs on its real web address (PUBLIC_URL).');
  const exp = Date.now() + LINK_HOURS * 3600_000;
  return `${config.publicUrl}/v/${postId}/${exp}/${sign(`${postId}.${exp}`)}.mp4`;
}

/** The clip file behind a signed link, or null (bad signature, expired, or the post isn't uploading any more). */
export async function videoForLink(postId: string, exp: string, sig: string): Promise<string | null> {
  if (!verify(`${postId}.${exp}`, sig) || !(Number(exp) > Date.now())) return null;
  const post = await posts.get(postId);
  if (!post || post.status !== 'uploading') return null;
  const clip = await clips.get(post.clipId);
  return clip?.filePath && (await ensureLocal(clip.filePath)) ? clip.filePath : null;
}

export async function runPost(postId: string) {
  if (running.has(postId)) return;
  running.add(postId);
  try {
    const post = await posts.get(postId);
    if (!post || post.status !== 'scheduled') return;
    const conn = await connections.get(post.connectionId);
    const clip = await clips.get(post.clipId);
    if (!conn) return await posts.update(post.id, { status: 'failed', error: 'The account was disconnected.' });
    if (!clip?.filePath || !(await ensureLocal(clip.filePath)))
      return await posts.update(post.id, { status: 'failed', error: 'The clip isn’t rendered (or was deleted). Re-render it and try again.' });
    if (!(await posts.claim(post.id, post.attempts + 1))) return; // another process took it a moment ago
    const token = await accessToken(conn);
    const res: { id: string; url: string; note?: string } =
      conn.platform === 'youtube' ? await youtube.publish(token, post, clip.filePath) : await instagram.publish(token, conn.accountId, post, videoLink(post.id));
    // YouTube schedules are "published" to YouTube now and go live at publishAt; the UI shows them as scheduled until then
    await posts.update(post.id, { status: 'published', remoteId: res.id, remoteUrl: res.url, error: res.note ?? null });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    console.warn(`[publish ${postId}]`, msg);
    await posts.update(postId, { status: 'failed', error: friendly(msg) });
  } finally {
    running.delete(postId);
  }
}

function friendly(msg: string) {
  if (/video_url is required|Media download has failed|media_url/i.test(msg)) return 'Instagram couldn’t fetch the clip from CrestClip’s web address. Check that the clip still exists and that CrestClip runs on its public https address, then retry.';
  if (/quotaExceeded|uploadLimitExceeded/i.test(msg)) return 'YouTube’s daily upload limit for this app was reached. Try again tomorrow.';
  if (/insufficient|scope/i.test(msg)) return 'CrestClip doesn’t have upload permission for this account. Disconnect and connect it again.';
  if (/invalid_grant|expired|OAuthException/i.test(msg)) return `The account login expired — reconnect it. (${msg.slice(0, 160)})`;
  if (/application request limit|rate limit|too many/i.test(msg)) return 'The platform is rate-limiting posts right now. Try again in a little while.';
  return msg.slice(0, 400);
}

/** "Post now" and YouTube schedules (YouTube holds them until publishAt) start right away; the scheduler does the rest. */
const startsNow = (p: Pick<PostRow, 'scheduledAt' | 'platform'>) => !p.scheduledAt || p.platform === 'youtube';

/** One post per chosen account. */
export async function createPosts(r: CreatePosts, user: UserRow): Promise<PostRow[]> {
  const clip = await clips.get(r.clipId);
  if (!clip || (await projects.get(clip.projectId))?.userId !== user.id) throw new HttpError(404, 'Clip not found');
  if (clip.status !== 'ready' || !clip.filePath) throw new HttpError(409, 'Wait for the clip to finish rendering first.');
  const when = r.scheduledAt ?? null;
  if (when && when < Date.now() - 60_000) throw new HttpError(400, 'That time is in the past.');
  if (when && when > Date.now() + 5 * 60_000) assertCanSchedule(user);
  const made: PostRow[] = [];
  for (const t of r.targets) {
    const c = await connections.get(t.connectionId);
    if (!c || c.userId !== user.id) throw new HttpError(400, 'One of the accounts is no longer connected.');
    made.push(
      await posts.create({
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
  for (const p of made) if (startsNow(p)) void runPost(p.id);
  // posted by hand → an autopilot that has this clip won't post it again (loaded here to avoid an import loop)
  void import('../autopilot/autopilot.engine.js')
    .then((m) => m.clipPostedByHand(r.clipId))
    .catch((e) => console.warn('[posts] autopilot sync:', (e as Error).message));
  return (await Promise.all(made.map((p) => posts.get(p.id)))).filter((p): p is PostRow => Boolean(p));
}

/** Posts of one clip, or all of the person's posts. */
export async function listPosts(user: UserRow, clipId?: string) {
  if (clipId === undefined) return await posts.list(user.id);
  const clip = await clips.get(clipId);
  return clip && (await projects.get(clip.projectId))?.userId === user.id ? await posts.forClip(clipId) : [];
}

/** A post on a clip the person owns (404 otherwise). */
async function getPost(id: string, user: UserRow): Promise<PostRow> {
  const p = await posts.get(id);
  const clip = p && (await clips.get(p.clipId));
  if (!p || !clip || (await projects.get(clip.projectId))?.userId !== user.id) throw new HttpError(404, 'Not found');
  return p;
}

export async function retryPost(id: string, user: UserRow): Promise<PostRow> {
  const p = await getPost(id, user);
  if (p.status !== 'failed' && p.status !== 'canceled') throw new HttpError(409, 'Only failed or canceled posts can be retried.');
  if (p.status === 'canceled' && p.autopilotId) throw new HttpError(409, 'This clip was removed from the Autopilot. Post it again from its project instead.');
  const keepTime = p.scheduledAt && p.scheduledAt > Date.now() + 60_000 ? p.scheduledAt : null;
  await posts.update(p.id, { status: 'scheduled', error: null, scheduledAt: keepTime });
  if (startsNow({ scheduledAt: keepTime, platform: p.platform })) void runPost(p.id);
  return (await posts.get(p.id))!;
}

export async function cancelPost(id: string, user: UserRow): Promise<PostRow> {
  const p = await getPost(id, user);
  if (p.status !== 'scheduled')
    throw new HttpError(409, p.platform === 'youtube' && p.status === 'published' ? 'Already on YouTube — change or delete it in YouTube Studio.' : 'This post already started.');
  await posts.update(p.id, { status: 'canceled' });
  if (p.autopilotId) {
    // tell the Autopilot now, so its page stops showing this clip at that time (loaded here to avoid an import loop)
    const { postCanceled } = await import('../autopilot/autopilot.engine.js');
    await postCanceled(p).catch((e) => console.warn('[posts] autopilot sync:', (e as Error).message));
  }
  return (await posts.get(p.id))!;
}

/** Every 30 s: publish anything that's due. Also resumes posts interrupted by a restart. */
export function startScheduler() {
  const tick = () =>
    void posts
      .due()
      .then((due) => due.forEach((p) => void runPost(p.id)))
      .catch((e) => console.warn('[posts] scheduler:', (e as Error).message));
  // posts left half-uploaded by a process that stopped go back in line (checked now and every 10 minutes)
  const resume = () =>
    void (async () => {
      for (const p of await posts.stuck()) await posts.update(p.id, { status: 'scheduled', error: 'Restarted after an interruption' });
    })().catch((e) => console.warn('[posts] could not resume interrupted posts:', (e as Error).message));
  resume();
  setInterval(resume, 10 * 60_000).unref();
  setTimeout(tick, 5000);
  setInterval(tick, 30_000).unref();
}

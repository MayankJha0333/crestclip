import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { autopilots, connections, credits, posts, projects, sessions, users, type UserRow } from '../../db/index.js';
import { removeCloudFolder } from '../../infra/cloudStore.js';
import { HttpError } from '../../lib/http.js';
import { deleteAutopilot } from '../autopilot/autopilot.service.js';
import { purgeProject } from '../projects/retention.js';
import { disconnect } from '../publishing/publishing.service.js';

/**
 * "Delete my account" (Settings → Your account). Google and Meta both ask that people can remove their data
 * themselves; the public /data-deletion page explains it.
 *
 * Removed: Autopilots, projects (videos, clips, posts — here and in the cloud bucket), connected YouTube/Instagram
 * accounts (their access is also revoked with Google/Instagram), credits, uploaded logos and music, every log-in,
 * and the account. Kept: payment records, because tax law requires it (see the privacy policy).
 */
export async function deleteAccount(user: UserRow, typedEmail: string) {
  if (typedEmail.trim().toLowerCase() !== user.email.toLowerCase()) throw new HttpError(400, 'Type your email address exactly as shown to confirm.');
  if (user.plan !== 'free' && (user.dodoSubscriptionId || user.rzSubscriptionId) && !user.cancelAtPeriodEnd)
    throw new HttpError(409, 'Cancel your plan first (Plan & credits → Cancel plan), so you aren’t charged again. Then delete your account.');

  const mine = await projects.list(user.id);
  const kids = (await Promise.all(mine.filter((p) => p.sourceType === 'group').map((g) => projects.children(g.id)))).flat();
  if ([...mine, ...kids].some((p) => p.status === 'processing' || p.status === 'queued'))
    throw new HttpError(409, 'Some videos are still being clipped. Wait until they finish (or fail), then delete your account.');

  for (const ap of await autopilots.list(user.id)) await deleteAutopilot(ap.id, user);
  for (const p of mine) await purgeProject(p);
  for (const c of await connections.list(user.id)) await disconnect(c.id, user); // also revokes access with Google / Instagram
  await posts.removeAllFor(user.id);
  await credits.removeAllFor(user.id);
  const safe = user.id.replace(/[^\w-]/g, '');
  for (const dir of [path.join(config.dataDir, 'brand', safe), path.join(config.dataDir, 'music', 'uploads', safe)]) {
    fs.rmSync(dir, { recursive: true, force: true });
    await removeCloudFolder(dir).catch(() => {});
  }
  await sessions.removeAllFor(user.id);
  await users.remove(user.id);
  console.log(`[account] deleted account ${user.id}`);
}

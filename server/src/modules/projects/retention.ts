import fs from 'node:fs';
import { config } from '../../config.js';
import { clips, projects, type ProjectRow } from '../../db/index.js';
import { cloudOn, ensureLifecycleRule, inCloud, removeCloudFolder, saveToCloud } from '../../infra/cloudStore.js';
import { projectDir } from '../../lib/paths.js';

/**
 * Storage time: every project — its video, clips and work files, on this disk and in the cloud bucket — is deleted
 * RETENTION_DAYS (7) after it was made. A project is kept a little longer only while it's still being clipped or
 * something from it is still waiting to be posted.
 */

/** Delete a project (and the videos inside it) everywhere: database, data folder, cloud bucket. */
export async function purgeProject(p: ProjectRow) {
  const kids = p.sourceType === 'group' ? await projects.children(p.id) : [];
  for (const k of [...kids, p]) {
    await projects.remove(k.id); // its clips and their posts go with it
    fs.rmSync(projectDir(k.id), { recursive: true, force: true });
    await removeCloudFolder(projectDir(k.id), k.id);
  }
}

const busy = (p: ProjectRow) => p.status === 'processing' || p.status === 'queued';

/** Delete every project whose storage time is over. Returns how many were deleted. */
async function sweepExpired(at = Date.now()): Promise<number> {
  let n = 0;
  for (const p of await projects.expired(at)) {
    const kids = p.sourceType === 'group' ? await projects.children(p.id) : [];
    if (busy(p) || kids.some(busy) || (await projects.hasPendingPosts(p.id))) continue; // try again next hour
    try {
      await purgeProject(p);
      n++;
    } catch (e) {
      console.warn(`[storage] couldn't delete project ${p.id}:`, (e as Error).message);
    }
  }
  if (n) console.log(`[storage] deleted ${n} project${n > 1 ? 's' : ''} older than ${config.retentionDays} days`);
  return n;
}

/** Clips rendered before cloud storage was on (or while the bucket was unreachable) → copy them up now. */
async function backfillCloud() {
  if (!cloudOn()) return;
  let n = 0;
  for (const c of await clips.allReady()) {
    for (const f of [c.filePath, c.thumbPath]) {
      if (f && fs.existsSync(f) && !(await inCloud(f)) && (await saveToCloud(f))) n++;
    }
  }
  if (n) console.log(`[storage] copied ${n} older clip file${n > 1 ? 's' : ''} to gs://${config.gcsBucket}`);
}

export function startRetention() {
  if (cloudOn()) console.log(`  Clip storage: gs://${config.gcsBucket} · projects deleted after ${config.retentionDays} days`);
  else console.log(`  Clip storage: this disk only (set GCS_BUCKET to keep clips in the cloud) · projects deleted after ${config.retentionDays} days`);
  const run = () => void sweepExpired().catch((e) => console.warn('[storage] cleanup failed:', (e as Error).message));
  setTimeout(() => {
    run();
    void ensureLifecycleRule()
      .then(backfillCloud)
      .catch((e) => console.warn('[storage] cloud setup failed:', (e as Error).message));
  }, 30_000).unref();
  setInterval(run, 3600_000).unref();
}

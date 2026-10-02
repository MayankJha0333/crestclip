import fs from 'node:fs';
import path from 'node:path';
import { Storage, type LifecycleRule } from '@google-cloud/storage';
import { config } from '../config.js';

/**
 * Rendered clips are also kept in your Google Cloud Storage bucket (GCS_BUCKET), under crestclip/media/… with the
 * same path they have in the data folder. The local file is a working copy: when it's missing (a new server, a wiped
 * disk), it is fetched back from the bucket on first use. Auth = the same Google login Gemini uses.
 */

let storage: Storage | null = null;
export function gcs(): Storage {
  storage ??= new Storage({ projectId: config.gcpProject || undefined });
  return storage;
}
const bucket = () => gcs().bucket(config.gcsBucket);

/** Clips go to the bucket when one is set (CLOUD_CLIPS=false turns it off). */
export const cloudOn = () => Boolean(config.gcsBucket) && config.cloudClips;

const ROOT = 'crestclip/';
const MEDIA = `${ROOT}media/`;

/** Only files inside the data folder have a cloud copy. */
function keyFor(abs: string): string | null {
  const rel = path.relative(config.dataDir, path.resolve(abs));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return MEDIA + rel.split(path.sep).join('/');
}

const quiet = (what: string, e: unknown) => console.warn(`[cloud] ${what}:`, (e as Error).message ?? e);

/** Copy a local file to the bucket. Never throws — the local file still works if this fails. */
export async function saveToCloud(abs: string | null | undefined): Promise<boolean> {
  const key = abs && keyFor(abs);
  if (!cloudOn() || !key || !fs.existsSync(abs)) return false;
  try {
    const size = fs.statSync(abs).size;
    await bucket().upload(abs, { destination: key, resumable: size > 8 * 1024 * 1024, metadata: { cacheControl: 'private, max-age=3600' } });
    return true;
  } catch (e) {
    quiet(`couldn't upload ${key}`, e);
    return false;
  }
}

/** Bring a file back from the bucket when the local copy is missing. True when it's there now. */
export async function fetchFromCloud(abs: string): Promise<boolean> {
  if (fs.existsSync(abs)) return true;
  const key = keyFor(abs);
  if (!cloudOn() || !key) return false;
  const tmp = `${abs}.part${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await bucket().file(key).download({ destination: tmp });
    fs.renameSync(tmp, abs);
    return true;
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    if ((e as { code?: number }).code !== 404) quiet(`couldn't download ${key}`, e);
    return false;
  }
}

/** The local path of a file, fetched from the bucket first if needed (null when it exists nowhere). */
export async function ensureLocal(abs: string | null | undefined): Promise<string | null> {
  if (!abs) return null;
  return (await fetchFromCloud(abs)) ? abs : null;
}

/** Is there a cloud copy? */
export async function inCloud(abs: string): Promise<boolean> {
  const key = keyFor(abs);
  if (!cloudOn() || !key) return false;
  try {
    return (await bucket().file(key).exists())[0];
  } catch {
    return false;
  }
}

export async function removeFromCloud(abs: string | null | undefined) {
  const key = abs && keyFor(abs);
  if (!cloudOn() || !key) return;
  await bucket()
    .file(key)
    .delete({ ignoreNotFound: true })
    .catch((e) => quiet(`couldn't delete ${key}`, e));
}

/** Delete everything stored for a folder (e.g. a project), plus the temporary Gemini preview of that project. */
export async function removeCloudFolder(absDir: string, projectId?: string) {
  const key = keyFor(absDir);
  if (!config.gcsBucket || !key) return;
  const prefixes = [`${key}/`, ...(projectId ? [`${ROOT}tmp/${projectId}/`, `${ROOT}${projectId}/`] : [])];
  for (const prefix of prefixes)
    await bucket()
      .deleteFiles({ prefix, force: true })
      .catch((e) => quiet(`couldn't delete ${prefix}`, e));
}

/**
 * Safety net in the bucket itself: anything CrestClip stored is deleted by Google a day after the storage time,
 * even if this app is off. Only touches files under crestclip/ — other rules and files in the bucket stay as they are.
 */
export async function ensureLifecycleRule() {
  if (!cloudOn()) return;
  const age = config.retentionDays + 1;
  try {
    const [meta] = await bucket().getMetadata();
    const rules = (meta.lifecycle?.rule ?? []) as LifecycleRule[];
    // a bucket-wide "delete after N days" rule shorter than the storage time would delete clips too early
    const early = rules.find((r) => r.action?.type === 'Delete' && !r.condition?.matchesPrefix?.length && !r.condition?.matchesSuffix?.length && (r.condition?.age ?? Infinity) < config.retentionDays);
    if (early)
      console.warn(
        `[cloud] bucket ${config.gcsBucket} has a rule that deletes EVERY file after ${early.condition?.age} day(s) — clips in the bucket won't last ${config.retentionDays} days. Limit that rule to the prefix ${ROOT}tmp/ (temporary Gemini previews) in the Cloud console → bucket → Lifecycle.`,
      );
    const ours = (r: LifecycleRule) => r.action?.type === 'Delete' && r.condition?.matchesPrefix?.length === 1 && r.condition.matchesPrefix[0] === ROOT;
    if (rules.some((r) => ours(r) && r.condition?.age === age)) return;
    const rule: LifecycleRule = { action: { type: 'Delete' }, condition: { age, matchesPrefix: [ROOT] } };
    await bucket().setMetadata({ lifecycle: { rule: [...rules.filter((r) => !ours(r)), rule] } });
    console.log(`[cloud] bucket ${config.gcsBucket}: files under ${ROOT} are now deleted after ${age} days`);
  } catch (e) {
    quiet(`couldn't set the auto-delete rule on bucket ${config.gcsBucket} (CrestClip still deletes its files itself)`, e);
  }
}

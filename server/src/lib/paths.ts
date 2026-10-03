import path from 'node:path';
import { config } from '../config.js';

/** Where a project's files live (source video, work files, rendered clips). */
export const projectDir = (id: string) => path.join(config.dataDir, 'projects', id);

/** Where multer puts incoming files before they're moved to their project / the music library. */
export const uploadTmpDir = path.join(config.dataDir, 'uploads');

/**
 * A stored file path, made to point into this computer's data folder. Rows written on another computer (for example
 * projects made on a Mac, then served from the cloud server) keep that computer's absolute path — the part after its
 * own data folder is the same here, so it's re-based. Paths already inside this data folder pass through unchanged.
 */
export function inDataDir(stored: string | null): string | null {
  if (!stored) return stored;
  const rel = path.relative(config.dataDir, stored);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return stored;
  const parts = stored.split(/[\\/]+/);
  const top = ['projects', 'brand', 'music', 'uploads'];
  const afterData = parts.findIndex((p, i) => i > 0 && parts[i - 1] === 'data' && top.includes(p));
  const at = afterData > 0 ? afterData : parts.findIndex((p) => top.includes(p));
  return at > 0 ? path.join(config.dataDir, ...parts.slice(at)) : stored;
}

/** A file inside the data folder → its URL under /media (null stays null). */
export const toMediaUrl = (abs: string | null) => (abs ? '/media/' + path.relative(config.dataDir, abs).split(path.sep).map(encodeURIComponent).join('/') : null);

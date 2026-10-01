import path from 'node:path';
import { config } from '../config.js';

/** Where a project's files live (source video, work files, rendered clips). */
export const projectDir = (id: string) => path.join(config.dataDir, 'projects', id);

/** Where multer puts incoming files before they're moved to their project / the music library. */
export const uploadTmpDir = path.join(config.dataDir, 'uploads');

/** A file inside the data folder → its URL under /media (null stays null). */
export const toMediaUrl = (abs: string | null) =>
  abs ? '/media/' + path.relative(config.dataDir, abs).split(path.sep).map(encodeURIComponent).join('/') : null;

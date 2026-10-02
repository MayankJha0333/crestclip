import fs from 'node:fs';
import { HttpError, toHttpError } from '../../lib/http.js';
import { addUpload, generateMood } from '../../pipeline/music.js';

export { removeUpload as removeMusicUpload } from '../../pipeline/music.js';

/** Make (or, with `fresh`, remake) the AI track for a mood. */
export async function makeMoodTrack(moodId: string, fresh: boolean) {
  await generateMood(moodId, fresh).catch(toHttpError(502));
}

/** Add an uploaded audio file to the library. Returns the new track's id. */
export async function addMusicUpload(userId: string, file: { path: string; originalname: string }): Promise<string> {
  try {
    return (await addUpload(userId, file.path, file.originalname)).id;
  } catch {
    fs.rmSync(file.path, { force: true });
    throw new HttpError(400, 'That file doesn’t look like audio CrestClip can read.');
  }
}

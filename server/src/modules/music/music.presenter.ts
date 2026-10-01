import { config } from '../../config.js';
import { toMediaUrl } from '../../lib/paths.js';
import { lyriaStatus, musicLibrary } from '../../pipeline/music.js';

/** The background-music library: mood tracks, the person's uploads, and whether AI music can be made. */
export function publicMusic() {
  const lib = musicLibrary();
  return {
    moods: lib.moods.map((m) => ({ id: m.id, label: m.label, hint: m.hint, ready: m.ready, url: toMediaUrl(m.file) })),
    uploads: lib.uploads.map((u) => ({ id: u.id, name: u.name, url: toMediaUrl(u.file) })),
    ai: { available: !config.fakeAi && Boolean(config.gcpProject || config.vertexApiKey), fake: config.fakeAi, ...lyriaStatus },
  };
}

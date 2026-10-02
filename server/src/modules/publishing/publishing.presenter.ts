import { clips, connections, type ConnectionRow, type PostRow, type UserRow } from '../../db/index.js';
import { toMediaUrl } from '../../lib/paths.js';
import { isConfigured, redirectUri } from './providers/index.js';
import { tokenExpiry } from './publishing.service.js';

function publicConnection(c: ConnectionRow) {
  return { id: c.id, platform: c.platform, name: c.name, handle: c.handle, avatar: c.avatar, connectedAt: c.createdAt, expiresAt: tokenExpiry(c) };
}

/** Connected accounts + whether each platform is set up (and the return link to register with it). */
export function publicConnections(user: UserRow) {
  return {
    accounts: connections.list(user.id).map(publicConnection),
    platforms: {
      youtube: { configured: isConfigured('youtube'), redirectUri: redirectUri('youtube') },
      instagram: { configured: isConfigured('instagram'), redirectUri: redirectUri('instagram'), needsHttps: !redirectUri('instagram').startsWith('https://') },
    },
  };
}

export function publicPost(p: PostRow) {
  const c = connections.get(p.connectionId);
  const clip = clips.get(p.clipId);
  return {
    ...p,
    account: c ? { name: c.name, handle: c.handle, avatar: c.avatar } : null,
    clip: clip ? { id: clip.id, title: clip.title, projectId: clip.projectId, thumbUrl: toMediaUrl(clip.thumbPath) } : null,
  };
}

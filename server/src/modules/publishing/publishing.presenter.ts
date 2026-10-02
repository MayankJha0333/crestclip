import { clips, connections, type ConnectionRow, type PostRow, type UserRow } from '../../db/index.js';
import { toMediaUrl } from '../../lib/paths.js';
import { isConfigured, redirectUri } from './providers/index.js';
import { tokenExpiry } from './publishing.service.js';

function publicConnection(c: ConnectionRow) {
  return { id: c.id, platform: c.platform, name: c.name, handle: c.handle, avatar: c.avatar, connectedAt: c.createdAt, expiresAt: tokenExpiry(c) };
}

/** Connected accounts + whether each platform is set up (and the return link to register with it). */
export async function publicConnections(user: UserRow) {
  return {
    accounts: (await connections.list(user.id)).map(publicConnection),
    platforms: {
      youtube: { configured: isConfigured('youtube'), redirectUri: redirectUri('youtube') },
      instagram: { configured: isConfigured('instagram'), redirectUri: redirectUri('instagram'), needsHttps: !redirectUri('instagram').startsWith('https://') },
    },
  };
}

/** Posts as the app shows them, with their account and clip (each looked up once for the whole list). */
export async function publicPosts(list: PostRow[]) {
  const [accounts, clipRows] = await Promise.all([connections.getMany(list.map((p) => p.connectionId)), clips.getMany(list.map((p) => p.clipId))]);
  const account = new Map(accounts.map((c) => [c.id, c]));
  const clip = new Map(clipRows.map((c) => [c.id, c]));
  return list.map(({ userId: _u, projectId: _p, ...p }) => {
    const c = account.get(p.connectionId);
    const k = clip.get(p.clipId);
    return {
      ...p,
      account: c ? { name: c.name, handle: c.handle, avatar: c.avatar } : null,
      clip: k ? { id: k.id, title: k.title, projectId: k.projectId, thumbUrl: toMediaUrl(k.thumbPath) } : null,
    };
  });
}

export const publicPost = async (p: PostRow) => (await publicPosts([p]))[0];

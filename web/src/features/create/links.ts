/** Recognise what kind of link was pasted, so the form can say what will happen. (Mirrors server/src/pipeline/filelink.ts.) */
export type LinkKind = 'youtube' | 'twitch' | 'gdrive' | 'dropbox' | 'onedrive' | 'direct' | 'site';
export interface LinkInfo {
  kind: LinkKind;
  label: string;
  hint: string;
  error?: string;
}

const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|mpe?g|ts|mts|m2ts|wmv|flv|3gp)$/i;

export function detectLink(raw: string): LinkInfo | null {
  const s = raw.trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (!u.hostname.includes('.')) return null;
  const host = u.hostname.replace(/^www\./, '');
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(host)) return { kind: 'youtube', label: 'YouTube', hint: 'Uses the “Most replayed” graph · long videos download only the parts that become clips' };
  if (/(^|\.)twitch\.tv$/.test(host)) return { kind: 'twitch', label: 'Twitch', hint: 'Past broadcasts, highlights and clips work · live streams can be clipped after they end' };
  if (host === 'drive.google.com' || host === 'docs.google.com' || host === 'drive.usercontent.google.com') {
    if (/\/folders\//.test(u.pathname)) return { kind: 'gdrive', label: 'Google Drive', hint: '', error: 'That’s a folder — open the video and copy the link of the file itself.' };
    if (/\/(document|spreadsheets|presentation|forms)\//.test(u.pathname)) return { kind: 'gdrive', label: 'Google Drive', hint: '', error: 'That Google link isn’t a video file.' };
    return { kind: 'gdrive', label: 'Google Drive', hint: 'Make sure sharing is set to “Anyone with the link”' };
  }
  if (host === 'dropbox.com' || host === 'dl.dropboxusercontent.com') return { kind: 'dropbox', label: 'Dropbox', hint: 'Use the share link of the video file (not a folder)' };
  if (host === '1drv.ms' || host === 'onedrive.live.com' || host.endsWith('.sharepoint.com')) return { kind: 'onedrive', label: 'OneDrive', hint: 'Sharing must allow “Anyone with the link” to view' };
  if (VIDEO_EXT.test(u.pathname)) return { kind: 'direct', label: 'Video file', hint: 'Downloaded straight from the link' };
  return { kind: 'site', label: host, hint: 'Works with 1,000+ video sites (Vimeo, TikTok, X, Instagram…)' };
}

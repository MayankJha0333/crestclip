import { config } from '../config.js';
import { publicFetch } from '../lib/net.js';

/**
 * Google Drive FOLDERS: list everything inside a publicly shared folder (and its subfolders), sort the files into
 * videos / written briefs / images, and read the briefs as text.
 *
 * With GOOGLE_DRIVE_API_KEY set, the official Drive API is used (also gives sizes and video lengths).
 * Without it, the folder's public "embedded view" page is read — no key or sign-in needed.
 * Either way the folder must be shared with "Anyone with the link".
 */

export type DriveKind = 'video' | 'doc' | 'image' | 'other';
export interface DriveEntry {
  id: string;
  name: string;
  mimeType: string;
  kind: DriveKind;
  /** subfolder path inside the shared folder, e.g. "Creator Studio" ('' = top level) */
  folder: string;
  size: number | null;
  /** video length in seconds (API only) */
  seconds: number | null;
}
export interface DriveFolder {
  id: string;
  name: string;
  files: DriveEntry[];
  /** true when the listing stopped early (too many files or subfolders) */
  truncated: boolean;
}

const MAX_DEPTH = 4;
const MAX_FOLDERS = 40;
const MAX_FILES = 400;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|mpe?g|mts|m2ts|wmv|flv|3gp)$/i;
const TEXT_EXT = /\.(txt|md|markdown|csv|rtf)$/i;
const DOC_MIME = /^(application\/vnd\.google-apps\.(document|spreadsheet)|application\/pdf|text\/)/;

/** The folder id in a Drive folder link, or null when it isn't one. */
export function driveFolderId(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.hostname.replace(/^www\./, '') !== 'drive.google.com') return null;
  // drive.google.com/drive/folders/ID, …/drive/u/0/folders/ID, …/embeddedfolderview?id=ID
  const id = u.pathname.match(/\/folders\/([\w-]{10,})/)?.[1] ?? (u.pathname === '/embeddedfolderview' ? u.searchParams.get('id') : null);
  return id && /^[\w-]{10,}$/.test(id) ? id : null;
}

export function kindOf(name: string, mimeType: string): DriveKind {
  if (mimeType.startsWith('video/') || VIDEO_EXT.test(name)) return 'video';
  if (DOC_MIME.test(mimeType) || TEXT_EXT.test(name) || /\.pdf$/i.test(name)) return 'doc';
  if (mimeType.startsWith('image/')) return 'image';
  return 'other';
}

const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const privateError = () => new Error('This Google Drive folder is private. In Drive, set sharing to “Anyone with the link”, then try again.');

// ---------- without a key: the public embedded view ----------

interface RawEntry {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
}

/** Parse one embedded-view page (exported for tests). */
export function parseEmbeddedView(html: string): { title: string; entries: RawEntry[] } {
  const title = decode(html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '').trim();
  const entries: RawEntry[] = [];
  for (const chunk of html.split('<div class="flip-entry" id="entry-').slice(1)) {
    const id = chunk.slice(0, chunk.indexOf('"'));
    const href = chunk.match(/<a href="([^"]+)"/)?.[1] ?? '';
    const icon = chunk.match(/flip-entry-list-icon"><img src="([^"]*)"/)?.[1] ?? '';
    const name = decode(chunk.match(/flip-entry-title">([^<]*)</)?.[1] ?? '').trim();
    if (!/^[\w-]{10,}$/.test(id) || !name) continue;
    const isFolder = /\/folders\//.test(href);
    // the list icon names the file type: …/type/video/quicktime
    const mimeType = isFolder ? 'application/vnd.google-apps.folder' : decodeURIComponent(icon.split('/type/')[1] ?? '');
    entries.push({ id, name, mimeType, isFolder });
  }
  return { title, entries };
}

async function readEmbeddedView(id: string) {
  const res = await publicFetch(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}`, { headers: { 'user-agent': UA } });
  if (res.status === 404) throw new Error('Google Drive says this folder doesn’t exist (or isn’t shared).');
  if (res.status === 401 || res.status === 403) throw privateError();
  if (/accounts\.google\.com/.test(res.url)) throw privateError(); // sent to the sign-in page
  if (!res.ok) throw new Error(`Couldn’t open the Google Drive folder (error ${res.status}).`);
  const html = await res.text();
  if (/accounts\.google\.com\/ServiceLogin|<form[^>]+signin/i.test(html) || (!html.includes('flip-entries') && /sign in/i.test(html))) throw privateError();
  return parseEmbeddedView(html);
}

// ---------- with GOOGLE_DRIVE_API_KEY: the Drive API ----------

interface ApiFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  videoMediaMetadata?: { durationMillis?: string };
  shortcutDetails?: { targetId: string; targetMimeType: string };
}

async function api<T>(path: string, params: Record<string, string>): Promise<T> {
  const q = new URLSearchParams({ ...params, key: config.driveApiKey, supportsAllDrives: 'true' });
  const res = await publicFetch(`https://www.googleapis.com/drive/v3/${path}?${q}`);
  if (res.status === 404) throw new Error('Google Drive says this folder doesn’t exist (or isn’t shared with “Anyone with the link”).');
  if (res.status === 403 || res.status === 401) {
    const body = await res.text();
    // a key problem is the server's to fix: log it and fall back to the public view
    if (/API key|has not been used|disabled|keyInvalid|accessNotConfigured/i.test(body)) throw new KeyProblem(body.slice(0, 300));
    throw privateError();
  }
  if (!res.ok) throw new Error(`Couldn’t open the Google Drive folder (error ${res.status}).`);
  return (await res.json()) as T;
}
class KeyProblem extends Error {}

async function apiList(id: string) {
  const out: ApiFile[] = [];
  let pageToken = '';
  do {
    const r = await api<{ files: ApiFile[]; nextPageToken?: string }>('files', {
      q: `'${id}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, videoMediaMetadata(durationMillis), shortcutDetails)',
      pageSize: '1000',
      includeItemsFromAllDrives: 'true',
      ...(pageToken ? { pageToken } : {}),
    });
    out.push(...r.files);
    pageToken = r.nextPageToken ?? '';
  } while (pageToken && out.length < MAX_FILES);
  return out;
}

// ---------- the walk ----------

/** List a shared folder and its subfolders (breadth-first, capped). */
export async function listDriveFolder(id: string): Promise<DriveFolder> {
  if (config.driveApiKey) {
    try {
      return await walkWithApi(id);
    } catch (e) {
      if (!(e instanceof KeyProblem)) throw e;
      console.warn('[drive] GOOGLE_DRIVE_API_KEY was refused, reading the public folder view instead:', e.message);
    }
  }
  return await walkEmbedded(id);
}

async function walkEmbedded(rootId: string): Promise<DriveFolder> {
  const root = await readEmbeddedView(rootId);
  const files: DriveEntry[] = [];
  const queue: { id: string; path: string; depth: number; entries?: RawEntry[] }[] = [{ id: rootId, path: '', depth: 0, entries: root.entries }];
  let folders = 0;
  let truncated = false;
  while (queue.length) {
    const f = queue.shift()!;
    const entries = f.entries ?? (await readEmbeddedView(f.id).catch(() => ({ entries: [] as RawEntry[] }))).entries;
    for (const e of entries) {
      if (e.isFolder) {
        if (f.depth + 1 > MAX_DEPTH || ++folders > MAX_FOLDERS) truncated = true;
        else queue.push({ id: e.id, path: f.path ? `${f.path}/${e.name}` : e.name, depth: f.depth + 1 });
        continue;
      }
      if (files.length >= MAX_FILES) {
        truncated = true;
        break;
      }
      files.push({ id: e.id, name: e.name, mimeType: e.mimeType, kind: kindOf(e.name, e.mimeType), folder: f.path, size: null, seconds: null });
    }
  }
  return { id: rootId, name: root.title.replace(/\s*-\s*Google Drive\s*$/i, '') || 'Google Drive folder', files, truncated };
}

async function walkWithApi(rootId: string): Promise<DriveFolder> {
  const meta = await api<{ name: string }>(`files/${encodeURIComponent(rootId)}`, { fields: 'name' });
  const files: DriveEntry[] = [];
  const queue = [{ id: rootId, path: '', depth: 0 }];
  let folders = 0;
  let truncated = false;
  while (queue.length) {
    const f = queue.shift()!;
    for (const raw of await apiList(f.id)) {
      const isShortcut = raw.mimeType === 'application/vnd.google-apps.shortcut' && raw.shortcutDetails;
      const mimeType = isShortcut ? raw.shortcutDetails!.targetMimeType : raw.mimeType;
      const fid = isShortcut ? raw.shortcutDetails!.targetId : raw.id;
      if (mimeType === 'application/vnd.google-apps.folder') {
        if (f.depth + 1 > MAX_DEPTH || ++folders > MAX_FOLDERS) truncated = true;
        else queue.push({ id: fid, path: f.path ? `${f.path}/${raw.name}` : raw.name, depth: f.depth + 1 });
        continue;
      }
      if (files.length >= MAX_FILES) {
        truncated = true;
        break;
      }
      const ms = Number(raw.videoMediaMetadata?.durationMillis);
      files.push({
        id: fid,
        name: raw.name,
        mimeType,
        kind: kindOf(raw.name, mimeType),
        folder: f.path,
        size: raw.size ? Number(raw.size) : null,
        seconds: Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : null,
      });
    }
  }
  return { id: rootId, name: meta.name || 'Google Drive folder', files, truncated };
}

/** A short cache, so the preview in New clips and pressing Go don't list the same folder twice. */
const cache = new Map<string, { at: number; folder: Promise<DriveFolder> }>();
export function listDriveFolderCached(id: string): Promise<DriveFolder> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 3 * 60_000) return hit.folder;
  const folder = listDriveFolder(id);
  cache.set(id, { at: Date.now(), folder });
  folder.catch(() => cache.delete(id));
  for (const [k, v] of cache) if (Date.now() - v.at > 10 * 60_000) cache.delete(k);
  return folder;
}

// ---------- reading the briefs ----------

export interface ReadDoc {
  file: DriveEntry;
  /** the text, for Google Docs / Sheets / plain text files */
  text?: string;
  /** the bytes, for PDFs (the AI reads them directly) */
  pdf?: Buffer;
}

const MAX_DOCS = 8;
const MAX_DOC_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 20_000;

async function fetchLimited(url: string): Promise<{ type: string; body: Buffer } | null> {
  const res = await publicFetch(url, { headers: { 'user-agent': UA } }).catch(() => null);
  if (!res?.ok || !res.body) return null;
  const type = res.headers.get('content-type') ?? '';
  if (Number(res.headers.get('content-length')) > MAX_DOC_BYTES) return null;
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_DOC_BYTES) return null;
  return { type, body };
}

/** Read up to 8 briefs (Google Docs, Sheets, PDFs, .txt/.md/.csv). Unreadable ones are skipped. */
export async function readDriveDocs(files: DriveEntry[]): Promise<ReadDoc[]> {
  const docs = files.filter((f) => f.kind === 'doc').slice(0, MAX_DOCS);
  const read = await Promise.all(
    docs.map(async (file): Promise<ReadDoc | null> => {
      const id = encodeURIComponent(file.id);
      if (file.mimeType === 'application/vnd.google-apps.document') {
        const r = await fetchLimited(`https://docs.google.com/document/d/${id}/export?format=txt`);
        return r && !/text\/html/.test(r.type) ? { file, text: r.body.toString('utf8').slice(0, MAX_TEXT) } : null;
      }
      if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
        const r = await fetchLimited(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv`);
        return r && !/text\/html/.test(r.type) ? { file, text: r.body.toString('utf8').slice(0, MAX_TEXT) } : null;
      }
      const r = await fetchLimited(`https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`);
      if (!r || /text\/html/.test(r.type)) return null;
      if (file.mimeType === 'application/pdf' || /\.pdf$/i.test(file.name)) return r.body.subarray(0, 5).toString() === '%PDF-' ? { file, pdf: r.body } : null;
      return { file, text: r.body.toString('utf8').slice(0, MAX_TEXT) };
    }),
  );
  return read.filter((d): d is ReadDoc => Boolean(d && (d.pdf || d.text?.trim())));
}

/** The link the normal Drive-file download understands. */
export const driveFileUrl = (id: string) => `https://drive.google.com/file/d/${id}/view`;

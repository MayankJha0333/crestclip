import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { config } from '../config.js';

/**
 * Links to a video FILE in cloud storage (not a video website):
 *   Google Drive · Dropbox · OneDrive · a direct .mp4/.mov/... link.
 * These are downloaded like an upload — one plain HTTP download, no yt-dlp — and then processed as a file.
 */

export type FileLinkKind = 'gdrive' | 'dropbox' | 'onedrive' | 'direct';
export interface FileLink {
  kind: FileLinkKind;
  url: string;
  id?: string;
}

const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|mpe?g|ts|mts|m2ts|wmv|flv|3gp)$/i;

export function classifyFileLink(raw: string): FileLink | { error: string } | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '');

  if (host === 'drive.google.com' || host === 'docs.google.com' || host === 'drive.usercontent.google.com') {
    if (/\/folders\//.test(u.pathname)) return { error: 'That’s a Google Drive folder. Open the video inside it and copy that file’s link.' };
    if (/\/(document|spreadsheets|presentation|forms)\//.test(u.pathname)) return { error: 'That Google link isn’t a video file. Share the video file itself.' };
    const id = u.pathname.match(/\/(?:file\/)?d\/([\w-]{10,})/)?.[1] ?? u.searchParams.get('id') ?? undefined;
    if (!id) return { error: 'Couldn’t find the file in that Google Drive link. Use “Share → Copy link” on the video file.' };
    return { kind: 'gdrive', url: raw, id };
  }
  if (host === 'dropbox.com' || host === 'dl.dropboxusercontent.com') {
    if (/\/(home|sh)\//.test(u.pathname) && !u.searchParams.get('rlkey')) return { error: 'That’s a Dropbox folder. Share the video file itself.' };
    return { kind: 'dropbox', url: raw };
  }
  if (host === '1drv.ms' || host === 'onedrive.live.com' || host.endsWith('.sharepoint.com')) return { kind: 'onedrive', url: raw };
  if (VIDEO_EXT.test(u.pathname)) return { kind: 'direct', url: raw };
  return null;
}

export const fileLinkLabel: Record<FileLinkKind, string> = {
  gdrive: 'Google Drive',
  dropbox: 'Dropbox',
  onedrive: 'OneDrive',
  direct: 'the link',
};

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Google Drive shows a "can't scan this file for viruses" page for big files — submit its form to get the file. */
export function driveConfirmUrl(html: string): string | null {
  const form = html.match(/<form[^>]*id="download-form"[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
  if (!form) return null;
  const params = new URLSearchParams();
  for (const m of form[2].matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
    const name = m[0].match(/name="([^"]+)"/)?.[1];
    const value = m[0].match(/value="([^"]*)"/)?.[1] ?? '';
    if (name) params.set(name, decode(value));
  }
  return `${decode(form[1])}${decode(form[1]).includes('?') ? '&' : '?'}${params}`;
}

function directUrl(link: FileLink): string {
  if (link.kind === 'gdrive') return `https://drive.usercontent.google.com/download?id=${link.id}&export=download&confirm=t`;
  if (link.kind === 'dropbox') {
    const u = new URL(link.url);
    u.searchParams.delete('dl');
    u.searchParams.set('dl', '1');
    return u.toString();
  }
  if (link.kind === 'onedrive') {
    const u = new URL(link.url);
    if (u.hostname.endsWith('.sharepoint.com')) {
      u.searchParams.set('download', '1');
      return u.toString();
    }
    // personal OneDrive: the documented "shares" API turns a share link into its file
    const enc = Buffer.from(link.url).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
    return `https://api.onedrive.com/v1.0/shares/u!${enc}/root/content`;
  }
  return link.url;
}

function fileNameFrom(res: Response, fallback: string) {
  const cd = res.headers.get('content-disposition') ?? '';
  const star = cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i)?.[1];
  const plain = cd.match(/filename="?([^";]+)"?/i)?.[1];
  let name = star ? decodeURIComponent(star.replace(/"/g, '')) : plain ?? '';
  if (!name) {
    try {
      name = decodeURIComponent(path.basename(new URL(res.url).pathname));
    } catch {
      /* ignore */
    }
  }
  return name && name !== 'download' && name !== 'content' ? name : fallback;
}

const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(0)} MB`);

/** Download the file into `dir`. Returns the saved path and the file's own name. */
export async function downloadFileLink(link: FileLink, dir: string, onProgress: (pct: number, detail: string) => void): Promise<{ file: string; name: string }> {
  const where = fileLinkLabel[link.kind];
  let res = await fetch(directUrl(link), { headers: { 'user-agent': UA }, redirect: 'follow' });

  // Google Drive: big files → confirmation page; private files → sign-in page
  if (link.kind === 'gdrive' && res.ok && /text\/html/i.test(res.headers.get('content-type') ?? '')) {
    const html = await res.text();
    const next = driveConfirmUrl(html);
    if (!next) {
      if (/accounts\.google\.com|ServiceLogin|You need access|Request access/i.test(html))
        throw new Error('This Google Drive file is private. In Drive, set sharing to “Anyone with the link”, then try again.');
      throw new Error('Google Drive didn’t send the video. Check the file is shared with “Anyone with the link”.');
    }
    res = await fetch(next, { headers: { 'user-agent': UA }, redirect: 'follow' });
  }

  if (res.status === 401 || res.status === 403)
    throw new Error(`${where} refused the download — make sure the file is shared publicly (“Anyone with the link”).`);
  if (res.status === 404) throw new Error(`${where} says this file doesn’t exist (or isn’t shared).`);
  if (!res.ok || !res.body) throw new Error(`Couldn’t download from ${where} (error ${res.status}).`);
  const type = res.headers.get('content-type') ?? '';
  if (/text\/html|application\/json/i.test(type)) throw new Error(`${where} sent a web page instead of a video. Check the link points to a video file shared with “Anyone with the link”.`);

  const total = Number(res.headers.get('content-length')) || 0;
  const limit = config.maxUploadMb * 1024 * 1024;
  if (total > limit) throw new Error(`This file is ${mb(total)} — the limit is ${config.maxUploadMb} MB.`);

  const name = fileNameFrom(res, 'video.mp4');
  const ext = (path.extname(name) || '.mp4').toLowerCase().slice(0, 6);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `source${ext}`);
  const tmp = `${out}.part`;

  let got = 0;
  let lastReport = 0;
  const started = Date.now();
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      got += chunk.length;
      if (got > limit) return cb(new Error(`This file is bigger than the ${config.maxUploadMb} MB limit.`));
      const now = Date.now();
      if (now - lastReport > 500) {
        lastReport = now;
        const speed = got / Math.max(0.5, (now - started) / 1000);
        onProgress(total ? (got / total) * 100 : 0, `${total ? `${Math.round((got / total) * 100)}% of ${mb(total)}` : mb(got)} · ${mb(speed)}/s`);
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), counter, fs.createWriteStream(tmp));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  if (got < 50_000) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`${where} sent an empty or tiny file — is the link right and shared publicly?`);
  }
  fs.renameSync(tmp, out);
  onProgress(100, `${mb(got)} downloaded`);
  return { file: out, name };
}

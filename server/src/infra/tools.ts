import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { run } from '../lib/proc.js';
import { hasLibass, resetFfmpegCache } from '../pipeline/media.js';
import { gunzipSync } from 'node:zlib';

/**
 * CrestClip manages its own video tools so nobody has to open a terminal:
 *
 *  • ffmpeg / ffprobe — shipped inside the app via npm (ffmpeg-static / ffprobe-static). These builds include
 *    libx264 + libass, so rendering and burned-in captions work on macOS, Linux and Windows out of the box.
 *  • yt-dlp — YouTube changes often, so a fixed version goes stale. CrestClip downloads the official standalone
 *    yt-dlp binary into data/bin, checks for updates every day, and updates immediately if a download fails.
 *
 * Anything set explicitly in .env (FFMPEG_PATH, FFPROBE_PATH, YTDLP_PATH) wins.
 */

const binDir = path.join(config.dataDir, 'bin');
const exe = process.platform === 'win32' ? '.exe' : '';
const log = (...a: unknown[]) => console.log('  [tools]', ...a);

// ---------------- ffmpeg / ffprobe ----------------
// Normally resolved in config.ts (bundled via npm). If npm skipped the download, or only a system ffmpeg without
// caption support is around, CrestClip fetches the same static build itself into data/bin.
export const ffmpegPath = () => config.ffmpeg;
export const ffmpegSource = () => config.ffmpegSource;

const FF_RELEASE = 'b6.1.1';
const ffPlatform = () => {
  const { platform, arch } = process;
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) return null;
  return `${platform}-${arch}`;
};
const managedFf = (name: 'ffmpeg' | 'ffprobe') => path.join(binDir, `${name}${exe}`);

export const ffStatus: { state: 'ready' | 'installing' | 'error'; detail: string } = { state: 'ready', detail: '' };

async function downloadFf(name: 'ffmpeg' | 'ffprobe') {
  const plat = ffPlatform();
  if (!plat) throw new Error(`No ${name} build for ${process.platform}/${process.arch}`);
  const res = await fetch(`https://github.com/eugeneware/ffmpeg-static/releases/download/${FF_RELEASE}/${name}-${plat}.gz`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  fs.mkdirSync(binDir, { recursive: true });
  const tmp = `${managedFf(name)}.download`;
  fs.writeFileSync(tmp, gunzipSync(Buffer.from(await res.arrayBuffer())));
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, managedFf(name));
}

function useManagedFf() {
  config.ffmpeg = managedFf('ffmpeg');
  if (fs.existsSync(managedFf('ffprobe'))) config.ffprobe = managedFf('ffprobe');
  config.ffmpegSource = 'built in';
  resetFfmpegCache();
}

let ffBusy: Promise<void> | null = null;
/** Make sure there's an ffmpeg that can burn in captions. Never throws. */
export function ensureFfmpeg(): Promise<void> {
  if (config.ffmpegSource !== 'system') return Promise.resolve(); // bundled or custom (.env) — respect it
  if (ffBusy) return ffBusy;
  ffBusy = (async () => {
    if (fs.existsSync(managedFf('ffmpeg'))) {
      useManagedFf();
      if (await hasLibass()) return;
    }
    try {
      ffStatus.state = 'installing';
      ffStatus.detail = 'Downloading the video engine (one time, ~40 MB)…';
      log('installing ffmpeg…');
      await downloadFf('ffmpeg');
      await downloadFf('ffprobe').catch(() => {}); // a system ffprobe is fine if this fails
      useManagedFf();
      ffStatus.state = (await hasLibass()) ? 'ready' : 'error';
      ffStatus.detail = ffStatus.state === 'ready' ? '' : 'The video engine was installed but can’t draw captions.';
    } catch (e) {
      ffStatus.state = 'error';
      ffStatus.detail = `Couldn’t download the video engine: ${(e as Error).message}. CrestClip will retry automatically.`;
    }
  })().finally(() => {
    ffBusy = null;
  });
  return ffBusy;
}

// ---------------- yt-dlp ----------------
function ytAsset(): string | null {
  const { platform, arch } = process;
  if (platform === 'darwin') return 'yt-dlp_macos';
  if (platform === 'win32') return arch === 'arm64' ? 'yt-dlp_arm64.exe' : 'yt-dlp.exe';
  if (platform === 'linux') return arch === 'arm64' ? 'yt-dlp_linux_aarch64' : arch === 'x64' ? 'yt-dlp_linux' : null;
  return null;
}

const managedYt = path.join(binDir, `yt-dlp${exe}`);
const stampFile = path.join(binDir, 'yt-dlp.checked');
const customYt = () => (process.env.YTDLP_PATH?.trim() && process.env.YTDLP_PATH.trim() !== 'yt-dlp' ? process.env.YTDLP_PATH.trim() : null);

type YtState = 'ready' | 'installing' | 'updating' | 'missing' | 'error';
export const ytStatus: { state: YtState; version: string | null; source: 'managed' | 'custom' | 'system' | null; detail: string; checkedAt: number | null } = {
  state: 'missing',
  version: null,
  source: null,
  detail: '',
  checkedAt: null,
};

/** Path to use right now. Falls back to a system yt-dlp while the managed one is being installed. */
export function ytdlpPath(): string {
  const c = customYt();
  if (c) return c;
  if (fs.existsSync(managedYt)) return managedYt;
  return 'yt-dlp';
}

async function version(bin: string): Promise<string | null> {
  try {
    return (await run(bin, ['--version'], { timeoutMs: 60_000 })).stdout.trim() || null;
  } catch {
    return null;
  }
}

async function downloadYt(): Promise<void> {
  const asset = ytAsset();
  if (!asset) throw new Error(`No yt-dlp build for ${process.platform}/${process.arch}`);
  fs.mkdirSync(binDir, { recursive: true });
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const tmp = `${managedYt}.download`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, managedYt);
}

let busy: Promise<void> | null = null;

/**
 * Make sure a working, up-to-date yt-dlp exists. `force` = check for an update now (e.g. after YouTube broke a download).
 * Never throws — status is reported through ytStatus.
 */
export function ensureYtdlp(force = false): Promise<void> {
  if (busy) return busy;
  busy = (async () => {
    const c = customYt();
    if (c) {
      ytStatus.source = 'custom';
      ytStatus.version = await version(c);
      ytStatus.state = ytStatus.version ? 'ready' : 'error';
      ytStatus.detail = ytStatus.version ? '' : `YTDLP_PATH (${c}) doesn’t run`;
      return;
    }
    try {
      if (!fs.existsSync(managedYt)) {
        ytStatus.state = 'installing';
        ytStatus.detail = 'Downloading the video downloader (one time, ~35 MB)…';
        log('installing yt-dlp…');
        await downloadYt();
        fs.writeFileSync(stampFile, String(Date.now()));
      } else {
        const last = Number(fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8') : 0);
        if (force || Date.now() - last > 24 * 3600_000) {
          ytStatus.state = 'updating';
          ytStatus.detail = 'Checking for downloader updates…';
          const channel = (process.env.YTDLP_CHANNEL || 'stable').trim();
          const r = await run(managedYt, ['--update-to', channel], { timeoutMs: 180_000 }).catch((e: Error) => ({ stdout: '', stderr: e.message }));
          const out = `${r.stdout}\n${r.stderr}`;
          if (/Updated yt-dlp to/i.test(out)) log(out.match(/Updated yt-dlp to[^\n]*/i)?.[0]);
          // If self-update isn't possible (e.g. read-only), re-download the latest build instead.
          if (/ERROR/i.test(out) && !/is up to date/i.test(out)) await downloadYt().catch(() => {});
          fs.writeFileSync(stampFile, String(Date.now()));
        }
      }
      ytStatus.source = 'managed';
      // The first run of the one-file build unpacks itself and can be slow or cut off by a quick restart — try twice.
      ytStatus.version = (await version(managedYt)) ?? (await new Promise((r) => setTimeout(r, 3000)).then(() => version(managedYt)));
      ytStatus.state = ytStatus.version ? 'ready' : 'error';
      ytStatus.detail = ytStatus.version ? '' : 'The downloader was installed but doesn’t run on this computer.';
    } catch (e) {
      // No internet / GitHub blocked — use a system yt-dlp if there is one.
      const sys = await version('yt-dlp');
      ytStatus.source = sys ? 'system' : null;
      ytStatus.version = sys;
      ytStatus.state = sys ? 'ready' : 'error';
      ytStatus.detail = sys ? '' : `Couldn’t download the video downloader: ${(e as Error).message}. Check the internet connection — CrestClip will retry automatically.`;
    } finally {
      ytStatus.checkedAt = Date.now();
    }
  })().finally(() => {
    busy = null;
  });
  return busy;
}

/** Start-up + daily upkeep. */
export function startToolUpkeep() {
  ensureFfmpeg().then(() => log(`ffmpeg: ${ffmpegSource()} → ${ffmpegPath()}`));
  ensureYtdlp().then(() => ytStatus.version && log(`yt-dlp ${ytStatus.version} (${ytStatus.source})`));
  const t = setInterval(() => {
    ensureYtdlp();
    if (ffStatus.state === 'error') ensureFfmpeg();
  }, 6 * 3600_000);
  t.unref();
}

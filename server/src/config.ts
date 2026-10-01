import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(here, '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

// Load ../.env (repo root) then server/.env — whichever exists. Real env vars always win.
for (const p of [path.join(REPO_ROOT, '.env'), path.join(SERVER_ROOT, '.env')]) {
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      const [, key, raw] = m;
      if (process.env[key] !== undefined) continue;
      process.env[key] = raw.replace(/^['"]|['"]$/g, '');
    }
  }
}

// A service-account key path in .env may be relative to the project folder.
if (process.env.GOOGLE_APPLICATION_CREDENTIALS === '') delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS && !path.isAbsolute(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(REPO_ROOT, process.env.GOOGLE_APPLICATION_CREDENTIALS);
}

// ffmpeg/ffprobe ship inside the app (npm ffmpeg-static / ffprobe-static — built with libx264 + libass for captions).
// A path set in .env wins; plain "ffmpeg"/"ffprobe" there means "use the default".
const requireCjs = createRequire(import.meta.url);
function bundledBin(pkg: string): string | null {
  try {
    const m = requireCjs(pkg) as string | { path?: string };
    const p = typeof m === 'string' ? m : m?.path;
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}
const customBin = (key: string, plain: string) => {
  const v = (process.env[key] ?? '').trim();
  return v && v !== plain ? v : '';
};

const env = (k: string, d = '') => (process.env[k] ?? d).trim();
const num = (k: string, d: number) => {
  const v = Number(env(k));
  return Number.isFinite(v) && env(k) !== '' ? v : d;
};

export const config = {
  port: num('PORT', 8787),
  /** Where people open CrestClip (used for OAuth redirect links). Dev = the Vite app; production = your domain. */
  publicUrl: env('PUBLIC_URL', 'http://localhost:5173').replace(/\/$/, ''),
  // Publishing connectors (OAuth apps you create — see README → "Post to YouTube & Instagram")
  youtubeClientId: env('YOUTUBE_CLIENT_ID'),
  youtubeClientSecret: env('YOUTUBE_CLIENT_SECRET'),
  instagramAppId: env('INSTAGRAM_APP_ID'),
  instagramAppSecret: env('INSTAGRAM_APP_SECRET'),
  instagramApiVersion: env('INSTAGRAM_API_VERSION', 'v25.0'),
  /**
   * Instagram only accepts https sign-in return links. In local dev (PUBLIC_URL is http) CrestClip also listens on
   * https://localhost:HTTPS_PORT with a self-made certificate, just for that return trip.
   */
  httpsPort: num('HTTPS_PORT', 8443),
  get localHttps() {
    return !this.publicUrl.startsWith('https://') && env('LOCAL_HTTPS', 'true') !== 'false';
  },
  get instagramRedirectBase() {
    return (env('INSTAGRAM_REDIRECT_BASE') || (this.publicUrl.startsWith('https://') ? this.publicUrl : `https://localhost:${this.httpsPort}`)).replace(/\/$/, '');
  },
  secretKey: env('SECRET_KEY'),
  dataDir: path.resolve(REPO_ROOT, env('DATA_DIR', 'data')),
  fontsDir: path.join(SERVER_ROOT, 'assets', 'fonts'),
  webDist: path.join(REPO_ROOT, 'web', 'dist'),

  // Google Cloud / Vertex AI (Gemini only)
  gcpProject: env('GOOGLE_CLOUD_PROJECT'),
  // Vertex AI API key (bound to a service account). Alternative to gcloud login / key files.
  vertexApiKey: env('VERTEX_API_KEY'),
  gcpLocation: env('GOOGLE_CLOUD_LOCATION', 'global'),
  model: env('GEMINI_MODEL', 'gemini-3.8-flash'),
  fastModel: env('GEMINI_FAST_MODEL', 'gemini-3.5-flash-lite'),
  gcsBucket: env('GCS_BUCKET'),
  sendVideoToGemini: env('GEMINI_SEND_VIDEO', 'true') !== 'false',
  fakeAi: (env('CRESTCLIP_FAKE_AI') || env('PEAKCLIP_FAKE_AI')) === '1', // old name still works

  // Tools
  ytdlp: env('YTDLP_PATH', 'yt-dlp'),
  ytdlpExtraArgs: env('YTDLP_EXTRA_ARGS', '--js-runtimes node').split(/\s+/).filter(Boolean),
  ytdlpCookies: env('YTDLP_COOKIES'),
  // Optional Twitch API app (dev.twitch.tv) — enables Twitch channel search + richer VOD/clip data in Explore
  twitchClientId: env('TWITCH_CLIENT_ID'),
  twitchClientSecret: env('TWITCH_CLIENT_SECRET'),

  ffmpeg: customBin('FFMPEG_PATH', 'ffmpeg') || bundledBin('ffmpeg-static') || 'ffmpeg',
  ffprobe: customBin('FFPROBE_PATH', 'ffprobe') || bundledBin('ffprobe-static') || 'ffprobe',
  ffmpegSource: customBin('FFMPEG_PATH', 'ffmpeg') ? 'custom' : bundledBin('ffmpeg-static') ? 'built in' : 'system',

  // Limits
  maxUploadMb: num('MAX_UPLOAD_MB', 4096),
  maxSourceMinutes: num('MAX_SOURCE_MINUTES', 240),
  // "smart" = for long links, download only the audio + the clip parts (not the whole video). "full" = old behaviour.
  downloadMode: env('DOWNLOAD_MODE', 'smart') === 'full' ? ('full' as const) : ('smart' as const),
  smartMinMinutes: num('SMART_DOWNLOAD_MIN_MINUTES', 8),
  // extra seconds kept around each clip part, so small trims in the editor don't need another download
  sectionPad: num('SECTION_PAD_SECONDS', 20),
  // Background music: Google's Lyria model on Vertex AI (same project/credits as Gemini)
  musicModel: env('MUSIC_MODEL', 'lyria-002'),
  musicLocation: env('MUSIC_LOCATION', 'us-central1'),
  jobConcurrency: num('JOB_CONCURRENCY', 1),
  renderConcurrency: num('RENDER_CONCURRENCY', 2),
  x264Preset: env('X264_PRESET', 'medium'),
};

export const aiReady = () => config.fakeAi || Boolean(config.gcpProject) || Boolean(config.vertexApiKey);

fs.mkdirSync(config.dataDir, { recursive: true });

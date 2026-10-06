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
/** The MongoDB connection string, with the user and password added when it has none. */
function mongoUri(uri: string, user: string, password: string) {
  if (!uri || !user || /^mongodb(\+srv)?:\/\/[^/]*@/.test(uri)) return uri;
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/)/, `$1${encodeURIComponent(user)}:${encodeURIComponent(password)}@`);
}

export const config = {
  port: num('PORT', 8787),
  /** Where people open CrestClip (used for OAuth redirect links). Dev = the Vite app; production = your domain. */
  publicUrl: env('PUBLIC_URL', 'http://localhost:5173').replace(/\/$/, ''),
  // Publishing connectors (OAuth apps you create — see README → "Post to YouTube & Instagram")
  youtubeClientId: env('YOUTUBE_CLIENT_ID'),
  youtubeClientSecret: env('YOUTUBE_CLIENT_SECRET'),
  /** Set YOUTUBE_AUDIT_PASSED=1 once Google's YouTube API audit is through: until then YouTube keeps every upload private, and the app says so. */
  youtubeAuditPassed: env('YOUTUBE_AUDIT_PASSED') === '1',
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

  // Accounts
  /** emails that are admins (comma-separated). The very first account is always an admin. */
  adminEmails: env('ADMIN_EMAILS')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  allowSignups: env('ALLOW_SIGNUPS', 'true') !== 'false',
  /** "Continue with Google": its own OAuth client, or the YouTube one (add the extra redirect URL to it — see README) */
  googleLoginClientId: env('GOOGLE_LOGIN_CLIENT_ID') || env('YOUTUBE_CLIENT_ID'),
  googleLoginClientSecret: env('GOOGLE_LOGIN_CLIENT_ID') ? env('GOOGLE_LOGIN_CLIENT_SECRET') : env('YOUTUBE_CLIENT_SECRET'),

  // Payments (Razorpay) — see README → "Plans, credits & payments"
  razorpayKeyId: env('RAZORPAY_KEY_ID'),
  razorpayKeySecret: env('RAZORPAY_KEY_SECRET'),
  razorpayWebhookSecret: env('RAZORPAY_WEBHOOK_SECRET'),
  razorpayPlanCreator: env('RAZORPAY_PLAN_CREATOR'),
  razorpayPlanPro: env('RAZORPAY_PLAN_PRO'),
  // Database (MongoDB) — e.g. an Atlas connection string. MONGODB_USERNAME / MONGODB_PASSWORD fill it in when the
  // string has no user in it.
  mongoUri: mongoUri(env('MONGODB_URI'), env('MONGODB_USERNAME'), env('MONGODB_PASSWORD')),
  mongoDb: env('MONGODB_DB', 'crestclip'),
  /** testing only: let pasted links point at this computer / the local network */
  allowPrivateLinks: env('ALLOW_PRIVATE_LINKS') === '1',
  dataDir: path.resolve(REPO_ROOT, env('DATA_DIR', 'data')),
  fontsDir: path.join(SERVER_ROOT, 'assets', 'fonts'),
  webDist: path.join(REPO_ROOT, 'web', 'dist'),

  // Google Cloud / Vertex AI (Gemini only)
  gcpProject: env('GOOGLE_CLOUD_PROJECT'),
  // Vertex AI API key (bound to a service account). Alternative to gcloud login / key files.
  vertexApiKey: env('VERTEX_API_KEY'),
  /** optional: Drive API key for reading shared Drive folders (without it, the public folder view is read) */
  driveApiKey: env('GOOGLE_DRIVE_API_KEY'),
  gcpLocation: env('GOOGLE_CLOUD_LOCATION', 'global'),
  model: env('GEMINI_MODEL', 'gemini-3.8-flash'),
  fastModel: env('GEMINI_FAST_MODEL', 'gemini-3.5-flash-lite'),
  gcsBucket: env('GCS_BUCKET'),
  /** keep a copy of every rendered clip in GCS_BUCKET (so clips survive a lost disk and can be served from the cloud) */
  cloudClips: env('CLOUD_CLIPS', 'true') !== 'false',
  /** projects (video, clips, files — here and in the bucket) are deleted this many days after they're made */
  retentionDays: num('RETENTION_DAYS', 7),
  /** who runs CrestClip — shown on the About, Contact, Terms, Privacy and Refund pages (Razorpay checks these) */
  business: {
    name: env('BUSINESS_NAME', 'CrestClip'),
    legalName: env('BUSINESS_LEGAL_NAME'),
    email: env('SUPPORT_EMAIL'),
    address: env('BUSINESS_ADDRESS'),
    /** courts for disputes, e.g. "Bengaluru, Karnataka" */
    jurisdiction: env('BUSINESS_JURISDICTION'),
    /** when support answers (shown on the Contact page) */
    hours: env('SUPPORT_HOURS', 'Monday to Friday, 10 am – 6 pm IST'),
    /** the person who handles complaints (defaults to BUSINESS_LEGAL_NAME) */
    grievanceOfficer: env('GRIEVANCE_OFFICER'),
  },
  /** visitor tracking (both optional): Google Analytics 4 "G-…" ID and Microsoft Clarity project ID */
  analytics: {
    gaId: env('GA_MEASUREMENT_ID'),
    clarityId: env('CLARITY_PROJECT_ID'),
  },
  sendVideoToGemini: env('GEMINI_SEND_VIDEO', 'true') !== 'false',
  fakeAi: env('CRESTCLIP_FAKE_AI') === '1',

  // Tools
  ytdlp: env('YTDLP_PATH', 'yt-dlp'),
  ytdlpExtraArgs: env('YTDLP_EXTRA_ARGS', '--js-runtimes node').split(/\s+/).filter(Boolean),
  ytdlpCookies: env('YTDLP_COOKIES'),
  /**
   * The PO-token helper (bgutil-ytdlp-pot-provider) yt-dlp asks for YouTube's "proof of origin" tokens.
   * Default = the helper from docker-compose on this machine. '' = don't use one.
   */
  ytdlpPotUrl: env('YTDLP_POT_URL', 'http://127.0.0.1:4416').replace(/\/$/, ''),
  /**
   * Rotating residential proxy for YouTube/yt-dlp traffic only (Drive, cloud storage, AI calls stay direct).
   * e.g. http://USER-session-{session}:PASS@gate.example.com:7000, or http://USER:PASS@gw.dataimpulse.com:{port}
   * — several may be listed, comma-separated. {session} (a tag in the username) or {port} (providers that keep one
   * address per port) is filled in per video (one exit address for all of that video's steps, which YouTube requires)
   * and with a fresh value whenever YouTube blocks or the proxy fails. Use http(s)://, not socks (ffmpeg cuts need http).
   */
  ytdlpProxies: env('YTDLP_PROXY')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /**
   * 'fallback' (default): go direct first and use the proxy only for a video YouTube blocks — you pay per GB, and
   * direct often still works. 'always': every YouTube request goes through the proxy.
   */
  ytdlpProxyMode: env('YTDLP_PROXY_MODE', 'fallback') === 'always' ? ('always' as const) : ('fallback' as const),
  /** how many fresh addresses to try per step before giving up */
  ytdlpProxyRetries: num('YTDLP_PROXY_RETRIES', 2),
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

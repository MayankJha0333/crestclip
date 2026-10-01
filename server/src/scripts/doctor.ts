import '../lib/quiet.js';
import { config } from '../config.js';
import { checkGemini } from '../pipeline/gemini.js';
import { ffmpegVersion, hasLibass } from '../pipeline/media.js';
import { ensureFfmpeg, ensureYtdlp, ytStatus } from '../infra/tools.js';

/** `npm run doctor` — checks everything CrestClip needs. Video tools are installed/updated automatically. */
const ok = (s: string) => console.log(`  \x1b[32m✔\x1b[0m ${s}`);
const bad = (s: string, fix: string) => console.log(`  \x1b[31m✘\x1b[0m ${s}\n      → ${fix}`);
const warn = (s: string, fix: string) => console.log(`  \x1b[33m!\x1b[0m ${s}\n      → ${fix}`);

console.log('\nCrestClip doctor\n');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 13)) ok(`Node ${process.versions.node}`);
else bad(`Node ${process.versions.node}`, 'Install Node 22.13 or newer');

await ensureFfmpeg();
const ff = await ffmpegVersion();
if (!ff) bad('ffmpeg could not start', 'Run `npm install` again — CrestClip ships its own ffmpeg');
else if (!(await hasLibass())) warn(`${ff} (${config.ffmpegSource})`, 'This ffmpeg can’t draw captions. Remove FFMPEG_PATH from .env to use the built-in one.');
else ok(`${ff} · ${config.ffmpegSource} · captions on`);

await ensureYtdlp();
if (ytStatus.state === 'ready') ok(`yt-dlp ${ytStatus.version} · ${ytStatus.source === 'managed' ? 'managed by CrestClip, auto-updates daily' : ytStatus.source}`);
else warn('yt-dlp is not ready', ytStatus.detail || 'CrestClip will retry automatically. Uploads still work.');

if (config.fakeAi) warn('CRESTCLIP_FAKE_AI=1 — using fake AI (development only)', 'Remove it from .env to use Gemini');
else if (!config.gcpProject && !config.vertexApiKey) bad('No Google Cloud credentials', 'Set GOOGLE_CLOUD_PROJECT in .env and sign in once with Google Cloud (see README)');
else {
  const g = await checkGemini();
  if (g.ok) ok(`Gemini on Vertex AI: ${g.detail} · main=${config.model} · fast=${config.fastModel}`);
  else bad(`Gemini on Vertex AI: ${g.detail}`, 'Sign in to Google Cloud once (see README → "Connect Google Cloud")');
}
if (config.gcsBucket) ok(`Cloud Storage bucket: ${config.gcsBucket} (uploads get visual analysis too)`);
else console.log('  · No GCS_BUCKET — uploaded files are judged from transcript + audio (YouTube links still get video analysis)');
console.log('');

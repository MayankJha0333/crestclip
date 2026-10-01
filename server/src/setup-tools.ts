import './lib/quiet.js';
import { ensureFfmpeg, ensureYtdlp, ytStatus, ffmpegPath, ffmpegSource } from './tools.js';

/** Pre-installs the video tools (used when building the Docker image so the first request is instant). */
await Promise.all([ensureFfmpeg(), ensureYtdlp()]);
console.log(`ffmpeg: ${ffmpegSource()} → ${ffmpegPath()}`);
console.log(`yt-dlp: ${ytStatus.state} ${ytStatus.version ?? ''} ${ytStatus.detail}`);
if (ytStatus.state !== 'ready') process.exitCode = 1;

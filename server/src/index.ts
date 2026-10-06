import './lib/quiet.js';
import { createApp } from './app.js';
import { config } from './config.js';
import './infra/jobs.js';
import { initQueue, queueHealth, repairQueue, startWorkers, watchFailures } from './infra/queue.js';
import { startLocalHttps } from './infra/localhttps.js';
import { startToolUpkeep } from './infra/tools.js';
import { startAutopilot } from './modules/autopilot/autopilot.engine.js';
import { warmExplore } from './modules/explore/explore.service.js';
import { startScheduler } from './modules/publishing/publishing.service.js';
import { connectDb, sessions } from './db/index.js';
import { importSqliteOnce } from './db/import-sqlite.js';
import { startRetention } from './modules/projects/retention.js';

// a background task that fails (e.g. the database blinked) is logged, not fatal
process.on('unhandledRejection', (e) => console.error('[background]', e));

const role = config.role;
const has = (...r: (typeof role)[]) => role === 'all' || r.includes(role);

try {
  await connectDb();
  if (has('scheduler')) await importSqliteOnce();
} catch (e) {
  console.error(`\n  Can't reach the database (MongoDB): ${(e as Error).message}\n  Check MONGODB_URI in .env and that this computer's IP is allowed in MongoDB Atlas → Network Access.\n`);
  process.exit(1);
}

const banner = () => {
  console.log(`\n  CrestClip · role: ${role}${has('web') ? `  →  http://localhost:${config.port}` : ''}`);
  console.log(
    `  Gemini (Vertex AI): ${config.fakeAi ? 'FAKE MODE (dev only)' : config.gcpProject ? `${config.gcpProject} · ${config.gcpLocation} · ${config.model}` : 'NOT CONFIGURED — set GOOGLE_CLOUD_PROJECT in .env'}`,
  );
  console.log(`  Database: MongoDB · ${config.mongoDb}`);
  console.log(`  Data folder: ${config.dataDir}`);
  if (has('worker')) console.log(`  Jobs at once: ${config.jobConcurrency} videos · ${config.renderConcurrency} renders`);
  console.log('');
};

await initQueue();

// ---- web: the website + API. Only queues work; several copies run behind Caddy's load balancer.
if (has('web')) {
  const app = createApp();
  app.listen(config.port, () => {
    banner();
    startLocalHttps(app);
    warmExplore();
  });
  // Autopilot: website copies only book/cancel posts on its queue; the scheduler runs them
  void startAutopilot({ runWorkers: has('scheduler') });
} else banner();

// tools (ffmpeg, yt-dlp): every process that uses them; only the scheduler checks for updates
startToolUpkeep({ updates: has('scheduler') });

// ---- worker: takes video and render jobs from the queue.
if (has('worker')) {
  const usingRedis = await startWorkers();
  if (!usingRedis && role === 'worker') {
    console.error('  A worker needs Redis (REDIS_URL) — without it there is no queue to take jobs from.');
    process.exit(1);
  }
}

// ---- scheduler: exactly one. Posts at the booked time, Autopilot, storage cleanup, queue repair.
if (has('scheduler')) {
  startScheduler();
  if (!has('web')) void startAutopilot({ runWorkers: true });
  startRetention(); // 7-day storage: delete old projects here and in the cloud bucket
  setInterval(() => void sessions.prune().catch(() => {}), 6 * 3600_000).unref(); // drop expired log-ins
  void watchFailures();
  // put back anything unfinished that has no job (Redis emptied, a crash before queueing); then every 10 minutes
  const repair = () => void repairQueue().catch((e) => console.warn('[start] queue repair failed:', (e as Error).message));
  setTimeout(repair, 5000);
  setInterval(repair, 10 * 60_000).unref();
  // cancel jobs that waited too long; warn when no worker is connected or Redis is nearly full
  setInterval(() => void queueHealth().catch((e) => console.warn('[queue] health check failed:', (e as Error).message)), 60_000).unref();
}

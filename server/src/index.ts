import './lib/quiet.js';
import { createApp } from './app.js';
import { config } from './config.js';
import { resumeUnfinished } from './infra/queue.js';
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

try {
  await connectDb();
  await importSqliteOnce();
} catch (e) {
  console.error(`\n  Can't reach the database (MongoDB): ${(e as Error).message}\n  Check MONGODB_URI in .env and that this computer's IP is allowed in MongoDB Atlas → Network Access.\n`);
  process.exit(1);
}

const app = createApp();

app.listen(config.port, () => {
  console.log(`\n  CrestClip API  →  http://localhost:${config.port}`);
  console.log(
    `  Gemini (Vertex AI): ${config.fakeAi ? 'FAKE MODE (dev only)' : config.gcpProject ? `${config.gcpProject} · ${config.gcpLocation} · ${config.model}` : 'NOT CONFIGURED — set GOOGLE_CLOUD_PROJECT in .env'}`,
  );
  console.log(`  Database: MongoDB · ${config.mongoDb}`);
  console.log(`  Data folder: ${config.dataDir}\n`);
  startToolUpkeep();
  startScheduler();
  startLocalHttps(app);
  void startAutopilot();
  void resumeUnfinished().catch((e) => console.warn('[start] could not resume unfinished work:', (e as Error).message));
  warmExplore();
  setInterval(() => void sessions.prune().catch(() => {}), 6 * 3600_000).unref(); // drop expired log-ins
  startRetention(); // 7-day storage: delete old projects here and in the cloud bucket
});

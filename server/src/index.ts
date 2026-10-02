import './lib/quiet.js';
import { createApp } from './app.js';
import { config } from './config.js';
import { resumeUnfinished } from './infra/queue.js';
import { startLocalHttps } from './infra/localhttps.js';
import { startToolUpkeep } from './infra/tools.js';
import { startAutopilot } from './modules/autopilot/autopilot.engine.js';
import { warmExplore } from './modules/explore/explore.service.js';
import { startScheduler } from './modules/publishing/publishing.service.js';
import { sessions } from './db/index.js';
import { startRetention } from './modules/projects/retention.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(`\n  CrestClip API  →  http://localhost:${config.port}`);
  console.log(
    `  Gemini (Vertex AI): ${config.fakeAi ? 'FAKE MODE (dev only)' : config.gcpProject ? `${config.gcpProject} · ${config.gcpLocation} · ${config.model}` : 'NOT CONFIGURED — set GOOGLE_CLOUD_PROJECT in .env'}`,
  );
  console.log(`  Data folder: ${config.dataDir}\n`);
  startToolUpkeep();
  startScheduler();
  startLocalHttps(app);
  void startAutopilot();
  resumeUnfinished();
  warmExplore();
  setInterval(() => sessions.prune(), 6 * 3600_000).unref(); // drop expired log-ins
  startRetention(); // 7-day storage: delete old projects here and in the cloud bucket
});

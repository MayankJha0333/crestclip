import { clips, credits, projects } from '../db/index.js';
import { refundProject } from '../modules/billing/billing.service.js';
import { runPick } from '../modules/projects/projects.service.js';
import { processProject, renderClipJob } from '../pipeline/process.js';
import { defineJob } from './queue.js';

/**
 * What each queued job does (imported once at start-up by every process that runs or gives up on jobs).
 * The give-up step runs when a job fails for good — e.g. it got stuck twice — so nothing is left "processing" forever.
 */
defineJob(
  'project',
  async (d) => processProject(String(d.id)),
  async (d, reason) => {
    const id = String(d.id);
    const p = await projects.get(id);
    if (!p || p.status === 'done' || p.status === 'failed') return;
    await refundProject(id); // nothing usable came out of it, so the credits go back
    await projects.update(id, { status: 'failed', error: reason, errorCode: null });
    console.warn(`  [queue] project ${id} gave up: ${reason}`);
  },
);

defineJob(
  'render',
  async (d) => renderClipJob(String(d.clipId)),
  async (d, reason) => {
    const c = await clips.get(String(d.clipId));
    if (c && c.status !== 'ready') await clips.update(c.id, { status: 'failed', error: reason });
  },
);

defineJob(
  'pick',
  async (d) => runPick(d as { projectId: string; ids: string[]; paid: string | null }),
  async (d, reason) => {
    for (const id of (d.ids as string[]) ?? []) {
      const c = await clips.get(id);
      if (c && c.status !== 'ready') await clips.update(id, { status: 'failed', error: reason });
    }
    if (d.paid) await credits.refund(String(d.paid), 'Refund · picked parts couldn’t be prepared');
  },
);

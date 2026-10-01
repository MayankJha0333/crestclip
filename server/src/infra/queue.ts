import { config } from '../config.js';
import { clips, projects } from '../db/index.js';
import { processProject, renderClipJob } from '../pipeline/process.js';

type Job = () => Promise<void>;

class Queue {
  private running = 0;
  private items: { key: string; job: Job }[] = [];
  private keys = new Set<string>();
  private active = new Set<string>();
  private dirty = new Map<string, Job>();
  constructor(private limit: number) {}
  push(key: string, job: Job) {
    // Already running → run it again when it finishes (the user changed something mid-render).
    if (this.active.has(key)) {
      this.dirty.set(key, job);
      return;
    }
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.items.push({ key, job });
    this.tick();
  }
  private tick() {
    while (this.running < this.limit && this.items.length) {
      const { key, job } = this.items.shift()!;
      this.running++;
      this.active.add(key);
      job()
        .catch((e) => console.error('[queue]', e))
        .finally(() => {
          this.running--;
          this.keys.delete(key);
          this.active.delete(key);
          const again = this.dirty.get(key);
          if (again) {
            this.dirty.delete(key);
            this.push(key, again);
          }
          this.tick();
        });
    }
  }
}

const projectQueue = new Queue(config.jobConcurrency);
const renderQueue = new Queue(config.renderConcurrency);

export const enqueueProject = (id: string) => projectQueue.push(id, () => processProject(id));
export const enqueueRender = (clipId: string) => renderQueue.push(clipId, () => renderClipJob(clipId));
/** Any other background job (runs on the project queue). */
export const enqueueJob = (key: string, job: () => Promise<void>) => projectQueue.push(key, job);

/** After a restart, pick up anything that was mid-flight. */
export function resumeUnfinished() {
  const busy = new Set<string>();
  for (const p of projects.unfinished()) {
    busy.add(p.id);
    enqueueProject(p.id);
  }
  for (const c of clips.unfinished()) if (!busy.has(c.projectId)) enqueueRender(c.id);
}

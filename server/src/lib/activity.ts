import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * "This job is still doing something." The queue runs each job inside `activity.run(...)`; anything the job does
 * — a progress update, an AI answer, a line of output from ffmpeg / yt-dlp — calls `touch()`. A job that goes quiet
 * for too long is stuck (see JOB_IDLE_MINUTES in infra/queue.ts). No dependencies, so any file can import it.
 */
export const activity = new AsyncLocalStorage<{ last: number }>();

export function touch() {
  const s = activity.getStore();
  if (s) s.last = Date.now();
}

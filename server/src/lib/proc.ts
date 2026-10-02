import { spawn } from 'node:child_process';

interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  maxBuffer?: number; // bytes kept for stdout
}

export class ProcError extends Error {
  constructor(
    message: string,
    public code: number | null,
    public stderr: string,
  ) {
    super(message);
  }
}

/** Run a command, resolve with stdout/stderr. Rejects on non-zero exit. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const max = opts.maxBuffer ?? 256 * 1024 * 1024;
    let out = '';
    let err = '';
    let lineBufs = { stdout: '', stderr: '' };
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new ProcError(`${cmd} timed out after ${Math.round(opts.timeoutMs! / 1000)}s`, null, err.slice(-4000)));
      }, opts.timeoutMs);
    }
    const feed = (stream: 'stdout' | 'stderr', chunk: string) => {
      if (!opts.onLine) return;
      lineBufs[stream] += chunk;
      const parts = lineBufs[stream].split(/\r|\n/);
      lineBufs[stream] = parts.pop() ?? '';
      for (const p of parts) if (p.trim()) opts.onLine(p, stream);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (out.length < max) out += d;
      feed('stdout', d);
    });
    child.stderr.on('data', (d: string) => {
      err += d;
      if (err.length > 2_000_000) err = err.slice(-1_000_000);
      feed('stderr', d);
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(new ProcError(`Could not start "${cmd}": ${e.message}`, null, ''));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new ProcError(`${cmd} exited with code ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`, code, err.slice(-4000)));
    });
  });
}

/** Tiny promise pool. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

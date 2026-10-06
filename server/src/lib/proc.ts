import { spawn } from 'node:child_process';

interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Kill the command if it prints nothing for this long (a stuck download), instead of waiting for `timeoutMs`. */
  idleTimeoutMs?: number;
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
    let idle: NodeJS.Timeout | undefined;
    const stop = () => {
      if (timer) clearTimeout(timer);
      if (idle) clearTimeout(idle);
    };
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        stop();
        child.kill('SIGKILL');
        reject(new ProcError(`${cmd} ran too long and was stopped (limit ${Math.round(opts.timeoutMs! / 60_000)} min)`, null, err.slice(-4000)));
      }, opts.timeoutMs);
    }
    const poke = () => {
      if (!opts.idleTimeoutMs) return;
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        stop();
        child.kill('SIGKILL');
        reject(new ProcError(`${cmd} stalled: no progress for ${Math.round(opts.idleTimeoutMs! / 1000)}s`, null, err.slice(-4000)));
      }, opts.idleTimeoutMs);
    };
    poke();
    const feed = (stream: 'stdout' | 'stderr', chunk: string) => {
      poke();
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
      stop();
      reject(new ProcError(`Could not start "${cmd}": ${e.message}`, null, ''));
    });
    child.on('close', (code) => {
      stop();
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

/**
 * A shared cap on how many of one kind of job run at once, across everything that uses it — e.g. clip renders
 * from every project together, so 5 videos being processed side by side never start 10 ffmpeg encodes at once.
 */
export function limiter(limit: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (running >= Math.max(1, limit)) await new Promise<void>((go) => waiting.push(go));
    running++;
    try {
      return await fn();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

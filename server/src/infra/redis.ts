import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { run, sleep } from '../lib/proc.js';

/**
 * Redis for the Autopilot scheduler (BullMQ jobs).
 *
 * Where it comes from, in order:
 *   1. REDIS_URL in .env (e.g. a hosted Redis like Upstash, or Memorystore in production)
 *   2. a Redis already running on this computer (127.0.0.1:6379, e.g. from Docker)
 *   3. CrestClip's own private copy: Valkey (the open-source Redis), built once from source into data/bin
 *      and started on 127.0.0.1:6390 — no brew, no terminal. Needs Apple's command line tools on a Mac.
 *
 * MongoDB stays the record of truth; Redis only times the jobs, so it is fine if Redis restarts empty —
 * CrestClip puts every job back on start-up.
 */

type State = 'starting' | 'installing' | 'ready' | 'error' | 'off';
export const redisStatus: { state: State; source: 'env' | 'local' | 'managed' | null; detail: string; url: string | null } = {
  state: 'starting',
  source: null,
  detail: '',
  url: null,
};

const VALKEY_VERSION = '8.1.10';
const MANAGED_PORT = Number(process.env.REDIS_MANAGED_PORT || 6390);
const binDir = path.join(config.dataDir, 'bin');
const managedBin = path.join(binDir, 'valkey-server');
const log = (...a: unknown[]) => console.log('  [redis]', ...a);

/** Quick PING over a raw socket (no client library needed). */
function ping(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let done = false;
    const end = (ok: boolean) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => end(false));
    s.on('error', () => end(false));
    s.on('connect', () => s.write('PING\r\n'));
    s.on('data', (d) => end(/PONG|NOAUTH/.test(d.toString())));
  });
}

async function onPath(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await run(process.platform === 'win32' ? 'where' : 'which', [cmd], { timeoutMs: 5000 });
    return stdout.trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

/** Build Valkey from its source code once (≈1–3 min). */
async function buildValkey(): Promise<string> {
  if (process.platform === 'win32') throw new Error('Building Redis isn’t supported on Windows — set REDIS_URL in .env (for example a free Upstash database).');
  if (!(await onPath('make')) || !((await onPath('cc')) || (await onPath('clang')) || (await onPath('gcc'))))
    throw new Error(
      process.platform === 'darwin'
        ? 'This Mac is missing Apple’s command line tools (needed once to build Redis). Install them from System Settings → General → Software Update, or set REDIS_URL in .env.'
        : 'A C compiler (make + gcc) is needed once to build Redis — or set REDIS_URL in .env.',
    );
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crestclip-valkey-'));
  try {
    redisStatus.state = 'installing';
    redisStatus.detail = 'Setting up the scheduler (one time, about 1–3 minutes)…';
    log(`downloading Valkey ${VALKEY_VERSION} source…`);
    const res = await fetch(`https://github.com/valkey-io/valkey/archive/refs/tags/${VALKEY_VERSION}.tar.gz`, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Couldn’t download Redis (error ${res.status})`);
    const tgz = path.join(work, 'src.tgz');
    fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
    await run('tar', ['-xzf', tgz, '-C', work], { timeoutMs: 120_000 });
    const srcDir = path.join(work, `valkey-${VALKEY_VERSION}`);
    log('building Valkey (one time)…');
    await run('make', [`-j${Math.max(2, Math.min(8, os.cpus().length))}`, 'BUILD_TLS=no', 'valkey-server'], { cwd: srcDir, timeoutMs: 15 * 60_000 });
    fs.mkdirSync(binDir, { recursive: true });
    fs.copyFileSync(path.join(srcDir, 'src', 'valkey-server'), `${managedBin}.tmp`);
    fs.chmodSync(`${managedBin}.tmp`, 0o755);
    fs.renameSync(`${managedBin}.tmp`, managedBin);
    log('Valkey ready →', managedBin);
    return managedBin;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function startManaged(): Promise<string> {
  const url = `redis://127.0.0.1:${MANAGED_PORT}`;
  // still running from before a restart? reuse it
  if (await ping('127.0.0.1', MANAGED_PORT)) return url;
  const bin =
    (process.env.REDIS_SERVER_BIN || '').trim() || (fs.existsSync(managedBin) ? managedBin : null) || (await onPath('valkey-server')) || (await onPath('redis-server')) || (await buildValkey());
  const dir = path.join(config.dataDir, 'redis');
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(
    bin,
    ['--port', String(MANAGED_PORT), '--bind', '127.0.0.1', '--dir', dir, '--save', '60 1', '--appendonly', 'no', '--protected-mode', 'yes', '--daemonize', 'no', '--loglevel', 'warning'],
    { stdio: 'ignore', detached: true },
  );
  child.unref(); // keeps running across `tsx watch` restarts; the next start finds it with ping()
  for (let i = 0; i < 40; i++) {
    if (await ping('127.0.0.1', MANAGED_PORT)) return url;
    await sleep(250);
  }
  throw new Error('The scheduler’s Redis didn’t start.');
}

/** Find or start Redis. Never throws — the result is in redisStatus. */
export async function ensureRedis(): Promise<string | null> {
  try {
    const envUrl = (process.env.REDIS_URL || '').trim();
    if (envUrl === 'off') {
      Object.assign(redisStatus, { state: 'off', source: null, detail: 'Autopilot is turned off (REDIS_URL=off).', url: null });
      return null;
    }
    if (envUrl) {
      Object.assign(redisStatus, { state: 'ready', source: 'env', detail: '', url: envUrl });
      return envUrl;
    }
    if (await ping('127.0.0.1', 6379)) {
      Object.assign(redisStatus, { state: 'ready', source: 'local', detail: '', url: 'redis://127.0.0.1:6379' });
      return redisStatus.url;
    }
    const url = await startManaged();
    Object.assign(redisStatus, { state: 'ready', source: 'managed', detail: '', url });
    return url;
  } catch (e) {
    Object.assign(redisStatus, { state: 'error', source: null, detail: (e as Error).message, url: null });
    log('not available:', (e as Error).message);
    return null;
  }
}

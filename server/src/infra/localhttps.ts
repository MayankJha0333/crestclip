import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Express } from 'express';
import { config } from '../config.js';

/**
 * Local https for development.
 * Instagram refuses http sign-in return links, so in dev CrestClip also serves the same app on
 * https://localhost:8443 with a self-made certificate (made once with openssl, saved in data/certs).
 * Your browser shows a one-time "not private" warning for it — that's expected for a local certificate.
 */
function ensureCert(): { key: Buffer; cert: Buffer } | null {
  const dir = path.join(config.dataDir, 'certs');
  const keyFile = path.join(dir, 'localhost-key.pem');
  const certFile = path.join(dir, 'localhost.pem');
  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
    fs.mkdirSync(dir, { recursive: true });
    const base = ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825', '-keyout', keyFile, '-out', certFile, '-subj', '/CN=localhost'];
    try {
      execFileSync('openssl', [...base, '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    } catch {
      try {
        execFileSync('openssl', base, { stdio: 'ignore' }); // older openssl without -addext
      } catch {
        return null;
      }
    }
  }
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

export function startLocalHttps(app: Express) {
  if (!config.localHttps) return;
  const creds = ensureCert();
  if (!creds) {
    console.log('  [https] openssl not found — Instagram connect needs an https link (set PUBLIC_URL to your https domain).');
    return;
  }
  https
    .createServer(creds, app)
    .on('error', (e: NodeJS.ErrnoException) => console.log(`  [https] couldn’t open port ${config.httpsPort} (${e.code ?? e.message}) — set HTTPS_PORT in .env to another port.`))
    .listen(config.httpsPort, () => console.log(`  Local https (Instagram sign-in) → https://localhost:${config.httpsPort}`));
}

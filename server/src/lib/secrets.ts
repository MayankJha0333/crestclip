import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/** Encrypts small secrets (OAuth tokens) for the local database with AES-256-GCM. */

function key(): Buffer {
  if (/^[0-9a-f]{64}$/i.test(config.secretKeyHex)) return Buffer.from(config.secretKeyHex, 'hex');
  if (config.secretKey) return crypto.createHash('sha256').update(config.secretKey).digest();
  const file = path.join(config.dataDir, 'secret.key');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}

export function seal(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

/** Throws if the text was sealed with another key or was changed. */
export function open<T>(sealed: string): T {
  const [iv, tag, enc] = sealed.split('.').map((b) => Buffer.from(b, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString('utf8')) as T;
}

/** A signature for short text (e.g. a temporary download link), made with the same secret key. */
export function sign(text: string): string {
  return crypto.createHmac('sha256', key()).update(`link:${text}`).digest('base64url');
}

/** True when `sig` is sign(text) — compared in constant time. */
export function verify(text: string, sig: string): boolean {
  const want = Buffer.from(sign(text));
  const got = Buffer.from(String(sig));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

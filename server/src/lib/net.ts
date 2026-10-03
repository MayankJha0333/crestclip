import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';
import { HttpError } from './http.js';

/**
 * Links people paste are fetched by this server. They must point at the public internet — never at this computer,
 * the local network or cloud metadata addresses (otherwise a link could be used to reach internal services).
 */

function privateV4(ip: string) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast, reserved
  );
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return privateV4(ip);
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateV4(mapped[1]);
  // the same, written in hex (URLs normalise ::ffff:127.0.0.1 to ::ffff:7f00:1)
  const hex = v6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const [h, l] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
    return privateV4(`${h >> 8}.${h & 255}.${l >> 8}.${l & 255}`);
  }
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
}

const blocked = () => new HttpError(400, 'That link points to a private or local address, which CrestClip can’t open. Use a public link.');

/** Throws a 400 when `raw` isn't an http(s) link to a public address. */
export async function assertPublicUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, 'That doesn’t look like a link.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'Only http(s) links work.');
  if (config.allowPrivateLinks) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) throw blocked();
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((r) => r.address);
  if (ips.some(isPrivateIp)) throw blocked();
}

/** fetch() that checks every hop of a redirect chain with assertPublicUrl. */
export async function publicFetch(url: string, init: RequestInit = {}, maxRedirects = 8): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, { ...init, redirect: 'manual' });
    const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!next) return res;
    current = new URL(next, current).toString();
  }
  throw new Error('Too many redirects.');
}

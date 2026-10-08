import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import { config } from '../config.js';
import { run } from '../lib/proc.js';

/**
 * A clip's part of a YouTube video, fetched by byte range — in seconds instead of minutes.
 *
 * yt-dlp's way of cutting a part (ffmpeg reading the stream from a seek point) gets ~1–2× playback speed, because
 * YouTube throttles one long read. yt-dlp's own full downloads go fast by asking for the file in 10 MB pieces, and
 * that is what this does for just the part that's needed: the video and audio streams are DASH files whose `sidx`
 * box lists every ~5-second fragment with its byte offset, so the fragments covering the clip are fetched in parallel
 * pieces and stitched behind the stream's header. ffmpeg then cuts the exact clip without re-encoding.
 *
 * Anything unexpected (no sidx, a refused request, an odd file) → false, and the caller uses yt-dlp as before.
 */

interface Format {
  format_id: string;
  ext?: string;
  vcodec?: string;
  acodec?: string;
  height?: number;
  abr?: number;
  tbr?: number;
  url?: string;
  protocol?: string;
  fragments?: unknown;
  filesize?: number;
  filesize_approx?: number;
  http_headers?: Record<string, string>;
}

interface Fragment {
  t: number; // seconds
  dur: number;
  offset: number; // bytes from the start of the file
  size: number;
}

interface StreamIndex {
  sidxAt: number; // where the index box starts: the header (ftyp + moov) is everything before it
  headerBytes: number; // ftyp + moov + sidx: everything before the first fragment
  fragments: Fragment[];
}

const PIECE = 8 * 1024 * 1024; // bytes per request (YouTube serves pieces this size at full speed)
const AT_ONCE = 6;
const HEAD = 512 * 1024; // enough for the header boxes of a multi-hour file

function pick(formats: Format[]): { video: Format; audio: Format } | null {
  const ok = (f: Format) => f.url && f.protocol === 'https' && !f.fragments;
  const vids = formats.filter((f) => ok(f) && f.ext === 'mp4' && f.vcodec?.startsWith('avc1') && (f.acodec === 'none' || !f.acodec) && (f.height ?? 0) <= 1080);
  const auds = formats.filter((f) => ok(f) && f.ext === 'm4a' && (f.vcodec === 'none' || !f.vcodec) && f.acodec?.startsWith('mp4a'));
  if (!vids.length || !auds.length) return null;
  vids.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0));
  auds.sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0));
  return { video: vids[0], audio: auds[0] };
}

/** A TLS connection to `host`, through an http(s) proxy's CONNECT tunnel when one is set. */
function connectVia(proxy: string, host: string, port: number): Promise<tls.TLSSocket> {
  const p = new URL(proxy);
  const auth = p.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}` } : {};
  return new Promise((resolve, reject) => {
    const req = (p.protocol === 'https:' ? https : http).request({ host: p.hostname, port: Number(p.port) || (p.protocol === 'https:' ? 443 : 80), method: 'CONNECT', path: `${host}:${port}`, headers: { Host: `${host}:${port}`, ...auth }, timeout: 30_000 });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`proxy answered ${res.statusCode} to CONNECT`));
      }
      resolve(tls.connect({ socket, servername: host }));
    });
    req.on('timeout', () => req.destroy(new Error('proxy connect timed out')));
    req.on('error', reject);
    req.end();
  });
}

/** A GET (a byte range when `range` is set), following redirects, through the proxy when one is set. */
function get(url: string, headers: Record<string, string>, proxy: string | null, range: { from: number; to: number } | null, hops = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const go = (createConnection?: () => tls.TLSSocket) => {
      const req = (u.protocol === 'http:' ? http : https).request(
        u,
        { method: 'GET', headers: { ...headers, ...(range ? { Range: `bytes=${range.from}-${range.to}` } : {}) }, timeout: 60_000, ...(createConnection ? { createConnection, agent: false } : {}) },
        (res) => {
          // YouTube sometimes points at another of its servers first
          if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 3) {
            res.resume();
            return get(new URL(res.headers.location, u).toString(), headers, proxy, range, hops + 1).then(resolve, reject);
          }
          if (res.statusCode !== (range ? 206 : 200)) {
            res.resume();
            const err = new Error(`${range ? 'range ' : ''}request answered ${res.statusCode}`) as Error & { status?: number };
            err.status = res.statusCode;
            return reject(err);
          }
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('request timed out')));
      req.on('error', reject);
      req.end();
    };
    if (!proxy || u.protocol === 'http:') go();
    else connectVia(proxy, u.hostname, Number(u.port) || 443).then((socket) => go(() => socket), reject);
  });
}

/** One byte range of a file, as yt-dlp fetches them (a plain Range request; YouTube serves these at full speed). */
const getRange = (url: string, from: number, to: number, headers: Record<string, string>, proxy: string | null) => get(url, headers, proxy, { from, to });

// ---------------- HLS (Twitch and other sites that serve video as a list of short files) ----------------

/** The best ≤1080p HLS rendition that carries both picture and sound (Twitch's are muxed). */
function pickHls(formats: Format[]): Format | null {
  const list = formats.filter(
    (f) => f.url && /^m3u8/.test(f.protocol ?? '') && f.vcodec && f.vcodec !== 'none' && f.vcodec.startsWith('avc1') && f.acodec && f.acodec !== 'none' && (f.height ?? 0) <= 1080,
  );
  list.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0));
  return list[0] ?? null;
}

interface Segment {
  t: number;
  dur: number;
  url: string;
}

/** The segments of a media playlist with their play times; null for anything this doesn't handle. */
function parseM3u8(text: string, base: string): { init: string | null; segments: Segment[] } | null {
  if (!text.startsWith('#EXTM3U') || /#EXT-X-STREAM-INF|#EXT-X-BYTERANGE|#EXT-X-KEY:METHOD=(?!NONE)/.test(text)) return null;
  const segments: Segment[] = [];
  let init: string | null = null;
  let t = 0;
  let dur: number | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const map = line.match(/^#EXT-X-MAP:.*URI="([^"]+)"/);
    if (map) {
      if (/BYTERANGE/.test(line)) return null;
      init = new URL(map[1], base).toString();
    } else if (line.startsWith('#EXTINF:')) dur = parseFloat(line.slice(8));
    else if (!line.startsWith('#') && dur != null) {
      segments.push({ t, dur, url: new URL(line, base).toString() });
      t += dur;
      dur = null;
    }
  }
  return segments.length ? { init, segments } : null;
}

async function fetchHlsPart(f: Format, range: { start: number; end: number }, out: string, proxy: string | null, onProgress?: (frac: number) => void): Promise<'ok' | 'refused' | 'unsupported'> {
  const headers = f.http_headers ?? {};
  const tmp = `${out}.${process.pid}.seg`;
  const t0 = Date.now();
  try {
    const list = parseM3u8((await get(f.url!, headers, proxy, null)).toString('utf8'), f.url!);
    if (!list) return 'unsupported';
    const segs = list.segments;
    let a = segs.findIndex((x) => x.t + x.dur > range.start);
    if (a < 0) return 'unsupported';
    let b = segs.findIndex((x) => x.t >= range.end);
    b = b < 0 ? segs.length - 1 : b;
    a = Math.max(0, a - 1); // one segment of slack before, so the cut never lands on an edge
    const pick = segs.slice(a, b + 1);
    const got: Buffer[] = new Array(pick.length);
    let next = 0;
    let done = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, pick.length) }, async () => {
        while (next < pick.length) {
          const i = next++;
          got[i] = await get(pick[i].url, headers, proxy, null);
          onProgress?.(Math.min(0.9, ++done / pick.length));
        }
      }),
    );
    const fd = fs.openSync(tmp, 'w');
    try {
      if (list.init) fs.writeSync(fd, await get(list.init, headers, proxy, null));
      for (const buf of got) fs.writeSync(fd, buf);
    } finally {
      fs.closeSync(fd);
    }
    // The stitched segments are rewrapped as an mp4 first (copy, no re-encode): seeking inside a .ts file lands on
    // the keyframe AFTER the start (seconds of picture lost), seeking an mp4 lands on the one before and hides the
    // extra frames — the same exact cut as the YouTube path. The mp4 starts at the first segment's time.
    const whole = `${tmp}.mp4`;
    try {
      await run(config.ffmpeg, ['-y', '-v', 'error', '-i', tmp, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-f', 'mp4', whole], { timeoutMs: 10 * 60_000 });
      await run(
        config.ffmpeg,
        ['-y', '-v', 'error', '-ss', Math.max(0, range.start - pick[0].t).toFixed(3), '-t', String(range.end - range.start), '-i', whole, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', out],
        { timeoutMs: 10 * 60_000 },
      );
    } finally {
      fs.rmSync(whole, { force: true });
    }
    onProgress?.(1);
    const mb = got.reduce((n, x) => n + x.length, 0) / 1e6;
    console.log(`  [fast parts] ${range.start}–${range.end}s · ${mb.toFixed(0)} MB in ${pick.length} segments, ${((Date.now() - t0) / 1000).toFixed(1)}s (HLS)`);
    return 'ok';
  } catch (e) {
    const refused = (e as { status?: number }).status === 403;
    console.warn(`  [fast parts] ${range.start}–${range.end} (HLS): ${(e as Error).message.slice(0, 200)} — using yt-dlp for this part`);
    fs.rmSync(out, { force: true });
    return refused ? 'refused' : 'unsupported';
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Read the `sidx` box out of the file's first bytes: where every fragment is and when it plays. */
function parseIndex(head: Buffer): StreamIndex | null {
  let pos = 0;
  while (pos + 8 <= head.length) {
    let size = head.readUInt32BE(pos);
    const type = head.toString('latin1', pos + 4, pos + 8);
    let hdr = 8;
    if (size === 1) {
      size = Number(head.readBigUInt64BE(pos + 8));
      hdr = 16;
    } else if (size === 0) size = head.length - pos;
    if (type === 'sidx') {
      if (pos + size > head.length) return null; // the index doesn't fit in what we read
      const b = head.subarray(pos + hdr, pos + size);
      const version = b[0];
      let o = 4; // version + flags
      o += 4; // reference_ID
      const timescale = b.readUInt32BE(o);
      o += 4;
      let earliest: number;
      let firstOffset: number;
      if (version === 0) {
        earliest = b.readUInt32BE(o);
        firstOffset = b.readUInt32BE(o + 4);
        o += 8;
      } else {
        earliest = Number(b.readBigUInt64BE(o));
        firstOffset = Number(b.readBigUInt64BE(o + 8));
        o += 16;
      }
      o += 2; // reserved
      const count = b.readUInt16BE(o);
      o += 2;
      const fragments: Fragment[] = [];
      let offset = pos + size + firstOffset;
      let t = earliest / timescale;
      for (let i = 0; i < count; i++) {
        const a = b.readUInt32BE(o);
        const dur = b.readUInt32BE(o + 4) / timescale;
        o += 12;
        const refType = a >>> 31;
        const refSize = a & 0x7fffffff;
        if (refType === 1) return null; // an index of indexes — not what YouTube serves
        fragments.push({ t, dur, offset, size: refSize });
        offset += refSize;
        t += dur;
      }
      return fragments.length ? { sidxAt: pos, headerBytes: pos + size, fragments } : null;
    }
    if (type === 'moof' || type === 'mdat') return null; // fragments before any index
    pos += size;
  }
  return null;
}

/** The file bytes holding [start, end] seconds: the header, then the fragments that cover it. */
function plan(idx: StreamIndex, start: number, end: number): { from: number; to: number; t0: number } | null {
  const f = idx.fragments;
  let a = f.findIndex((x) => x.t + x.dur > start);
  if (a < 0) return null;
  let b = f.findIndex((x) => x.t >= end);
  b = b < 0 ? f.length - 1 : Math.max(a, b);
  // one fragment of slack either side, so the cut never lands on an edge
  a = Math.max(0, a - 1);
  b = Math.min(f.length - 1, b + 1);
  return { from: f[a].offset, to: f[b].offset + f[b].size - 1, t0: f[a].t };
}

async function fetchStream(f: Format, start: number, end: number, out: string, proxy: string | null, onBytes: (n: number) => void): Promise<number> {
  const headers = f.http_headers ?? {};
  const head = await getRange(f.url!, 0, HEAD - 1, headers, proxy);
  const idx = parseIndex(head);
  if (!idx || idx.headerBytes > head.length) throw new Error(`no usable index in format ${f.format_id}`);
  const p = plan(idx, start, end);
  if (!p) throw new Error(`format ${f.format_id} has nothing for ${start}–${end}`);
  // the header, then the fragment bytes in parallel pieces, written in order
  const pieces: { from: number; to: number }[] = [];
  for (let at = p.from; at <= p.to; at += PIECE) pieces.push({ from: at, to: Math.min(p.to, at + PIECE - 1) });
  const got: Buffer[] = new Array(pieces.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(AT_ONCE, pieces.length) }, async () => {
      while (next < pieces.length) {
        const i = next++;
        got[i] = await getRange(f.url!, pieces[i].from, pieces[i].to, headers, proxy);
        onBytes(got[i].length);
      }
    }),
  );
  const fd = fs.openSync(out, 'w');
  try {
    // the header without its index: the index points at fragments that aren't here, so ffmpeg reads the ones that are
    fs.writeSync(fd, head.subarray(0, idx.sidxAt));
    for (const b of got) fs.writeSync(fd, b);
  } finally {
    fs.closeSync(fd);
  }
  return p.t0;
}

/**
 * Fetch [start, end] of the video into `out` (an mp4 whose time 0 is `start`).
 *   'ok'          — done
 *   'refused'     — the stream links were refused (403): fresh links from another player client may work
 *   'unsupported' — this video can't be fetched this way; the caller uses yt-dlp
 */
export async function fetchPartFast(
  infoJson: string,
  range: { start: number; end: number },
  out: string,
  opts: { proxy?: string | null; onProgress?: (frac: number) => void } = {},
): Promise<'ok' | 'refused' | 'unsupported'> {
  let formats: Format[];
  try {
    formats = (JSON.parse(fs.readFileSync(infoJson, 'utf8')) as { formats?: Format[] }).formats ?? [];
  } catch {
    return 'unsupported';
  }
  const proxy = opts.proxy ?? null;
  const chosen = pick(formats);
  if (!chosen) {
    // no DASH files (Twitch, Kick, Vimeo…): the HLS list of short files, only those the part needs
    const hls = pickHls(formats);
    return hls ? fetchHlsPart(hls, range, out, proxy, opts.onProgress) : 'unsupported';
  }
  const dir = path.dirname(out);
  const tag = `${path.basename(out, path.extname(out))}_${process.pid}`;
  const vFile = path.join(dir, `${tag}.v.mp4`);
  const aFile = path.join(dir, `${tag}.a.m4a`);
  const expect = Math.max(1, ((chosen.video.filesize ?? chosen.video.filesize_approx ?? 0) + (chosen.audio.filesize ?? chosen.audio.filesize_approx ?? 0)) * ((range.end - range.start + 10) / 36000));
  let bytes = 0;
  const t0 = Date.now();
  const onBytes = (n: number) => {
    bytes += n;
    opts.onProgress?.(Math.min(0.9, bytes / expect));
  };
  try {
    const [tv, ta] = await Promise.all([fetchStream(chosen.video, range.start, range.end, vFile, proxy, onBytes), fetchStream(chosen.audio, range.start, range.end, aFile, proxy, onBytes)]);
    const dur = range.end - range.start;
    // each file starts at its first fragment's time, so the seek is measured from there; the cut lands on `start`
    // exactly in both (the frames before the keyframe are kept but hidden, as yt-dlp's cut does)
    const ss = (t0: number) => Math.max(0, range.start - t0).toFixed(3);
    await run(
      config.ffmpeg,
      ['-y', '-v', 'error', '-ss', ss(tv), '-t', String(dur), '-i', vFile, '-ss', ss(ta), '-t', String(dur), '-i', aFile, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', out],
      { timeoutMs: 10 * 60_000 },
    );
    opts.onProgress?.(1);
    console.log(`  [fast parts] ${range.start}–${range.end}s · ${(bytes / 1e6).toFixed(0)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return 'ok';
  } catch (e) {
    const refused = (e as { status?: number }).status === 403;
    console.warn(`  [fast parts] ${range.start}–${range.end}: ${(e as Error).message.slice(0, 200)}${refused ? '' : ' — using yt-dlp for this part'}`);
    fs.rmSync(out, { force: true });
    return refused ? 'refused' : 'unsupported';
  } finally {
    fs.rmSync(vFile, { force: true });
    fs.rmSync(aFile, { force: true });
  }
}

/**
 * The whole sound track of an HLS video (Twitch's "Audio_Only"), its short files fetched 16 at a time: yt-dlp takes
 * them one after another (~1 MB/s); this takes seconds. Null when there's no such track — the caller uses yt-dlp.
 */
export async function fetchAudioFast(infoJson: string, out: string, onProgress?: (pct: number, detail: string) => void): Promise<string | null> {
  let formats: Format[];
  try {
    formats = (JSON.parse(fs.readFileSync(infoJson, 'utf8')) as { formats?: Format[] }).formats ?? [];
  } catch {
    return null;
  }
  const f = formats
    .filter((x) => x.url && /^m3u8/.test(x.protocol ?? '') && (!x.vcodec || x.vcodec === 'none') && x.acodec && x.acodec !== 'none')
    .sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0];
  if (!f) return null;
  const headers = f.http_headers ?? {};
  const tmp = `${out}.${process.pid}.seg`;
  const t0 = Date.now();
  try {
    const list = parseM3u8((await get(f.url!, headers, null, null)).toString('utf8'), f.url!);
    if (!list) return null;
    const segs = list.segments;
    const got: Buffer[] = new Array(segs.length);
    let next = 0;
    let done = 0;
    await Promise.all(
      Array.from({ length: Math.min(16, segs.length) }, async () => {
        while (next < segs.length) {
          const i = next++;
          got[i] = await get(segs[i].url, headers, null, null);
          done++;
          if (done % 20 === 0 || done === segs.length) onProgress?.((done / segs.length) * 100, `${done} of ${segs.length} pieces`);
        }
      }),
    );
    const fd = fs.openSync(tmp, 'w');
    try {
      if (list.init) fs.writeSync(fd, await get(list.init, headers, null, null));
      for (const b of got) fs.writeSync(fd, b);
    } finally {
      fs.closeSync(fd);
    }
    await run(config.ffmpeg, ['-y', '-v', 'error', '-i', tmp, '-map', '0:a:0', '-c', 'copy', '-f', 'mp4', out], { timeoutMs: 10 * 60_000 });
    console.log(`  [fast audio] ${segs.length} pieces · ${(got.reduce((n, x) => n + x.length, 0) / 1e6).toFixed(0)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return out;
  } catch (e) {
    console.warn(`  [fast audio] ${(e as Error).message.slice(0, 200)} — using yt-dlp`);
    fs.rmSync(out, { force: true });
    return null;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

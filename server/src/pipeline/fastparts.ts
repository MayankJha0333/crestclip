import fs from 'node:fs';
import path from 'node:path';
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
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

async function getRange(url: string, from: number, to: number, headers: Record<string, string>, dispatcher?: Dispatcher): Promise<Buffer> {
  const res = await undiciFetch(url, { headers: { ...headers, Range: `bytes=${from}-${to}` }, dispatcher, signal: AbortSignal.timeout(60_000) });
  if (res.status !== 206) throw new Error(`range request answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
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

async function fetchStream(f: Format, start: number, end: number, out: string, dispatcher: Dispatcher | undefined, onBytes: (n: number) => void): Promise<number> {
  const headers = f.http_headers ?? {};
  const head = await getRange(f.url!, 0, HEAD - 1, headers, dispatcher);
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
        got[i] = await getRange(f.url!, pieces[i].from, pieces[i].to, headers, dispatcher);
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
 * Fetch [start, end] of the video into `out` (an mp4 whose time 0 is `start`). Returns false when this video can't
 * be fetched this way, so the caller falls back to yt-dlp.
 */
export async function fetchPartFast(
  infoJson: string,
  range: { start: number; end: number },
  out: string,
  opts: { proxy?: string | null; onProgress?: (frac: number) => void } = {},
): Promise<boolean> {
  let formats: Format[];
  try {
    formats = (JSON.parse(fs.readFileSync(infoJson, 'utf8')) as { formats?: Format[] }).formats ?? [];
  } catch {
    return false;
  }
  const chosen = pick(formats);
  if (!chosen) return false;
  const dispatcher = opts.proxy ? new ProxyAgent(opts.proxy) : undefined;
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
    const [tv, ta] = await Promise.all([fetchStream(chosen.video, range.start, range.end, vFile, dispatcher, onBytes), fetchStream(chosen.audio, range.start, range.end, aFile, dispatcher, onBytes)]);
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
    return true;
  } catch (e) {
    console.warn(`  [fast parts] ${range.start}–${range.end}: ${(e as Error).message.slice(0, 200)} — using yt-dlp for this part`);
    fs.rmSync(out, { force: true });
    return false;
  } finally {
    fs.rmSync(vFile, { force: true });
    fs.rmSync(aFile, { force: true });
    await dispatcher?.close().catch(() => {});
  }
}

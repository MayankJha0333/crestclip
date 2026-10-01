import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { run } from '../lib/proc.js';
import type { Motion, ReframePlan, Word } from '../types.js';

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Crop position over time: holds like a human editor. At a camera cut the frame jumps;
 * within the same shot (speaker changes) it can glide there smoothly (`smooth`).
 */
function holdExpr(holds: { t: number; x: number; cut?: boolean }[], srcW: number, cropW: number, smooth = false) {
  const px = (x: number) => Math.round(clamp(x * srcW - cropW / 2, 0, srcW - cropW));
  const hs = holds.length ? holds : [{ t: 0, x: 0.5 }];
  let expr = String(px(hs[hs.length - 1].x));
  for (let i = hs.length - 2; i >= 0; i--) {
    const T = hs[i + 1].t;
    const a = px(hs[i].x);
    const b = px(hs[i + 1].x);
    const next = i + 2 < hs.length ? hs[i + 2].t : Infinity;
    const E = Math.min(0.55, (next - T) * 0.6);
    if (smooth && hs[i + 1].cut === false && E > 0.12 && a !== b) {
      const p = `((t-${T.toFixed(3)})/${E.toFixed(3)})`;
      const ease = `(${p}*${p}*(3-2*${p}))`;
      expr = `if(lt(t\\,${T.toFixed(3)})\\,${a}\\,if(lt(t\\,${(T + E).toFixed(3)})\\,${a}+(${b - a})*${ease}\\,${expr}))`;
    } else {
      expr = `if(lt(t\\,${T.toFixed(3)})\\,${a}\\,${expr})`;
    }
  }
  return expr;
}

export interface Zoom {
  t: number; // seconds from clip start
  z: number; // 1 = no zoom
}

/**
 * "Punch-in" zooms like a short-form editor: the frame jumps between a normal and a closer framing
 * at natural pauses, so talking-head clips feel cut and alive. Dynamic also opens with a quick zoom-out.
 */
export function planZooms(words: Word[], dur: number, motion: Motion): Zoom[] {
  if (motion === 'none' || dur < 4) return [];
  const spacing = motion === 'dynamic' ? 2.2 : 4.5;
  const levels = motion === 'dynamic' ? [1.0, 1.12, 1.0, 1.2] : [1.0, 1.08];
  const out: Zoom[] = [{ t: 0, z: levels[0] }];
  let li = 0;
  let last = 0;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const prev = words[i - 1];
    const pause = w.s - prev.e >= 0.25 || /[.!?,;:]$/.test(prev.w);
    if (!pause || w.s - last < spacing || w.s > dur - 1.2) continue;
    li = (li + 1) % levels.length;
    const t = Math.max(0, w.s - 0.04);
    out.push({ t: +t.toFixed(3), z: levels[li] });
    last = t;
  }
  return out;
}

function zoomExpr(zooms: Zoom[], intro: boolean) {
  let expr = zooms.length ? zooms[zooms.length - 1].z.toFixed(3) : '1';
  for (let i = zooms.length - 2; i >= 0; i--) expr = `if(lt(it\\,${zooms[i + 1].t.toFixed(3)})\\,${zooms[i].z.toFixed(3)}\\,${expr})`;
  if (intro) expr = `if(lt(it\\,0.5)\\,1.18-0.18*(it/0.5)*(2-it/0.5)\\,${expr})`; // quick ease-out zoom on the hook
  return expr;
}

function buildVideoGraph(plan: ReframePlan, w: number, h: number, smooth = false): string {
  const layout = plan.layout;
  const cw = even((h * 9) / 16);

  if (layout === 'fit' || (layout === 'split' && !plan.splitCenters)) {
    return [
      `[0:v]split=2[bgsrc][fgsrc]`,
      `[bgsrc]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=28:3,eq=brightness=-0.07:saturation=1.15[bg]`,
      `[fgsrc]scale=1080:-2:flags=lanczos[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2-90,setsar=1[v0]`,
    ].join(';');
  }

  if (layout === 'split' && plan.splitCenters) {
    let hc = even(h * 0.84);
    let wc = even((hc * 9) / 8);
    if (wc > w) {
      wc = even(w);
      hc = even((wc * 8) / 9);
    }
    const fy = plan.faceY ?? 0.42;
    const y = Math.round(clamp(fy * h - hc * 0.42, 0, h - hc));
    const x = (c: number) => Math.round(clamp(c * w - wc / 2, 0, w - wc));
    return [
      `[0:v]split=2[ta][tb]`,
      `[ta]crop=${wc}:${hc}:${x(plan.splitCenters[0])}:${y},scale=1080:960:flags=lanczos,setsar=1[top]`,
      `[tb]crop=${wc}:${hc}:${x(plan.splitCenters[1])}:${y},scale=1080:960:flags=lanczos,setsar=1[bot]`,
      `[top][bot]vstack=inputs=2,drawbox=x=0:y=955:w=1080:h=10:color=0xFFF7EC@1:t=fill[v0]`,
    ].join(';');
  }

  // fill (face-tracked crop)
  if (cw >= w) {
    return `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[v0]`;
  }
  return `[0:v]crop=w=${cw}:h=${even(h)}:x='${holdExpr(plan.holds, w, cw, smooth)}':y=0,scale=1080:1920:flags=lanczos,setsar=1[v0]`;
}

export async function renderClip(opts: {
  src: string;
  start: number;
  end: number;
  width: number;
  height: number;
  hasAudio: boolean;
  plan: ReframePlan;
  assContent: string | null;
  workDir: string;
  out: string;
  onProgress?: (pct: number) => void;
  motion?: Motion;
  zooms?: Zoom[];
  introZoom?: boolean;
}) {
  const { workDir } = opts;
  fs.mkdirSync(workDir, { recursive: true });
  const dur = Math.max(0.5, opts.end - opts.start);

  const motion = opts.motion ?? 'none';
  let graph = buildVideoGraph(opts.plan, opts.width, opts.height, motion !== 'none');
  let vOut = '[v0]';
  // punch-in zooms (not on split screen — it would cut the two halves)
  const zooms = opts.zooms ?? [];
  const wantZoom = motion !== 'none' && opts.plan.layout !== 'split' && (zooms.some((z) => z.z !== 1) || opts.introZoom);
  if (wantZoom) {
    const fy = opts.plan.layout === 'fit' ? 0.5 : 0.4; // keep faces in frame when zooming a crop
    graph += `;[v0]fps=30,zoompan=z='${zoomExpr(zooms, Boolean(opts.introZoom))}':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)*${fy}':d=1:s=1080x1920:fps=30[vz]`;
    vOut = '[vz]';
  }
  if (opts.assContent) {
    fs.writeFileSync(path.join(workDir, 'captions.ass'), opts.assContent);
    const fontsLink = path.join(workDir, 'fonts');
    if (!fs.existsSync(fontsLink)) {
      try {
        fs.symlinkSync(config.fontsDir, fontsLink, 'dir');
      } catch {
        fs.cpSync(config.fontsDir, fontsLink, { recursive: true });
      }
    }
    graph += `;${vOut}ass=captions.ass:fontsdir=fonts[v1]`;
    vOut = '[v1]';
  }
  graph += `;${vOut}fps=30,format=yuv420p[v]`;
  if (opts.hasAudio) graph += `;[0:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a]`;

  const tmp = path.join(workDir, `render_${Date.now()}.mp4`);
  const args = [
    '-y', '-v', 'info', '-nostats', '-progress', 'pipe:1',
    '-ss', opts.start.toFixed(3), '-t', dur.toFixed(3), '-i', opts.src,
    '-filter_complex', graph,
    '-map', '[v]', ...(opts.hasAudio ? ['-map', '[a]'] : []),
    '-c:v', 'libx264', '-preset', config.x264Preset, '-crf', '20', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    ...(opts.hasAudio ? ['-c:a', 'aac', '-b:a', '160k'] : []),
    '-movflags', '+faststart', '-t', dur.toFixed(3),
    tmp,
  ];
  try {
    await run(config.ffmpeg, args, {
      cwd: workDir,
      timeoutMs: 45 * 60 * 1000,
      onLine: (line, stream) => {
        if (stream !== 'stdout') return;
        const m = line.match(/^out_time_ms=(\d+)/);
        if (m && opts.onProgress) opts.onProgress(Math.min(100, (Number(m[1]) / 1e6 / dur) * 100));
      },
    });
  } catch (e) {
    // keep the full ffmpeg output for debugging (the work dir is deleted afterwards)
    try {
      const logDir = path.join(config.dataDir, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const err = e as Error & { stderr?: string };
      fs.writeFileSync(path.join(logDir, `render-${Date.now()}.log`), `${config.ffmpeg}\n${args.join(' ')}\n\n${err.stderr ?? err.message}`);
    } catch {
      /* ignore */
    }
    throw e;
  }
  fs.renameSync(tmp, opts.out);
}

/** Join rendered parts (same size/codec) into one clip. */
export async function concatParts(files: string[], out: string, workDir: string) {
  const list = path.join(workDir, 'parts.txt');
  fs.writeFileSync(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  await run(config.ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out], { timeoutMs: 10 * 60 * 1000 });
}

/**
 * Lay background music under the clip: loops the track, fades it in/out, and (duck) pushes it down
 * whenever someone is talking, so the voice always stays clear. Video is copied, not re-encoded.
 */
export async function mixMusic(opts: { input: string; music: string; volume: number; duck: boolean; hasVoice: boolean; duration: number; out: string }) {
  const D = Math.max(1, opts.duration);
  const gain = Math.max(0, Math.min(2, (opts.volume / 100) * 1.6));
  const fadeOut = Math.min(1.8, D / 4);
  const m = `[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=0:${D.toFixed(3)},asetpts=PTS-STARTPTS,volume=${gain.toFixed(3)},afade=t=in:st=0:d=0.8,afade=t=out:st=${(D - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}[m]`;
  const tail = 'alimiter=limit=0.95:level=disabled,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a]';
  let graph: string;
  if (!opts.hasVoice) graph = `${m};[m]${tail}`;
  else if (opts.duck)
    graph = `${m};[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asplit=2[v1][v2];[m][v2]sidechaincompress=threshold=0.03:ratio=4:attack=20:release=400:makeup=1[md];[v1][md]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,${tail}`;
  else graph = `${m};[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[v1];[v1][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,${tail}`;
  await run(
    config.ffmpeg,
    ['-y', '-v', 'error', '-i', opts.input, '-stream_loop', '-1', '-i', opts.music, '-filter_complex', graph, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', D.toFixed(3), '-movflags', '+faststart', opts.out],
    { timeoutMs: 10 * 60 * 1000 },
  );
}

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { run } from '../lib/proc.js';
import type { Motion, ReframePlan, Word } from '../types.js';
import { probe } from './media.js';
import { MAX_BAND_ZOOM } from './reframe.js';
import { watermarkFilter, type Watermark } from './watermark.js';

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

interface Zoom {
  t: number; // seconds from clip start
  z: number; // 1 = no zoom
}

/**
 * "Punch-in" zooms like a short-form editor: the frame jumps between a normal and a closer framing
 * at natural pauses, so talking-head clips feel cut and alive. Dynamic also opens with a quick zoom-out.
 * Every jump cut (a removed pause) also gets a zoom change, which hides the jump in the picture.
 */
export function planZooms(words: Word[], dur: number, motion: Motion, jumpCuts: number[] = []): Zoom[] {
  if (motion === 'none' || dur < 4) return [];
  const spacing = motion === 'dynamic' ? 2.2 : 4.5;
  const levels = motion === 'dynamic' ? [1.0, 1.12, 1.0, 1.2] : [1.0, 1.08];
  const cuts = jumpCuts.filter((t) => t > 0.3 && t < dur - 0.3);
  const forced = new Set(cuts);
  const events = [...cuts];
  let last = -Infinity;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const prev = words[i - 1];
    const pause = w.s - prev.e >= 0.25 || /[.!?,;:]$/.test(prev.w);
    const t = Math.max(0, w.s - 0.04);
    if (!pause || t - last < spacing || w.s > dur - 1.2 || cuts.some((c) => Math.abs(c - t) < 1)) continue;
    events.push(t);
    last = t;
  }
  events.sort((a, b) => a - b);
  const out: Zoom[] = [{ t: 0, z: levels[0] }];
  let li = 0;
  let prevT = 0;
  for (const t of events) {
    if (t - prevT < 0.5 && !forced.has(t)) continue;
    li = (li + 1) % levels.length;
    out.push({ t: +t.toFixed(3), z: levels[li] });
    prevT = t;
  }
  return out;
}

function zoomExpr(zooms: Zoom[], intro: boolean) {
  let expr = zooms.length ? zooms[zooms.length - 1].z.toFixed(3) : '1';
  for (let i = zooms.length - 2; i >= 0; i--) expr = `if(lt(it\\,${zooms[i + 1].t.toFixed(3)})\\,${zooms[i].z.toFixed(3)}\\,${expr})`;
  if (intro) expr = `if(lt(it\\,0.5)\\,1.18-0.18*(it/0.5)*(2-it/0.5)\\,${expr})`; // quick ease-out zoom on the hook
  return expr;
}

/**
 * The "fill" crop window on the source: full height, or — when the video has empty dark borders above/below
 * (plan.band) — a shorter window around the picture, so the borders are cut away and the subject fills the frame.
 */
export function fillWindow(plan: Pick<ReframePlan, 'band'>, h: number) {
  const band = plan.band;
  if (!band) return { ch: even(h), y: 0 };
  const ch = even(Math.min(h, Math.max((band.bottom - band.top) * h, h / MAX_BAND_ZOOM)));
  const mid = ((band.top + band.bottom) / 2) * h;
  return { ch, y: Math.round(clamp(mid - ch / 2, 0, h - ch)) };
}

/** Where the speaker's face lands on the finished 9:16 frame (0 = top, 1 = bottom), when known. */
export function faceOnFrame(plan: ReframePlan, h: number): number | null {
  if (plan.layout !== 'fill' || plan.faceY == null) return null;
  const { ch, y } = fillWindow(plan, h);
  return clamp((plan.faceY * h - y) / ch, 0, 1);
}

function buildVideoGraph(plan: ReframePlan, w: number, h: number, smooth = false): string {
  const layout = plan.layout;
  const cw = even((h * 9) / 16);

  if (layout === 'fit' || (layout === 'split' && !plan.splitCenters)) {
    return [
      `[0:v]split=2[bgsrc][fgsrc]`,
      // the blurred backdrop is made at a quarter size and scaled back up: a blur this heavy looks the same, and it
      // costs a fraction of blurring 1080×1920 pixels on every frame
      `[bgsrc]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=7:3,eq=brightness=-0.07:saturation=1.15,scale=1080:1920:flags=bilinear[bg]`,
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
  const win = fillWindow(plan, h); // shorter than the full height when there are empty borders to cut away
  const fw = even((win.ch * 9) / 16);
  return `[0:v]crop=w=${fw}:h=${win.ch}:x='${holdExpr(plan.holds, w, fw, smooth)}':y=${win.y},scale=1080:1920:flags=lanczos,setsar=1[v0]`;
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
  /** the person's logo, stamped under the captions */
  watermark?: (Watermark & { file: string }) | null;
  /** pieces to keep, in play order (seconds from `start`); omitted = the whole range, uncut */
  keep?: { s: number; e: number }[];
  /** emoji images shown above the captions (times on the edited clip) */
  emojis?: { file: string; s: number; e: number }[];
  captionY?: number;
  /** final height (1920 = full HD; 1280 = 720p for the Free plan). Everything is drawn at 1920 first. */
  exportHeight?: number;
}) {
  const { workDir } = opts;
  fs.mkdirSync(workDir, { recursive: true });
  const dur = Math.max(0.5, opts.end - opts.start);
  const keep = opts.keep?.length ? opts.keep : null;
  // the clip is a whole number of frames, and the sound is made exactly that long too — so parts joined later
  // (flash-forward, several ranges, music) line up to the millisecond
  const frames = Math.max(1, Math.round((keep ? keep.reduce((a, k) => a + k.e - k.s, 0) : dur) * 30));
  const outDur = frames / 30;

  const motion = opts.motion ?? 'none';
  let graph = buildVideoGraph(opts.plan, opts.width, opts.height, motion !== 'none');
  let vOut = '[v0]';
  let aIn = '[0:a]';
  // jump cuts: keep only the listed pieces and join them (crop/face tracking above still uses source time)
  if (keep) {
    const n = keep.length;
    const ids = keep.map((_, i) => i);
    graph += `;[v0]fps=30,split=${n}${ids.map((i) => `[ks${i}]`).join('')}`;
    graph += ids.map((i) => `;[ks${i}]trim=start=${keep[i].s.toFixed(3)}:end=${keep[i].e.toFixed(3)},setpts=PTS-STARTPTS[kc${i}]`).join('');
    graph += `;${ids.map((i) => `[kc${i}]`).join('')}concat=n=${n}:v=1:a=0[vk]`;
    vOut = '[vk]';
    if (opts.hasAudio) {
      // a 12 ms fade at each edge so the joins don't click
      graph += `;[0:a]asplit=${n}${ids.map((i) => `[as${i}]`).join('')}`;
      graph += ids
        .map((i) => {
          const len = keep[i].e - keep[i].s;
          const f = Math.min(0.012, len / 4).toFixed(3);
          return `;[as${i}]atrim=start=${keep[i].s.toFixed(3)}:end=${keep[i].e.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${f},afade=t=out:st=${(len - Number(f)).toFixed(3)}:d=${f}[ac${i}]`;
        })
        .join('');
      graph += `;${ids.map((i) => `[ac${i}]`).join('')}concat=n=${n}:v=0:a=1[ak]`;
      aIn = '[ak]';
    }
  }
  // punch-in zooms (not on split screen — it would cut the two halves)
  const zooms = opts.zooms ?? [];
  const wantZoom = motion !== 'none' && opts.plan.layout !== 'split' && (zooms.some((z) => z.z !== 1) || opts.introZoom);
  if (wantZoom) {
    const fy = opts.plan.layout === 'fit' ? 0.5 : 0.4; // keep faces in frame when zooming a crop
    graph += `;${vOut}fps=30,zoompan=z='${zoomExpr(zooms, Boolean(opts.introZoom))}':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)*${fy}':d=1:s=1080x1920:fps=30[vz]`;
    vOut = '[vz]';
  }
  if (opts.watermark) {
    graph += `;${watermarkFilter(opts.watermark, 1, vOut, '[vw]')}`;
    vOut = '[vw]';
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
  // emoji over the captions: each one fades in and out while its line is on screen
  const emojis = opts.emojis ?? [];
  const firstEmoji = 1 + (opts.watermark ? 1 : 0);
  emojis.forEach((em, j) => {
    const y = Math.round((opts.captionY ?? 1180) - 235);
    const f = Math.min(0.12, (em.e - em.s) / 3).toFixed(3);
    graph += `;[${firstEmoji + j}:v]format=rgba,fade=t=in:st=${em.s.toFixed(3)}:d=${f}:alpha=1,fade=t=out:st=${(em.e - Number(f)).toFixed(3)}:d=${f}:alpha=1[em${j}]`;
    graph += `;${vOut}[em${j}]overlay=x=(W-w)/2:y=${y}:enable='between(t\\,${em.s.toFixed(3)}\\,${em.e.toFixed(3)})':format=auto[ve${j}]`;
    vOut = `[ve${j}]`;
  });
  const h = opts.exportHeight && opts.exportHeight < 1920 ? opts.exportHeight : null;
  graph += `;${vOut}fps=30,tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${frames},${h ? `scale=${Math.round((h * 9) / 32) * 2}:${h}:flags=lanczos,` : ''}format=yuv420p[v]`;
  if (opts.hasAudio)
    graph += `;${aIn}loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,apad=whole_dur=${outDur.toFixed(4)},atrim=end=${outDur.toFixed(4)}[a]`;

  const tmp = path.join(workDir, `render_${Date.now()}.mp4`);
  const args = [
    '-y',
    '-v',
    'info',
    '-nostats',
    '-progress',
    'pipe:1',
    '-ss',
    opts.start.toFixed(3),
    '-t',
    dur.toFixed(3),
    '-i',
    opts.src,
    ...(opts.watermark ? ['-i', opts.watermark.file] : []),
    ...emojis.flatMap((em) => ['-loop', '1', '-framerate', '30', '-t', outDur.toFixed(3), '-i', em.file]),
    '-filter_complex',
    graph,
    '-map',
    '[v]',
    ...(opts.hasAudio ? ['-map', '[a]'] : []),
    '-c:v',
    'libx264',
    '-preset',
    config.x264Preset,
    '-crf',
    '20',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    ...(opts.hasAudio ? ['-c:a', 'aac', '-b:a', '160k'] : []),
    '-movflags',
    '+faststart',
    '-t',
    outDur.toFixed(3),
    tmp,
  ];
  try {
    await run(config.ffmpeg, args, {
      cwd: workDir,
      timeoutMs: 45 * 60 * 1000,
      onLine: (line, stream) => {
        if (stream !== 'stdout') return;
        const m = line.match(/^out_time_ms=(\d+)/);
        if (m && opts.onProgress) opts.onProgress(Math.min(100, (Number(m[1]) / 1e6 / outDur) * 100));
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

/**
 * Join rendered parts (same size/codec) into one clip. The picture is copied as is; the sound is decoded and joined
 * sample-exact (copying AAC across files shifts it by its start-up padding at every join — the sound would run a
 * few dozen ms behind the picture after a flash-forward).
 */
export async function concatParts(files: string[], out: string, workDir: string) {
  const withSound = (
    await Promise.all(
      files.map((f) =>
        probe(f)
          .then((x) => x.hasAudio)
          .catch(() => false),
      ),
    )
  ).every(Boolean);
  // picture-only copies first: when a file still has sound, the joiner shifts its picture by the sound's padding too
  const pictures = withSound
    ? await Promise.all(
        files.map(async (f, i) => {
          const v = path.join(workDir, `join_v${i}.mp4`);
          await run(config.ffmpeg, ['-y', '-v', 'error', '-i', f, '-map', '0:v', '-c', 'copy', '-an', v], { timeoutMs: 5 * 60 * 1000 });
          return v;
        }),
      )
    : files;
  const list = path.join(workDir, 'parts.txt');
  fs.writeFileSync(list, pictures.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  // each part's sound cut to its picture's length (the encoder pads the last bit of sound, which would add up)
  const lens = withSound ? await Promise.all(pictures.map((v) => probe(v).then((x) => x.duration))) : [];
  const args = withSound
    ? [
        ...['-f', 'concat', '-safe', '0', '-i', list],
        ...files.flatMap((f) => ['-i', f]),
        '-filter_complex',
        `${files.map((_, i) => `[${i + 1}:a]atrim=end=${lens[i].toFixed(4)},asetpts=PTS-STARTPTS[j${i}]`).join(';')};${files.map((_, i) => `[j${i}]`).join('')}concat=n=${files.length}:v=0:a=1[a]`,
        ...['-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k'],
      ]
    : ['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy'];
  await run(config.ffmpeg, ['-y', '-v', 'error', ...args, '-movflags', '+faststart', out], { timeoutMs: 10 * 60 * 1000 });
}

/**
 * Lay background music under the clip: loops the track, fades it in/out, and (duck) pushes it down
 * whenever someone is talking, so the voice always stays clear. Video is copied, not re-encoded.
 */
/** `sourceVolume`: how loud the clip's own sound stays under the music (1 = as is; no-speech clips use 0.8). */
export async function mixMusic(opts: { input: string; music: string; volume: number; duck: boolean; hasVoice: boolean; duration: number; out: string; sourceVolume?: number }) {
  const D = Math.max(1, opts.duration);
  const gain = Math.max(0, Math.min(2, (opts.volume / 100) * 1.6));
  const fadeOut = Math.min(1.8, D / 4);
  const src = Math.max(0, Math.min(1, opts.sourceVolume ?? 1));
  const m = `[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=0:${D.toFixed(3)},asetpts=PTS-STARTPTS,volume=${gain.toFixed(3)},afade=t=in:st=0:d=0.8,afade=t=out:st=${(D - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}[m]`;
  const tail = 'alimiter=limit=0.95:level=disabled:latency=1,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a]';
  let graph: string;
  if (!opts.hasVoice) graph = `${m};[m]${tail}`;
  else if (opts.duck)
    graph = `${m};[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asplit=2[v1][v2];[m][v2]sidechaincompress=threshold=0.03:ratio=4:attack=20:release=400:makeup=1[md];[v1]volume=${src.toFixed(2)}[v1s];[v1s][md]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,${tail}`;
  else graph = `${m};[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${src.toFixed(2)}[v1];[v1][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,${tail}`;
  await run(
    config.ffmpeg,
    [
      '-y',
      '-v',
      'error',
      '-i',
      opts.input,
      '-stream_loop',
      '-1',
      '-i',
      opts.music,
      '-filter_complex',
      graph,
      '-map',
      '0:v',
      '-map',
      '[a]',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-t',
      D.toFixed(3),
      '-movflags',
      '+faststart',
      opts.out,
    ],
    { timeoutMs: 10 * 60 * 1000 },
  );
}

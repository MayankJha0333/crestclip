import './lib/quiet.js';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { optionsSchema } from './options.js';
import { aiReady, config } from './config.js';
import { clips, posts, projects, type ClipRow, type ProjectRow } from './db.js';
import { checkGemini } from './pipeline/gemini.js';
import { ffmpegVersion } from './pipeline/media.js';
import { lengthRange, RUBRIC_WEIGHTS } from './pipeline/moments.js';
import { clipParts, createPickedClips, preparePickedClips, projectDir, toMediaUrl } from './pipeline/process.js';
import { enqueueJob, enqueueProject, enqueueRender, resumeUnfinished } from './queue.js';
import { addUpload, generateMood, lyriaStatus, musicLibrary, removeUpload } from './pipeline/music.js';
import { exploreRouter, warmExplore } from './explore.js';
import { footageSavings, readFootage } from './pipeline/footage.js';
import { classifyFileLink, fileLinkLabel } from './pipeline/filelink.js';
import { applyInstructions } from './pipeline/instructions.js';
import { publishRouter, startScheduler } from './publish.js';
import { startLocalHttps } from './localhttps.js';
import { autopilotRouter } from './autopilot/routes.js';
import { startAutopilot } from './autopilot/engine.js';
import { ensureFfmpeg, ensureYtdlp, ffStatus, startToolUpkeep, ytStatus } from './tools.js';
import { hasLibass } from './pipeline/media.js';
import type { ProjectOptions } from './types.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

// ---------- helpers ----------


/** The original video, if a full copy is on disk (uploads, short links). Long links only keep the clip parts. */
function sourceVideoUrl(p: ProjectRow): string | null {
  if (!p.mediaPath || !fs.existsSync(p.mediaPath) || /source-audio\./.test(p.mediaPath)) return null;
  if (readFootage(projectDir(p.id))) return null;
  return toMediaUrl(p.mediaPath);
}

function publicProject(p: ProjectRow, withDetail = false) {
  return {
    id: p.id,
    createdAt: p.createdAt,
    sourceType: p.sourceType,
    parentId: p.parentId,
    sourceUrl: p.sourceUrl,
    title: p.title,
    channel: p.channel,
    duration: p.duration,
    width: p.width,
    height: p.height,
    viewCount: p.viewCount,
    status: p.status,
    stage: p.stage,
    stageDetail: p.stageDetail,
    progress: p.progress,
    error: p.error,
    options: p.options,
    thumbUrl: toMediaUrl(p.thumbPath),
    ...(withDetail
      ? {
          download: footageSavings(projectDir(p.id)),
          aiNotes: p.aiNotes,
          signals: p.signals
            ? {
                sources: p.signals.sources,
                curve: p.signals.curve,
                curveKind: p.signals.curveKind,
                hotspots: p.signals.hotspots,
                chapters: p.signals.chapters,
                hasHeatmap: Boolean(p.signals.heatmap?.length),
              }
            : null,
          hasTranscript: Boolean(p.transcript?.length),
          sourceVideoUrl: sourceVideoUrl(p),
        }
      : {}),
  };
}

/** A multi-video project: its status, progress and numbers come from the videos inside it. */
function groupSummary(g: ProjectRow) {
  const kids = projects.children(g.id);
  const busy = kids.some((k) => k.status === 'queued' || k.status === 'processing');
  const failed = kids.length > 0 && kids.every((k) => k.status === 'failed');
  const all = kids.flatMap((k) => clips.forProject(k.id));
  const first = kids.find((k) => k.thumbPath) ?? kids[0];
  const named = kids.filter((k) => k.title);
  const title = g.title || (named.length ? `${named[0].title}${kids.length > 1 ? ` + ${kids.length - 1} more` : ''}` : `${kids.length} videos`);
  const working = kids.find((k) => k.status === 'processing');
  return {
    kids,
    all,
    view: {
      ...publicProject(g),
      title,
      status: busy ? 'processing' : failed ? 'failed' : 'done',
      stage: busy ? 'processing' : 'done',
      progress: kids.length ? kids.reduce((a, k) => a + (k.status === 'done' || k.status === 'failed' ? 100 : k.progress), 0) / kids.length : 100,
      stageDetail: busy
        ? `${kids.filter((k) => k.status === 'done').length} of ${kids.length} videos done${working?.stageDetail ? ` · ${working.stageDetail}` : ''}`
        : failed
          ? 'All videos failed'
          : `${kids.length} videos`,
      error: failed ? kids[0]?.error ?? null : null,
      duration: kids.reduce((a, k) => a + (k.duration ?? 0), 0) || null,
      thumbUrl: first ? toMediaUrl(first.thumbPath) : null,
      videoCount: kids.length,
      clipCount: all.length,
      readyCount: all.filter((c) => c.status === 'ready').length,
      bestScore: all.length ? Math.max(...all.map((c) => c.peakScore)) : null,
    },
  };
}

function publicGroup(g: ProjectRow) {
  const { kids, all, view } = groupSummary(g);
  const index = new Map(kids.map((k, i) => [k.id, i]));
  return {
    ...view,
    parts: kids.map((k, i) => ({
      ...publicProject(k),
      index: i + 1,
      clipCount: all.filter((c) => c.projectId === k.id).length,
      readyCount: all.filter((c) => c.projectId === k.id && c.status === 'ready').length,
    })),
    clips: all.map((c) => ({ ...publicClip(c), part: (index.get(c.projectId) ?? 0) + 1 })),
  };
}

function publicClip(c: ClipRow) {
  return {
    id: c.id,
    projectId: c.projectId,
    start: c.start,
    end: c.end,
    duration: +clipParts(c)
      .reduce((a, r) => a + r.end - r.start, 0)
      .toFixed(2),
    segments: c.segments,
    posts: posts.forClip(c.id).map((p) => ({ id: p.id, platform: p.platform, status: p.status, scheduledAt: p.scheduledAt, remoteUrl: p.remoteUrl, error: p.error })),
    motion: c.motion,
    music: c.music,
    source: c.source,
    title: c.title,
    hook: c.hook,
    description: c.description,
    hashtags: c.hashtags,
    reason: c.reason,
    category: c.category,
    rubric: c.rubric,
    aiScore: c.aiScore,
    audienceScore: c.audienceScore,
    peakScore: c.peakScore,
    layout: c.layout,
    appliedLayout: c.reframe?.layout ?? null,
    captionStyle: c.captionStyle,
    showHook: c.showHook,
    status: c.status,
    error: c.error,
    videoUrl: toMediaUrl(c.filePath),
    thumbUrl: toMediaUrl(c.thumbPath),
    version: c.version,
  };
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

// ---------- API ----------
let geminiStatus: { ok: boolean; detail: string; checkedAt: number } | null = null;
app.get(
  '/api/health',
  wrap(async (req, res) => {
    if (!geminiStatus || req.query.refresh || Date.now() - geminiStatus.checkedAt > 10 * 60 * 1000) {
      geminiStatus = { ...(await checkGemini()), checkedAt: Date.now() };
    }
    const [ff, captions] = await Promise.all([ffmpegVersion(), hasLibass()]);
    res.json({
      ok: Boolean(ff) && geminiStatus.ok,
      gemini: { ...geminiStatus, project: config.gcpProject || null, location: config.gcpLocation, model: config.model, fastModel: config.fastModel, fake: config.fakeAi },
      gcsBucket: config.gcsBucket || null,
      ffmpeg: ff,
      ffmpegSource: config.ffmpegSource,
      ffmpegStatus: { ...ffStatus },
      captions,
      ytdlp: ytStatus.version,
      ytdlpStatus: { state: ytStatus.state, source: ytStatus.source, detail: ytStatus.detail, checkedAt: ytStatus.checkedAt },
      rubricWeights: RUBRIC_WEIGHTS,
    });
  }),
);

// Re-check / repair the managed tools (used by the "Try again" button in the app)
app.post(
  '/api/tools/refresh',
  wrap(async (_req, res) => {
    await Promise.all([ensureYtdlp(true), ensureFfmpeg()]);
    res.json({ ytdlp: ytStatus, ffmpeg: ffStatus });
  }),
);

app.get('/api/projects', (_req, res) => {
  res.json(
    projects.list().map((p) =>
      p.sourceType === 'group' ? groupSummary(p).view : { ...publicProject(p), clipCount: p.clipCount, readyCount: p.readyCount, bestScore: p.bestScore },
    ),
  );
});

/** One project from one link. Drive / Dropbox / OneDrive / direct .mp4 are downloaded as plain files (like uploads). */
function projectFromLink(url: string, options: ProjectOptions, parentId: string | null = null) {
  const file = classifyFileLink(url);
  if (file && 'error' in file) throw Object.assign(new Error(file.error), { status: 400 });
  const opts = { ...options };
  delete opts.ranges;
  return file
    ? projects.create({ sourceType: 'upload', sourceUrl: url, title: `Video from ${fileLinkLabel[file.kind]}`, options: opts, parentId })
    : projects.create({ sourceType: 'url', sourceUrl: url, options: opts, parentId });
}

app.post(
  '/api/projects',
  wrap(async (req, res) => {
    const body = z.object({ url: z.string().url(), options: optionsSchema.default({}) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Please paste a valid video link (https://…).' });
    if (!aiReady()) return res.status(400).json({ error: 'Gemini is not configured yet. Set VERTEX_API_KEY or GOOGLE_CLOUD_PROJECT in .env and restart.' });
    try {
      const options = await applyInstructions(body.data.options as ProjectOptions);
      const p = projectFromLink(body.data.url, options);
      enqueueProject(p.id);
      res.status(201).json(publicProject(p));
    } catch (e) {
      res.status((e as { status?: number }).status ?? 500).json({ error: (e as Error).message });
    }
  }),
);

/** Several links at once (same settings + instructions) → one project per link. */
app.post(
  '/api/projects/batch',
  wrap(async (req, res) => {
    const body = z.object({ urls: z.array(z.string().url()).min(1).max(20), options: optionsSchema.default({}) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Check the links — each must be a full https:// link (up to 20).' });
    if (!aiReady()) return res.status(400).json({ error: 'Gemini is not configured yet. Set VERTEX_API_KEY or GOOGLE_CLOUD_PROJECT in .env and restart.' });
    const urls = [...new Set(body.data.urls.map((u) => u.trim()))];
    for (const u of urls) {
      const f = classifyFileLink(u);
      if (f && 'error' in f) return res.status(400).json({ error: `${u.slice(0, 60)}… — ${f.error}` });
    }
    const options = await applyInstructions(body.data.options as ProjectOptions); // read the instructions once for all links
    // several links = ONE project that holds every video (each video is still clipped on its own)
    const group = urls.length > 1 ? projects.create({ sourceType: 'group', options }) : null;
    const made = urls.map((u) => projectFromLink(u, options, group?.id ?? null));
    for (const p of made) enqueueProject(p.id);
    res.status(201).json({
      project: group ? groupSummary(projects.get(group.id)!).view : publicProject(made[0]),
      projects: made.map((p) => publicProject(p)),
      understood: {
        minSeconds: options.minSeconds ?? null,
        maxSeconds: options.maxSeconds ?? null,
        tags: [...(options.requiredMentions ?? []), ...(options.requiredHashtags ?? [])],
        rules: options.rules ?? [],
      },
    });
  }),
);

const uploadTmp = path.join(config.dataDir, 'uploads');
fs.mkdirSync(uploadTmp, { recursive: true });
const upload = multer({
  dest: uploadTmp,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^video\//.test(file.mimetype) || /\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(file.originalname)),
});
app.post(
  '/api/projects/upload',
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Please choose a video file (mp4, mov, mkv, webm).' });
    if (!aiReady()) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(400).json({ error: 'Gemini is not configured yet. Set GOOGLE_CLOUD_PROJECT in .env and restart.' });
    }
    let opts: unknown = {};
    try {
      opts = JSON.parse(String(req.body.options ?? '{}'));
    } catch {
      /* default */
    }
    const parsed = optionsSchema.safeParse(opts);
    const options = await applyInstructions((parsed.success ? parsed.data : optionsSchema.parse({})) as ProjectOptions);
    const title = req.file.originalname.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 120);
    const p = projects.create({ sourceType: 'upload', title, options });
    const dir = projectDir(p.id);
    fs.mkdirSync(dir, { recursive: true });
    const ext = (path.extname(req.file.originalname) || '.mp4').toLowerCase();
    const dest = path.join(dir, `source${ext}`);
    fs.renameSync(req.file.path, dest);
    projects.update(p.id, { mediaPath: dest });
    enqueueProject(p.id);
    res.status(201).json(publicProject(projects.get(p.id)!));
  }),
);

app.get('/api/projects/:id', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (p.sourceType === 'group') return res.json(publicGroup(p));
  res.json({ ...publicProject(p, true), clips: clips.forProject(p.id).map(publicClip) });
});

app.post('/api/projects/:id/retry', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const list = p.sourceType === 'group' ? projects.children(p.id).filter((k) => k.status === 'failed') : [p];
  for (const k of list) {
    projects.update(k.id, { status: 'queued', error: null, stage: 'queued', progress: 0 });
    enqueueProject(k.id);
  }
  res.json({ ok: true });
});

app.delete('/api/projects/:id', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const kids = p.sourceType === 'group' ? projects.children(p.id) : [];
  if (p.status === 'processing' || kids.some((k) => k.status === 'processing'))
    return res.status(409).json({ error: 'Wait for this project to finish before deleting it.' });
  for (const k of [...kids, p]) {
    projects.remove(k.id);
    fs.rmSync(projectDir(k.id), { recursive: true, force: true });
  }
  res.json({ ok: true });
});

// transcript words around a clip (for the trim editor)
app.get('/api/clips/:id/transcript', (req, res) => {
  const c = clips.get(req.params.id);
  const p = c && projects.get(c.projectId);
  if (!c || !p) return res.status(404).json({ error: 'Clip not found' });
  const pad = 30;
  const segs = (p.transcript ?? []).filter((s) => s.e >= c.start - pad && s.s <= c.end + pad).map((s) => ({ s: s.s, e: s.e, text: s.text, speaker: s.speaker }));
  res.json({ start: c.start, end: c.end, duration: p.duration, segments: segs });
});

const clipPatch = z.object({
  title: z.string().max(140).optional(),
  hook: z.string().max(90).optional(),
  description: z.string().max(2200).optional(),
  hashtags: z.array(z.string().max(60)).max(15).optional(),
  start: z.number().min(0).optional(),
  end: z.number().min(0).optional(),
  layout: z.enum(['auto', 'fill', 'fit', 'split']).optional(),
  captionStyle: z.enum(['pop', 'clay', 'neon', 'comic', 'minimal', 'none']).optional(),
  showHook: z.boolean().optional(),
  motion: z.enum(['none', 'subtle', 'dynamic']).optional(),
  music: z
    .object({ track: z.string().max(40), volume: z.number().min(0).max(100), duck: z.boolean() })
    .optional(),
});
const RENDER_KEYS = ['hook', 'start', 'end', 'layout', 'captionStyle', 'showHook', 'motion', 'music'] as const;

app.patch('/api/clips/:id', (req, res) => {
  const c = clips.get(req.params.id);
  const p = c && projects.get(c.projectId);
  if (!c || !p) return res.status(404).json({ error: 'Clip not found' });
  const body = clipPatch.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid edit' });
  const patch: typeof body.data & { segments?: { start: number; end: number }[] | null } = { ...body.data };
  const dur = p.duration || Infinity;
  const start = Math.max(0, patch.start ?? c.start);
  const end = Math.min(dur, patch.end ?? c.end);
  if (c.segments?.length) {
    // joined clip: trimming moves the start of the first part and the end of the last part
    const segs = c.segments.map((r) => ({ ...r }));
    segs[0].start = +start.toFixed(3);
    segs[segs.length - 1].end = +end.toFixed(3);
    if (segs.some((r) => r.end - r.start < 1)) return res.status(400).json({ error: 'Each part must stay at least 1 second long.' });
    const total = segs.reduce((a, r) => a + r.end - r.start, 0);
    if (total > 180) return res.status(400).json({ error: 'Clips can be at most 3 minutes long.' });
    if (patch.start !== undefined || patch.end !== undefined) patch.segments = segs;
  } else {
    if (end - start < 3) return res.status(400).json({ error: 'Clips must be at least 3 seconds long.' });
    if (end - start > 180) return res.status(400).json({ error: 'Clips can be at most 3 minutes long.' });
  }
  if (patch.start !== undefined) patch.start = +start.toFixed(3);
  if (patch.end !== undefined) patch.end = +end.toFixed(3);
  if (patch.hashtags) patch.hashtags = patch.hashtags.map((h) => '#' + h.replace(/^#+/, '').replace(/\s+/g, '')).filter((h) => h.length > 1);

  const same = (a: unknown, b: unknown) => (typeof a === 'object' ? JSON.stringify(a) === JSON.stringify(b) : a === b);
  const needsRender = RENDER_KEYS.some((k) => patch[k] !== undefined && !same(patch[k], (c as unknown as Record<string, unknown>)[k]));
  clips.update(c.id, { ...patch, ...(needsRender ? { status: 'pending' as const } : {}) });
  if (needsRender) enqueueRender(c.id);
  res.json(publicClip(clips.get(c.id)!));
});

app.post('/api/clips/:id/render', (req, res) => {
  const c = clips.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Clip not found' });
  clips.update(c.id, { status: 'pending', reframe: null });
  enqueueRender(c.id);
  res.json(publicClip(clips.get(c.id)!));
});

app.post('/api/clips/:id/variant', (req, res) => {
  const c = clips.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Clip not found' });
  const styles = ['pop', 'clay', 'neon', 'comic', 'minimal'];
  const nextStyle = styles[(styles.indexOf(c.captionStyle) + 1) % styles.length];
  const v = clips.duplicate(c.id, { captionStyle: nextStyle, titleSuffix: ' (variant)' });
  if (!v) return res.status(500).json({ error: 'Could not create variant' });
  enqueueRender(v.id);
  res.status(201).json(publicClip(v));
});

app.get('/api/clips/:id/download', (req, res) => {
  const c = clips.get(req.params.id);
  if (!c?.filePath || !fs.existsSync(c.filePath)) return res.status(404).json({ error: 'This clip is not rendered yet.' });
  const safe = (c.title || 'clip').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) || 'clip';
  res.download(c.filePath, `${safe}.mp4`);
});

// Clip the parts the user selected on the "Where viewers rewatch" graph (each part its own clip, or joined into one).
app.post(
  '/api/projects/:id/clips',
  wrap(async (req, res) => {
    const p = projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    if (p.status === 'processing' || p.status === 'queued') return res.status(409).json({ error: 'Wait until this project finishes, then add your own clips.' });
    const body = z
      .object({ ranges: z.array(z.object({ start: z.number().min(0), end: z.number().min(0) })).min(1).max(20), join: z.boolean().default(false) })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Select at least one part of the graph.' });
    let created;
    try {
      created = createPickedClips(p.id, body.data.ranges, body.data.join);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
    const ids = created.map((c) => c.id);
    enqueueJob(`pick:${p.id}:${ids.join(',')}`, async () => {
      await preparePickedClips(p.id, ids);
      for (const id of ids) enqueueRender(id);
    });
    res.status(201).json(created.map(publicClip));
  }),
);

// ---------- background music ----------
const musicUpload = multer({ dest: path.join(config.dataDir, 'uploads'), limits: { fileSize: 60 * 1024 * 1024 } });
const publicMusic = () => {
  const lib = musicLibrary();
  return {
    moods: lib.moods.map((m) => ({ id: m.id, label: m.label, hint: m.hint, ready: m.ready, url: toMediaUrl(m.file) })),
    uploads: lib.uploads.map((u) => ({ id: u.id, name: u.name, url: toMediaUrl(u.file) })),
    ai: { available: !config.fakeAi && Boolean(config.gcpProject || config.vertexApiKey), fake: config.fakeAi, ...lyriaStatus },
  };
};
app.get('/api/music', (_req, res) => res.json(publicMusic()));
app.post(
  '/api/music/moods/:id',
  wrap(async (req, res) => {
    try {
      await generateMood(req.params.id, req.query.fresh === '1');
      res.json(publicMusic());
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  }),
);
app.post(
  '/api/music/uploads',
  musicUpload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose an audio file.' });
    try {
      const u = await addUpload(req.file.path, req.file.originalname);
      res.status(201).json({ ...publicMusic(), added: u.id });
    } catch {
      fs.rmSync(req.file.path, { force: true });
      res.status(400).json({ error: 'That file doesn’t look like audio CrestClip can read.' });
    }
  }),
);
app.delete('/api/music/uploads/:id', (req, res) => {
  removeUpload(req.params.id);
  res.json(publicMusic());
});

app.get('/api/meta', (_req, res) => {
  res.json({
    lengths: Object.fromEntries(
      (['shorts', 'tiktok', 'reels'] as const).map((pl) => [pl, Object.fromEntries((['auto', 'short', 'medium', 'long'] as const).map((l) => [l, lengthRange(pl, l)]))]),
    ),
  });
});

app.use('/api/explore', exploreRouter);
app.use('/api', publishRouter);
app.use('/api', autopilotRouter);

// ---------- media + web ----------
app.use('/media', express.static(config.dataDir, { fallthrough: false, maxAge: '1h', index: false, dotfiles: 'deny' }));
if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api|media).*/, (_req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const tooBig = (err as { code?: string }).code === 'LIMIT_FILE_SIZE';
  if (!tooBig) console.error(err);
  res.status(tooBig ? 413 : 500).json({ error: tooBig ? `File is larger than ${config.maxUploadMb} MB.` : err.message || 'Something went wrong' });
});

app.listen(config.port, () => {
  console.log(`\n  CrestClip API  →  http://localhost:${config.port}`);
  console.log(`  Gemini (Vertex AI): ${config.fakeAi ? 'FAKE MODE (dev only)' : config.gcpProject ? `${config.gcpProject} · ${config.gcpLocation} · ${config.model}` : 'NOT CONFIGURED — set GOOGLE_CLOUD_PROJECT in .env'}`);
  console.log(`  Data folder: ${config.dataDir}\n`);
  startToolUpkeep();
  startScheduler();
  startLocalHttps(app);
  void startAutopilot();
  resumeUnfinished();
  warmExplore();
});

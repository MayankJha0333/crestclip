import './lib/quiet.js';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import type { ClipCandidate, MusicSettings, Motion, ProjectOptions, ReframePlan, Rubric, Segment, Signals, TimeRange } from './types.js';

// required lazily (not a static import) so lib/quiet.ts can silence the experimental warning first
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncT };
// The app was renamed PeakClip → CrestClip: move the old database file over once (with its -wal/-shm side files).
const dbFile = path.join(config.dataDir, 'crestclip.db');
const oldDbFile = path.join(config.dataDir, 'peakclip.db');
if (!fs.existsSync(dbFile) && fs.existsSync(oldDbFile)) {
  for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(oldDbFile + ext)) fs.renameSync(oldDbFile + ext, dbFile + ext);
}
const db = new DatabaseSync(dbFile);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  title TEXT,
  channel TEXT,
  description TEXT,
  duration REAL,
  width INTEGER,
  height INTEGER,
  view_count INTEGER,
  status TEXT NOT NULL DEFAULT 'queued',
  stage TEXT,
  stage_detail TEXT,
  progress REAL DEFAULT 0,
  error TEXT,
  options_json TEXT NOT NULL,
  signals_json TEXT,
  transcript_json TEXT,
  media_path TEXT,
  thumb_path TEXT,
  ai_notes TEXT
);
CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  start REAL NOT NULL,
  end REAL NOT NULL,
  title TEXT,
  hook TEXT,
  description TEXT,
  hashtags_json TEXT,
  reason TEXT,
  category TEXT,
  rubric_json TEXT,
  ai_score REAL,
  audience_score REAL,
  peak_score REAL,
  layout TEXT,
  caption_style TEXT,
  show_hook INTEGER DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  file_path TEXT,
  thumb_path TEXT,
  reframe_json TEXT,
  version INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS clips_project ON clips(project_id);
`);

// ---- publishing: connected accounts + posts ----
db.exec(`
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,            -- 'youtube' | 'instagram'
  account_id TEXT NOT NULL,
  name TEXT,
  handle TEXT,
  avatar TEXT,
  tokens TEXT NOT NULL,              -- encrypted JSON {access, refresh, expiresAt}
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(platform, account_id)
);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  title TEXT,
  caption TEXT,
  privacy TEXT,
  scheduled_at INTEGER,              -- null = post now
  status TEXT NOT NULL,              -- scheduled | uploading | processing | published | failed | canceled
  remote_id TEXT,
  remote_url TEXT,
  error TEXT,
  attempts INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_clip ON posts(clip_id);
CREATE INDEX IF NOT EXISTS posts_due ON posts(status, scheduled_at);
`);

// ---- migrations: add columns introduced after the first release ----
{
  const cols = new Set((db.prepare('PRAGMA table_info(clips)').all() as { name: string }[]).map((c) => c.name));
  const add = (name: string, def: string) => !cols.has(name) && db.exec(`ALTER TABLE clips ADD COLUMN ${name} ${def}`);
  add('segments_json', 'TEXT'); // multi-part clips: [{start,end}, ...]
  add('motion', "TEXT DEFAULT 'subtle'");
  add('music_json', 'TEXT');
  add('source', "TEXT DEFAULT 'ai'"); // 'ai' | 'manual'
}
{
  // one project can hold several videos: each video is a child project of a 'group' project
  const cols = new Set((db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((c) => c.name));
  if (!cols.has('parent_id')) db.exec('ALTER TABLE projects ADD COLUMN parent_id TEXT');
}
{
  const cols = new Set((db.prepare('PRAGMA table_info(posts)').all() as { name: string }[]).map((c) => c.name));
  const add = (name: string, def: string) => !cols.has(name) && db.exec(`ALTER TABLE posts ADD COLUMN ${name} ${def}`);
  add('autopilot_id', 'TEXT'); // set when an Autopilot made this post
  add('slot_key', 'TEXT'); // the Autopilot time slot it fills, e.g. "2026-10-02T13:00"
}

// ---- Autopilot: find videos → clip them → post at the chosen times every day ----
db.exec(`
CREATE TABLE IF NOT EXISTS autopilots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',   -- active | paused
  config_json TEXT NOT NULL,               -- sources, filters, clip options, times, targets, mode, caption…
  last_scan_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS autopilot_videos (
  id TEXT PRIMARY KEY,
  autopilot_id TEXT NOT NULL REFERENCES autopilots(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  channel TEXT,
  thumbnail TEXT,
  views INTEGER,
  duration REAL,
  published_at INTEGER,
  status TEXT NOT NULL,                    -- waiting | queued | clipping | done | skipped | failed
  reason TEXT,
  project_id TEXT,
  found_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(autopilot_id, video_id)
);
CREATE TABLE IF NOT EXISTS autopilot_clips (
  id TEXT PRIMARY KEY,
  autopilot_id TEXT NOT NULL REFERENCES autopilots(id) ON DELETE CASCADE,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  video_row_id TEXT,
  status TEXT NOT NULL,                    -- review | ready | scheduled | posted | rejected | failed
  score REAL,
  slot_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(autopilot_id, clip_id)
);
CREATE TABLE IF NOT EXISTS autopilot_skips (
  autopilot_id TEXT NOT NULL REFERENCES autopilots(id) ON DELETE CASCADE,
  slot_key TEXT NOT NULL,
  PRIMARY KEY (autopilot_id, slot_key)
);
CREATE INDEX IF NOT EXISTS ap_videos_status ON autopilot_videos(autopilot_id, status);
CREATE INDEX IF NOT EXISTS ap_clips_status ON autopilot_clips(autopilot_id, status);
`);

const now = () => Date.now();
const parse = <T>(s: unknown, d: T): T => {
  if (typeof s !== 'string' || !s) return d;
  try {
    return JSON.parse(s) as T;
  } catch {
    return d;
  }
};

export interface ProjectRow {
  id: string;
  createdAt: number;
  updatedAt: number;
  sourceType: 'url' | 'upload' | 'group';
  sourceUrl: string | null;
  title: string | null;
  channel: string | null;
  description: string | null;
  /** set when this video is part of a multi-video project */
  parentId: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  viewCount: number | null;
  status: 'queued' | 'processing' | 'done' | 'failed';
  stage: string | null;
  stageDetail: string | null;
  progress: number;
  error: string | null;
  options: ProjectOptions;
  signals: Signals | null;
  transcript: Segment[] | null;
  mediaPath: string | null;
  thumbPath: string | null;
  aiNotes: string | null;
}

export interface ClipRow {
  id: string;
  projectId: string;
  idx: number;
  createdAt: number;
  updatedAt: number;
  start: number;
  end: number;
  title: string;
  hook: string;
  description: string;
  hashtags: string[];
  reason: string;
  category: string;
  rubric: Rubric | null;
  aiScore: number;
  audienceScore: number | null;
  peakScore: number;
  layout: string;
  captionStyle: string;
  showHook: boolean;
  status: 'pending' | 'rendering' | 'ready' | 'failed';
  error: string | null;
  filePath: string | null;
  thumbPath: string | null;
  reframe: ReframePlan | null;
  version: number;
  /** null = one continuous part (start..end) */
  segments: TimeRange[] | null;
  motion: Motion;
  music: MusicSettings;
  source: 'ai' | 'manual';
}

export const DEFAULT_MUSIC: MusicSettings = { track: 'none', volume: 15, duck: true };

type Raw = Record<string, unknown>;

function toProject(r: Raw): ProjectRow {
  return {
    id: r.id as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    sourceType: r.source_type as ProjectRow['sourceType'],
    sourceUrl: (r.source_url as string) ?? null,
    parentId: (r.parent_id as string) ?? null,
    title: (r.title as string) ?? null,
    channel: (r.channel as string) ?? null,
    description: (r.description as string) ?? null,
    duration: (r.duration as number) ?? null,
    width: (r.width as number) ?? null,
    height: (r.height as number) ?? null,
    viewCount: (r.view_count as number) ?? null,
    status: r.status as ProjectRow['status'],
    stage: (r.stage as string) ?? null,
    stageDetail: (r.stage_detail as string) ?? null,
    progress: (r.progress as number) ?? 0,
    error: (r.error as string) ?? null,
    options: parse(r.options_json, {} as ProjectOptions),
    signals: parse(r.signals_json, null),
    transcript: parse(r.transcript_json, null),
    mediaPath: (r.media_path as string) ?? null,
    thumbPath: (r.thumb_path as string) ?? null,
    aiNotes: (r.ai_notes as string) ?? null,
  };
}

function toClip(r: Raw): ClipRow {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    idx: r.idx as number,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    start: r.start as number,
    end: r.end as number,
    title: (r.title as string) ?? '',
    hook: (r.hook as string) ?? '',
    description: (r.description as string) ?? '',
    hashtags: parse(r.hashtags_json, [] as string[]),
    reason: (r.reason as string) ?? '',
    category: (r.category as string) ?? '',
    rubric: parse(r.rubric_json, null),
    aiScore: (r.ai_score as number) ?? 0,
    audienceScore: (r.audience_score as number) ?? null,
    peakScore: (r.peak_score as number) ?? 0,
    layout: (r.layout as string) ?? 'auto',
    captionStyle: (r.caption_style as string) ?? 'pop',
    showHook: Boolean(r.show_hook),
    status: r.status as ClipRow['status'],
    error: (r.error as string) ?? null,
    filePath: (r.file_path as string) ?? null,
    thumbPath: (r.thumb_path as string) ?? null,
    reframe: parse(r.reframe_json, null),
    version: (r.version as number) ?? 0,
    segments: parse(r.segments_json, null),
    motion: ((r.motion as string) || 'subtle') as Motion,
    music: { ...DEFAULT_MUSIC, ...parse(r.music_json, {} as Partial<MusicSettings>) },
    source: ((r.source as string) || 'ai') as 'ai' | 'manual',
  };
}

// ---------- projects ----------
export const projects = {
  create(p: { sourceType: 'url' | 'upload' | 'group'; sourceUrl?: string; title?: string; options: ProjectOptions; parentId?: string | null }) {
    const id = randomUUID().slice(0, 12);
    // a group only holds its videos; its status is worked out from them
    const status = p.sourceType === 'group' ? 'done' : 'queued';
    db.prepare(
      `INSERT INTO projects (id, created_at, updated_at, source_type, source_url, title, options_json, status, stage, progress, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(id, now(), now(), p.sourceType, p.sourceUrl ?? null, p.title ?? null, JSON.stringify(p.options), status, status, p.parentId ?? null);
    return this.get(id)!;
  },
  get(id: string): ProjectRow | null {
    const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Raw | undefined;
    return r ? toProject(r) : null;
  },
  list(): (ProjectRow & { clipCount: number; readyCount: number; bestScore: number | null })[] {
    const rows = db
      .prepare(
        `SELECT p.id, p.created_at, p.updated_at, p.source_type, p.source_url, p.title, p.channel, p.duration, p.width, p.height,
                p.view_count, p.status, p.stage, p.stage_detail, p.progress, p.error, p.options_json, p.thumb_path, p.parent_id,
                (SELECT COUNT(*) FROM clips c WHERE c.project_id = p.id) AS clip_count,
                (SELECT COUNT(*) FROM clips c WHERE c.project_id = p.id AND c.status='ready') AS ready_count,
                (SELECT MAX(peak_score) FROM clips c WHERE c.project_id = p.id) AS best_score
         FROM projects p WHERE p.parent_id IS NULL ORDER BY created_at DESC`,
      )
      .all() as Raw[];
    return rows.map((r) => ({
      ...toProject(r),
      clipCount: r.clip_count as number,
      readyCount: r.ready_count as number,
      bestScore: (r.best_score as number) ?? null,
    }));
  },
  update(id: string, patch: Partial<Omit<ProjectRow, 'id' | 'createdAt'>>) {
    const map: Record<string, [string, (v: unknown) => unknown]> = {
      sourceUrl: ['source_url', (v) => v],
      title: ['title', (v) => v],
      channel: ['channel', (v) => v],
      description: ['description', (v) => v],
      duration: ['duration', (v) => v],
      width: ['width', (v) => v],
      height: ['height', (v) => v],
      viewCount: ['view_count', (v) => v],
      status: ['status', (v) => v],
      stage: ['stage', (v) => v],
      stageDetail: ['stage_detail', (v) => v],
      progress: ['progress', (v) => v],
      error: ['error', (v) => v],
      options: ['options_json', (v) => JSON.stringify(v)],
      signals: ['signals_json', (v) => JSON.stringify(v)],
      transcript: ['transcript_json', (v) => JSON.stringify(v)],
      mediaPath: ['media_path', (v) => v],
      thumbPath: ['thumb_path', (v) => v],
      aiNotes: ['ai_notes', (v) => v],
    };
    const sets: string[] = ['updated_at = ?'];
    const vals: unknown[] = [now()];
    for (const [k, v] of Object.entries(patch)) {
      const m = map[k];
      if (!m) continue;
      sets.push(`${m[0]} = ?`);
      vals.push(v === undefined ? null : m[1](v));
    }
    vals.push(id);
    db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]));
  },
  remove(id: string) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  },
  /** the videos inside a multi-video project, in the order they were added */
  children(parentId: string): ProjectRow[] {
    return (db.prepare('SELECT * FROM projects WHERE parent_id = ? ORDER BY created_at, rowid').all(parentId) as Raw[]).map(toProject);
  },
  unfinished(): ProjectRow[] {
    return (db.prepare(`SELECT * FROM projects WHERE status IN ('queued','processing') ORDER BY created_at`).all() as Raw[]).map(
      toProject,
    );
  },
};

// ---------- clips ----------
export interface ClipDefaults {
  layout: string;
  captionStyle: string;
  showHook: boolean;
  motion: Motion;
  music: MusicSettings;
}
export const clips = {
  replaceForProject(
    projectId: string,
    list: (ClipCandidate & { aiScore: number; audienceScore: number | null; peakScore: number })[],
    defaults: ClipDefaults,
    source: 'ai' | 'manual' = 'ai',
  ) {
    db.prepare('DELETE FROM clips WHERE project_id = ?').run(projectId);
    this.insert(projectId, list, defaults, 0, source);
    return this.forProject(projectId);
  },
  /** Add clips (keeps existing ones). Returns the new rows. */
  insert(
    projectId: string,
    list: (ClipCandidate & { aiScore: number; audienceScore: number | null; peakScore: number; segments?: TimeRange[] | null })[],
    defaults: ClipDefaults,
    startIdx?: number,
    source: 'ai' | 'manual' = 'ai',
  ): ClipRow[] {
    const maxIdx = (db.prepare('SELECT MAX(idx) AS m FROM clips WHERE project_id = ?').get(projectId) as Raw).m as number | null;
    const base = startIdx ?? (maxIdx ?? -1) + 1;
    const stmt = db.prepare(
      `INSERT INTO clips (id, project_id, idx, created_at, updated_at, start, end, title, hook, description, hashtags_json,
        reason, category, rubric_json, ai_score, audience_score, peak_score, layout, caption_style, show_hook, status,
        segments_json, motion, music_json, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    );
    const ids: string[] = [];
    list.forEach((c, j) => {
      const i = base + j;
      const id = randomUUID().slice(0, 12);
      ids.push(id);
      stmt.run(
        id,
        projectId,
        i,
        now(),
        now(),
        c.start,
        c.end,
        c.title,
        c.hook,
        c.description,
        JSON.stringify(c.hashtags),
        c.reason,
        c.category,
        JSON.stringify(c.rubric),
        c.aiScore,
        c.audienceScore,
        c.peakScore,
        defaults.layout,
        defaults.captionStyle,
        defaults.showHook ? 1 : 0,
        c.segments && c.segments.length > 1 ? JSON.stringify(c.segments) : null,
        defaults.motion,
        JSON.stringify(defaults.music),
        source,
      );
    });
    return ids.map((id) => this.get(id)!).filter(Boolean);
  },
  forProject(projectId: string): ClipRow[] {
    return (db.prepare('SELECT * FROM clips WHERE project_id = ? ORDER BY peak_score DESC, idx').all(projectId) as Raw[]).map(
      toClip,
    );
  },
  get(id: string): ClipRow | null {
    const r = db.prepare('SELECT * FROM clips WHERE id = ?').get(id) as Raw | undefined;
    return r ? toClip(r) : null;
  },
  update(id: string, patch: Partial<Omit<ClipRow, 'id' | 'projectId' | 'createdAt'>>) {
    const map: Record<string, [string, (v: unknown) => unknown]> = {
      start: ['start', (v) => v],
      end: ['end', (v) => v],
      title: ['title', (v) => v],
      hook: ['hook', (v) => v],
      description: ['description', (v) => v],
      hashtags: ['hashtags_json', (v) => JSON.stringify(v)],
      layout: ['layout', (v) => v],
      captionStyle: ['caption_style', (v) => v],
      showHook: ['show_hook', (v) => (v ? 1 : 0)],
      status: ['status', (v) => v],
      error: ['error', (v) => v],
      filePath: ['file_path', (v) => v],
      thumbPath: ['thumb_path', (v) => v],
      reframe: ['reframe_json', (v) => JSON.stringify(v)],
      version: ['version', (v) => v],
      audienceScore: ['audience_score', (v) => v],
      peakScore: ['peak_score', (v) => v],
      aiScore: ['ai_score', (v) => v],
      category: ['category', (v) => v],
      reason: ['reason', (v) => v],
      rubric: ['rubric_json', (v) => JSON.stringify(v)],
      segments: ['segments_json', (v) => JSON.stringify(v)],
      motion: ['motion', (v) => v],
      music: ['music_json', (v) => JSON.stringify(v)],
    };
    const sets: string[] = ['updated_at = ?'];
    const vals: unknown[] = [now()];
    for (const [k, v] of Object.entries(patch)) {
      const m = map[k];
      if (!m) continue;
      sets.push(`${m[0]} = ?`);
      vals.push(v === undefined || v === null ? null : m[1](v));
    }
    vals.push(id);
    db.prepare(`UPDATE clips SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]));
  },
  unfinished(): ClipRow[] {
    return (db.prepare(`SELECT * FROM clips WHERE status IN ('pending','rendering')`).all() as Raw[]).map(toClip);
  },
  /** Copy a clip (same moment) with a different look — posting variations avoids duplicate-content flags. */
  duplicate(id: string, o: { captionStyle: string; titleSuffix: string }): ClipRow | null {
    const c = this.get(id);
    if (!c) return null;
    const nid = randomUUID().slice(0, 12);
    const maxIdx = (db.prepare('SELECT MAX(idx) AS m FROM clips WHERE project_id = ?').get(c.projectId) as Raw).m as number;
    db.prepare(
      `INSERT INTO clips (id, project_id, idx, created_at, updated_at, start, end, title, hook, description, hashtags_json, reason, category,
        rubric_json, ai_score, audience_score, peak_score, layout, caption_style, show_hook, status, reframe_json, segments_json, motion, music_json, source)
       SELECT ?, project_id, ?, ?, ?, start, end, title || ?, hook, description, hashtags_json, reason, category, rubric_json, ai_score,
        audience_score, peak_score - 0.01, layout, ?, show_hook, 'pending', reframe_json, segments_json, motion, music_json, source FROM clips WHERE id = ?`,
    ).run(nid, (maxIdx ?? 0) + 1, now(), now(), o.titleSuffix, o.captionStyle, id);
    return this.get(nid);
  },
};

// ---------- connected accounts ----------
export interface ConnectionRow {
  id: string;
  platform: 'youtube' | 'instagram';
  accountId: string;
  name: string | null;
  handle: string | null;
  avatar: string | null;
  tokens: string;
  createdAt: number;
  updatedAt: number;
}
const toConn = (r: Raw): ConnectionRow => ({
  id: r.id as string,
  platform: r.platform as ConnectionRow['platform'],
  accountId: r.account_id as string,
  name: (r.name as string) ?? null,
  handle: (r.handle as string) ?? null,
  avatar: (r.avatar as string) ?? null,
  tokens: r.tokens as string,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
});
export const connections = {
  list(): ConnectionRow[] {
    return (db.prepare('SELECT * FROM connections ORDER BY platform, created_at').all() as Raw[]).map(toConn);
  },
  get(id: string): ConnectionRow | null {
    const r = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as Raw | undefined;
    return r ? toConn(r) : null;
  },
  /** insert or update (same platform + account = reconnect) */
  upsert(c: { platform: string; accountId: string; name: string | null; handle: string | null; avatar: string | null; tokens: string }): ConnectionRow {
    const existing = db.prepare('SELECT id FROM connections WHERE platform = ? AND account_id = ?').get(c.platform, c.accountId) as Raw | undefined;
    const id = (existing?.id as string) ?? randomUUID().slice(0, 12);
    if (existing)
      db.prepare('UPDATE connections SET name = ?, handle = ?, avatar = ?, tokens = ?, updated_at = ? WHERE id = ?').run(c.name, c.handle, c.avatar, c.tokens, now(), id);
    else
      db.prepare('INSERT INTO connections (id, platform, account_id, name, handle, avatar, tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        id, c.platform, c.accountId, c.name, c.handle, c.avatar, c.tokens, now(), now(),
      );
    return this.get(id)!;
  },
  setTokens(id: string, tokens: string) {
    db.prepare('UPDATE connections SET tokens = ?, updated_at = ? WHERE id = ?').run(tokens, now(), id);
  },
  remove(id: string) {
    db.prepare('DELETE FROM connections WHERE id = ?').run(id);
  },
};

// ---------- posts (publish / schedule) ----------
export type PostStatus = 'scheduled' | 'uploading' | 'processing' | 'published' | 'failed' | 'canceled';
export interface PostRow {
  id: string;
  clipId: string;
  connectionId: string;
  platform: 'youtube' | 'instagram';
  title: string | null;
  caption: string | null;
  privacy: string | null;
  scheduledAt: number | null;
  status: PostStatus;
  remoteId: string | null;
  remoteUrl: string | null;
  error: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  autopilotId: string | null;
  slotKey: string | null;
}
const toPost = (r: Raw): PostRow => ({
  id: r.id as string,
  clipId: r.clip_id as string,
  connectionId: r.connection_id as string,
  platform: r.platform as PostRow['platform'],
  title: (r.title as string) ?? null,
  caption: (r.caption as string) ?? null,
  privacy: (r.privacy as string) ?? null,
  scheduledAt: (r.scheduled_at as number) ?? null,
  status: r.status as PostStatus,
  remoteId: (r.remote_id as string) ?? null,
  remoteUrl: (r.remote_url as string) ?? null,
  error: (r.error as string) ?? null,
  attempts: (r.attempts as number) ?? 0,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
  autopilotId: (r.autopilot_id as string) ?? null,
  slotKey: (r.slot_key as string) ?? null,
});
export const posts = {
  create(p: {
    clipId: string;
    connectionId: string;
    platform: string;
    title: string | null;
    caption: string | null;
    privacy: string | null;
    scheduledAt: number | null;
    autopilotId?: string | null;
    slotKey?: string | null;
  }): PostRow {
    const id = randomUUID().slice(0, 12);
    db.prepare(
      `INSERT INTO posts (id, clip_id, connection_id, platform, title, caption, privacy, scheduled_at, status, created_at, updated_at, autopilot_id, slot_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?)`,
    ).run(id, p.clipId, p.connectionId, p.platform, p.title, p.caption, p.privacy, p.scheduledAt, now(), now(), p.autopilotId ?? null, p.slotKey ?? null);
    return this.get(id)!;
  },
  get(id: string): PostRow | null {
    const r = db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as Raw | undefined;
    return r ? toPost(r) : null;
  },
  forClip(clipId: string): PostRow[] {
    return (db.prepare('SELECT * FROM posts WHERE clip_id = ? ORDER BY created_at DESC').all(clipId) as Raw[]).map(toPost);
  },
  list(limit = 200): PostRow[] {
    return (db.prepare('SELECT * FROM posts ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT ?').all(limit) as Raw[]).map(toPost);
  },
  /**
   * due = scheduled and its time has come (or "now" posts).
   * Autopilot posts are fired on time by their Redis job; this is only their safety net (10 min late).
   */
  due(): PostRow[] {
    return (
      db
        .prepare(
          `SELECT * FROM posts WHERE status = 'scheduled' AND (
             (autopilot_id IS NULL AND (scheduled_at IS NULL OR scheduled_at <= ?)) OR (autopilot_id IS NOT NULL AND scheduled_at <= ?)
           ) ORDER BY scheduled_at`,
        )
        .all(now(), now() - 10 * 60_000) as Raw[]
    ).map(toPost);
  },
  forAutopilot(autopilotId: string, limit = 300): PostRow[] {
    return (db.prepare('SELECT * FROM posts WHERE autopilot_id = ? ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT ?').all(autopilotId, limit) as Raw[]).map(toPost);
  },
  forSlot(autopilotId: string, slotKey: string): PostRow[] {
    return (db.prepare('SELECT * FROM posts WHERE autopilot_id = ? AND slot_key = ?').all(autopilotId, slotKey) as Raw[]).map(toPost);
  },
  scheduledForAutopilot(autopilotId: string): PostRow[] {
    return (db.prepare(`SELECT * FROM posts WHERE autopilot_id = ? AND status = 'scheduled'`).all(autopilotId) as Raw[]).map(toPost);
  },
  allScheduledAutopilot(): PostRow[] {
    return (db.prepare(`SELECT * FROM posts WHERE autopilot_id IS NOT NULL AND status = 'scheduled'`).all() as Raw[]).map(toPost);
  },
  stuck(): PostRow[] {
    return (db.prepare(`SELECT * FROM posts WHERE status IN ('uploading', 'processing')`).all() as Raw[]).map(toPost);
  },
  update(id: string, patch: Partial<Pick<PostRow, 'status' | 'remoteId' | 'remoteUrl' | 'error' | 'attempts' | 'scheduledAt'>>) {
    const map: Record<string, string> = { status: 'status', remoteId: 'remote_id', remoteUrl: 'remote_url', error: 'error', attempts: 'attempts', scheduledAt: 'scheduled_at' };
    const sets = ['updated_at = ?'];
    const vals: unknown[] = [now()];
    for (const [k, v] of Object.entries(patch)) {
      if (!map[k]) continue;
      sets.push(`${map[k]} = ?`);
      vals.push(v ?? null);
    }
    vals.push(id);
    db.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]));
  },
};

// ---------- Autopilot ----------
export interface AutopilotSource {
  kind: 'youtube_channel' | 'youtube_topic';
  /** channel: the link/@handle the person typed; topic: the search words */
  value: string;
  /** resolved YouTube channel id (UC…) or topic region code (e.g. "IN") */
  channelId?: string | null;
  label?: string | null;
  region?: string | null;
}
export interface AutopilotConfig {
  sources: AutopilotSource[];
  filters: { minViews: number; minMinutes: number; maxMinutes: number; maxAgeDays: number; waitHours: number };
  options: ProjectOptions;
  clipsPerVideo: number;
  /** local times "HH:MM", one per daily post */
  times: string[];
  timezone: string;
  /** which connected accounts to post to */
  targets: { connectionId: string; privacy?: 'public' | 'unlisted' | 'private' }[];
  mode: 'review' | 'auto';
  caption: string;
  rightsConfirmed: boolean;
}
export interface AutopilotRow {
  id: string;
  name: string;
  status: 'active' | 'paused';
  config: AutopilotConfig;
  lastScanAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}
const toAutopilot = (r: Raw): AutopilotRow => ({
  id: r.id as string,
  name: r.name as string,
  status: r.status as AutopilotRow['status'],
  config: parse<AutopilotConfig>(r.config_json, {} as AutopilotConfig),
  lastScanAt: (r.last_scan_at as number) ?? null,
  lastError: (r.last_error as string) ?? null,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
});
export const autopilots = {
  create(name: string, cfg: AutopilotConfig): AutopilotRow {
    const id = randomUUID().slice(0, 12);
    db.prepare('INSERT INTO autopilots (id, name, status, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, 'active', JSON.stringify(cfg), now(), now());
    return this.get(id)!;
  },
  get(id: string): AutopilotRow | null {
    const r = db.prepare('SELECT * FROM autopilots WHERE id = ?').get(id) as Raw | undefined;
    return r ? toAutopilot(r) : null;
  },
  list(): AutopilotRow[] {
    return (db.prepare('SELECT * FROM autopilots ORDER BY created_at DESC').all() as Raw[]).map(toAutopilot);
  },
  active(): AutopilotRow[] {
    return (db.prepare(`SELECT * FROM autopilots WHERE status = 'active'`).all() as Raw[]).map(toAutopilot);
  },
  update(id: string, patch: { name?: string; status?: AutopilotRow['status']; config?: AutopilotConfig; lastScanAt?: number | null; lastError?: string | null }) {
    const map: Record<string, [string, (v: unknown) => unknown]> = {
      name: ['name', (v) => v],
      status: ['status', (v) => v],
      config: ['config_json', (v) => JSON.stringify(v)],
      lastScanAt: ['last_scan_at', (v) => v],
      lastError: ['last_error', (v) => v],
    };
    const sets = ['updated_at = ?'];
    const vals: unknown[] = [now()];
    for (const [k, v] of Object.entries(patch)) {
      if (!map[k] || v === undefined) continue;
      sets.push(`${map[k][0]} = ?`);
      vals.push(map[k][1](v) ?? null);
    }
    vals.push(id);
    db.prepare(`UPDATE autopilots SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]));
  },
  remove(id: string) {
    db.prepare('DELETE FROM autopilots WHERE id = ?').run(id);
  },
};

export type ApVideoStatus = 'waiting' | 'queued' | 'clipping' | 'done' | 'skipped' | 'failed';
export interface ApVideoRow {
  id: string;
  autopilotId: string;
  videoId: string;
  url: string;
  title: string | null;
  channel: string | null;
  thumbnail: string | null;
  views: number | null;
  duration: number | null;
  publishedAt: number | null;
  status: ApVideoStatus;
  reason: string | null;
  projectId: string | null;
  foundAt: number;
  updatedAt: number;
}
const toApVideo = (r: Raw): ApVideoRow => ({
  id: r.id as string,
  autopilotId: r.autopilot_id as string,
  videoId: r.video_id as string,
  url: r.url as string,
  title: (r.title as string) ?? null,
  channel: (r.channel as string) ?? null,
  thumbnail: (r.thumbnail as string) ?? null,
  views: (r.views as number) ?? null,
  duration: (r.duration as number) ?? null,
  publishedAt: (r.published_at as number) ?? null,
  status: r.status as ApVideoStatus,
  reason: (r.reason as string) ?? null,
  projectId: (r.project_id as string) ?? null,
  foundAt: r.found_at as number,
  updatedAt: r.updated_at as number,
});
export const apVideos = {
  /** insert if new; returns null when this autopilot already knows the video */
  add(v: { autopilotId: string; videoId: string; url: string; title: string | null; channel: string | null; thumbnail: string | null; views: number | null; duration: number | null; publishedAt: number | null; status: ApVideoStatus; reason?: string | null }): ApVideoRow | null {
    const id = randomUUID().slice(0, 12);
    const r = db
      .prepare(
        `INSERT OR IGNORE INTO autopilot_videos (id, autopilot_id, video_id, url, title, channel, thumbnail, views, duration, published_at, status, reason, found_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, v.autopilotId, v.videoId, v.url, v.title, v.channel, v.thumbnail, v.views, v.duration, v.publishedAt, v.status, v.reason ?? null, now(), now());
    return r.changes ? this.get(id) : null;
  },
  get(id: string): ApVideoRow | null {
    const r = db.prepare('SELECT * FROM autopilot_videos WHERE id = ?').get(id) as Raw | undefined;
    return r ? toApVideo(r) : null;
  },
  has(autopilotId: string, videoId: string) {
    return Boolean(db.prepare('SELECT 1 FROM autopilot_videos WHERE autopilot_id = ? AND video_id = ?').get(autopilotId, videoId));
  },
  list(autopilotId: string, limit = 200): ApVideoRow[] {
    return (db.prepare('SELECT * FROM autopilot_videos WHERE autopilot_id = ? ORDER BY found_at DESC LIMIT ?').all(autopilotId, limit) as Raw[]).map(toApVideo);
  },
  withStatus(autopilotId: string, status: ApVideoStatus): ApVideoRow[] {
    return (db.prepare('SELECT * FROM autopilot_videos WHERE autopilot_id = ? AND status = ? ORDER BY COALESCE(views, 0) DESC').all(autopilotId, status) as Raw[]).map(toApVideo);
  },
  /** how many videos this autopilot started clipping since `since` */
  startedSince(autopilotId: string, since: number): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM autopilot_videos WHERE autopilot_id = ? AND project_id IS NOT NULL AND updated_at >= ?`).get(autopilotId, since) as Raw).n as number;
  },
  update(id: string, patch: Partial<Pick<ApVideoRow, 'status' | 'reason' | 'projectId' | 'views' | 'duration' | 'title'>>) {
    const map: Record<string, string> = { status: 'status', reason: 'reason', projectId: 'project_id', views: 'views', duration: 'duration', title: 'title' };
    const sets = ['updated_at = ?'];
    const vals: unknown[] = [now()];
    for (const [k, v] of Object.entries(patch)) {
      if (!map[k]) continue;
      sets.push(`${map[k]} = ?`);
      vals.push(v ?? null);
    }
    vals.push(id);
    db.prepare(`UPDATE autopilot_videos SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]));
  },
};

export type ApClipStatus = 'review' | 'ready' | 'scheduled' | 'posted' | 'rejected' | 'failed';
export interface ApClipRow {
  id: string;
  autopilotId: string;
  clipId: string;
  videoRowId: string | null;
  status: ApClipStatus;
  score: number | null;
  slotKey: string | null;
  createdAt: number;
  updatedAt: number;
}
const toApClip = (r: Raw): ApClipRow => ({
  id: r.id as string,
  autopilotId: r.autopilot_id as string,
  clipId: r.clip_id as string,
  videoRowId: (r.video_row_id as string) ?? null,
  status: r.status as ApClipStatus,
  score: (r.score as number) ?? null,
  slotKey: (r.slot_key as string) ?? null,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
});
export const apClips = {
  add(c: { autopilotId: string; clipId: string; videoRowId: string | null; status: ApClipStatus; score: number | null }): ApClipRow | null {
    const id = randomUUID().slice(0, 12);
    const r = db
      .prepare('INSERT OR IGNORE INTO autopilot_clips (id, autopilot_id, clip_id, video_row_id, status, score, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, c.autopilotId, c.clipId, c.videoRowId, c.status, c.score, now(), now());
    return r.changes ? this.get(id) : null;
  },
  get(id: string): ApClipRow | null {
    const r = db.prepare('SELECT * FROM autopilot_clips WHERE id = ?').get(id) as Raw | undefined;
    return r ? toApClip(r) : null;
  },
  list(autopilotId: string): ApClipRow[] {
    return (db.prepare('SELECT * FROM autopilot_clips WHERE autopilot_id = ? ORDER BY created_at DESC').all(autopilotId) as Raw[]).map(toApClip);
  },
  withStatus(autopilotId: string, status: ApClipStatus): ApClipRow[] {
    // best first, then oldest first
    return (db.prepare('SELECT * FROM autopilot_clips WHERE autopilot_id = ? AND status = ? ORDER BY COALESCE(score, 0) DESC, created_at').all(autopilotId, status) as Raw[]).map(toApClip);
  },
  bySlot(autopilotId: string, slotKey: string): ApClipRow | null {
    const r = db.prepare('SELECT * FROM autopilot_clips WHERE autopilot_id = ? AND slot_key = ?').get(autopilotId, slotKey) as Raw | undefined;
    return r ? toApClip(r) : null;
  },
  update(id: string, patch: { status?: ApClipStatus; slotKey?: string | null }) {
    if (patch.status !== undefined) db.prepare('UPDATE autopilot_clips SET status = ?, updated_at = ? WHERE id = ?').run(patch.status, now(), id);
    if (patch.slotKey !== undefined) db.prepare('UPDATE autopilot_clips SET slot_key = ?, updated_at = ? WHERE id = ?').run(patch.slotKey, now(), id);
  },
};

export const apSkips = {
  list(autopilotId: string): Set<string> {
    return new Set((db.prepare('SELECT slot_key FROM autopilot_skips WHERE autopilot_id = ?').all(autopilotId) as Raw[]).map((r) => r.slot_key as string));
  },
  add(autopilotId: string, slotKey: string) {
    db.prepare('INSERT OR IGNORE INTO autopilot_skips (autopilot_id, slot_key) VALUES (?, ?)').run(autopilotId, slotKey);
  },
  remove(autopilotId: string, slotKey: string) {
    db.prepare('DELETE FROM autopilot_skips WHERE autopilot_id = ? AND slot_key = ?').run(autopilotId, slotKey);
  },
};

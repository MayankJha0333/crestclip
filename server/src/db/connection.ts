import '../lib/quiet.js';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

// required lazily (not a static import) so lib/quiet.ts can silence the experimental warning first
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncT };
// The app was renamed PeakClip → CrestClip: move the old database file over once (with its -wal/-shm side files).
const dbFile = path.join(config.dataDir, 'crestclip.db');
const oldDbFile = path.join(config.dataDir, 'peakclip.db');
if (!fs.existsSync(dbFile) && fs.existsSync(oldDbFile)) {
  for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(oldDbFile + ext)) fs.renameSync(oldDbFile + ext, dbFile + ext);
}
export const db = new DatabaseSync(dbFile);
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
  add('pace', "TEXT DEFAULT 'off'"); // pause cutting; clips made before it existed stay uncut
  add('hooks_json', 'TEXT'); // headline options
  add('keywords_json', 'TEXT'); // [{w, emoji}] for caption emphasis
  add('teaser_json', 'TEXT'); // {start,end} flash-forward line
  add('emoji', 'INTEGER DEFAULT 0');
  add('flash', 'INTEGER DEFAULT 0');
  add('out_duration', 'REAL'); // length of the finished video (after pause cuts / tease)
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

// ---- accounts, plans and credits ----
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  password_hash TEXT,                      -- null for Google-only accounts
  google_sub TEXT UNIQUE,
  avatar TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  plan TEXT NOT NULL DEFAULT 'free',       -- free | creator | pro
  cycle_start INTEGER,                     -- current credit month
  cycle_end INTEGER,
  rz_subscription_id TEXT,                 -- Razorpay subscription paying for the plan
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                     -- sha256 of the cookie token (the token itself is never stored)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS credit_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,                    -- plan | topup | bonus | refund
  amount INTEGER NOT NULL,
  remaining INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ref TEXT UNIQUE,                         -- makes grants idempotent (payment / subscription cycle)
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS credit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,                  -- + added, − used
  kind TEXT NOT NULL,                      -- grant | topup | spend | refund | adjust
  note TEXT,
  project_id TEXT,
  detail_json TEXT,                        -- spend: which grants it came from (so a refund can put it back)
  refunded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,                     -- Razorpay payment id
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                      -- subscription | topup
  plan TEXT,
  amount INTEGER,                          -- smallest currency unit
  currency TEXT,
  ref TEXT,                                -- order / subscription id
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS grants_user ON credit_grants(user_id, expires_at);
CREATE INDEX IF NOT EXISTS events_user ON credit_events(user_id, created_at);
`);
{
  // every project, social account and Autopilot belongs to a user (rows from before accounts → the first user)
  for (const table of ['projects', 'connections', 'autopilots']) {
    const cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    if (!cols.has('user_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT`);
  }
  const cols = new Set((db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((c) => c.name));
  if (!cols.has('credits_charged')) db.exec('ALTER TABLE projects ADD COLUMN credits_charged INTEGER NOT NULL DEFAULT 0');
  if (!cols.has('error_code')) db.exec('ALTER TABLE projects ADD COLUMN error_code TEXT'); // credits | plan_limit
  if (!cols.has('expires_at')) {
    // auto-delete: projects made before this existed get the full storage time from today
    db.exec('ALTER TABLE projects ADD COLUMN expires_at INTEGER');
    db.prepare('UPDATE projects SET expires_at = ? WHERE expires_at IS NULL').run(Date.now() + config.retentionDays * 86400_000);
  }
  db.exec('CREATE INDEX IF NOT EXISTS projects_user ON projects(user_id, created_at)');
  // the subscription opened in Checkout but not confirmed yet (so a payment that didn't report back is still found)
  const ucols = new Set((db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name));
  if (!ucols.has('rz_pending_sub')) db.exec('ALTER TABLE users ADD COLUMN rz_pending_sub TEXT');
}

export const now = () => Date.now();
/** Short random id for new rows. */
export const newId = () => randomUUID().slice(0, 12);
/** Read a JSON column; `d` when it's empty or unreadable. */
export const parse = <T>(s: unknown, d: T): T => {
  if (typeof s !== 'string' || !s) return d;
  try {
    return JSON.parse(s) as T;
  } catch {
    return d;
  }
};

/** A row as SQLite returns it. */
export type Raw = Record<string, unknown>;

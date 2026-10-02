import '../lib/quiet.js';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import type { AnyBulkWriteOperation } from 'mongodb';
import { config } from '../config.js';
import { collection, COLLECTIONS, isDuplicate } from './connection.js';

/**
 * One-time move from the old SQLite file (data/crestclip.db) to MongoDB. Runs on start-up when that file exists
 * and hasn't been imported yet; afterwards the file is left as it is (a backup) and a note in `meta` stops it
 * from running again. Safe to run twice: every record keeps its id and is written with an upsert.
 */

type Row = Record<string, unknown>;

const DONE_ID = 'import:sqlite';
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const json = (v: unknown, d: unknown = null) => {
  if (typeof v !== 'string' || !v) return d;
  try {
    return JSON.parse(v);
  } catch {
    return d;
  }
};

/** column → field name, where it isn't simply the camelCase of the column */
const RENAME: Record<string, string> = { rz_pending_sub: 'pendingSubscriptionId', flash: 'flashForward' };
/** columns stored as 0/1 that are true/false now */
const BOOLEAN = new Set(['is_admin', 'cancel_at_period_end', 'show_hook', 'emoji', 'flash', 'refunded']);
/** columns that are gone */
const DROP = new Set(['rowid', 'billing_currency']);

/** One SQLite row → a MongoDB document (JSON columns become real objects, 0/1 become true/false). */
function toDoc(r: Row, idColumn = 'id'): Row {
  const d: Row = { _id: r[idColumn] };
  for (const [col, v] of Object.entries(r)) {
    if (col === idColumn || DROP.has(col)) continue;
    if (col.endsWith('_json')) d[camel(col.slice(0, -5))] = json(v);
    else d[RENAME[col] ?? camel(col)] = BOOLEAN.has(col) ? Boolean(v) : (v ?? null);
  }
  return d;
}

const TABLES: { table: string; collection: string; id?: string; fix?: (d: Row, r: Row) => void }[] = [
  { table: 'users', collection: COLLECTIONS.users, fix: (d) => (d.email = String(d.email).toLowerCase()) },
  { table: 'sessions', collection: COLLECTIONS.sessions },
  { table: 'credit_grants', collection: COLLECTIONS.creditGrants },
  { table: 'credit_events', collection: COLLECTIONS.creditEvents },
  { table: 'payments', collection: COLLECTIONS.payments },
  { table: 'projects', collection: COLLECTIONS.projects, fix: (d) => (d.progress ??= 0) },
  { table: 'clips', collection: COLLECTIONS.clips },
  { table: 'connections', collection: COLLECTIONS.connections },
  { table: 'posts', collection: COLLECTIONS.posts },
  { table: 'autopilots', collection: COLLECTIONS.autopilots },
  { table: 'autopilot_videos', collection: COLLECTIONS.autopilotVideos },
  { table: 'autopilot_clips', collection: COLLECTIONS.autopilotClips },
];

export async function importSqliteOnce(): Promise<void> {
  const file = path.join(config.dataDir, 'crestclip.db');
  if (!fs.existsSync(file)) return;
  const meta = collection<{ _id: string; at: number; counts: Record<string, number> }>(COLLECTIONS.meta);
  if (await meta.findOne({ _id: DONE_ID })) return;

  console.log('  Moving your data from SQLite (data/crestclip.db) to MongoDB…');
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncT };
  const sqlite = new DatabaseSync(file, { readOnly: true });
  const tables = new Set((sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Row[]).map((t) => t.name as string));
  const counts: Record<string, number> = {};
  try {
    for (const t of TABLES) {
      if (!tables.has(t.table)) continue;
      const rows = sqlite.prepare(`SELECT * FROM ${t.table}`).all() as Row[];
      const docs = rows.map((r) => {
        const d = toDoc(r, t.id);
        t.fix?.(d, r);
        return d;
      });
      if (t.table === 'posts') linkPosts(sqlite, docs);
      counts[t.table] = await upsertAll(t.collection, docs);
    }
    if (tables.has('autopilot_skips')) {
      const skips = (sqlite.prepare('SELECT * FROM autopilot_skips').all() as Row[]).map((r) => ({ _id: `${r.autopilot_id}|${r.slot_key}`, autopilotId: r.autopilot_id, slotKey: r.slot_key }));
      counts.autopilot_skips = await upsertAll(COLLECTIONS.autopilotSkips, skips);
    }
  } finally {
    sqlite.close();
  }
  await meta.updateOne({ _id: DONE_ID }, { $set: { at: Date.now(), counts } }, { upsert: true });
  console.log(
    `  Done: ${Object.entries(counts)
      .map(([t, n]) => `${n} ${t}`)
      .join(', ')}. The old file stays in data/ as a backup.\n`,
  );
}

/** Posts now also carry their clip's project and owner (MongoDB has no joins to find them later). */
function linkPosts(sqlite: DatabaseSyncT, docs: Row[]) {
  const owner = sqlite.prepare('SELECT c.project_id AS projectId, p.user_id AS userId FROM clips c JOIN projects p ON p.id = c.project_id WHERE c.id = ?');
  for (const d of docs) {
    const o = owner.get(d.clipId as string) as Row | undefined;
    d.projectId = o?.projectId ?? null;
    d.userId = o?.userId ?? null;
  }
}

async function upsertAll(name: string, docs: Row[]): Promise<number> {
  const col = collection<Row>(name);
  let n = 0;
  for (let i = 0; i < docs.length; i += 500) {
    const batch = docs.slice(i, i + 500);
    try {
      const r = await col.bulkWrite(batch.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })) as AnyBulkWriteOperation<Row>[], { ordered: false });
      n += r.upsertedCount + r.matchedCount;
    } catch (e) {
      // a record that clashes with one already in MongoDB (e.g. the same email signed up there first) is skipped
      if (!isDuplicate(e)) throw e;
      console.warn(`  [import] ${name}: some records were already in MongoDB and were skipped.`);
      n += batch.length;
    }
  }
  return n;
}

import { randomUUID } from 'node:crypto';
import { MongoClient, MongoServerError, type Collection, type Db, type Document } from 'mongodb';
import { config } from '../config.js';

/**
 * MongoDB. Every record is a document whose `_id` is a short random string; the rest of the app sees plain
 * objects with an `id` instead (see `fromDoc`). Collections and indexes are set up once by `connectDb()`.
 */

/** A stored document: the row's fields, with `id` kept as `_id`. */
export type Doc<T extends { id: string }> = Omit<T, 'id'> & { _id: string };

let client: MongoClient | null = null;
let database: Db | null = null;

/** Connect (once) and make sure every collection has its indexes. Call before anything reads or writes. */
export async function connectDb(): Promise<Db> {
  if (database) return database;
  if (!config.mongoUri) throw new Error('MONGODB_URI is not set in .env — CrestClip needs a MongoDB database (for example a free MongoDB Atlas cluster).');
  // ignoreUndefined: a field set to undefined is left out (as JSON does), not saved as null
  // socketTimeoutMS: a call on a connection that silently died fails after 2 min instead of waiting forever
  client = new MongoClient(config.mongoUri, { appName: 'crestclip', serverSelectionTimeoutMS: 15_000, socketTimeoutMS: 120_000, ignoreUndefined: true });
  await client.connect();
  database = client.db(config.mongoDb);
  await createIndexes(database);
  return database;
}

export async function closeDb() {
  await client?.close();
  client = null;
  database = null;
}

/** A quick round trip to the database (the "is it up?" check used by deploys). */
export async function pingDb() {
  if (!database) throw new Error('The database is not connected yet.');
  await database.command({ ping: 1 });
}

/** A collection, typed by the row it stores. */
export function collection<T extends Document>(name: string): Collection<T> {
  if (!database) throw new Error('The database is not connected yet (connectDb() must run first).');
  return database.collection<T>(name);
}

export const COLLECTIONS = {
  users: 'users',
  sessions: 'sessions',
  creditGrants: 'credit_grants',
  creditEvents: 'credit_events',
  payments: 'payments',
  projects: 'projects',
  clips: 'clips',
  connections: 'connections',
  posts: 'posts',
  autopilots: 'autopilots',
  autopilotVideos: 'autopilot_videos',
  autopilotClips: 'autopilot_clips',
  autopilotSkips: 'autopilot_skips',
  meta: 'meta',
  tickets: 'tickets',
} as const;

async function createIndexes(db: Db) {
  const c = COLLECTIONS;
  // one channel used to be allowed in only one CrestClip account; now each account can connect it
  await db
    .collection(c.connections)
    .dropIndex('platform_1_accountId_1')
    .catch(() => {});
  const hasString = (field: string) => ({ partialFilterExpression: { [field]: { $type: 'string' } } });
  await Promise.all([
    db.collection(c.users).createIndexes([{ key: { email: 1 }, unique: true }, { key: { googleSub: 1 }, unique: true, ...hasString('googleSub') }, { key: { dodoSubscriptionId: 1 } }, { key: { dodoCustomerId: 1 } }]),
    db.collection(c.sessions).createIndexes([{ key: { userId: 1 } }, { key: { expiresAt: 1 } }]),
    db.collection(c.creditGrants).createIndexes([{ key: { userId: 1, expiresAt: 1 } }, { key: { ref: 1 }, unique: true, ...hasString('ref') }]),
    db.collection(c.creditEvents).createIndexes([{ key: { userId: 1, createdAt: -1 } }, { key: { projectId: 1, kind: 1 } }]),
    db.collection(c.payments).createIndexes([{ key: { userId: 1, createdAt: -1 } }]),
    db.collection(c.tickets).createIndexes([{ key: { userId: 1, updatedAt: -1 } }, { key: { status: 1, updatedAt: -1 } }, { key: { number: 1 } }]),
    db.collection(c.projects).createIndexes([{ key: { userId: 1, createdAt: -1 } }, { key: { parentId: 1, createdAt: 1 } }, { key: { status: 1 } }, { key: { expiresAt: 1 } }]),
    db.collection(c.clips).createIndexes([{ key: { projectId: 1, peakScore: -1 } }, { key: { status: 1 } }]),
    db.collection(c.connections).createIndexes([{ key: { userId: 1, platform: 1, accountId: 1 }, unique: true }]),
    db
      .collection(c.posts)
      .createIndexes([
        { key: { clipId: 1 } },
        { key: { connectionId: 1 } },
        { key: { userId: 1 } },
        { key: { projectId: 1, status: 1 } },
        { key: { status: 1, scheduledAt: 1 } },
        { key: { autopilotId: 1, slotKey: 1 } },
      ]),
    db.collection(c.autopilots).createIndexes([{ key: { userId: 1, createdAt: -1 } }, { key: { status: 1 } }]),
    db.collection(c.autopilotVideos).createIndexes([{ key: { autopilotId: 1, videoId: 1 }, unique: true }, { key: { autopilotId: 1, status: 1 } }]),
    db.collection(c.autopilotClips).createIndexes([{ key: { autopilotId: 1, clipId: 1 }, unique: true }, { key: { autopilotId: 1, status: 1 } }, { key: { clipId: 1 } }]),
    db.collection(c.autopilotSkips).createIndexes([{ key: { autopilotId: 1 } }]),
  ]);
}

/** Short random id for new records. */
export const newId = () => randomUUID().slice(0, 12);

export const now = () => Date.now();

let lastStamp = 0;
/** A creation time that never repeats in this process, so "in the order they were made" stays exact. */
export function stamp() {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

/** A stored document → the row the app uses (`_id` becomes `id`). */
export function fromDoc<T extends { id: string }>(d: Doc<T>): T {
  const { _id, ...rest } = d;
  return { id: _id, ...rest } as unknown as T;
}

/**
 * The `$set` for an update: only the allowed fields that are in `patch`, plus `updatedAt`.
 * `undefined` values are stored as null (like clearing a field) unless `skipUndefined` is set.
 */
export function setFields(patch: object, allowed: readonly string[], opts: { skipUndefined?: boolean; touch?: boolean } = {}) {
  const set: Record<string, unknown> = opts.touch === false ? {} : { updatedAt: now() };
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    if (v === undefined && opts.skipUndefined) continue;
    set[k] = v === undefined ? null : v;
  }
  return set;
}

/** True for "this would break a unique index" (for insert-or-ignore). */
export const isDuplicate = (e: unknown) => e instanceof MongoServerError && e.code === 11000;

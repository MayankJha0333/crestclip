/**
 * Sample data for the "same answers as main" test (.github/compare-api.sh — runs on pull requests).
 *
 * Fills an EMPTY test database with one account that has a bit of everything: single-video projects, multi-video
 * projects (busy-looking, finished, all failed, empty), clips, credits, a connected channel, posts and Autopilots —
 * plus a second account whose things must never show up for the first. Fixed ids, so both app versions see the same.
 *
 * Never point this at the real database: it refuses unless the database name starts with "cmp".
 */
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { upcomingSlots } from '../modules/autopilot/autopilot.time.js';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB ?? '';
if (!uri || !dbName.startsWith('cmp')) throw new Error('Set MONGODB_URI and a MONGODB_DB starting with "cmp" (test databases only).');

export const TOKEN = 'compare-test-session-token';
const DAY = 86400_000;
const now = Date.now();
const DATA = '/data';
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

const client = new MongoClient(uri);
await client.connect();
const db = client.db(dbName);
await db.dropDatabase();
// every record here uses a short text id, like the app does
const col = (name: string) => db.collection<{ _id: string } & Record<string, unknown>>(name);

// accounts: A is the one we sign in as, B is someone else
const user = (id: string, email: string) => ({
  _id: id,
  email,
  name: id.toUpperCase(),
  passwordHash: null,
  googleSub: null,
  avatar: null,
  isAdmin: false,
  plan: 'free',
  cycleStart: now - 5 * DAY,
  cycleEnd: now + 25 * DAY, // inside the month, so signing in changes nothing
  dodoCustomerId: null,
  dodoSubscriptionId: null,
  subscriptionStatus: null,
  cancelAtPeriodEnd: false,
  createdAt: now - 30 * DAY,
  updatedAt: now - 30 * DAY,
});
await col('users').insertMany([user('usera', 'a@test.local'), user('userb', 'b@test.local')]);
await col('sessions').insertMany([
  { _id: sha(TOKEN), userId: 'usera', createdAt: now - DAY, expiresAt: now + 20 * DAY },
  { _id: sha('expired-token'), userId: 'usera', createdAt: now - 40 * DAY, expiresAt: now - DAY },
]);

// credits: two live grants, one used up, one expired, and some spending this month
await col('credit_grants').insertMany([
  { _id: 'g1', userId: 'usera', source: 'plan', amount: 60, remaining: 42, expiresAt: now + 25 * DAY, ref: 'plan-1', createdAt: now - 5 * DAY },
  { _id: 'g2', userId: 'usera', source: 'topup', amount: 100, remaining: 100, expiresAt: now + 300 * DAY, ref: 'topup-1', createdAt: now - 3 * DAY },
  { _id: 'g3', userId: 'usera', source: 'bonus', amount: 10, remaining: 0, expiresAt: now + 10 * DAY, ref: null, createdAt: now - 4 * DAY },
  { _id: 'g4', userId: 'usera', source: 'plan', amount: 60, remaining: 30, expiresAt: now - DAY, ref: 'plan-0', createdAt: now - 40 * DAY },
  { _id: 'g5', userId: 'userb', source: 'plan', amount: 60, remaining: 60, expiresAt: now + 25 * DAY, ref: 'plan-b', createdAt: now - 5 * DAY },
]);
const ev = (id: string, delta: number, kind: string, at: number, refunded = false) => ({ _id: id, userId: 'usera', delta, kind, note: kind, projectId: null, detail: null, refunded, createdAt: at });
await col('credit_events').insertMany([
  ev('e1', 60, 'grant', now - 5 * DAY),
  ev('e2', -10, 'spend', now - 4 * DAY),
  ev('e3', -8, 'spend', now - 2 * DAY),
  ev('e4', -5, 'spend', now - DAY, true),
  ev('e5', -7, 'spend', now - 10 * DAY), // last month
]);

// projects
let t = now - 10 * DAY;
const project = (id: string, userId: string, p: Record<string, unknown> = {}) => ({
  _id: id,
  userId,
  creditsCharged: 5,
  errorCode: null,
  createdAt: (t += 60_000),
  updatedAt: t,
  expiresAt: now + 5 * DAY,
  sourceType: 'url',
  sourceUrl: `https://www.youtube.com/watch?v=${id}`,
  title: `Video ${id}`,
  channel: 'Some channel',
  description: 'a description',
  parentId: null,
  duration: 600,
  width: 1920,
  height: 1080,
  viewCount: 12345,
  status: 'done',
  stage: 'done',
  stageDetail: null,
  progress: 100,
  error: null,
  options: { clipCount: 3 },
  signals: null,
  transcript: [{ start: 0, end: 1, text: 'hi' }],
  mediaPath: null,
  thumbPath: null,
  aiNotes: null,
  ...p,
});
await col('projects').insertMany([
  // single videos
  project('p1', 'usera'), // thumbnail comes from its best clip
  project('p2', 'usera', { title: null }), // no clips at all
  project('p3', 'usera', { thumbPath: `${DATA}/projects/p3/thumb.jpg` }), // own thumbnail file not on this disk → falls back to clips
  project('p4', 'usera', { status: 'failed', stage: 'failed', error: 'Gemini did not find a good moment', errorCode: 'credits', creditsCharged: 0 }),
  // a multi-video project: one finished, one failed, one whose own thumbnail is set
  project('g1', 'usera', { sourceType: 'group', sourceUrl: null, title: null, duration: null, options: { clipCount: 2 } }),
  project('k1', 'usera', { parentId: 'g1', title: 'First part' }),
  project('k2', 'usera', { parentId: 'g1', title: null, status: 'failed', stage: 'failed', error: 'Vertex AI said no', creditsCharged: 0 }),
  project('k3', 'usera', { parentId: 'g1', title: 'Third part', thumbPath: `${DATA}/projects/k3/thumb.jpg`, duration: 300 }),
  // a named multi-video project (Drive folder) with notes
  project('g2', 'usera', { sourceType: 'group', title: 'My folder', aiNotes: 'Picked the two funniest', duration: null }),
  project('k4', 'usera', { parentId: 'g2', title: 'Folder video 1' }),
  project('k5', 'usera', { parentId: 'g2', title: 'Folder video 2' }),
  // every video failed
  project('g3', 'usera', { sourceType: 'group', title: null, duration: null }),
  project('k6', 'usera', { parentId: 'g3', status: 'failed', stage: 'failed', error: 'Gemini timed out', errorCode: 'plan_limit' }),
  project('k7', 'usera', { parentId: 'g3', status: 'failed', stage: 'failed', error: 'Download failed' }),
  // empty multi-video project
  project('g4', 'usera', { sourceType: 'group', title: null, duration: null }),
  // someone else's
  project('pb', 'userb'),
]);

// clips
const clip = (id: string, projectId: string, peakScore: number, status: string, thumb: boolean) => ({
  _id: id,
  projectId,
  idx: Number(id.replace(/\D/g, '')) || 0,
  createdAt: now - DAY,
  updatedAt: now - DAY,
  start: 10,
  end: 40,
  title: `Clip ${id}`,
  hook: `Hook ${id}`,
  description: 'd',
  hashtags: ['#a'],
  reason: 'r',
  category: 'funny',
  rubric: null,
  aiScore: peakScore,
  audienceScore: null,
  peakScore,
  layout: 'fill',
  captionStyle: 'bold',
  showHook: true,
  status,
  error: status === 'failed' ? 'render failed' : null,
  filePath: status === 'ready' ? `${DATA}/projects/${projectId}/${id}.mp4` : null,
  thumbPath: thumb ? `${DATA}/projects/${projectId}/${id}.jpg` : null,
  reframe: null,
  version: 1,
  segments: null,
  motion: 'subtle',
  music: { track: 'none', volume: 15, duck: true },
  source: 'ai',
  pace: 'natural',
  hooks: [],
  keywords: [],
  teaser: null,
  emoji: false,
  flashForward: false,
  outDuration: 30,
});
await col('clips').insertMany([
  clip('c1', 'p1', 71, 'ready', true),
  clip('c2', 'p1', 93, 'ready', true), // best → p1's thumbnail
  clip('c3', 'p1', 99, 'failed', false), // best score but no thumbnail
  clip('c4', 'p3', 50, 'ready', true),
  clip('c5', 'k1', 80, 'ready', true),
  clip('c6', 'k1', 60, 'failed', false),
  clip('c7', 'k3', 88, 'ready', true),
  clip('c8', 'k4', 40, 'ready', false),
  clip('c9', 'k5', 77, 'ready', true),
  clip('c10', 'pb', 95, 'ready', true),
]);

// a connected channel, posts and Autopilots
await col('connections').insertMany([
  { _id: 'conn1', userId: 'usera', platform: 'youtube', accountId: 'UC1', name: 'My channel', handle: '@me', avatar: null, tokens: 'x', createdAt: now - 9 * DAY, updatedAt: now - 9 * DAY },
  { _id: 'connb', userId: 'userb', platform: 'youtube', accountId: 'UC2', name: 'B channel', handle: '@b', avatar: null, tokens: 'x', createdAt: now - 9 * DAY, updatedAt: now - 9 * DAY },
]);
const times = ['09:00', '13:00', '18:00', '22:00'];
const tz = 'Asia/Kolkata';
// only times at least 2 hours away, so nothing becomes due while the test runs
const slots = upcomingSlots(times, tz, now + 2 * 3600_000, 3);
const post = (id: string, p: Record<string, unknown>) => ({
  _id: id,
  clipId: 'c2',
  projectId: 'p1',
  userId: 'usera',
  connectionId: 'conn1',
  platform: 'youtube',
  title: 'Post title',
  caption: 'caption',
  privacy: 'public',
  scheduledAt: null,
  status: 'published',
  remoteId: 'yt1',
  remoteUrl: 'https://youtu.be/x',
  error: null,
  attempts: 1,
  createdAt: now - 3 * DAY,
  updatedAt: now - 3 * DAY,
  autopilotId: null,
  slotKey: null,
  ...p,
});
await col('posts').insertMany([
  post('post1', {}),
  post('post2', { status: 'failed', error: 'quota', clipId: 'c5', projectId: 'k1', createdAt: now - 2 * DAY }),
  post('post3', { status: 'scheduled', scheduledAt: slots[0].at, remoteId: null, remoteUrl: null, attempts: 0, autopilotId: 'ap1', slotKey: slots[0].key, clipId: 'c7', projectId: 'k3' }),
  post('post4', { status: 'canceled', scheduledAt: slots[1].at, remoteId: null, remoteUrl: null, attempts: 0, autopilotId: 'ap1', slotKey: slots[1].key, clipId: 'c9', projectId: 'k5' }),
  post('postb', { userId: 'userb', connectionId: 'connb', clipId: 'c10', projectId: 'pb' }),
]);
const apConfig = (connectionId: string) => ({
  sources: [{ kind: 'youtube_channel', value: '@someone', channelId: 'UCx', label: 'Someone' }],
  filters: { minViews: 1000, minMinutes: 5, maxMinutes: 120, maxAgeDays: 7, waitHours: 6, languages: ['en'] },
  options: { clipCount: 2 },
  clipsPerVideo: 2,
  times,
  timezone: tz,
  targets: [{ connectionId, privacy: 'public' }],
  mode: 'auto',
  caption: '{title}',
  rightsConfirmed: true,
});
await col('autopilots').insertMany([
  // paused, so the Autopilot engine never acts on it during the test
  { _id: 'ap1', userId: 'usera', name: 'Daily clips', status: 'paused', config: apConfig('conn1'), lastScanAt: now - DAY, lastError: null, createdAt: now - 8 * DAY, updatedAt: now - DAY },
  { _id: 'ap2', userId: 'usera', name: 'No times yet', status: 'paused', config: { ...apConfig('conn1'), times: [] }, lastScanAt: null, lastError: 'Nothing found', createdAt: now - 7 * DAY, updatedAt: now - DAY },
  { _id: 'apb', userId: 'userb', name: 'B pilot', status: 'paused', config: apConfig('connb'), lastScanAt: null, lastError: null, createdAt: now - 7 * DAY, updatedAt: now - DAY },
]);
const apClip = (id: string, clipId: string, status: string, score: number, slotKey: string | null = null) => ({
  _id: id,
  autopilotId: 'ap1',
  clipId,
  videoRowId: null,
  status,
  score,
  slotKey,
  createdAt: now - 2 * DAY,
  updatedAt: now - DAY,
});
await col('autopilot_clips').insertMany([
  apClip('ac1', 'c7', 'scheduled', 88, slots[0].key),
  apClip('ac2', 'c5', 'review', 80),
  apClip('ac3', 'c9', 'ready', 77),
  apClip('ac4', 'c8', 'ready', 40, slots[2].key), // booked on a time but not posted yet
  apClip('ac5', 'c2', 'posted', 93),
]);
const vid = (id: string, status: string, views: number) => ({
  _id: id,
  autopilotId: 'ap1',
  videoId: id,
  url: `https://youtu.be/${id}`,
  title: id,
  channel: 'Someone',
  thumbnail: null,
  views,
  duration: 900,
  publishedAt: now - DAY,
  status,
  reason: null,
  projectId: null,
  foundAt: now - DAY,
  updatedAt: now - DAY,
});
await col('autopilot_videos').insertMany([vid('v1', 'waiting', 5000), vid('v2', 'waiting', 9000), vid('v3', 'clipping', 7000), vid('v4', 'done', 100)]);
await col('autopilot_skips').insertOne({ _id: `ap1|${slots[3].key}`, autopilotId: 'ap1', slotKey: slots[3].key });

await client.close();
console.log(`seeded ${dbName}: 2 accounts, 16 projects, 10 clips, 5 posts, 3 autopilots (slots ${slots[0].key} … ${slots[3].key})`);

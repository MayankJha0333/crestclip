/**
 * Starts what the billing tests need: the stand-in Dodo API (dodo-mock.ts) and the CrestClip app on a throwaway
 * database, with the Dodo settings pointing at the stand-in. Import it before anything from ../src (the settings are
 * read when the app's code first loads).
 */
import type { AddressInfo } from 'node:net';
import { startMockDodo } from './dodo-mock.js';

export const KEY = 'test_key_mock';
export const WHSEC = 'whsec_' + Buffer.from('a-test-webhook-secret-32-bytes!!').toString('base64');
export const P = { creator: 'pdt_creator', pro: 'pdt_pro', topup: 'pdt_topup' };

export const mock = await startMockDodo({
  apiKey: KEY,
  products: [
    { product_id: P.creator, price: 1500, recurring: true },
    { product_id: P.pro, price: 2900, recurring: true },
    { product_id: P.topup, price: 500, recurring: false },
  ],
}).listen();

Object.assign(process.env, {
  DODO_MODE: 'test',
  DODO_API_URL: mock.url,
  DODO_API_KEY: KEY,
  DODO_WEBHOOK_SECRET: WHSEC,
  DODO_PRODUCT_CREATOR: P.creator,
  DODO_PRODUCT_PRO: P.pro,
  DODO_PRODUCT_TOPUP: P.topup,
  RAZORPAY_KEY_ID: '',
  RAZORPAY_KEY_SECRET: '',
  MONGODB_URI: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/',
  MONGODB_DB: `crestclip_billing_test_${Date.now()}`,
  PUBLIC_URL: process.env.PUBLIC_URL ?? 'https://crestclip.test',
  REDIS_URL: '',
});

// FerretDB (a MongoDB stand-in for offline runs) has no partial indexes: there, keep the one that matters here
// (unique credit-grant refs — what stops double credits) and skip the others. Real MongoDB never takes this path.
const { Collection } = await import('mongodb');
const createIndexes = Collection.prototype.createIndexes;
Collection.prototype.createIndexes = async function (this: any, specs: any[], ...rest: any[]) {
  try {
    return await createIndexes.call(this, specs, ...rest);
  } catch (e) {
    if ((e as { code?: number }).code !== 238) throw e;
    const plain = specs
      .filter((s) => !s.partialFilterExpression || 'ref' in s.key)
      .map(({ partialFilterExpression: _p, ...s }) => s);
    return await createIndexes.call(this, plain, ...rest);
  }
} as any;

const db = await import('../src/db/index.js');
export const { users, sessions, credits, payments } = db;
const dbHandle = await (await import('../src/db/connection.js')).connectDb();
// FerretDB also has no $lookup (used to read a session and its user in one trip): read them in two there.
{
  const crypto = await import('node:crypto');
  const { collection: col } = await import('../src/db/connection.js');
  const oneTrip = sessions.user.bind(sessions);
  sessions.user = async (token: string) => {
    try {
      return await oneTrip(token);
    } catch (e) {
      if ((e as { code?: number }).code !== 238) throw e;
      const s = await col<any>('sessions').findOne({ _id: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: { $gt: Date.now() } });
      return s ? users.get(s.userId) : null;
    }
  };
}
// …and no $subtract inside $group (the "used this month" meter): add it up here there.
{
  const { collection: col } = await import('../src/db/connection.js');
  const inDb = credits.spentSince.bind(credits);
  credits.spentSince = async (userId: string, since: number) => {
    try {
      return await inDb(userId, since);
    } catch (e) {
      if ((e as { code?: number }).code !== 238) throw e;
      const rows = await col<any>('credit_events').find({ userId, kind: 'spend', refunded: false, createdAt: { $gte: since } }).toArray();
      return rows.reduce((n, r) => n - r.delta, 0);
    }
  };
}
const { createApp } = await import('../src/app.js');
export const { collection } = await import('../src/db/connection.js');
const server = createApp().listen(Number(process.env.TEST_APP_PORT ?? 0), '127.0.0.1');
await new Promise((r) => server.once('listening', r));
export const APP = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** Stop everything and drop the throwaway database. */
export async function closeAll() {
  await dbHandle.dropDatabase().catch(() => {});
  server.close();
  await mock.close();
  await db.closeDb();
}

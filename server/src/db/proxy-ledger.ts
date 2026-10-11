import crypto from 'node:crypto';
import { collection, COLLECTIONS } from './connection.js';

interface DailyUsage {
  _id: string;
  usedBytes: number;
  reservations: Record<string, number>;
}

/** Reserve an estimated video's egress once per UTC day, shared atomically across workers in MongoDB. */
export async function reserveProxyBytes(videoKey: string, bytes: number, capBytes: number) {
  const day = new Date().toISOString().slice(0, 10);
  const id = `proxy_usage:${day}`;
  const reservation = crypto.createHash('sha256').update(videoKey).digest('hex').slice(0, 32);
  const field = `reservations.${reservation}`;
  const col = collection<DailyUsage>(COLLECTIONS.meta);
  await col.updateOne({ _id: id }, { $setOnInsert: { usedBytes: 0, reservations: {} } }, { upsert: true });

  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await col.findOne({ _id: id });
    const oldBytes = current?.reservations?.[reservation] ?? 0;
    const wanted = Math.max(oldBytes, Math.ceil(bytes));
    if (wanted === oldBytes) return { allowed: true, usedBytes: current?.usedBytes ?? 0 };
    const delta = wanted - oldBytes;
    const filter: Record<string, unknown> = { _id: id, usedBytes: { $lte: capBytes - delta } };
    filter[field] = oldBytes ? oldBytes : { $exists: false };
    const updated = await col.updateOne(filter, { $inc: { usedBytes: delta }, $set: { [field]: wanted } });
    if (updated.modifiedCount) return { allowed: true, usedBytes: (current?.usedBytes ?? 0) + delta };
  }
  const current = await col.findOne({ _id: id });
  return { allowed: false, usedBytes: current?.usedBytes ?? 0 };
}

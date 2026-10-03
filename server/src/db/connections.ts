import { collection, COLLECTIONS, fromDoc, newId, now, stamp, type Doc } from './connection.js';

export interface ConnectionRow {
  id: string;
  userId: string | null;
  platform: 'youtube' | 'instagram';
  accountId: string;
  name: string | null;
  handle: string | null;
  avatar: string | null;
  /** encrypted JSON {access, refresh, expiresAt} */
  tokens: string;
  createdAt: number;
  updatedAt: number;
}

const col = () => collection<Doc<ConnectionRow>>(COLLECTIONS.connections);
const toConn = (d: Doc<ConnectionRow>) => fromDoc<ConnectionRow>(d);

export const connections = {
  async list(userId: string): Promise<ConnectionRow[]> {
    return (await col().find({ userId }).sort({ platform: 1, createdAt: 1 }).toArray()).map(toConn);
  },
  async getMany(ids: string[]): Promise<ConnectionRow[]> {
    return ids.length
      ? (
          await col()
            .find({ _id: { $in: [...new Set(ids)] } })
            .toArray()
        ).map(toConn)
      : [];
  },
  async get(id: string): Promise<ConnectionRow | null> {
    const d = await col().findOne({ _id: id });
    return d ? toConn(d) : null;
  },
  /**
   * Insert or update: the same person connecting the same YouTube / Instagram account again = a reconnect.
   * Different CrestClip accounts may connect the same channel; each keeps its own sign-in.
   */
  async upsert(c: { userId: string; platform: string; accountId: string; name: string | null; handle: string | null; avatar: string | null; tokens: string }): Promise<ConnectionRow> {
    const at = stamp();
    const d = await col().findOneAndUpdate(
      { userId: c.userId, platform: c.platform as ConnectionRow['platform'], accountId: c.accountId },
      {
        $set: { name: c.name, handle: c.handle, avatar: c.avatar, tokens: c.tokens, updatedAt: at },
        $setOnInsert: { _id: newId(), createdAt: at },
      },
      { upsert: true, returnDocument: 'after' },
    );
    return toConn(d!);
  },
  async setTokens(id: string, tokens: string) {
    await col().updateOne({ _id: id }, { $set: { tokens, updatedAt: now() } });
  },
  /** Disconnect: the account and its posts. */
  async remove(id: string) {
    await collection(COLLECTIONS.posts).deleteMany({ connectionId: id });
    await col().deleteOne({ _id: id });
  },
};

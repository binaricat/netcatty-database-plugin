/**
 * Pure-TS MongoDB Wire Protocol (OP_MSG, opcode 2013) Driver.
 * Uses pure-JS `bson` + WebCrypto SCRAM-SHA-256 — 100% browser-sandbox compatible!
 */

import { Binary, BSON, ObjectId } from 'bson';
import { ScramSha256Session } from './crypto';
import { BufferedByteStream, concatBytes } from './streamBuffer';
import type {
  ByteStreamTransport,
  ConnectionConfig,
  ConnectionInfo,
  MongoCollectionInfo,
  MongoCollectionStats,
  MongoDatabaseInfo,
  MongoDocument,
  MongoDriver,
  MongoFindOptions,
  MongoFindResult,
  MongoIndexInfo,
  TestConnectionResult,
} from './types';

const OP_MSG = 2013;
const te = new TextEncoder();
const td = new TextDecoder('utf-8');

function encodeOpMsg(requestId: number, commandDoc: MongoDocument): Uint8Array {
  const bsonBody = BSON.serialize(commandDoc);
  // 16-byte header + 4-byte flagBits + 1-byte section kind (0) + bsonBody
  const totalLen = 16 + 4 + 1 + bsonBody.length;
  const header = new Uint8Array(21);
  const dv = new DataView(header.buffer);
  dv.setInt32(0, totalLen, true);
  dv.setInt32(4, requestId, true);
  dv.setInt32(8, 0, true); // responseTo
  dv.setInt32(12, OP_MSG, true);
  dv.setUint32(16, 0, true); // flagBits
  header[20] = 0; // Section kind 0 (Body)
  return concatBytes(header, bsonBody);
}

function decodeOpMsgBody(frame: Uint8Array): MongoDocument {
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const opCode = dv.getInt32(12, true);
  if (opCode !== OP_MSG) {
    throw new Error(`Unexpected MongoDB reply opcode: ${opCode} (expected ${OP_MSG})`);
  }
  // Skip 16-byte header + 4-byte flagBits
  let pos = 20;
  let body: MongoDocument = {};
  while (pos < frame.length) {
    const kind = frame[pos++];
    if (kind === 0) {
      const docLen = dv.getInt32(pos, true);
      body = BSON.deserialize(frame.subarray(pos, pos + docLen)) as MongoDocument;
      pos += docLen;
    } else if (kind === 1) {
      const secLen = dv.getInt32(pos, true);
      pos += secLen;
    } else {
      break;
    }
  }
  return body;
}

export class PureMongoDriver implements MongoDriver {
  readonly engine = 'mongodb' as const;
  readonly family = 'mongodb' as const;

  private stream: BufferedByteStream | null = null;
  private config: ConnectionConfig | null = null;
  private _connected = false;
  private _serverVersion = '';
  private _tlsActive = false;
  private reqId = 1;
  private busy: Promise<unknown> = Promise.resolve();

  get connected(): boolean {
    return this._connected;
  }
  get serverVersion(): string {
    return this._serverVersion;
  }

  private async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => {});
    return run;
  }

  private async sendCommandRaw(database: string, command: MongoDocument): Promise<MongoDocument> {
    const bs = this.stream;
    if (!bs) throw new Error('MongoDB connection is closed');
    const requestId = this.reqId++;
    const payload = { ...command, $db: database };
    const wire = encodeOpMsg(requestId, payload);
    await bs.write(wire);

    const lenBytes = await bs.readExact(4);
    const totalLen = new DataView(lenBytes.buffer, lenBytes.byteOffset, 4).getInt32(0, true);
    if (totalLen < 20 || totalLen > 64 * 1024 * 1024) {
      throw new Error(`Invalid MongoDB OP_MSG length: ${totalLen}`);
    }
    const rest = await bs.readExact(totalLen - 4);
    const fullFrame = concatBytes(lenBytes, rest);
    const doc = decodeOpMsgBody(fullFrame);

    if (doc.ok === 0) {
      const code = doc.code !== undefined ? ` (${doc.codeName ?? doc.code})` : '';
      throw new Error(`MongoDB command error${code}: ${String(doc.errmsg ?? 'Unknown error')}`);
    }
    return doc;
  }

  async runCommand(database: string, command: MongoDocument): Promise<MongoDocument> {
    if (!this._connected) throw new Error('MongoDB is not connected');
    return this.enqueue(() => this.sendCommandRaw(database, command));
  }

  private async authenticateScramSha256(
    authDb: string,
    username: string,
    password: string,
  ): Promise<void> {
    const scram = new ScramSha256Session(username, password);
    const firstMsg = te.encode(scram.clientFirstMessage());

    const startResp = await this.sendCommandRaw(authDb, {
      saslStart: 1,
      mechanism: 'SCRAM-SHA-256',
      payload: new Binary(firstMsg),
      autoAuthorize: 1,
      options: { skipEmptyExchange: true },
    });

    const conversationId = startResp.conversationId;
    const serverFirstBytes = extractBinaryBytes(startResp.payload);
    const clientFinal = await scram.processServerFirst(td.decode(serverFirstBytes));

    const contResp = await this.sendCommandRaw(authDb, {
      saslContinue: 1,
      conversationId,
      payload: new Binary(te.encode(clientFinal)),
    });

    const serverFinalBytes = extractBinaryBytes(contResp.payload);
    scram.verifyServerFinal(td.decode(serverFinalBytes));

    if (!contResp.done) {
      await this.sendCommandRaw(authDb, {
        saslContinue: 1,
        conversationId,
        payload: new Binary(new Uint8Array(0)),
      });
    }
  }

  async connect(config: ConnectionConfig, transport: ByteStreamTransport): Promise<ConnectionInfo> {
    const started = performance.now();
    this.config = config;
    const host = config.host ?? '127.0.0.1';
    const port = config.port ?? 27017;
    const useTls = (config.tlsMode ?? 'disable') !== 'disable';

    const rawStream = await transport.connect({
      host,
      port,
      tls: useTls,
      servername: host,
      allowSelfSigned: config.allowSelfSigned ?? config.tlsMode !== 'verify-full',
      caPem: config.caPem,
      timeoutMs: config.timeoutMs ?? 15000,
    });
    const bs = new BufferedByteStream(rawStream);
    this.stream = bs;
    this._tlsActive = useTls;

    try {
      // Handshake: hello
      await this.sendCommandRaw('admin', {
        hello: 1,
        client: {
          application: { name: 'netcatty-database' },
          driver: { name: 'netcatty-pure-ts', version: '1.0.0' },
          os: { type: 'Browser' },
        },
        ...(config.username
          ? { saslSupportedMechs: `${config.authSource || 'admin'}.${config.username}` }
          : {}),
      });

      if (config.username) {
        const authDb = config.authSource || 'admin';
        await this.authenticateScramSha256(authDb, config.username, config.password ?? '');
      }

      const info: MongoDocument = await this.sendCommandRaw('admin', { buildInfo: 1 }).catch(
        (): MongoDocument => ({}),
      );
      this._serverVersion = info.version ? String(info.version) : 'MongoDB';
      this._connected = true;

      return {
        engine: 'mongodb',
        family: 'mongodb',
        serverVersion: this._serverVersion,
        database: config.database || 'admin',
        tlsActive: this._tlsActive,
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      this._connected = false;
      await bs.close().catch(() => {});
      this.stream = null;
      throw err;
    }
  }

  async testConnection(): Promise<TestConnectionResult> {
    const started = performance.now();
    try {
      await this.ping();
      return {
        ok: true,
        serverVersion: this._serverVersion,
        latencyMs: Math.round(performance.now() - started),
        tlsActive: this._tlsActive,
      };
    } catch (err) {
      return {
        ok: false,
        serverVersion: this._serverVersion,
        latencyMs: Math.round(performance.now() - started),
        tlsActive: this._tlsActive,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async close(): Promise<void> {
    this._connected = false;
    const bs = this.stream;
    this.stream = null;
    if (bs) {
      await bs.close().catch(() => {});
    }
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    const started = performance.now();
    const res = await this.runCommand('admin', { ping: 1 });
    return { ok: Number(res.ok) === 1, latencyMs: Math.round(performance.now() - started) };
  }

  async buildInfo(): Promise<MongoDocument> {
    return this.runCommand('admin', { buildInfo: 1 });
  }

  async listDatabases(): Promise<MongoDatabaseInfo[]> {
    const res = await this.runCommand('admin', { listDatabases: 1 });
    const dbs = Array.isArray(res.databases) ? (res.databases as MongoDocument[]) : [];
    return dbs.map((d) => ({
      name: String(d.name),
      sizeOnDisk: typeof d.sizeOnDisk === 'number' ? d.sizeOnDisk : undefined,
      empty: typeof d.empty === 'boolean' ? d.empty : undefined,
    }));
  }

  async listCollections(database: string): Promise<MongoCollectionInfo[]> {
    const res = await this.runCommand(database, { listCollections: 1 });
    const cursor = res.cursor as { firstBatch?: MongoDocument[] } | undefined;
    const batch = Array.isArray(cursor?.firstBatch) ? cursor.firstBatch : [];
    return batch.map((c) => ({
      name: String(c.name),
      type: String(c.type ?? 'collection'),
    }));
  }

  async find(
    database: string,
    collection: string,
    options?: MongoFindOptions,
  ): Promise<MongoFindResult> {
    const started = performance.now();
    const cmd: MongoDocument = {
      find: collection,
      filter: options?.filter ?? {},
      limit: options?.limit ?? 50,
    };
    if (options?.sort && Object.keys(options.sort).length > 0) cmd.sort = options.sort;
    if (options?.projection && Object.keys(options.projection).length > 0) {
      cmd.projection = options.projection;
    }
    if (options?.skip && options.skip > 0) cmd.skip = options.skip;

    const [findRes, totalCount] = await Promise.all([
      this.runCommand(database, cmd),
      this.countDocuments(database, collection, options?.filter),
    ]);
    const cursor = findRes.cursor as { firstBatch?: MongoDocument[] } | undefined;
    const documents = Array.isArray(cursor?.firstBatch) ? cursor.firstBatch : [];

    return {
      documents,
      totalCount,
      executionMs: Math.round(performance.now() - started),
    };
  }

  async countDocuments(
    database: string,
    collection: string,
    filter?: MongoDocument,
  ): Promise<number> {
    const res = await this.runCommand(database, {
      count: collection,
      query: filter ?? {},
    });
    return Number(res.n ?? 0);
  }

  async aggregate(
    database: string,
    collection: string,
    pipeline: MongoDocument[],
  ): Promise<MongoDocument[]> {
    const res = await this.runCommand(database, {
      aggregate: collection,
      pipeline,
      cursor: {},
    });
    const cursor = res.cursor as { firstBatch?: MongoDocument[] } | undefined;
    return Array.isArray(cursor?.firstBatch) ? cursor.firstBatch : [];
  }

  async insertOne(
    database: string,
    collection: string,
    document: MongoDocument,
  ): Promise<{ insertedId: unknown }> {
    const docToInsert = document._id !== undefined ? document : { _id: new ObjectId(), ...document };
    await this.runCommand(database, {
      insert: collection,
      documents: [docToInsert],
    });
    return { insertedId: docToInsert._id };
  }

  async replaceOne(
    database: string,
    collection: string,
    filter: MongoDocument,
    replacement: MongoDocument,
    upsert = false,
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const res = await this.runCommand(database, {
      update: collection,
      updates: [{ q: filter, u: replacement, upsert, multi: false }],
    });
    return {
      matchedCount: Number(res.n ?? 0),
      modifiedCount: Number(res.nModified ?? 0),
    };
  }

  async updateOne(
    database: string,
    collection: string,
    filter: MongoDocument,
    update: MongoDocument,
    upsert = false,
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const res = await this.runCommand(database, {
      update: collection,
      updates: [{ q: filter, u: update, upsert, multi: false }],
    });
    return {
      matchedCount: Number(res.n ?? 0),
      modifiedCount: Number(res.nModified ?? 0),
    };
  }

  async deleteOne(
    database: string,
    collection: string,
    filter: MongoDocument,
  ): Promise<{ deletedCount: number }> {
    const res = await this.runCommand(database, {
      delete: collection,
      deletes: [{ q: filter, limit: 1 }],
    });
    return { deletedCount: Number(res.n ?? 0) };
  }

  async listIndexes(database: string, collection: string): Promise<MongoIndexInfo[]> {
    const res = await this.runCommand(database, { listIndexes: collection });
    const cursor = res.cursor as { firstBatch?: MongoDocument[] } | undefined;
    const batch = Array.isArray(cursor?.firstBatch) ? cursor.firstBatch : [];
    return batch.map((idx) => ({
      name: String(idx.name),
      key: (idx.key ?? {}) as Record<string, number | string>,
      unique: typeof idx.unique === 'boolean' ? idx.unique : undefined,
      sparse: typeof idx.sparse === 'boolean' ? idx.sparse : undefined,
      expireAfterSeconds:
        typeof idx.expireAfterSeconds === 'number' ? idx.expireAfterSeconds : undefined,
    }));
  }

  async createIndexes(
    database: string,
    collection: string,
    indexes: Array<{ key: Record<string, number | string>; name?: string; unique?: boolean }>,
  ): Promise<MongoDocument> {
    const specs = indexes.map((idx) => ({
      key: idx.key,
      name:
        idx.name ??
        Object.entries(idx.key)
          .map(([k, v]) => `${k}_${v}`)
          .join('_'),
      ...(idx.unique !== undefined ? { unique: idx.unique } : {}),
    }));
    return this.runCommand(database, {
      createIndexes: collection,
      indexes: specs,
    });
  }

  async dropIndexes(
    database: string,
    collection: string,
    indexName: string,
  ): Promise<MongoDocument> {
    return this.runCommand(database, {
      dropIndexes: collection,
      index: indexName,
    });
  }

  async collStats(database: string, collection: string): Promise<MongoCollectionStats> {
    const res = await this.runCommand(database, { collStats: collection });
    return {
      ns: String(res.ns ?? `${database}.${collection}`),
      count: Number(res.count ?? 0),
      size: Number(res.size ?? 0),
      avgObjSize: Number(res.avgObjSize ?? 0),
      storageSize: Number(res.storageSize ?? 0),
      nindexes: Number(res.nindexes ?? 0),
      totalIndexSize: Number(res.totalIndexSize ?? 0),
    };
  }
}

function extractBinaryBytes(val: unknown): Uint8Array {
  if (val instanceof Uint8Array) return val;
  if (val && typeof val === 'object' && 'buffer' in val) {
    const bin = val as { buffer: Uint8Array; position?: number };
    const buf = bin.buffer instanceof Uint8Array ? bin.buffer : new Uint8Array(bin.buffer);
    return bin.position !== undefined ? buf.subarray(0, bin.position) : buf;
  }
  throw new Error('Expected BSON Binary payload in MongoDB SASL response');
}

export { ObjectId, Binary };

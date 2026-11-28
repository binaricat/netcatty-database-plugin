/**
 * Pure-TS MongoDB Wire Protocol (OP_MSG, opcode 2013) Driver.
 * Uses pure-JS `bson` + WebCrypto SCRAM-SHA-256 — 100% browser-sandbox compatible!
 */

import { Binary, BSON, Decimal128, EJSON, Long, ObjectId, Timestamp, UUID } from 'bson';
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
  MongoSchemaAnalysis,
  MongoSchemaFieldInfo,
  TestConnectionResult,
} from './types';

/**
 * Parses MongoDB Extended JSON (supports {$oid}, {$date}, {$numberLong}, {$binary}, etc.)
 * into real BSON-typed objects for filters, updates, and replacements.
 */
export function parseMongoEjson<T = MongoDocument>(jsonText: string): T {
  const trimmed = jsonText.trim();
  if (!trimmed) return {} as T;
  return EJSON.parse(trimmed, { relaxed: true }) as T;
}

/**
 * Serializes BSON documents (preserving ObjectId, Date, Binary, Decimal128) to Extended JSON.
 */
export function stringifyMongoEjson(value: unknown, pretty = true): string {
  return EJSON.stringify(value, undefined, pretty ? 2 : 0, { relaxed: false });
}

export interface MongoExplainStageNode {
  stage: string;
  nReturned?: number;
  executionTimeMillisEstimate?: number;
  indexName?: string;
  direction?: string;
  filter?: unknown;
  children: MongoExplainStageNode[];
}

export interface MongoExplainSummary {
  winningStage: string;
  nReturned: number;
  executionTimeMillis: number;
  totalKeysExamined: number;
  totalDocsExamined: number;
  isCollectionScan: boolean;
  tree: MongoExplainStageNode | null;
  raw: MongoDocument;
}

export interface MongoGridFsFileInfo {
  _id: unknown;
  filename: string;
  length: number;
  chunkSize: number;
  uploadDate?: string;
  contentType?: string;
  metadata?: MongoDocument;
}

export interface MongoUserEntry {
  user: string;
  db: string;
  roles: Array<{ role: string; db: string }>;
}

function buildExplainStageNode(raw: unknown): MongoExplainStageNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const stage = String(obj.stage ?? obj.inputStage ? (obj.stage ?? 'STAGE') : 'STAGE');
  const children: MongoExplainStageNode[] = [];
  if (obj.inputStage) {
    const child = buildExplainStageNode(obj.inputStage);
    if (child) children.push(child);
  }
  if (Array.isArray(obj.inputStages)) {
    for (const s of obj.inputStages) {
      const child = buildExplainStageNode(s);
      if (child) children.push(child);
    }
  }
  if (obj.shards && typeof obj.shards === 'object' && !Array.isArray(obj.shards)) {
    for (const shardVal of Object.values(obj.shards as Record<string, unknown>)) {
      const child = buildExplainStageNode(shardVal);
      if (child) children.push(child);
    }
  }
  return {
    stage,
    nReturned: typeof obj.nReturned === 'number' ? obj.nReturned : undefined,
    executionTimeMillisEstimate:
      typeof obj.executionTimeMillisEstimate === 'number'
        ? obj.executionTimeMillisEstimate
        : undefined,
    indexName: typeof obj.indexName === 'string' ? obj.indexName : undefined,
    direction: typeof obj.direction === 'string' ? obj.direction : undefined,
    filter: obj.filter,
    children,
  };
}

/**
 * Extracts a concise executionStats summary + stage tree from a MongoDB `explain` document.
 */
export function summarizeMongoExplain(raw: MongoDocument): MongoExplainSummary {
  const execStats = (raw.executionStats ?? {}) as Record<string, unknown>;
  const queryPlanner = (raw.queryPlanner ?? {}) as Record<string, unknown>;
  const rootRaw = execStats.executionStages ?? queryPlanner.winningPlan ?? null;
  const tree = buildExplainStageNode(rootRaw);

  const hasCollScan = (node: MongoExplainStageNode | null): boolean => {
    if (!node) return false;
    if (node.stage === 'COLLSCAN') return true;
    return node.children.some((c) => hasCollScan(c));
  };

  return {
    winningStage: tree?.stage ?? 'UNKNOWN',
    nReturned: Number(execStats.nReturned ?? 0),
    executionTimeMillis: Number(execStats.executionTimeMillis ?? 0),
    totalKeysExamined: Number(execStats.totalKeysExamined ?? 0),
    totalDocsExamined: Number(execStats.totalDocsExamined ?? 0),
    isCollectionScan: hasCollScan(tree),
    tree,
    raw,
  };
}

/**
 * Parses bulk MongoDB JSON/EJSON input (either a JSON array or newline-delimited EJSON objects).
 */
export function parseMongoBulkDocuments(input: string): MongoDocument[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const parsed = parseMongoEjson<unknown>(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error('Expected a JSON/EJSON array of documents');
    }
    return parsed.map((item, idx) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`Item at index ${idx} is not a JSON object`);
      }
      return item as MongoDocument;
    });
  }
  // Support single object or NDJSON / JSON Lines
  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 1) {
    const single = parseMongoEjson<unknown>(lines[0]);
    if (!single || typeof single !== 'object' || Array.isArray(single)) {
      throw new Error('Expected a JSON/EJSON object');
    }
    return [single as MongoDocument];
  }
  // Try parsing whole text as a single pretty-printed object first
  try {
    const whole = parseMongoEjson<unknown>(trimmed);
    if (whole && typeof whole === 'object' && !Array.isArray(whole)) {
      return [whole as MongoDocument];
    }
  } catch {
    // Fall back to line-by-line NDJSON
  }
  return lines.map((line, idx) => {
    const doc = parseMongoEjson<unknown>(line);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error(`NDJSON line ${idx + 1} is not an object`);
    }
    return doc as MongoDocument;
  });
}

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

  async createCollection(
    database: string,
    name: string,
    options?: MongoDocument,
  ): Promise<void> {
    await this.runCommand(database, { create: name, ...(options ?? {}) });
  }

  async dropCollection(database: string, name: string): Promise<void> {
    await this.runCommand(database, { drop: name });
  }

  async analyzeCollectionSchema(
    database: string,
    collection: string,
    sampleSize = 200,
  ): Promise<MongoSchemaAnalysis> {
    const capped = Math.max(1, Math.min(2000, sampleSize));
    const [totalDocuments, sampledDocs] = await Promise.all([
      this.countDocuments(database, collection),
      this.aggregate(database, collection, [{ $sample: { size: capped } }]).catch(async () => {
        const res = await this.find(database, collection, { limit: capped });
        return res.documents;
      }),
    ]);

    const fieldStats = new Map<
      string,
      { count: number; types: Map<string, number>; samples: string[] }
    >();

    const recordValue = (path: string, val: unknown) => {
      let entry = fieldStats.get(path);
      if (!entry) {
        entry = { count: 0, types: new Map(), samples: [] };
        fieldStats.set(path, entry);
      }
      entry.count++;
      const t = detectBsonType(val);
      entry.types.set(t, (entry.types.get(t) ?? 0) + 1);
      if (entry.samples.length < 3 && val !== null && val !== undefined) {
        const preview = formatSchemaSample(val);
        if (!entry.samples.includes(preview)) entry.samples.push(preview);
      }
    };

    const walk = (doc: Record<string, unknown>, prefix: string, depth: number) => {
      if (depth > 6) return;
      for (const [k, v] of Object.entries(doc)) {
        const path = prefix ? `${prefix}.${k}` : k;
        recordValue(path, v);
        if (v !== null && typeof v === 'object' && !isBsonLeaf(v)) {
          if (Array.isArray(v)) {
            if (v.length > 0 && v[0] && typeof v[0] === 'object' && !isBsonLeaf(v[0]) && !Array.isArray(v[0])) {
              walk(v[0] as Record<string, unknown>, `${path}[]`, depth + 1);
            }
          } else {
            walk(v as Record<string, unknown>, path, depth + 1);
          }
        }
      }
    };

    for (const doc of sampledDocs) {
      walk(doc, '', 0);
    }

    const denom = Math.max(1, sampledDocs.length);
    const fields: MongoSchemaFieldInfo[] = Array.from(fieldStats.entries())
      .map(([path, stat]) => ({
        path,
        count: stat.count,
        percentage: Math.round((stat.count / denom) * 1000) / 10,
        types: Array.from(stat.types.entries())
          .map(([type, count]) => ({
            type,
            count,
            percentage: Math.round((count / stat.count) * 1000) / 10,
          }))
          .sort((a, b) => b.count - a.count),
        samples: stat.samples,
      }))
      .sort((a, b) => {
        if (a.path === '_id') return -1;
        if (b.path === '_id') return 1;
        return b.count - a.count || a.path.localeCompare(b.path);
      });

    return {
      database,
      collection,
      sampleCount: sampledDocs.length,
      totalDocuments,
      fields,
    };
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
    const cleanReplacement: MongoDocument = { ...replacement };
    if (filter._id !== undefined) {
      // Preserve the immutable BSON _id (e.g. ObjectId) from the filter if replacement omitted or stringified it
      if (
        cleanReplacement._id === undefined ||
        (filter._id instanceof ObjectId &&
          typeof cleanReplacement._id === 'string' &&
          cleanReplacement._id === filter._id.toHexString())
      ) {
        cleanReplacement._id = filter._id;
      }
    }
    const res = await this.runCommand(database, {
      update: collection,
      updates: [{ q: filter, u: cleanReplacement, upsert, multi: false }],
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

  async renameCollection(
    database: string,
    fromName: string,
    toName: string,
    dropTarget = false,
  ): Promise<void> {
    await this.runCommand('admin', {
      renameCollection: `${database}.${fromName}`,
      to: `${database}.${toName}`,
      dropTarget,
    });
  }

  async cloneCollection(
    database: string,
    fromName: string,
    toName: string,
  ): Promise<void> {
    await this.runCommand(database, {
      aggregate: fromName,
      pipeline: [{ $match: {} }, { $out: toName }],
      cursor: {},
    });
  }

  async createDatabase(database: string, initialCollection = 'init'): Promise<void> {
    const dbName = database.trim();
    const coll = initialCollection.trim() || 'init';
    if (!dbName) throw new Error('Database name is required');
    await this.createCollection(dbName, coll);
  }

  async dropDatabase(database: string): Promise<void> {
    const dbName = database.trim();
    if (!dbName) throw new Error('Database name is required');
    await this.runCommand(dbName, { dropDatabase: 1 });
  }

  async explainQuery(
    database: string,
    collection: string,
    filter?: MongoDocument,
    sort?: MongoDocument,
  ): Promise<MongoDocument> {
    const findCmd: MongoDocument = {
      find: collection,
      filter: filter ?? {},
    };
    if (sort && Object.keys(sort).length > 0) {
      findCmd.sort = sort;
    }
    return this.runCommand(database, {
      explain: findCmd,
      verbosity: 'executionStats',
    });
  }

  async getCollectionValidation(
    database: string,
    collection: string,
  ): Promise<{ validator?: MongoDocument; validationLevel?: string; validationAction?: string }> {
    const res = await this.runCommand(database, {
      listCollections: 1,
      filter: { name: collection },
    });
    const cursor = res.cursor as { firstBatch?: MongoDocument[] } | undefined;
    const info = cursor?.firstBatch?.[0];
    const opts = (info?.options ?? {}) as Record<string, unknown>;
    return {
      validator:
        opts.validator && typeof opts.validator === 'object'
          ? (opts.validator as MongoDocument)
          : undefined,
      validationLevel:
        typeof opts.validationLevel === 'string' ? opts.validationLevel : undefined,
      validationAction:
        typeof opts.validationAction === 'string' ? opts.validationAction : undefined,
    };
  }

  async setCollectionValidation(
    database: string,
    collection: string,
    options: { validator?: MongoDocument; validationLevel?: string; validationAction?: string },
  ): Promise<void> {
    const cmd: MongoDocument = { collMod: collection };
    if (options.validator !== undefined) cmd.validator = options.validator;
    if (options.validationLevel) cmd.validationLevel = options.validationLevel;
    if (options.validationAction) cmd.validationAction = options.validationAction;
    await this.runCommand(database, cmd);
  }

  async listGridFsBuckets(
    database: string,
  ): Promise<Array<{ name: string; filesCount?: number; totalBytes?: number }>> {
    const colls = await this.listCollections(database);
    const names = new Set(colls.map((c) => c.name));
    const bucketNames: string[] = [];
    for (const c of colls) {
      if (c.name.endsWith('.files')) {
        const prefix = c.name.slice(0, -'.files'.length);
        if (prefix && names.has(`${prefix}.chunks`)) {
          bucketNames.push(prefix);
        }
      }
    }
    const buckets: Array<{ name: string; filesCount?: number; totalBytes?: number }> = [];
    for (const name of bucketNames.sort()) {
      let filesCount: number | undefined;
      let totalBytes: number | undefined;
      try {
        filesCount = await this.countDocuments(database, `${name}.files`);
        const agg = await this.aggregate(database, `${name}.files`, [
          { $group: { _id: null, total: { $sum: '$length' } } },
        ]);
        if (agg[0] && typeof agg[0].total === 'number') {
          totalBytes = agg[0].total;
        }
      } catch {
        // ignore stats errors on restricted permissions
      }
      buckets.push({ name, filesCount, totalBytes });
    }
    return buckets;
  }

  async listGridFsFiles(
    database: string,
    bucket: string,
    limit = 100,
  ): Promise<MongoGridFsFileInfo[]> {
    const res = await this.find(database, `${bucket}.files`, {
      sort: { uploadDate: -1 },
      limit,
    });
    return res.documents.map((doc) => ({
      _id: doc._id,
      filename: String(doc.filename ?? ''),
      length: Number(doc.length ?? 0),
      chunkSize: Number(doc.chunkSize ?? 261120),
      uploadDate:
        doc.uploadDate instanceof Date
          ? doc.uploadDate.toISOString()
          : doc.uploadDate
            ? String(doc.uploadDate)
            : undefined,
      contentType: typeof doc.contentType === 'string' ? doc.contentType : undefined,
      metadata:
        doc.metadata && typeof doc.metadata === 'object'
          ? (doc.metadata as MongoDocument)
          : undefined,
    }));
  }

  async readGridFsFilePreview(
    database: string,
    bucket: string,
    fileId: unknown,
    maxChunks = 4,
  ): Promise<{ bytesLength: number; truncated: boolean; textPreview: string }> {
    const res = await this.find(database, `${bucket}.chunks`, {
      filter: { files_id: fileId },
      sort: { n: 1 },
      limit: Math.max(1, Math.min(20, maxChunks)),
    });
    const parts: Uint8Array[] = [];
    for (const chunk of res.documents) {
      try {
        parts.push(extractBinaryBytes(chunk.data));
      } catch {
        // skip non-binary chunk
      }
    }
    const merged = concatBytes(...parts);
    const sample = merged.subarray(0, Math.min(merged.length, 32768));
    const textPreview = td.decode(sample);
    return {
      bytesLength: merged.length,
      truncated: res.totalCount > res.documents.length || merged.length > 32768,
      textPreview,
    };
  }

  async insertMany(
    database: string,
    collection: string,
    documents: MongoDocument[],
    ordered = false,
  ): Promise<{ insertedCount: number }> {
    if (documents.length === 0) return { insertedCount: 0 };
    const batchSize = 200;
    let insertedCount = 0;
    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize).map((doc) =>
        doc._id !== undefined ? doc : { _id: new ObjectId(), ...doc },
      );
      const res = await this.runCommand(database, {
        insert: collection,
        documents: batch,
        ordered,
      });
      insertedCount += Number(res.n ?? batch.length);
    }
    return { insertedCount };
  }

  async distinctValues(
    database: string,
    collection: string,
    field: string,
    filter?: MongoDocument,
  ): Promise<unknown[]> {
    const res = await this.runCommand(database, {
      distinct: collection,
      key: field,
      query: filter ?? {},
    });
    return Array.isArray(res.values) ? res.values : [];
  }

  async listUsers(database: string): Promise<MongoUserEntry[]> {
    const res = await this.runCommand(database, { usersInfo: 1 });
    const users = Array.isArray(res.users) ? (res.users as MongoDocument[]) : [];
    return users.map((u) => ({
      user: String(u.user ?? ''),
      db: String(u.db ?? database),
      roles: Array.isArray(u.roles)
        ? (u.roles as Array<Record<string, unknown>>).map((r) => ({
            role: String(r.role ?? ''),
            db: String(r.db ?? database),
          }))
        : [],
    }));
  }

  async createUser(
    database: string,
    user: string,
    pwd: string,
    roles: Array<{ role: string; db: string }>,
  ): Promise<void> {
    await this.runCommand(database, {
      createUser: user,
      pwd,
      roles,
    });
  }

  async dropUser(database: string, user: string): Promise<void> {
    await this.runCommand(database, { dropUser: user });
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

function isBsonLeaf(val: unknown): boolean {
  return (
    val instanceof Date ||
    val instanceof ObjectId ||
    val instanceof Binary ||
    val instanceof Decimal128 ||
    val instanceof Long ||
    val instanceof Timestamp ||
    val instanceof UUID ||
    val instanceof Uint8Array
  );
}

function detectBsonType(val: unknown): string {
  if (val === null || val === undefined) return 'Null';
  if (val instanceof ObjectId) return 'ObjectId';
  if (val instanceof Date) return 'Date';
  if (val instanceof Binary || val instanceof Uint8Array) return 'Binary';
  if (val instanceof Decimal128) return 'Decimal128';
  if (val instanceof Long) return 'Int64';
  if (val instanceof Timestamp) return 'Timestamp';
  if (val instanceof UUID) return 'UUID';
  if (Array.isArray(val)) return 'Array';
  switch (typeof val) {
    case 'string':
      return 'String';
    case 'boolean':
      return 'Boolean';
    case 'number':
      return Number.isInteger(val) ? 'Int32' : 'Double';
    case 'object':
      return 'Object';
    default:
      return typeof val;
  }
}

function formatSchemaSample(val: unknown): string {
  if (val instanceof ObjectId) return `ObjectId("${val.toHexString()}")`;
  if (val instanceof Date) return val.toISOString();
  if (val instanceof Decimal128 || val instanceof Long) return val.toString();
  if (Array.isArray(val)) return `[Array(${val.length})]`;
  if (typeof val === 'object' && val !== null) return '{...}';
  const s = String(val);
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

export { ObjectId, Binary, EJSON };

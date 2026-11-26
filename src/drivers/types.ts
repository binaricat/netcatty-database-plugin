/**
 * Unified Multi-Database Driver Types & Transport Abstractions.
 * 100% browser-sandbox compatible (no Node-only imports).
 */

import type { PluginByteConnection, PluginNetworkClient } from '@netcatty/plugin-sdk';
import type { HostStreamTargetRef } from '../hostStreamEndpoint';

export type DatabaseEngineId =
  | 'postgres'
  | 'opengauss'
  | 'gaussdb'
  | 'kingbase'
  | 'highgo'
  | 'vastbase'
  | 'uxdb'
  | 'mysql'
  | 'mariadb'
  | 'tidb'
  | 'oceanbase'
  | 'goldendb'
  | 'sqlite'
  | 'clickhouse'
  | 'redis'
  | 'mongodb';

export type EngineFamily = 'postgres' | 'mysql' | 'sqlite' | 'clickhouse' | 'redis' | 'mongodb';
export type SqlDialect = 'postgres' | 'mysql' | 'sqlite' | 'clickhouse';
export type TlsMode = 'disable' | 'prefer' | 'require' | 'verify-full';

export function resolveEngineFamily(engine: string): EngineFamily {
  switch (engine) {
    case 'postgres':
    case 'postgresql':
    case 'opengauss':
    case 'gaussdb':
    case 'kingbase':
    case 'highgo':
    case 'vastbase':
    case 'uxdb':
      return 'postgres';
    case 'mysql':
    case 'mariadb':
    case 'tidb':
    case 'oceanbase':
    case 'goldendb':
      return 'mysql';
    case 'sqlite':
    case 'sqlite3':
      return 'sqlite';
    case 'clickhouse':
      return 'clickhouse';
    case 'redis':
      return 'redis';
    case 'mongodb':
    case 'mongo':
      return 'mongodb';
    default:
      throw new Error(`Unsupported database engine: ${engine}`);
  }
}

export interface TlsUpgradeOptions {
  servername?: string;
  allowSelfSigned?: boolean;
  caPem?: string;
}

export interface ByteStream {
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  upgradeTls?(options?: TlsUpgradeOptions): Promise<void>;
  close(): Promise<void>;
  readonly isTls?: boolean;
}

export interface ByteStreamEndpoint {
  host: string;
  port: number;
  tls?: boolean;
  servername?: string;
  allowSelfSigned?: boolean;
  caPem?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpRequestOptions {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpResponseData {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface ByteStreamTransport {
  connect(endpoint: ByteStreamEndpoint): Promise<ByteStream>;
  httpRequest?(request: HttpRequestOptions): Promise<HttpResponseData>;
}

export interface SshTunnelBinding {
  target?: HostStreamTargetRef;
  expectedRevision?: string;
  hostBindingToken?: string;
}

export interface ConnectionConfig {
  id?: string;
  name?: string;
  engine: DatabaseEngineId;
  host?: string;
  port?: number;
  database?: string;
  schema?: string;
  username?: string;
  password?: string;
  tlsMode?: TlsMode;
  allowSelfSigned?: boolean;
  caPem?: string;
  timeoutMs?: number;
  /** SQLite initial bytes (from ui.openFile) or undefined for in-memory DB. */
  sqliteBytes?: Uint8Array;
  /** SQLite file label for display. */
  sqliteFileName?: string;
  /** Seed demo tables when opening an empty in-memory SQLite DB. */
  sqliteSeedDemo?: boolean;
  /** Redis database index (0..15). */
  redisDb?: number;
  /** MongoDB authentication database (default 'admin'). */
  authSource?: string;
  /** ClickHouse HTTP(S) path prefix (default '/'). */
  httpPath?: string;
  /** Optional Vault SSH tunnel binding when connecting through Netcatty host. */
  sshTunnel?: SshTunnelBinding;
}

export interface ConnectionInfo {
  engine: DatabaseEngineId;
  family: EngineFamily;
  serverVersion: string;
  database: string;
  tlsActive: boolean;
  latencyMs: number;
  connectionId?: number;
  processId?: number;
}

export interface TestConnectionResult {
  ok: boolean;
  serverVersion: string;
  latencyMs: number;
  tlsActive?: boolean;
  error?: string;
}

export type CellValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | Record<string, unknown>
  | unknown[];

export interface ColumnMeta {
  name: string;
  dataType: string;
  typeOid?: number;
  nullable?: boolean;
  tableName?: string;
  isPrimaryKey?: boolean;
}

export interface QueryOptions {
  maxRows?: number;
  signal?: AbortSignal;
  params?: readonly (string | number | boolean | null)[];
  timeoutMs?: number;
  database?: string;
  schema?: string;
}

export interface QueryResultSet {
  sql: string;
  columns: ColumnMeta[];
  rows: CellValue[][];
  rowCount: number;
  affectedRows: number;
  executionMs: number;
  truncated: boolean;
  commandTag?: string;
  insertId?: number | string;
  warningCount?: number;
  error?: string;
}

export interface MultiQueryResult {
  results: QueryResultSet[];
  totalExecutionMs: number;
}

export interface DatabaseInfo {
  name: string;
  owner?: string;
  encoding?: string;
  sizeBytes?: number;
  collation?: string;
}

export interface SchemaInfo {
  name: string;
  owner?: string;
  isSystem?: boolean;
}

export interface TableSummary {
  name: string;
  schema: string;
  database: string;
  kind: 'table' | 'partitioned_table' | 'foreign_table' | 'materialized_view';
  rowCountEstimate?: number;
  sizeBytes?: number;
  engine?: string;
  comment?: string;
}

export interface ViewSummary {
  name: string;
  schema: string;
  database: string;
  definition?: string;
  isMaterialized?: boolean;
  comment?: string;
}

export interface RoutineSummary {
  name: string;
  schema: string;
  database: string;
  kind: 'function' | 'procedure';
  returnType?: string;
  arguments?: string;
  language?: string;
  definition?: string;
}

export interface TriggerSummary {
  name: string;
  schema: string;
  database: string;
  tableName: string;
  timing?: string;
  event?: string;
  definition?: string;
}

export interface ColumnStructure {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  primaryKeyOrdinal?: number;
  isAutoIncrement: boolean;
  comment?: string | null;
  maxLength?: number | null;
  numericPrecision?: number | null;
  numericScale?: number | null;
  extra?: string | null;
}

export interface IndexStructure {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  type?: string;
  predicate?: string | null;
  definition?: string | null;
}

export interface ForeignKeyStructure {
  name: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
  onUpdate?: string;
  onDelete?: string;
}

export interface CheckConstraintStructure {
  name: string;
  expression: string;
}

export interface TableStructure {
  database: string;
  schema: string;
  table: string;
  columns: ColumnStructure[];
  indexes: IndexStructure[];
  foreignKeys: ForeignKeyStructure[];
  checkConstraints: CheckConstraintStructure[];
  createDdl: string;
  engine?: string;
  comment?: string | null;
}

export interface SchemaErTable {
  name: string;
  schema: string;
  columns: ColumnStructure[];
}

export interface SchemaErEdge {
  id: string;
  name: string;
  sourceTable: string;
  sourceColumns: string[];
  targetTable: string;
  targetColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface SchemaErGraph {
  database: string;
  schema: string;
  tables: SchemaErTable[];
  edges: SchemaErEdge[];
}

export interface BrowseTableOptions {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  whereClause?: string;
  signal?: AbortSignal;
}

export interface BrowseTableResult {
  database: string;
  schema: string;
  table: string;
  columns: ColumnMeta[];
  rows: CellValue[][];
  page: number;
  pageSize: number;
  totalRows: number;
  totalEstimated: boolean;
  executionMs: number;
  sql: string;
}

export interface BatchRowInsert {
  values: Record<string, CellValue>;
}

export interface BatchRowUpdate {
  /** Primary key or identifying column values of the existing row. */
  keyValues: Record<string, CellValue>;
  /** Changed columns and their new values. */
  changes: Record<string, CellValue>;
}

export interface BatchRowDelete {
  keyValues: Record<string, CellValue>;
}

export interface BatchMutationChanges {
  inserts?: BatchRowInsert[];
  updates?: BatchRowUpdate[];
  deletes?: BatchRowDelete[];
}

export interface BatchMutationPreview {
  dialect: SqlDialect;
  statements: string[];
  sql: string;
  insertCount: number;
  updateCount: number;
  deleteCount: number;
}

export interface BatchMutationApplyResult {
  applied: number;
  affectedRows: number;
  executionMs: number;
}

export interface ExplainNode {
  id: string;
  nodeType: string;
  relation?: string;
  alias?: string;
  indexName?: string;
  startupCost?: number;
  totalCost?: number;
  planRows?: number;
  actualRows?: number;
  actualTimeMs?: number;
  loops?: number;
  filter?: string;
  detail?: string;
  warnings?: string[];
  children: ExplainNode[];
}

export interface ExplainResult {
  dialect: SqlDialect;
  analyzed: boolean;
  root: ExplainNode;
  totalCost?: number;
  actualTimeMs?: number;
  rawJson?: unknown;
  rawText: string;
}

export interface CreateColumnSpec {
  name: string;
  dataType: string;
  nullable?: boolean;
  defaultValue?: string | null;
  isPrimaryKey?: boolean;
  isAutoIncrement?: boolean;
  unique?: boolean;
  comment?: string;
}

export interface CreateTableSpec {
  name: string;
  columns: CreateColumnSpec[];
  primaryKey?: string[];
  foreignKeys?: Array<{
    name?: string;
    columns: string[];
    referencedTable: string;
    referencedSchema?: string;
    referencedColumns: string[];
    onDelete?: string;
    onUpdate?: string;
  }>;
  ifNotExists?: boolean;
  comment?: string;
}

export interface TableStructureDiff {
  renameTableTo?: string;
  addColumns?: CreateColumnSpec[];
  dropColumns?: string[];
  renameColumns?: Array<{ from: string; to: string }>;
  alterColumns?: Array<{
    name: string;
    dataType?: string;
    nullable?: boolean;
    defaultValue?: string | null;
    comment?: string;
  }>;
  addIndexes?: Array<{
    name: string;
    columns: string[];
    unique?: boolean;
  }>;
  dropIndexes?: string[];
}

export type DropObjectKind = 'table' | 'view' | 'index' | 'trigger' | 'routine';

export interface SchemaSnapshot {
  dialect: SqlDialect;
  database: string;
  schema: string;
  tables: TableStructure[];
  views?: ViewSummary[];
}

export interface SchemaTableDiff {
  table: string;
  status: 'added' | 'dropped' | 'modified';
  addedColumns: ColumnStructure[];
  droppedColumns: ColumnStructure[];
  modifiedColumns: Array<{
    name: string;
    before: ColumnStructure;
    after: ColumnStructure;
  }>;
  addedIndexes: IndexStructure[];
  droppedIndexes: IndexStructure[];
}

export interface SchemaDiffResult {
  dialect: SqlDialect;
  addedTables: string[];
  droppedTables: string[];
  modifiedTables: SchemaTableDiff[];
  migrationStatements: string[];
  migrationSql: string;
}

export interface RelationalDriver {
  readonly engine: DatabaseEngineId;
  readonly family: 'postgres' | 'mysql' | 'sqlite' | 'clickhouse';
  readonly connected: boolean;
  readonly inTransaction: boolean;
  readonly serverVersion: string;

  connect(config: ConnectionConfig, transport?: ByteStreamTransport): Promise<ConnectionInfo>;
  testConnection(): Promise<TestConnectionResult>;
  close(): Promise<void>;

  listDatabases(): Promise<DatabaseInfo[]>;
  listSchemas(db?: string): Promise<SchemaInfo[]>;
  listTables(db?: string, schema?: string): Promise<TableSummary[]>;
  listViews(db?: string, schema?: string): Promise<ViewSummary[]>;
  listRoutines(db?: string, schema?: string): Promise<RoutineSummary[]>;
  listTriggers(db?: string, schema?: string): Promise<TriggerSummary[]>;
  getTableStructure(db: string, schema: string, table: string): Promise<TableStructure>;
  getSchemaErGraph(db: string, schema: string): Promise<SchemaErGraph>;

  query(sql: string, options?: QueryOptions): Promise<MultiQueryResult>;
  cancelQuery(): Promise<void>;

  beginTransaction(): Promise<void>;
  commitTransaction(): Promise<void>;
  rollbackTransaction(): Promise<void>;

  browseTable(
    db: string,
    schema: string,
    table: string,
    options?: BrowseTableOptions,
  ): Promise<BrowseTableResult>;

  generateBatchMutations(
    db: string,
    schema: string,
    table: string,
    structure: TableStructure,
    changes: BatchMutationChanges,
  ): BatchMutationPreview;

  applyBatchMutations(sqlStatements: readonly string[]): Promise<BatchMutationApplyResult>;

  explain(sql: string, analyze?: boolean): Promise<ExplainResult>;

  generateAlterTableDdl(db: string, schema: string, table: string, diff: TableStructureDiff): string[];
  generateCreateTableDdl(db: string, schema: string, spec: CreateTableSpec): string;
  dropObject(db: string, schema: string, name: string, kind: DropObjectKind, cascade?: boolean): Promise<void>;
  truncateTable(db: string, schema: string, table: string, cascade?: boolean): Promise<void>;

  dumpDatabaseSql(db: string, schema: string, tables?: string[], includeData?: boolean): Promise<string>;
  diffSchemas(leftSchema: SchemaSnapshot, rightSchema: SchemaSnapshot): SchemaDiffResult;
}

/* ============================================================================
 * Redis Driver Types
 * ============================================================================ */

export type RedisKeyType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream' | 'none' | 'unknown';

export interface RedisKeyEntry {
  key: string;
  type: RedisKeyType;
  ttlMs: number; // -1 no expire, -2 missing
}

export interface RedisNamespaceNode {
  name: string;
  fullPath: string;
  isLeaf: boolean;
  key?: RedisKeyEntry;
  keyCount: number;
  children: RedisNamespaceNode[];
}

export interface RedisInfoParsed {
  raw: string;
  sections: Record<string, Record<string, string>>;
  serverVersion: string;
  usedMemoryHuman: string;
  usedMemoryBytes: number;
  connectedClients: number;
  uptimeSeconds: number;
  keyspace: Array<{ db: number; keys: number; expires: number; avgTtl: number }>;
}

export interface RedisStreamEntry {
  id: string;
  fields: Record<string, string>;
}

export interface RedisKeyDetail {
  key: string;
  type: RedisKeyType;
  ttlMs: number;
  size?: number;
  value:
    | string
    | Record<string, string>
    | string[]
    | Array<{ member: string; score: number }>
    | RedisStreamEntry[]
    | null;
}

export interface RedisCliResult {
  command: string;
  args: string[];
  output: unknown;
  formatted: string;
  executionMs: number;
  isError: boolean;
}

export interface RedisDriver {
  readonly engine: 'redis';
  readonly family: 'redis';
  readonly connected: boolean;
  readonly currentDb: number;
  readonly serverVersion: string;

  connect(config: ConnectionConfig, transport: ByteStreamTransport): Promise<ConnectionInfo>;
  testConnection(): Promise<TestConnectionResult>;
  close(): Promise<void>;

  selectDb(db: number): Promise<void>;
  getInfo(section?: string): Promise<RedisInfoParsed>;
  scanKeys(options?: {
    cursor?: string;
    match?: string;
    count?: number;
    maxKeys?: number;
    includeMeta?: boolean;
  }): Promise<{ cursor: string; keys: RedisKeyEntry[] }>;
  buildNamespaceTree(keys: readonly RedisKeyEntry[], delimiter?: string): RedisNamespaceNode[];

  getKeyDetail(key: string): Promise<RedisKeyDetail>;
  getString(key: string): Promise<string | null>;
  setString(key: string, value: string, ttlSeconds?: number): Promise<void>;
  getHash(key: string): Promise<Record<string, string>>;
  setHashField(key: string, field: string, value: string): Promise<void>;
  deleteHashField(key: string, fields: string | string[]): Promise<number>;
  getList(key: string, start?: number, stop?: number): Promise<string[]>;
  pushList(key: string, values: string | string[], direction?: 'left' | 'right'): Promise<number>;
  setListIndex(key: string, index: number, value: string): Promise<void>;
  removeListValue(key: string, value: string, count?: number): Promise<number>;
  getSet(key: string): Promise<string[]>;
  addSetMembers(key: string, members: string | string[]): Promise<number>;
  removeSetMembers(key: string, members: string | string[]): Promise<number>;
  getZSet(key: string, start?: number, stop?: number): Promise<Array<{ member: string; score: number }>>;
  addZSetMember(key: string, score: number, member: string): Promise<number>;
  removeZSetMembers(key: string, members: string | string[]): Promise<number>;
  getStream(key: string, start?: string, end?: string, count?: number): Promise<RedisStreamEntry[]>;
  addStreamEntry(key: string, fields: Record<string, string>, id?: string): Promise<string>;
  deleteStreamEntries(key: string, ids: string | string[]): Promise<number>;

  setTtl(key: string, ttlSeconds: number): Promise<boolean>;
  persistKey(key: string): Promise<boolean>;
  renameKey(oldKey: string, newKey: string): Promise<void>;
  deleteKeys(keys: string | string[]): Promise<number>;
  executeCommand(args: readonly (string | Uint8Array)[]): Promise<unknown>;
  executeCli(commandLine: string): Promise<RedisCliResult>;
}

/* ============================================================================
 * MongoDB Driver Types
 * ============================================================================ */

export type MongoDocument = Record<string, unknown>;

export interface MongoDatabaseInfo {
  name: string;
  sizeOnDisk?: number;
  empty?: boolean;
}

export interface MongoCollectionInfo {
  name: string;
  type: string;
}

export interface MongoFindOptions {
  filter?: MongoDocument;
  sort?: MongoDocument;
  projection?: MongoDocument;
  skip?: number;
  limit?: number;
}

export interface MongoFindResult {
  documents: MongoDocument[];
  totalCount: number;
  executionMs: number;
}

export interface MongoIndexInfo {
  name: string;
  key: Record<string, number | string>;
  unique?: boolean;
  sparse?: boolean;
  expireAfterSeconds?: number;
}

export interface MongoCollectionStats {
  ns: string;
  count: number;
  size: number;
  avgObjSize: number;
  storageSize: number;
  nindexes: number;
  totalIndexSize: number;
}

export interface MongoDriver {
  readonly engine: 'mongodb';
  readonly family: 'mongodb';
  readonly connected: boolean;
  readonly serverVersion: string;

  connect(config: ConnectionConfig, transport: ByteStreamTransport): Promise<ConnectionInfo>;
  testConnection(): Promise<TestConnectionResult>;
  close(): Promise<void>;

  ping(): Promise<{ ok: boolean; latencyMs: number }>;
  buildInfo(): Promise<MongoDocument>;
  runCommand(database: string, command: MongoDocument): Promise<MongoDocument>;

  listDatabases(): Promise<MongoDatabaseInfo[]>;
  listCollections(database: string): Promise<MongoCollectionInfo[]>;
  find(database: string, collection: string, options?: MongoFindOptions): Promise<MongoFindResult>;
  countDocuments(database: string, collection: string, filter?: MongoDocument): Promise<number>;
  aggregate(database: string, collection: string, pipeline: MongoDocument[]): Promise<MongoDocument[]>;
  insertOne(database: string, collection: string, document: MongoDocument): Promise<{ insertedId: unknown }>;
  replaceOne(
    database: string,
    collection: string,
    filter: MongoDocument,
    replacement: MongoDocument,
    upsert?: boolean,
  ): Promise<{ matchedCount: number; modifiedCount: number }>;
  updateOne(
    database: string,
    collection: string,
    filter: MongoDocument,
    update: MongoDocument,
    upsert?: boolean,
  ): Promise<{ matchedCount: number; modifiedCount: number }>;
  deleteOne(database: string, collection: string, filter: MongoDocument): Promise<{ deletedCount: number }>;
  listIndexes(database: string, collection: string): Promise<MongoIndexInfo[]>;
  createIndexes(
    database: string,
    collection: string,
    indexes: Array<{ key: Record<string, number | string>; name?: string; unique?: boolean }>,
  ): Promise<MongoDocument>;
  dropIndexes(database: string, collection: string, indexName: string): Promise<MongoDocument>;
  collStats(database: string, collection: string): Promise<MongoCollectionStats>;
}

/* ============================================================================
 * Plugin Host Transport Adapters (Browser-Safe)
 * ============================================================================ */

type UpgradeablePluginByteConnection = Omit<PluginByteConnection, 'upgradeTls'> & {
  upgradeTls?: (options?: TlsUpgradeOptions) => Promise<unknown>;
};

export function adaptPluginByteConnection(
  connection: UpgradeablePluginByteConnection,
  initialTls = false,
): ByteStream {
  let tlsActive = initialTls;
  let closed = false;
  return {
    get isTls() {
      return tlsActive;
    },
    async read(): Promise<Uint8Array | null> {
      if (closed) return null;
      const chunk = await connection.readable.read();
      if (chunk === null || chunk === undefined) return null;
      return chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    },
    async write(data: Uint8Array): Promise<void> {
      if (closed) throw new Error('Stream is closed');
      await connection.writable.write(data);
    },
    ...(typeof connection.upgradeTls === 'function'
      ? {
          async upgradeTls(options?: TlsUpgradeOptions): Promise<void> {
            const cleanOpts: TlsUpgradeOptions = {};
            if (options?.servername !== undefined) cleanOpts.servername = options.servername;
            if (options?.allowSelfSigned !== undefined) cleanOpts.allowSelfSigned = options.allowSelfSigned;
            if (options?.caPem !== undefined) cleanOpts.caPem = options.caPem;
            await connection.upgradeTls!(cleanOpts);
            tlsActive = true;
          },
        }
      : {}),
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        connection.readable.cancel();
      } catch {
        // ignore
      }
      try {
        connection.writable.cancel();
      } catch {
        // ignore
      }
      await connection.close().catch(() => {});
    },
  };
}

type ExtendedPluginNetworkClient = PluginNetworkClient & {
  connect: (
    request: {
      endpoint: string;
      allowSelfSigned?: boolean;
      caPem?: string;
      servername?: string;
    },
    token?: unknown,
  ) => Promise<UpgradeablePluginByteConnection>;
  connectViaHost?: (
    request: {
      target?: HostStreamTargetRef;
      expectedRevision?: string;
      hostBindingToken?: string;
      endpoint: string;
      allowSelfSigned?: boolean;
      caPem?: string;
    },
    token?: unknown,
  ) => Promise<UpgradeablePluginByteConnection>;
};

export function createPluginTransport(
  network: PluginNetworkClient,
  options?: { sshTunnel?: SshTunnelBinding },
): ByteStreamTransport {
  const net = network as ExtendedPluginNetworkClient;
  return {
    async connect(endpoint: ByteStreamEndpoint): Promise<ByteStream> {
      const scheme = endpoint.tls ? 'tls' : 'tcp';
      const hostPart = endpoint.host.includes(':') && !endpoint.host.startsWith('[')
        ? `[${endpoint.host}]`
        : endpoint.host;
      const url = `${scheme}://${hostPart}:${endpoint.port}`;
      let conn: UpgradeablePluginByteConnection;
      if (options?.sshTunnel && typeof net.connectViaHost === 'function') {
        const hostReq: Record<string, unknown> = { endpoint: url };
        if (options.sshTunnel.target !== undefined) hostReq.target = JSON.parse(JSON.stringify(options.sshTunnel.target));
        if (options.sshTunnel.expectedRevision !== undefined) hostReq.expectedRevision = options.sshTunnel.expectedRevision;
        if (options.sshTunnel.hostBindingToken !== undefined) hostReq.hostBindingToken = options.sshTunnel.hostBindingToken;
        if (endpoint.allowSelfSigned !== undefined) hostReq.allowSelfSigned = endpoint.allowSelfSigned;
        if (endpoint.caPem !== undefined) hostReq.caPem = endpoint.caPem;
        conn = await net.connectViaHost(hostReq as Parameters<NonNullable<ExtendedPluginNetworkClient['connectViaHost']>>[0]);
      } else {
        const directReq: Record<string, unknown> = { endpoint: url };
        if (endpoint.allowSelfSigned !== undefined) directReq.allowSelfSigned = endpoint.allowSelfSigned;
        if (endpoint.caPem !== undefined) directReq.caPem = endpoint.caPem;
        if (endpoint.servername !== undefined) directReq.servername = endpoint.servername;
        conn = await net.connect(directReq as Parameters<ExtendedPluginNetworkClient['connect']>[0]);
      }
      return adaptPluginByteConnection(conn, Boolean(endpoint.tls));
    },
    async httpRequest(request: HttpRequestOptions): Promise<HttpResponseData> {
      const reqPayload: Record<string, unknown> = {
        url: request.url,
        method: request.method,
        timeoutMs: request.timeoutMs ?? 30000,
      };
      if (request.headers !== undefined) reqPayload.headers = request.headers;
      if (request.body !== undefined) {
        reqPayload.body =
          typeof request.body === 'string'
            ? { encoding: 'utf8' as const, data: request.body }
            : { encoding: 'base64' as const, data: bytesToBase64(request.body) };
      }
      const response = await network.request(reqPayload as Parameters<PluginNetworkClient['request']>[0]);
      const respBody = response.body
        ? response.body.encoding === 'base64'
          ? base64ToBytes(response.body.data)
          : new TextEncoder().encode(response.body.data)
        : new Uint8Array(0);
      const headers: Record<string, string> = {};
      if (response.headers) {
        for (const [k, v] of Object.entries(response.headers)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
      return { status: response.status, headers, body: respBody };
    },
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

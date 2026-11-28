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
  | 'cockroachdb'
  | 'redshift'
  | 'cloudberry'
  | 'opentenbase'
  | 'questdb'
  | 'kwdb'
  | 'gbase8c'
  | 'custom_postgres'
  | 'mysql'
  | 'mariadb'
  | 'tidb'
  | 'oceanbase'
  | 'oceanbase-oracle'
  | 'goldendb'
  | 'doris'
  | 'starrocks'
  | 'selectdb'
  | 'polardb'
  | 'tdsql'
  | 'greatsql'
  | 'dolt'
  | 'manticoresearch'
  | 'custom_mysql'
  | 'sqlite'
  | 'clickhouse'
  | 'sqlserver'
  | 'trino'
  | 'prestosql'
  | 'databend'
  | 'rqlite'
  | 'turso'
  | 'tdengine'
  | 'influxdb'
  | 'influxdb3'
  | 'victoriametrics'
  | 'cloudflare-d1'
  | 'iotdb'
  | 'kylin'
  | 'databricks'
  | 'snowflake'
  | 'bigquery'
  | 'salesforce'
  | 'cassandra'
  | 'scylladb'
  | 'redis'
  | 'mongodb'
  | 'mongodb-legacy'
  | 'neo4j'
  | 'elasticsearch'
  | 'easysearch'
  | 'meilisearch'
  | 'couchdb'
  | 'qdrant'
  | 'chromadb'
  | 'weaviate'
  | 'solr'
  | 'milvus'
  | 'dynamodb'
  | 'hbase'
  | 'etcd'
  | 'etcd-v2'
  | 'consul'
  | 'nacos'
  | 'zookeeper'
  | 'rabbitmq'
  | 'pulsar'
  | 'mqtt'
  | 'kafka'
  | 'mq';

export type EngineFamily =
  | 'postgres'
  | 'mysql'
  | 'sqlite'
  | 'clickhouse'
  | 'mssql'
  | 'http_sql'
  | 'cql'
  | 'redis'
  | 'mongodb'
  | 'graph'
  | 'search'
  | 'kv'
  | 'mq';

export type SqlDialect =
  | 'postgres'
  | 'mysql'
  | 'sqlite'
  | 'clickhouse'
  | 'mssql'
  | 'trino'
  | 'tdengine'
  | 'influx'
  | 'cql';

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
    case 'cockroachdb':
    case 'redshift':
    case 'cloudberry':
    case 'opentenbase':
    case 'questdb':
    case 'kwdb':
    case 'gbase8c':
    case 'custom_postgres':
      return 'postgres';
    case 'mysql':
    case 'mariadb':
    case 'tidb':
    case 'oceanbase':
    case 'oceanbase-oracle':
    case 'goldendb':
    case 'doris':
    case 'starrocks':
    case 'selectdb':
    case 'polardb':
    case 'tdsql':
    case 'greatsql':
    case 'dolt':
    case 'manticoresearch':
    case 'custom_mysql':
      return 'mysql';
    case 'sqlite':
    case 'sqlite3':
      return 'sqlite';
    case 'clickhouse':
      return 'clickhouse';
    case 'sqlserver':
    case 'mssql':
      return 'mssql';
    case 'trino':
    case 'prestosql':
    case 'presto':
    case 'databend':
    case 'rqlite':
    case 'turso':
    case 'libsql':
    case 'tdengine':
    case 'influxdb':
    case 'influxdb3':
    case 'victoriametrics':
    case 'cloudflare-d1':
    case 'iotdb':
    case 'kylin':
    case 'databricks':
    case 'snowflake':
    case 'bigquery':
    case 'salesforce':
      return 'http_sql';
    case 'cassandra':
    case 'scylladb':
      return 'cql';
    case 'redis':
      return 'redis';
    case 'mongodb':
    case 'mongodb-legacy':
    case 'mongo':
      return 'mongodb';
    case 'neo4j':
      return 'graph';
    case 'elasticsearch':
    case 'easysearch':
    case 'meilisearch':
    case 'couchdb':
    case 'qdrant':
    case 'chromadb':
    case 'weaviate':
    case 'solr':
    case 'milvus':
    case 'dynamodb':
    case 'hbase':
      return 'search';
    case 'etcd':
    case 'etcd-v2':
    case 'consul':
    case 'nacos':
    case 'zookeeper':
      return 'kv';
    case 'rabbitmq':
    case 'pulsar':
    case 'mqtt':
    case 'kafka':
    case 'mq':
      return 'mq';
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
  /** ClickHouse or HTTP engine path prefix (default '/'). */
  httpPath?: string;
  /** Optional API key / Bearer token (Qdrant, Meilisearch, Turso, InfluxDB 2/3, Elasticsearch, Consul). */
  apiKey?: string;
  /** Optional organization / tenant (InfluxDB v2 org, ChromaDB tenant). */
  org?: string;
  /** Optional namespace (Nacos namespace, Consul namespace, ChromaDB database, Pulsar namespace). */
  namespace?: string;
  /** Optional cloud region (DynamoDB SigV4 region, BigQuery location). */
  region?: string;
  /** Optional cloud account/project ID (Cloudflare D1 accountId, BigQuery projectId, Snowflake account). */
  accountId?: string;
  /** Optional warehouse / cluster ID (Databricks SQL warehouseId, Snowflake warehouse). */
  warehouseId?: string;
  /** Optional RabbitMQ vhost (default '/'). */
  vhost?: string;
  /** Optional driver protocol variant (e.g. 'gbase-8c-pg', 'gaussdb-dws', 'kingbase-pg'). */
  variant?: string;
  /** Preferred protocol for multi-protocol engines like Neo4j ('bolt' | 'http'). */
  protocol?: 'bolt' | 'http';
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

export class QueryError extends Error {
  readonly code?: string;
  readonly position?: number;
  readonly line?: number;
  readonly column?: number;
  readonly hint?: string;
  readonly detail?: string;

  constructor(
    message: string,
    info?: {
      code?: string;
      position?: number;
      line?: number;
      column?: number;
      hint?: string;
      detail?: string;
    },
  ) {
    super(message);
    this.name = 'QueryError';
    this.code = info?.code;
    this.position = info?.position;
    this.line = info?.line;
    this.column = info?.column;
    this.hint = info?.hint;
    this.detail = info?.detail;
  }
}

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
  enabled?: boolean;
  definition?: string;
}

export interface SequenceSummary {
  name: string;
  schema: string;
  database: string;
  dataType?: string;
  startValue?: string;
  minValue?: string;
  maxValue?: string;
  increment?: string;
  cycle?: boolean;
  lastValue?: string | null;
  isCalled?: boolean;
  definition?: string;
}

export interface EventSummary {
  name: string;
  schema: string;
  database: string;
  eventType?: 'ONE TIME' | 'RECURRING' | string;
  executeAt?: string | null;
  intervalValue?: string | null;
  intervalField?: string | null;
  starts?: string | null;
  ends?: string | null;
  status?: 'ENABLED' | 'DISABLED' | 'SLAVESIDE_DISABLED' | string;
  onCompletion?: string;
  comment?: string;
  lastExecuted?: string | null;
  definition?: string;
}

export interface CustomTypeSummary {
  name: string;
  schema: string;
  database: string;
  kind: 'enum' | 'composite' | 'domain' | 'range' | 'multirange' | 'base';
  description?: string;
  enumValues?: string[];
  definition?: string;
}

export interface ExtensionSummary {
  name: string;
  version: string;
  schema?: string;
  description?: string;
  installed: boolean;
}

export interface PartitionSummary {
  name: string;
  subpartitionName?: string | null;
  method?: string;
  expression?: string;
  bound?: string;
  rowCountEstimate?: number;
  sizeBytes?: number;
  active?: boolean;
}

export interface SynonymSummary {
  name: string;
  schema: string;
  database: string;
  baseObject: string;
}

export interface EventTriggerSummary {
  name: string;
  event: string;
  owner?: string;
  enabled?: boolean;
  functionName?: string;
  tags?: string[];
  definition?: string;
}

export interface RuleSummary {
  name: string;
  schema: string;
  database: string;
  tableName: string;
  definition?: string;
}

export interface DictionarySummary {
  name: string;
  database: string;
  status?: string;
  source?: string;
  type?: string;
  elementCount?: number;
  bytesAllocated?: number;
}

export interface SchemaIndexSummary {
  name: string;
  schema: string;
  database: string;
  tableName: string;
  unique?: boolean;
  definition?: string;
}

export interface LinkedServerSummary {
  name: string;
  product?: string;
  provider?: string;
  dataSource?: string;
  catalog?: string;
}

export interface ObjectDependency {
  direction: 'depends_on' | 'referenced_by';
  kind: string;
  schema: string;
  name: string;
}

export interface ProcessEntry {
  id: string;
  user: string;
  host?: string;
  database?: string;
  command?: string;
  state?: string;
  durationSec?: number;
  sql?: string;
  waitEvent?: string;
  isCurrentSession?: boolean;
}

export interface ServerStatusMetric {
  key: string;
  label: string;
  value: string;
  group?: string;
}

export interface ServerVariableEntry {
  name: string;
  value: string;
  description?: string;
}

export interface ServerStatusSnapshot {
  engine: DatabaseEngineId;
  timestamp: number;
  uptimeSeconds: number;
  activeConnections: number;
  idleConnections?: number;
  totalConnections?: number;
  qpsOrTps?: number;
  cacheHitRatio?: number;
  slowQueries?: number;
  deadlocks?: number;
  bytesIn?: number;
  bytesOut?: number;
  metrics: ServerStatusMetric[];
  variables: ServerVariableEntry[];
}

export interface DatabaseUserSummary {
  name: string;
  host?: string;
  isSuperuser?: boolean;
  canLogin?: boolean;
  canCreateDb?: boolean;
  canCreateRole?: boolean;
  locked?: boolean;
  authPlugin?: string;
  roles?: string[];
  grants?: string[];
}

export interface ColumnStructure {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  primaryKeyOrdinal?: number;
  isForeignKey?: boolean;
  isAutoIncrement: boolean;
  unique?: boolean;
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
  objectKind?: 'table' | 'view' | 'materialized_view';
  columns: ColumnStructure[];
  indexes: IndexStructure[];
  foreignKeys: ForeignKeyStructure[];
  checkConstraints: CheckConstraintStructure[];
  createDdl: string;
  engine?: string;
  charset?: string | null;
  collation?: string | null;
  autoIncrement?: number | null;
  rowCountEstimate?: number;
  dataBytes?: number;
  indexBytes?: number;
  partitions?: PartitionSummary[];
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

export interface AddForeignKeySpec {
  name?: string;
  columns: string[];
  referencedSchema?: string;
  referencedTable: string;
  referencedColumns: string[];
  onUpdate?: string;
  onDelete?: string;
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
    unique?: boolean;
    isAutoIncrement?: boolean;
    comment?: string;
  }>;
  addIndexes?: Array<{
    name: string;
    columns: string[];
    unique?: boolean;
  }>;
  dropIndexes?: string[];
  addForeignKeys?: AddForeignKeySpec[];
  dropForeignKeys?: string[];
  addCheckConstraints?: Array<{
    name?: string;
    expression: string;
  }>;
  dropCheckConstraints?: string[];
  tableComment?: string | null;
  tableEngine?: string;
  tableCharset?: string;
  tableCollation?: string;
  tableAutoIncrement?: number;
}

export type DropObjectKind =
  | 'table'
  | 'view'
  | 'materialized_view'
  | 'index'
  | 'trigger'
  | 'routine'
  | 'function'
  | 'procedure'
  | 'sequence'
  | 'event'
  | 'extension'
  | 'synonym'
  | 'custom_type'
  | 'database'
  | 'schema';

export interface SchemaSnapshot {
  dialect: SqlDialect;
  database: string;
  schema: string;
  tables: TableStructure[];
  views?: ViewSummary[];
  routines?: RoutineSummary[];
  triggers?: TriggerSummary[];
  sequences?: SequenceSummary[];
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
  addedForeignKeys?: ForeignKeyStructure[];
  droppedForeignKeys?: ForeignKeyStructure[];
  addedCheckConstraints?: CheckConstraintStructure[];
  droppedCheckConstraints?: CheckConstraintStructure[];
}

export interface SchemaDiffItem {
  id: string;
  kind: 'table' | 'column' | 'index' | 'foreign_key' | 'check_constraint' | 'view' | 'materialized_view' | 'routine' | 'trigger' | 'sequence';
  action: 'add' | 'drop' | 'modify';
  table: string;
  name: string;
  summary: string;
  sql: string[];
}

export interface SchemaDiffResult {
  dialect: SqlDialect;
  addedTables: string[];
  droppedTables: string[];
  modifiedTables: SchemaTableDiff[];
  items: SchemaDiffItem[];
  migrationStatements: string[];
  migrationSql: string;
}

export interface RelationalDriver {
  readonly engine: DatabaseEngineId;
  readonly family: 'postgres' | 'mysql' | 'sqlite' | 'clickhouse' | 'mssql' | 'http_sql' | 'cql';
  readonly connected: boolean;
  readonly inTransaction: boolean;
  readonly serverVersion: string;

  connect(config: ConnectionConfig, transport?: ByteStreamTransport): Promise<ConnectionInfo>;
  switchDatabase?(db: string): Promise<ConnectionInfo>;
  testConnection(): Promise<TestConnectionResult>;
  close(): Promise<void>;

  listDatabases(): Promise<DatabaseInfo[]>;
  listSchemas(db?: string): Promise<SchemaInfo[]>;
  listTables(db?: string, schema?: string): Promise<TableSummary[]>;
  listViews(db?: string, schema?: string): Promise<ViewSummary[]>;
  listRoutines(db?: string, schema?: string): Promise<RoutineSummary[]>;
  listTriggers(db?: string, schema?: string): Promise<TriggerSummary[]>;
  listSequences?(db?: string, schema?: string): Promise<SequenceSummary[]>;
  listEvents?(db?: string, schema?: string): Promise<EventSummary[]>;
  listCustomTypes?(db?: string, schema?: string): Promise<CustomTypeSummary[]>;
  listExtensions?(): Promise<ExtensionSummary[]>;
  listSynonyms?(db?: string, schema?: string): Promise<SynonymSummary[]>;
  listEventTriggers?(): Promise<EventTriggerSummary[]>;
  listRules?(db?: string, schema?: string): Promise<RuleSummary[]>;
  listDictionaries?(db?: string): Promise<DictionarySummary[]>;
  listSchemaIndexes?(db?: string, schema?: string): Promise<SchemaIndexSummary[]>;
  listLinkedServers?(): Promise<LinkedServerSummary[]>;
  listTablePartitions?(db: string, schema: string, table: string): Promise<PartitionSummary[]>;
  listObjectDependencies?(db: string, schema: string, name: string, kind: string): Promise<ObjectDependency[]>;
  getObjectDefinition?(db: string, schema: string, name: string, kind: string): Promise<string>;
  refreshMaterializedView?(db: string, schema: string, name: string, concurrently?: boolean): Promise<void>;
  createDatabase?(name: string, options?: { charset?: string; collation?: string; owner?: string }): Promise<void>;
  createSchema?(db: string, name: string): Promise<void>;
  listProcesses?(): Promise<ProcessEntry[]>;
  killProcess?(id: string, mode?: 'cancel' | 'terminate'): Promise<void>;
  getServerStatus?(): Promise<ServerStatusSnapshot>;
  listUsers?(): Promise<DatabaseUserSummary[]>;
  getUserGrants?(user: string, host?: string): Promise<string[]>;
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
  dropObject(
    db: string,
    schema: string,
    name: string,
    kind: DropObjectKind,
    cascade?: boolean,
    tableName?: string,
  ): Promise<void>;
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

export interface RedisInfoSectionGroup {
  id: string;
  title: string;
  metrics: Array<{ key: string; label: string; value: string }>;
  raw: Record<string, string>;
}

export interface RedisPubSubMessage {
  channel: string;
  pattern?: string;
  message: string;
  timestamp: number;
}

export interface RedisSubscription {
  readonly channels: string[];
  unsubscribe(): Promise<void>;
}

export interface RedisCliResult {
  command: string;
  args: string[];
  output: unknown;
  formatted: string;
  executionMs: number;
  isError: boolean;
}

export interface RedisSlowlogEntry {
  id: number;
  timestamp: number;
  durationUs: number;
  command: string[];
  clientAddr?: string;
  clientName?: string;
}

export interface RedisClientInfo {
  id: string;
  addr: string;
  name?: string;
  db?: number;
  ageSec?: number;
  idleSec?: number;
  cmd?: string;
  flags?: string;
  raw?: string;
}

export interface RedisStreamGroupInfo {
  name: string;
  consumers: number;
  pending: number;
  lastDeliveredId: string;
  lag?: number | null;
}

export interface RedisStreamConsumerInfo {
  name: string;
  pending: number;
  idleMs: number;
}

export interface RedisStreamPendingEntry {
  id: string;
  consumer: string;
  idleMs: number;
  deliveryCount: number;
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
  memoryUsage(key: string): Promise<number | null>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(
    channels: string | string[],
    onMessage: (msg: RedisPubSubMessage) => void,
  ): Promise<RedisSubscription>;
  executeCommand(args: readonly (string | Uint8Array)[]): Promise<unknown>;
  executeCli(commandLine: string): Promise<RedisCliResult>;

  getSlowlog?(count?: number): Promise<RedisSlowlogEntry[]>;
  resetSlowlog?(): Promise<void>;
  listClients?(): Promise<RedisClientInfo[]>;
  killClient?(id: string): Promise<void>;
  flushDb?(): Promise<void>;
  batchDeleteByPattern?(pattern: string, maxKeys?: number): Promise<number>;
  getStreamGroups?(key: string): Promise<RedisStreamGroupInfo[]>;
  getStreamConsumers?(key: string, group: string): Promise<RedisStreamConsumerInfo[]>;
  getStreamPending?(key: string, group: string, count?: number): Promise<RedisStreamPendingEntry[]>;
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

export interface MongoSchemaFieldInfo {
  path: string;
  count: number;
  percentage: number;
  types: Array<{ type: string; count: number; percentage: number }>;
  samples: string[];
}

export interface MongoSchemaAnalysis {
  database: string;
  collection: string;
  sampleCount: number;
  totalDocuments: number;
  fields: MongoSchemaFieldInfo[];
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
  createCollection(database: string, name: string, options?: MongoDocument): Promise<void>;
  dropCollection(database: string, name: string): Promise<void>;
  analyzeCollectionSchema(
    database: string,
    collection: string,
    sampleSize?: number,
  ): Promise<MongoSchemaAnalysis>;
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
  renameCollection?(database: string, fromName: string, toName: string, dropTarget?: boolean): Promise<void>;
  dropDatabase?(database: string): Promise<void>;
  explainQuery?(
    database: string,
    collection: string,
    filter?: MongoDocument,
    sort?: MongoDocument,
  ): Promise<MongoDocument>;
  getCollectionValidation?(
    database: string,
    collection: string,
  ): Promise<{ validator?: MongoDocument; validationLevel?: string; validationAction?: string }>;
  setCollectionValidation?(
    database: string,
    collection: string,
    options: { validator?: MongoDocument; validationLevel?: string; validationAction?: string },
  ): Promise<void>;
  listGridFsBuckets?(database: string): Promise<Array<{ name: string; filesCount?: number; totalBytes?: number }>>;
  listUsers?(database: string): Promise<Array<{ user: string; db: string; roles: Array<{ role: string; db: string }> }>>;
  distinctValues?(
    database: string,
    collection: string,
    field: string,
    filter?: MongoDocument,
  ): Promise<unknown[]>;
}

/* ============================================================================
 * Graph Database Driver Types (Neo4j Bolt v4/v5 + HTTP Cypher)
 * ============================================================================ */

export interface GraphNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

export interface GraphRelationship {
  id: string;
  type: string;
  startNodeId: string;
  endNodeId: string;
  properties: Record<string, unknown>;
}

export interface GraphPath {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
}

export interface GraphLabelSummary {
  label: string;
  count?: number;
}

export interface GraphIndexSummary {
  name: string;
  type?: string;
  entityType?: string;
  labelsOrTypes?: string[];
  properties?: string[];
  state?: string;
}

export interface GraphConstraintSummary {
  name: string;
  type?: string;
  entityType?: string;
  labelsOrTypes?: string[];
  properties?: string[];
}

export interface GraphSchemaSummary {
  database: string;
  labels: GraphLabelSummary[];
  relationshipTypes: string[];
  propertyKeys: string[];
  indexes: GraphIndexSummary[];
  constraints: GraphConstraintSummary[];
}

export interface GraphQueryCounters {
  nodesCreated?: number;
  nodesDeleted?: number;
  relationshipsCreated?: number;
  relationshipsDeleted?: number;
  propertiesSet?: number;
  labelsAdded?: number;
  labelsRemoved?: number;
  indexesAdded?: number;
  indexesRemoved?: number;
  constraintsAdded?: number;
  constraintsRemoved?: number;
}

export interface GraphQueryResult {
  cypher: string;
  columns: string[];
  rows: CellValue[][];
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  rowCount: number;
  executionMs: number;
  truncated: boolean;
  counters?: GraphQueryCounters;
  notifications?: string[];
}

export interface GraphDriver {
  readonly engine: 'neo4j';
  readonly family: 'graph';
  readonly connected: boolean;
  readonly serverVersion: string;
  readonly activeDatabase: string;
  readonly transportProtocol: 'bolt' | 'http';

  connect(config: ConnectionConfig, transport: ByteStreamTransport): Promise<ConnectionInfo>;
  testConnection(): Promise<TestConnectionResult>;
  close(): Promise<void>;

  listDatabases(): Promise<DatabaseInfo[]>;
  switchDatabase(db: string): Promise<ConnectionInfo>;
  getSchemaSummary(db?: string): Promise<GraphSchemaSummary>;
  executeCypher(
    cypher: string,
    options?: {
      database?: string;
      params?: Record<string, unknown>;
      maxRows?: number;
      signal?: AbortSignal;
    },
  ): Promise<GraphQueryResult>;
}

/* ============================================================================
 * Search / Document / Vector HTTP Driver Types
 * (Elasticsearch, Easysearch, Meilisearch, CouchDB, Qdrant, ChromaDB, Weaviate)
 * ============================================================================ */

export interface SearchIndexInfo {
  name: string;
  docCount?: number;
  sizeBytes?: number;
  status?: string;
  vectorDimension?: number;
  distanceMetric?: string;
  extra?: Record<string, unknown>;
}

export interface SearchDocument {
  id: string;
  index?: string;
  score?: number;
  source: Record<string, unknown>;
  vector?: number[];
}

export interface SearchQueryResult {
  index: string;
  documents: SearchDocument[];
  totalCount: number;
  executionMs: number;
  raw?: unknown;
}

export interface SearchDriver {
  readonly engine: DatabaseEngineId;
  readonly family: 'search';
  readonly connected: boolean;
  readonly serverVersion: string;

  connect(config: ConnectionConfig, transport: ByteStreamTransport): Promise<ConnectionInfo>;
  testConnection(): Promise<TestConnectionResult>;
  close(): Promise<void>;

  listIndices(): Promise<SearchIndexInfo[]>;
  getIndexSchema(index: string): Promise<Record<string, unknown>>;
  createIndex(index: string, config?: Record<string, unknown>): Promise<void>;
  deleteIndex(index: string): Promise<void>;
  search(
    index: string,
    query: string | Record<string, unknown>,
    options?: { from?: number; size?: number },
  ): Promise<SearchQueryResult>;
  upsertDocument(
    index: string,
    document: Record<string, unknown>,
    id?: string,
  ): Promise<{ id: string }>;
  deleteDocument(index: string, id: string): Promise<void>;
  rawRequest?(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: string,
  ): Promise<{ status: number; body: string }>;
  getClusterHealth?(): Promise<Record<string, unknown>>;
  getIndexStats?(index: string): Promise<Record<string, unknown>>;
  getIndexAliases?(index: string): Promise<Record<string, unknown>>;
  deleteByQuery?(index: string, query: Record<string, unknown>): Promise<{ deleted: number }>;
}

/* ============================================================================
 * Registry / Config KV Driver Types (etcd v3/v2, Consul KV, Nacos, ZooKeeper)
 * ============================================================================ */

export interface KvEntry {
  key: string;
  value: string;
  version?: number;
  revision?: number;
  group?: string;
  format?: string;
  lease?: string;
  flags?: number;
}

export interface KvNamespaceInfo {
  id: string;
  name: string;
  count?: number;
}

export interface KvMemberInfo {
  id: string;
  name: string;
  peerUrls?: string[];
  clientUrls?: string[];
  isLeader?: boolean;
  status?: string;
}

export interface KvLeaseInfo {
  id: string;
  ttlSeconds?: number;
  grantedTtlSeconds?: number;
  keys?: string[];
}

export interface KvServiceInfo {
  name: string;
  namespace?: string;
  group?: string;
  instancesCount?: number;
  healthyCount?: number;
  tags?: string[];
  status?: string;
}

export interface KvConfigHistoryEntry {
  id: string;
  key: string;
  value: string;
  group?: string;
  opType?: string;
  updatedAt?: string;
  md5?: string;
}

export interface KvDriver {
  readonly engine: DatabaseEngineId;
  readonly family: 'kv';
  readonly connected: boolean;
  readonly serverVersion: string;

  connect(config: ConnectionConfig, transport: ByteStreamTransport): Promise<ConnectionInfo>;
  testConnection(): Promise<TestConnectionResult>;
  close(): Promise<void>;

  listNamespaces(): Promise<KvNamespaceInfo[]>;
  listKeys(prefix?: string, options?: { namespace?: string; group?: string; limit?: number }): Promise<KvEntry[]>;
  getKey(key: string, options?: { namespace?: string; group?: string }): Promise<KvEntry | null>;
  putKey(
    key: string,
    value: string,
    options?: { namespace?: string; group?: string; format?: string },
  ): Promise<void>;
  deleteKey(key: string, options?: { namespace?: string; group?: string }): Promise<void>;

  getClusterStatus?(): Promise<Record<string, unknown>>;
  listMembers?(): Promise<KvMemberInfo[]>;
  listLeases?(): Promise<KvLeaseInfo[]>;
  listServices?(options?: { namespace?: string; group?: string }): Promise<KvServiceInfo[]>;
  getConfigHistory?(key: string, options?: { namespace?: string; group?: string }): Promise<KvConfigHistoryEntry[]>;
}

/* ============================================================================
 * Message Queue / Broker Driver Types (RabbitMQ, Pulsar, MQTT)
 * ============================================================================ */

export interface MqOverview {
  engine: DatabaseEngineId;
  clusterName?: string;
  serverVersion: string;
  nodeCount?: number;
  queueCount?: number;
  exchangeCount?: number;
  connectionCount?: number;
  messagesReady?: number;
  messagesUnacked?: number;
  raw?: Record<string, unknown>;
}

export interface MqQueueInfo {
  name: string;
  vhost: string;
  messages?: number;
  messagesReady?: number;
  messagesUnacked?: number;
  consumers?: number;
  durable?: boolean;
  state?: string;
  type?: string;
}

export interface MqExchangeInfo {
  name: string;
  vhost: string;
  type: string;
  durable?: boolean;
  autoDelete?: boolean;
}

export interface MqBindingInfo {
  source: string;
  destination: string;
  destinationType?: string;
  routingKey: string;
  vhost?: string;
}

export interface MqMessage {
  id?: string;
  topicOrQueue: string;
  routingKey?: string;
  payload: string;
  headers?: Record<string, unknown>;
  timestamp?: number;
  redelivered?: boolean;
}

export interface MqDriver {
  readonly engine: DatabaseEngineId;
  readonly family: 'mq';
  readonly connected: boolean;
  readonly serverVersion: string;

  connect(config: ConnectionConfig, transport: ByteStreamTransport): Promise<ConnectionInfo>;
  testConnection(): Promise<TestConnectionResult>;
  close(): Promise<void>;

  getOverview(): Promise<MqOverview>;
  listVhosts(): Promise<string[]>;
  listQueues(vhost?: string): Promise<MqQueueInfo[]>;
  listExchanges(vhost?: string): Promise<MqExchangeInfo[]>;
  listBindings(vhost?: string): Promise<MqBindingInfo[]>;
  createQueue?(name: string, options?: { vhost?: string; durable?: boolean }): Promise<void>;
  deleteQueue?(name: string, vhost?: string): Promise<void>;
  publishMessage(
    target: string,
    payload: string,
    options?: { vhost?: string; exchange?: string; routingKey?: string; qos?: 0 | 1; retain?: boolean },
  ): Promise<{ routed: boolean }>;
  getMessages(
    queueOrTopic: string,
    options?: { vhost?: string; count?: number; requeue?: boolean; timeoutMs?: number },
  ): Promise<MqMessage[]>;
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

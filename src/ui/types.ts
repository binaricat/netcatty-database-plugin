/**
 * Core UI & Workbench domain types for the multi-database Netcatty Database IDE (v0.3.0).
 */

import type { AnyDatabaseDriver } from '../drivers/lazyFactory';
import type {
  CellValue,
  ColumnMeta,
  ConnectionInfo,
  CustomTypeSummary,
  DatabaseEngineId,
  DatabaseInfo,
  DatabaseUserSummary,
  DictionarySummary,
  EngineFamily,
  EventSummary,
  EventTriggerSummary,
  ExplainResult,
  ExtensionSummary,
  GraphQueryResult,
  GraphSchemaSummary,
  KvEntry,
  KvNamespaceInfo,
  LinkedServerSummary,
  MongoCollectionInfo,
  MongoCollectionStats,
  MongoDocument,
  MongoIndexInfo,
  MongoSchemaAnalysis,
  MqBindingInfo,
  MqExchangeInfo,
  MqMessage,
  MqOverview,
  MqQueueInfo,
  ObjectDependency,
  PartitionSummary,
  ProcessEntry,
  QueryResultSet,
  RedisCliResult,
  RedisInfoParsed,
  RedisKeyDetail,
  RedisKeyEntry,
  RedisPubSubMessage,
  RoutineSummary,
  RuleSummary,
  SchemaDiffResult,
  SchemaErGraph,
  SchemaIndexSummary,
  SchemaInfo,
  SearchDocument,
  SearchIndexInfo,
  SequenceSummary,
  ServerStatusSnapshot,
  SqlDialect,
  SynonymSummary,
  TableStructure,
  TableStructureDiff,
  TableSummary,
  TriggerSummary,
  TlsMode,
  ViewSummary,
} from '../drivers/types';
import type {
  FilterRule,
  RestoreProgress,
  RestoreResult,
  SqlParameterInfo,
  SqlRiskAssessment,
  TransferProgress,
  TransferResult,
} from '../sql/index';
import type {
  BiAnalysisCard,
  BiChartConfig,
  BiCrossFilter,
  BiPipelineStage,
} from '../bi/types';
import type { DriverId } from '../driverRegistry';
import type { PluginCodeEditorDiagnostic, PluginDataGridSort } from '@netcatty/plugin-sdk/host-react';
import type { HostStreamTargetRef } from '../hostStreamEndpoint';

export type { TableSummary, ViewSummary };

export type EnvColor = 'none' | 'blue' | 'emerald' | 'amber' | 'rose' | 'purple';

export interface SavedSshTunnelConfig {
  enabled: boolean;
  hostLabel?: string;
  hostBindingToken?: string;
  target?: HostStreamTargetRef;
  expectedRevision?: string;
}

export interface SavedConnection {
  id: string;
  name: string;
  group: string;
  color: EnvColor;
  engine: DriverId;
  host: string;
  port: number;
  database: string;
  schema: string;
  username: string;
  /** True when a password is saved in plugin encrypted secrets (`context.secrets`). */
  hasPassword: boolean;
  /** Read-Only / Safe Mode: blocks all DML/DDL & NoSQL writes. */
  readOnly?: boolean;
  tlsMode: TlsMode;
  allowSelfSigned: boolean;
  redisDb: number;
  authSource: string;
  httpPath: string;
  /** Optional API key / token stored in secret or inline config (InfluxDB, Qdrant, Turso, Meilisearch, Consul). */
  apiKey?: string;
  /** Optional organization / tenant (InfluxDB v2, ChromaDB). */
  org?: string;
  /** Optional namespace (Nacos, Consul, ChromaDB, Pulsar). */
  namespace?: string;
  /** Optional cloud region (DynamoDB SigV4, BigQuery). */
  region?: string;
  /** Optional cloud account/project ID (Cloudflare D1, BigQuery, Snowflake). */
  accountId?: string;
  /** Optional warehouse ID (Databricks, Snowflake). */
  warehouseId?: string;
  /** Optional RabbitMQ vhost. */
  vhost?: string;
  /** Optional protocol variant ID (e.g. 'gbase-8c-pg', 'kingbase-pg', 'gaussdb-dws'). */
  variant?: string;
  /** Preferred protocol for multi-protocol engines like Neo4j ('bolt' | 'http'). */
  protocol?: 'bolt' | 'http';
  sqliteMode: 'demo' | 'file' | 'memory';
  sqliteFileName?: string;
  sqliteFileHandleId?: string;
  sshTunnel: SavedSshTunnelConfig;
  createdAt: number;
  updatedAt: number;
}

export interface SchemaObjectsCache {
  tables: TableSummary[];
  views: ViewSummary[];
  routines: RoutineSummary[];
  triggers: TriggerSummary[];
  sequences?: SequenceSummary[];
  events?: EventSummary[];
  customTypes?: CustomTypeSummary[];
  extensions?: ExtensionSummary[];
  synonyms?: SynonymSummary[];
  eventTriggers?: EventTriggerSummary[];
  rules?: RuleSummary[];
  dictionaries?: DictionarySummary[];
  schemaIndexes?: SchemaIndexSummary[];
  linkedServers?: LinkedServerSummary[];
  structures: Record<string, TableStructure>;
  loaded: boolean;
  loading: boolean;
}

export interface ActiveSession {
  connectionId: string;
  connection: SavedConnection;
  driver: AnyDatabaseDriver;
  family: EngineFamily;
  info: ConnectionInfo;
  databases: DatabaseInfo[];
  activeDatabase: string;
  schemas: SchemaInfo[];
  activeSchema: string;
  /** Keyed by `${database}::${schema}` */
  objectsBySchema: Record<string, SchemaObjectsCache>;
  /** MongoDB collections keyed by database */
  mongoCollectionsByDb: Record<string, MongoCollectionInfo[]>;
  /** Graph database schema summary keyed by database (Neo4j) */
  graphSchemaByDb?: Record<string, GraphSchemaSummary>;
  /** Search/Vector engine indices or collections */
  searchIndices?: SearchIndexInfo[];
  /** Registry/Config KV namespaces */
  kvNamespaces?: KvNamespaceInfo[];
  /** MQ vhosts / queues cache */
  mqVhosts?: string[];
  mqQueues?: MqQueueInfo[];
  /** Redis server info cache */
  redisInfo?: RedisInfoParsed;
  sqliteFileHandleId?: string;
  sqliteDirty?: boolean;
  /** True if a network drop was detected; displays 1-click Reconnect banner. */
  disconnected?: boolean;
  error?: string;
}

export type WorkspaceTabKind =
  | 'sql'
  | 'table'
  | 'structure'
  | 'er'
  | 'bi'
  | 'redis'
  | 'mongo'
  | 'graph'
  | 'search'
  | 'kv'
  | 'mq'
  | 'diff'
  | 'objectDef'
  | 'monitor'
  | 'users'
  | 'dataCompare'
  | 'dolt'
  | 'powerTools';

export interface BaseTab {
  id: string;
  connectionId: string;
  kind: WorkspaceTabKind;
  title: string;
  dirty?: boolean;
}

export interface SqlTabMessage {
  time: number;
  level: 'info' | 'success' | 'warning' | 'error';
  text: string;
  line?: number;
  column?: number;
  hint?: string;
  sql?: string;
}

export interface SqlQueryTabState extends BaseTab {
  kind: 'sql';
  dialect: SqlDialect;
  database: string;
  schema: string;
  sql: string;
  selectedText: string;
  txMode: 'auto' | 'manual';
  inTransaction: boolean;
  running: boolean;
  results: QueryResultSet[];
  activeResultTab: number | 'chart' | 'messages' | 'explain';
  resultFilter: string;
  resultSort: PluginDataGridSort | null;
  chartConfig?: BiChartConfig | null;
  chartResultIndex?: number;
  explainViewMode: 'tree' | 'raw';
  messages: SqlTabMessage[];
  explainResult: ExplainResult | null;
  diagnostics: PluginCodeEditorDiagnostic[];
  serverDiagnostics: PluginCodeEditorDiagnostic[];
  lastParamValues: Record<string, string>;
  fileName?: string;
  fileHandleId?: string;
}

export interface GridEditSnapshot {
  dirtyCells: Record<string, CellValue>;
  insertedRows: Record<string, CellValue>[];
  deletedRowIndices: number[];
}

export interface TableDataTabState extends BaseTab {
  kind: 'table';
  database: string;
  schema: string;
  table: string;
  structure: TableStructure | null;
  whereClause: string;
  appliedWhere: string;
  filterRules: FilterRule[];
  showFilterBuilder: boolean;
  hiddenColumns: string[];
  sort: PluginDataGridSort | null;
  page: number;
  pageSize: number;
  totalRows: number;
  totalEstimated: boolean;
  columns: ColumnMeta[];
  rows: CellValue[][];
  loading: boolean;
  executionMs: number;
  sql: string;
  error?: string;
  /** Keyed by `${rowIndex}:${colName}` */
  dirtyCells: Record<string, CellValue>;
  insertedRows: Record<string, CellValue>[];
  deletedRowIndices: number[];
  selectedRowIndices: number[];
  undoStack: GridEditSnapshot[];
  redoStack: GridEditSnapshot[];
}

export interface StructureDesignerTabState extends BaseTab {
  kind: 'structure';
  database: string;
  schema: string;
  table: string;
  structure: TableStructure | null;
  triggers: TriggerSummary[];
  partitions?: PartitionSummary[];
  activeSubTab: 'columns' | 'indexes' | 'fks' | 'checks' | 'triggers' | 'partitions' | 'ddl';
  pendingDiff: TableStructureDiff;
  loading: boolean;
  applying: boolean;
  error?: string;
}

export interface ObjectDefTabState extends BaseTab {
  kind: 'objectDef';
  objectKind:
    | 'view'
    | 'materialized_view'
    | 'function'
    | 'procedure'
    | 'trigger'
    | 'sequence'
    | 'event'
    | 'custom_type'
    | 'extension'
    | 'synonym'
    | 'event_trigger'
    | 'rule'
    | 'dictionary'
    | 'index'
    | 'linked_server';
  database: string;
  schema: string;
  name: string;
  tableName?: string;
  returnType?: string;
  arguments?: string;
  language?: string;
  timing?: string;
  event?: string;
  enabled?: boolean;
  definition: string;
  dependencies?: ObjectDependency[];
}

export interface ErDiagramTabState extends BaseTab {
  kind: 'er';
  database: string;
  schema: string;
  graph: SchemaErGraph | null;
  filter: string;
  selectedTable: string | null;
  loading: boolean;
  error?: string;
}

export interface BiAnalyticsTabState extends BaseTab {
  kind: 'bi';
  database: string;
  schema: string;
  viewMode: 'spotlight' | 'dashboard';
  question: string;
  aiModel?: string;
  pipelineStage: BiPipelineStage;
  pipelineError?: string;
  cards: BiAnalysisCard[];
  activeCardId: string | null;
  crossFilter: BiCrossFilter | null;
}

export interface RedisWorkbenchTabState extends BaseTab {
  kind: 'redis';
  db: number;
  matchPattern: string;
  viewMode: 'tree' | 'flat';
  activeSubTab: 'keys' | 'info' | 'pubsub';
  keys: RedisKeyEntry[];
  cursor: string;
  selectedKey: string | null;
  keyDetail: RedisKeyDetail | null;
  info: RedisInfoParsed | null;
  infoFilter: string;
  showCli: boolean;
  cliInput: string;
  cliHistory: RedisCliResult[];
  cliCommandHistory: string[];
  pubsubChannel: string;
  pubsubMessage: string;
  pubsubSubscribed: string[];
  pubsubLog: RedisPubSubMessage[];
  loading: boolean;
  error?: string;
}

export interface MongoWorkbenchTabState extends BaseTab {
  kind: 'mongo';
  database: string;
  collection: string;
  mode: 'find' | 'aggregate';
  filterJson: string;
  sortJson: string;
  projectionJson: string;
  pipelineJson: string;
  limit: number;
  skip: number;
  viewMode: 'table' | 'tree' | 'json';
  activeSubTab: 'documents' | 'indexes' | 'schema';
  documents: MongoDocument[];
  totalCount: number;
  indexes: MongoIndexInfo[];
  stats: MongoCollectionStats | null;
  schemaAnalysis: MongoSchemaAnalysis | null;
  schemaLoading: boolean;
  selectedDocIndex: number | null;
  executionMs: number;
  loading: boolean;
  error?: string;
}

export interface SchemaDiffTabState extends BaseTab {
  kind: 'diff';
  mode: 'diff' | 'dump' | 'restore' | 'transfer';
  leftConnectionId: string;
  leftDatabase: string;
  leftSchema: string;
  rightConnectionId: string;
  rightDatabase: string;
  rightSchema: string;
  diffResult: SchemaDiffResult | null;
  selectedItemIds: string[];
  dumpSql: string;
  dumpTables: string[];
  includeData: boolean;
  restoreFileName: string;
  restoreSql: string;
  restoreContinueOnError: boolean;
  restoreProgress: RestoreProgress | null;
  restoreResult: RestoreResult | null;
  transferTables: string[];
  transferCreateTables: boolean;
  transferDropIfExists: boolean;
  transferIncludeData: boolean;
  transferProgress: TransferProgress | null;
  transferResult: TransferResult | null;
  loading: boolean;
  error?: string;
}

export interface GraphWorkbenchTabState extends BaseTab {
  kind: 'graph';
  database: string;
  cypher: string;
  viewMode: 'graph' | 'table' | 'json';
  result: GraphQueryResult | null;
  schema: GraphSchemaSummary | null;
  selectedNodeId: string | null;
  running: boolean;
  error?: string;
}

export interface SearchWorkbenchTabState extends BaseTab {
  kind: 'search';
  index: string;
  queryText: string;
  viewMode: 'table' | 'json';
  activeSubTab: 'documents' | 'mapping' | 'raw';
  documents: SearchDocument[];
  totalCount: number;
  mapping: Record<string, unknown> | null;
  from: number;
  size: number;
  executionMs: number;
  loading: boolean;
  error?: string;
}

export interface KvWorkbenchTabState extends BaseTab {
  kind: 'kv';
  namespace: string;
  prefix: string;
  entries: KvEntry[];
  selectedKey: string | null;
  selectedEntry: KvEntry | null;
  loading: boolean;
  error?: string;
}

export interface MqWorkbenchTabState extends BaseTab {
  kind: 'mq';
  vhost: string;
  activeSubTab: 'overview' | 'queues' | 'bindings' | 'publish' | 'messages' | 'nodes';
  overview: MqOverview | null;
  vhosts: string[];
  queues: MqQueueInfo[];
  exchanges: MqExchangeInfo[];
  bindings: MqBindingInfo[];
  selectedQueue: string | null;
  messages: MqMessage[];
  loading: boolean;
  error?: string;
}

export interface ServerMonitorTabState extends BaseTab {
  kind: 'monitor';
  activeSubTab: 'dashboard' | 'processes' | 'variables';
  autoRefreshSec: number;
  status: ServerStatusSnapshot | null;
  history: ServerStatusSnapshot[];
  processes: ProcessEntry[];
  loading: boolean;
  error?: string;
}

export interface UserAdminTabState extends BaseTab {
  kind: 'users';
  users: DatabaseUserSummary[];
  selectedUserKey: string | null;
  selectedGrants: string[];
  loading: boolean;
  error?: string;
}

export interface DataCompareTabState extends BaseTab {
  kind: 'dataCompare';
}

export interface DoltVersionTabState extends BaseTab {
  kind: 'dolt';
}

export interface DatabasePowerToolsTabState extends BaseTab {
  kind: 'powerTools';
  mode: 'dataCompare' | 'mockData' | 'docsCodeGen' | 'globalSearch';
  database: string;
  schema: string;
  initialTable?: string;
}

export type WorkspaceTab =
  | SqlQueryTabState
  | TableDataTabState
  | StructureDesignerTabState
  | ObjectDefTabState
  | ErDiagramTabState
  | BiAnalyticsTabState
  | RedisWorkbenchTabState
  | MongoWorkbenchTabState
  | GraphWorkbenchTabState
  | SearchWorkbenchTabState
  | KvWorkbenchTabState
  | MqWorkbenchTabState
  | SchemaDiffTabState
  | ServerMonitorTabState
  | UserAdminTabState
  | DataCompareTabState
  | DoltVersionTabState
  | DatabasePowerToolsTabState;

export interface QueryHistoryEntry {
  id: string;
  connectionId: string;
  connectionName: string;
  engine: DriverId;
  sql: string;
  executedAt: number;
  executionMs: number;
  rowCount: number;
  success: boolean;
  error?: string;
}

export interface SavedSnippet {
  id: string;
  title: string;
  sql: string;
  dialect: SqlDialect | 'all';
  tags: string[];
  updatedAt: number;
}

export interface PersistedTabDraft {
  id: string;
  kind: WorkspaceTabKind;
  title: string;
  database?: string;
  schema?: string;
  table?: string;
  collection?: string;
  sql?: string;
  dialect?: SqlDialect;
}

export interface ToastNotice {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

export interface ContextMenuItem {
  id: string;
  label: string;
  danger?: boolean;
  dividerBefore?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export interface InspectorTarget {
  tabId: string;
  rowIndex: number;
  colName: string;
  value: CellValue;
  rowObject: Record<string, CellValue>;
  editable: boolean;
}

export interface SqlPreviewTarget {
  title: string;
  subtitle?: string;
  sql: string;
  dialect: SqlDialect;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm?: () => Promise<void>;
}

export interface ConfirmSqlTarget {
  title: string;
  sql: string;
  dialect: SqlDialect;
  assessment: SqlRiskAssessment;
  onConfirm: () => Promise<void>;
}

export interface SqlParameterPromptTarget {
  tabId: string;
  sql: string;
  dialect: SqlDialect;
  parameters: SqlParameterInfo[];
  initialValues: Record<string, string>;
  onExecute: (boundSql: string, savedValues: Record<string, string>) => Promise<void>;
}

export interface ImportWizardTarget {
  tabId: string;
  connectionId: string;
  database: string;
  schema: string;
  table: string;
  structure: TableStructure | null;
}

export interface CreateTableTarget {
  connectionId: string;
  database: string;
  schema: string;
}

export interface AiDrawerOptions {
  initialMode?: 'generate' | 'explain' | 'optimize' | 'fix';
  initialPrompt?: string;
}

export type RightDrawerState =
  | { kind: 'none' }
  | { kind: 'connection'; editingId: string | null; initialEngine?: DriverId }
  | { kind: 'ai'; options?: AiDrawerOptions }
  | { kind: 'history'; initialTab: 'history' | 'snippets' }
  | { kind: 'inspector'; target: InspectorTarget }
  | { kind: 'sqlPreview'; target: SqlPreviewTarget }
  | { kind: 'confirmSql'; target: ConfirmSqlTarget }
  | { kind: 'params'; target: SqlParameterPromptTarget }
  | { kind: 'import'; target: ImportWizardTarget }
  | { kind: 'createTable'; target: CreateTableTarget }
  | { kind: 'createCollection'; connectionId: string; database: string }
  | { kind: 'mockData'; connectionId: string; initialTable?: string }
  | { kind: 'docsModel'; connectionId: string; initialTab?: 'dictionary' | 'model'; initialTable?: string }
  | { kind: 'globalSearch'; connectionId: string; initialTab?: 'objects' | 'data' };

const LIVE_ENGINE_SET = new Set<string>([
  'sqlite',
  'postgres',
  'opengauss',
  'gaussdb',
  'kingbase',
  'highgo',
  'vastbase',
  'uxdb',
  'gbase8c',
  'cockroachdb',
  'redshift',
  'cloudberry',
  'opentenbase',
  'questdb',
  'kwdb',
  'mysql',
  'mariadb',
  'tidb',
  'oceanbase',
  'goldendb',
  'doris',
  'starrocks',
  'selectdb',
  'polardb',
  'tdsql',
  'greatsql',
  'dolt',
  'manticoresearch',
  'clickhouse',
  'sqlserver',
  'trino',
  'prestosql',
  'databend',
  'rqlite',
  'turso',
  'tdengine',
  'influxdb',
  'influxdb3',
  'victoriametrics',
  'redis',
  'mongodb',
  'neo4j',
  'elasticsearch',
  'easysearch',
  'meilisearch',
  'couchdb',
  'qdrant',
  'chromadb',
  'weaviate',
  'etcd',
  'etcd-v2',
  'consul',
  'nacos',
  'zookeeper',
  'oceanbase-oracle',
  'custom_postgres',
  'custom_mysql',
  'mongodb-legacy',
  'cloudflare-d1',
  'solr',
  'milvus',
  'dynamodb',
  'hbase',
  'rabbitmq',
  'pulsar',
  'mqtt',
  'kafka',
  'mq',
  'iotdb',
  'kylin',
  'databricks',
  'snowflake',
  'bigquery',
  'salesforce',
  'cassandra',
  'scylladb',
]);

export function isLiveSupportedEngine(engine: DriverId): engine is DatabaseEngineId {
  return LIVE_ENGINE_SET.has(engine);
}

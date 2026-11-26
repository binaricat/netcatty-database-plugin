/**
 * Core UI & Workbench domain types for the DBX-parity Netcatty Database IDE.
 */

import type { AnyDatabaseDriver } from '../drivers/index';
import type {
  CellValue,
  ColumnMeta,
  ConnectionInfo,
  DatabaseEngineId,
  DatabaseInfo,
  EngineFamily,
  ExplainResult,
  MongoCollectionInfo,
  MongoCollectionStats,
  MongoDocument,
  MongoIndexInfo,
  QueryResultSet,
  RedisCliResult,
  RedisInfoParsed,
  RedisKeyDetail,
  RedisKeyEntry,
  RoutineSummary,
  SchemaDiffResult,
  SchemaErGraph,
  SchemaInfo,
  SqlDialect,
  TableStructure,
  TableStructureDiff,
  TableSummary,
  TriggerSummary,
  TlsMode,
  ViewSummary,
} from '../drivers/types';
export type { TableSummary, ViewSummary };
import type { DriverId } from '../driverRegistry';
import type { PluginCodeEditorDiagnostic, PluginDataGridSort } from '@netcatty/plugin-sdk/host-react';
import type { HostStreamTargetRef } from '../hostStreamEndpoint';

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
  tlsMode: TlsMode;
  allowSelfSigned: boolean;
  redisDb: number;
  authSource: string;
  httpPath: string;
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
  /** Redis server info cache */
  redisInfo?: RedisInfoParsed;
  sqliteFileHandleId?: string;
  sqliteDirty?: boolean;
  error?: string;
}

export type WorkspaceTabKind = 'sql' | 'table' | 'structure' | 'er' | 'redis' | 'mongo' | 'diff';

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
  activeResultTab: number | 'messages' | 'explain';
  messages: SqlTabMessage[];
  explainResult: ExplainResult | null;
  diagnostics: PluginCodeEditorDiagnostic[];
  fileName?: string;
  fileHandleId?: string;
}

export interface TableDataTabState extends BaseTab {
  kind: 'table';
  database: string;
  schema: string;
  table: string;
  structure: TableStructure | null;
  whereClause: string;
  appliedWhere: string;
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
}

export interface StructureDesignerTabState extends BaseTab {
  kind: 'structure';
  database: string;
  schema: string;
  table: string;
  structure: TableStructure | null;
  triggers: TriggerSummary[];
  activeSubTab: 'columns' | 'indexes' | 'fks' | 'triggers' | 'ddl';
  pendingDiff: TableStructureDiff;
  loading: boolean;
  applying: boolean;
  error?: string;
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

export interface RedisWorkbenchTabState extends BaseTab {
  kind: 'redis';
  db: number;
  matchPattern: string;
  viewMode: 'tree' | 'flat';
  keys: RedisKeyEntry[];
  cursor: string;
  selectedKey: string | null;
  keyDetail: RedisKeyDetail | null;
  info: RedisInfoParsed | null;
  showInfo: boolean;
  showCli: boolean;
  cliInput: string;
  cliHistory: RedisCliResult[];
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
  activeSubTab: 'documents' | 'indexes';
  documents: MongoDocument[];
  totalCount: number;
  indexes: MongoIndexInfo[];
  stats: MongoCollectionStats | null;
  selectedDocIndex: number | null;
  executionMs: number;
  loading: boolean;
  error?: string;
}

export interface SchemaDiffTabState extends BaseTab {
  kind: 'diff';
  database: string;
  leftSchema: string;
  rightSchema: string;
  diffResult: SchemaDiffResult | null;
  dumpSql: string;
  includeData: boolean;
  loading: boolean;
  error?: string;
}

export type WorkspaceTab =
  | SqlQueryTabState
  | TableDataTabState
  | StructureDesignerTabState
  | ErDiagramTabState
  | RedisWorkbenchTabState
  | MongoWorkbenchTabState
  | SchemaDiffTabState;

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
  onConfirm?: () => Promise<void>;
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

export type RightDrawerState =
  | { kind: 'none' }
  | { kind: 'connection'; editingId: string | null; initialEngine?: DriverId }
  | { kind: 'ai' }
  | { kind: 'history'; initialTab: 'history' | 'snippets' }
  | { kind: 'inspector'; target: InspectorTarget }
  | { kind: 'sqlPreview'; target: SqlPreviewTarget }
  | { kind: 'import'; target: ImportWizardTarget }
  | { kind: 'createTable'; target: CreateTableTarget };

export function isLiveSupportedEngine(engine: DriverId): engine is DatabaseEngineId {
  return (
    engine === 'sqlite' ||
    engine === 'postgres' ||
    engine === 'opengauss' ||
    engine === 'gaussdb' ||
    engine === 'kingbase' ||
    engine === 'highgo' ||
    engine === 'vastbase' ||
    engine === 'uxdb' ||
    engine === 'mysql' ||
    engine === 'mariadb' ||
    engine === 'tidb' ||
    engine === 'oceanbase' ||
    engine === 'goldendb' ||
    engine === 'clickhouse' ||
    engine === 'redis' ||
    engine === 'mongodb'
  );
}

// Plugin-owned database models, derived from the prior GPL-3.0-or-later snapshot.
// These are local application types, not a host RPC or host capability.
export type DatabaseConnectionIdRequest = {
  id: DatabaseHandle;
};

export type DatabaseConnectionMeta = {
  name: string;
  color: "default" | "blue" | "green" | "purple" | "orange";
  hostId?: string;
};

export type DatabaseDriverId = "sqlite" | "postgres" | "mysql" | "mariadb" | "goldendb" | "opengauss" | "gaussdb" | "kingbase" | "highgo" | "vastbase" | "uxdb" | "gbase8c" | "tidb" | "oceanbase" | "dameng" | "oracle" | "sqlserver" | "clickhouse" | "redis" | "mongodb" | "firebird";

export type DatabaseDriverProfile = {
  id: DatabaseDriverId;
  label: string;
  category: "lightweight" | "relational" | "domestic" | "analytics" | "document";
  wireFamily: "sqlite" | "postgres" | "mysql" | "unpackaged";
  defaultPort: number;
  fields: Array<string>;
  icon: string | null;
  source: string;
  qualification: "fixture" | "wire" | "alias" | "catalog";
  variants?: Array<DatabaseDriverVariant>;
};

export type DatabaseDriverVariant = {
  id: DatabaseVariantId;
  label: string;
  defaultPort: number;
  wireFamily: "postgres" | "mysql" | "unpackaged";
  authPolicy: "postgres" | "gauss-legacy" | "mysql" | "none";
  metadata: "pg" | "sys" | "mysql" | "none";
  modeCheck: "none" | "pg-compatibility";
};

export type DatabaseEmptyRequest = Record<string, never>;

export type DatabaseFileFixtureFeature = "database.sqlite-file-fixture.v1";

export type DatabaseFileOpenResult = {
  handleId: DatabaseHandle;
  revision: DatabaseHandle;
  engine: "sqlite";
  label: "Disposable SQLite file (read-only)";
  fixture: true;
  readOnly: true;
};

export type DatabaseFixtureFeature = "database.sqlite-fixture.v1";

export type DatabaseHandle = string;

export type DatabaseHandleRequest = {
  handleId: DatabaseHandle;
  revision?: DatabaseHandle;
};

export type DatabaseHostList = Array<DatabaseHostMeta>;

export type DatabaseHostLiveSshPgCancelRequest = {
  openId: DatabaseHandle;
};

export type DatabaseHostLiveSshPgCapability = {
  kind: "fixture";
  revision: DatabaseHandle;
};

export type DatabaseHostLiveSshPgCloseRequest = {
  sessionId: DatabaseHandle;
};

export type DatabaseHostLiveSshPgCloseResult = {
  fixture: true;
  connected: false;
  closed: true;
};

export type DatabaseHostLiveSshPgFeature = "database.host-live-ssh-pg.fixture.v1";

export type DatabaseHostLiveSshPgOpenRequest = {
  hostId: string;
  revision: DatabaseHandle;
  openId: DatabaseHandle;
};

export type DatabaseHostLiveSshPgOpenResult = ({
  code: "LIVE_OK";
  fixture: true;
  synthetic: false;
  connected: true;
  sessionId: DatabaseHandle;
  expiresAt: number;
  proof: {
    query: "SELECT 1";
    value: 1;
    pinnedHostKey: true;
  };
  secretRef: string;
  pgSecretRef: string;
}) | ({
  code: "AUTH_FAILED" | "UNKNOWN_HOST_KEY" | "HOST_KEY_MISMATCH" | "UNKNOWN_HOST" | "STALE_HOST" | "CANCELLED" | "DEADLINE_EXCEEDED" | "UNAVAILABLE";
  fixture: true;
  synthetic: false;
  connected: false;
});

export type DatabaseHostMeta = {
  hostId: string;
  label: string;
  hostname: string;
  port: number;
  username: string;
  capability: "metadata-only";
  tunnelAvailable: false;
  tunnelTest?: DatabaseTunnelTestCapability;
  portProbe?: DatabaseHostPortProbeCapability;
  liveSshPg?: DatabaseHostLiveSshPgCapability;
};

export type DatabaseHostPortProbeCancelRequest = {
  probeId: DatabaseHandle;
};

export type DatabaseHostPortProbeCapability = {
  revision: DatabaseHandle;
};

export type DatabaseHostPortProbeFeature = "database.host-port-probe.v1";

export type DatabaseHostPortProbeRequest = {
  hostId: string;
  revision: DatabaseHandle;
  probeId: DatabaseHandle;
};

export type DatabaseHostPortProbeResult = {
  hostId: string;
  hostname?: string;
  synthetic: false;
  connected: false;
  ports: Array<DatabaseHostPortResult>;
  code: "PROBE_OK" | "UNKNOWN_HOST" | "STALE_HOST" | "CANCELLED" | "DEADLINE_EXCEEDED" | "UNAVAILABLE";
};

export type DatabaseHostPortResult = {
  port: 5432 | 3306 | 1433 | 27017 | 6379;
  serviceLabel: "PostgreSQL" | "MySQL / MariaDB" | "Microsoft SQL Server" | "MongoDB" | "Redis";
  status: "open" | "closed" | "timeout";
  latencyMs?: number;
};

export type DatabaseOpenResult = {
  handleId: DatabaseHandle;
  engine: "sqlite";
  label: "Disposable synthetic notes";
  readOnly?: boolean;
  supportsReviewedWrites?: true;
  fixture: true;
};

export type DatabaseQueryRequest = {
  handleId: DatabaseHandle;
  sql: string;
  parameters: Array<DatabaseScalar>;
  mode: "read" | "write";
  writeConfirmation?: { handleId: DatabaseHandle; sql: string; parameters: Array<DatabaseScalar> };
  maxRows?: number;
  timeoutMs?: number;
  revision?: DatabaseHandle;
};

export type DatabaseQueryResult = {
  columns: Array<string>;
  rows: Array<Array<DatabaseScalar>>;
  truncated: boolean;
  changes: number;
  elapsedMs: number;
  schema?: DatabaseSchemaResult;
};

export type DatabaseSaveConnectionRequest = {
  handleId: DatabaseHandle;
  revision?: DatabaseHandle;
  meta: DatabaseConnectionMeta;
  secret?: {
    kind: "password";
    value: string;
  };
};

export type DatabaseSavedConnection = {
  id: DatabaseHandle;
  name: string;
  engine: "sqlite";
  color: "default" | "blue" | "green" | "purple" | "orange";
  targetKind: "memory" | "file";
  readOnly: boolean;
  hostId?: string;
  hostLabel?: string;
  secretRef?: string;
};

export type DatabaseSavedConnectionList = Array<DatabaseSavedConnection>;

export type DatabaseSavedConnectionsFeature = "database.saved-connections.v1";

export type DatabaseScalar = (null) | (boolean) | (number) | (string);

export type DatabaseSchemaResult = {
  tables: Array<{
    name: string;
    columns: Array<{
      name: string;
      type: string;
      primaryKey: boolean;
      nullable?: boolean;
      defaultSql?: string|null;
      rowidAlias?: boolean;
    }>;
    kind?: "table" | "view";
    /** Optional engine metadata. Absence means unavailable, not an empty list. */
    definition?: string;
    primaryKeyColumns?: string[];
    indexes?: Array<{ name: string; unique: boolean; origin: string; partial: boolean; columns: Array<{ name: string | null; expression: boolean; descending: boolean; collation: string | null }>; definition?: string }>;
    foreignKeys?: Array<{ id: number; targetTable: string; columns: Array<{ from: string; to: string | null }>; onUpdate: string; onDelete: string; match: string }>;
    triggers?: Array<{ name: string; definition: string }>;
  }>;
};

export type DatabaseTcpFeature = "database.tcp.v1";

export type DatabaseTcpOpenRequest = {
  driverId: DatabaseDriverId;
  hostname: string;
  port: number;
  database: string;
  username: string;
  password: string;
  tls: boolean;
  variant?: DatabaseVariantId;
};

export type DatabaseTcpOpenResult = {
  handleId: DatabaseHandle;
  engine: "postgres" | "mysql";
  driverId: DatabaseDriverId;
  label: string;
  readOnly: true;
  fixture: false;
};

export type DatabaseTunnelCancelRequest = {
  testId: DatabaseHandle;
};

export type DatabaseTunnelTestCapability = {
  kind: "synthetic";
  revision: DatabaseHandle;
};

export type DatabaseTunnelTestFeature = "database.tunnel-test.synthetic.v1";

export type DatabaseTunnelTestRequest = {
  hostId: string;
  revision: DatabaseHandle;
  testId: DatabaseHandle;
};

export type DatabaseTunnelTestResult = {
  status: "synthetic-passed" | "failed" | "cancelled";
  code: "SYNTHETIC_OK" | "AUTH_FAILED" | "UNKNOWN_HOST_KEY" | "HOST_KEY_MISMATCH" | "UNKNOWN_HOST" | "STALE_HOST" | "CANCELLED" | "DEADLINE_EXCEEDED" | "UNAVAILABLE";
  synthetic: true;
  connected: false;
  closed: boolean;
  secretRef?: string;
};

export type DatabaseVariantId = "goldendb-mysql" | "opengauss-pg" | "gaussdb-dws" | "gaussdb-mysql" | "gaussdb-native" | "kingbase-pg" | "kingbase-oracle" | "highgo-pg" | "highgo-secure" | "vastbase-g100-pg" | "vastbase-g100-other" | "vastbase-e100" | "gbase-8c" | "gbase-8a" | "gbase-8s";


export type {DatabaseCreateTableDraft,DatabaseCreateTableReview} from './schemaCreateTable';
export type DatabaseCreateTableRequest={handleId:DatabaseHandle;draft:import('./schemaCreateTable').DatabaseCreateTableDraft};
export type DatabaseCreateTableApplyRequest={handleId:DatabaseHandle;review:import('./schemaCreateTable').DatabaseCreateTableReview};
export type DatabaseCreateTableResult={changes:0;schema:DatabaseSchemaResult;sql:string};

export type {DatabaseCreateIndexDraft,DatabaseCreateIndexReview} from './schemaCreateIndex';
export type DatabaseCreateIndexRequest={handleId:DatabaseHandle;draft:import('./schemaCreateIndex').DatabaseCreateIndexDraft};
export type DatabaseCreateIndexApplyRequest={handleId:DatabaseHandle;review:import('./schemaCreateIndex').DatabaseCreateIndexReview};
export type DatabaseCreateIndexResult={changes:0;schema:DatabaseSchemaResult;sql:string};
export type GridMutationReview={handleId:DatabaseHandle;draft:import('./gridMutation').GridMutationDraft;sql:string;parameters:DatabaseScalar[];schemaRevision:number};
export type GridMutationRequest={handleId:DatabaseHandle;draft:import('./gridMutation').GridMutationDraft};
export type GridMutationApplyRequest={handleId:DatabaseHandle;review:GridMutationReview};
export type GridMutationResult={changes:1};
export type CsvImportReview={handleId:DatabaseHandle;draft:import('./csvImportModel').CsvImportDraft;plan:import('./csvImportModel').CsvImportPlan;schemaRevision:number};
export type CsvImportRequest={handleId:DatabaseHandle;draft:import('./csvImportModel').CsvImportDraft};
export type CsvImportApplyRequest={handleId:DatabaseHandle;review:CsvImportReview};
export type CsvImportResult={changes:number};

export type {AddColumnDraft,AddColumnReview} from './alterTableModel';
export type AddColumnRequest={handleId:DatabaseHandle;draft:import('./alterTableModel').AddColumnDraft};
export type AddColumnApplyRequest={handleId:DatabaseHandle;review:import('./alterTableModel').AddColumnReview};
export type AddColumnResult={changes:0;schema:DatabaseSchemaResult;sql:string};

export type RenameColumnReview=import('./schemaRenameColumn').RenameColumnPreview & {handleId:DatabaseHandle;schemaRevision:number;tempSchemaRevision:number};
export type RenameColumnRequest={handleId:DatabaseHandle;draft:import('./schemaRenameColumn').RenameColumnDraft};
export type RenameColumnApplyRequest={handleId:DatabaseHandle;review:RenameColumnReview};
export type RenameColumnResult={changes:0;schema:DatabaseSchemaResult;sql:string};

export type DropIndexReview=import('./schemaDropIndex').DropIndexPreview & {handleId:DatabaseHandle;schemaRevision:number;tempSchemaRevision:number};
export type DropIndexRequest={handleId:DatabaseHandle;draft:import('./schemaDropIndex').DropIndexDraft};
export type DropIndexApplyRequest={handleId:DatabaseHandle;review:DropIndexReview};
export type DropIndexResult={changes:0;schema:DatabaseSchemaResult;sql:string};

export type RowInsertReview=import('./rowInsertModel').RowInsertPlan & {handleId:DatabaseHandle;schemaRevision:number};
export type RowInsertRequest={handleId:DatabaseHandle;draft:import('./rowInsertModel').RowInsertDraft};
export type RowInsertApplyRequest={handleId:DatabaseHandle;review:RowInsertReview};
export type RowInsertResult={changes:1};

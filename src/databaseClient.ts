import type { PluginContext as HostPluginContext } from '@netcatty/plugin-sdk';
import type { DatabaseConnectionIdRequest, DatabaseConnectionMeta, DatabaseDriverId, DatabaseDriverProfile, DatabaseDriverVariant, DatabaseEmptyRequest, DatabaseFileFixtureFeature, DatabaseFileOpenResult, DatabaseFixtureFeature, DatabaseHandle, DatabaseHandleRequest, DatabaseHostList, DatabaseHostLiveSshPgCancelRequest, DatabaseHostLiveSshPgCapability, DatabaseHostLiveSshPgCloseRequest, DatabaseHostLiveSshPgCloseResult, DatabaseHostLiveSshPgFeature, DatabaseHostLiveSshPgOpenRequest, DatabaseHostLiveSshPgOpenResult, DatabaseHostMeta, DatabaseHostPortProbeCancelRequest, DatabaseHostPortProbeCapability, DatabaseHostPortProbeFeature, DatabaseHostPortProbeRequest, DatabaseHostPortProbeResult, DatabaseHostPortResult, DatabaseOpenResult, DatabaseQueryRequest, DatabaseQueryResult, DatabaseSaveConnectionRequest, DatabaseSavedConnection, DatabaseSavedConnectionList, DatabaseSavedConnectionsFeature, DatabaseScalar, DatabaseSchemaResult, DatabaseTcpFeature, DatabaseTcpOpenRequest, DatabaseTcpOpenResult, DatabaseTunnelCancelRequest, DatabaseTunnelTestCapability, DatabaseTunnelTestFeature, DatabaseTunnelTestRequest, DatabaseTunnelTestResult, DatabaseVariantId } from './databaseTypes';
export type * from './databaseTypes';
import type {DatabaseCreateTableRequest,DatabaseCreateTableApplyRequest,DatabaseCreateTableResult,DatabaseCreateTableReview} from './databaseTypes';
import type {DatabaseCreateIndexRequest,DatabaseCreateIndexApplyRequest,DatabaseCreateIndexResult,DatabaseCreateIndexReview} from './databaseTypes';
export interface PluginDatabaseClient {
  previewCreateIndex(params:DatabaseCreateIndexRequest):Promise<DatabaseCreateIndexReview>;
  applyCreateIndex(params:DatabaseCreateIndexApplyRequest):Promise<DatabaseCreateIndexResult>;
  previewCreateTable(params:DatabaseCreateTableRequest):Promise<DatabaseCreateTableReview>;
  applyCreateTable(params:DatabaseCreateTableApplyRequest):Promise<DatabaseCreateTableResult>;
  /** Plugin-local driver facade. No database business methods exist in the main host RPC. */
  openTcp(params: DatabaseTcpOpenRequest): Promise<DatabaseTcpOpenResult>;
  openHostLiveSshPgFixture(params: DatabaseHostLiveSshPgOpenRequest): Promise<DatabaseHostLiveSshPgOpenResult>;
  cancelHostLiveSshPgFixture(params: DatabaseHostLiveSshPgCancelRequest): Promise<null>;
  closeHostLiveSshPgSession(params: DatabaseHostLiveSshPgCloseRequest): Promise<DatabaseHostLiveSshPgCloseResult>;
  probeHostDatabasePorts(params: DatabaseHostPortProbeRequest): Promise<DatabaseHostPortProbeResult>;
  cancelHostDatabasePorts(params: DatabaseHostPortProbeCancelRequest): Promise<null>;
  testTunnel(params: DatabaseTunnelTestRequest): Promise<DatabaseTunnelTestResult>;
  cancelTunnelTest(params: DatabaseTunnelCancelRequest): Promise<null>;
  listSavedConnections(params?: DatabaseEmptyRequest): Promise<DatabaseSavedConnectionList>;
  saveConnection(params: DatabaseSaveConnectionRequest): Promise<DatabaseSavedConnection>;
  deleteConnection(params: DatabaseConnectionIdRequest): Promise<null>;
  openSavedConnection(params: DatabaseConnectionIdRequest): Promise<DatabaseOpenResult | DatabaseFileOpenResult>;
  listHostsForDatabase(params?: DatabaseEmptyRequest): Promise<DatabaseHostList>;
  /** Explicit quiescent WAL fixture refresh; preserves handle and replaces revision. */
  refreshSqliteFile(params: DatabaseHandleRequest): Promise<DatabaseFileOpenResult>;
  openSqliteFile(params?: DatabaseEmptyRequest): Promise<DatabaseFileOpenResult | null>;
  openFixture(params?: DatabaseEmptyRequest): Promise<DatabaseOpenResult>;
  readSchema(params: DatabaseHandleRequest): Promise<DatabaseSchemaResult>;
  query(params: DatabaseQueryRequest): Promise<DatabaseQueryResult>;
  cancel(params: DatabaseHandleRequest): Promise<null>;
  close(params: DatabaseHandleRequest): Promise<null>;
}

export interface WorkbenchContext extends HostPluginContext { readonly database: PluginDatabaseClient & { readonly capabilities: ReadonlySet<string> }; }
export type { WorkbenchContext as PluginContext };

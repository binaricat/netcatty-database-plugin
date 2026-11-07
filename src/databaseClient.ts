import type {RowInsertRequest,RowInsertReview,RowInsertApplyRequest,RowInsertResult} from './databaseTypes';
import type {DropIndexRequest,DropIndexReview,DropIndexApplyRequest,DropIndexResult} from './databaseTypes';
import type {RenameColumnRequest,RenameColumnReview,RenameColumnApplyRequest,RenameColumnResult} from './databaseTypes';
import type {AddColumnRequest,AddColumnApplyRequest,AddColumnResult,AddColumnReview} from './databaseTypes';
import type { PluginContext as HostPluginContext } from '@netcatty/plugin-sdk';
import type { DatabaseConnectionIdRequest, DatabaseConnectionMeta, DatabaseDriverId, DatabaseDriverProfile, DatabaseDriverVariant, DatabaseEmptyRequest, DatabaseFileFixtureFeature, DatabaseFileOpenResult, DatabaseFixtureFeature, DatabaseHandle, DatabaseHandleRequest, DatabaseHostList, DatabaseHostLiveSshPgCancelRequest, DatabaseHostLiveSshPgCapability, DatabaseHostLiveSshPgCloseRequest, DatabaseHostLiveSshPgCloseResult, DatabaseHostLiveSshPgFeature, DatabaseHostLiveSshPgOpenRequest, DatabaseHostLiveSshPgOpenResult, DatabaseHostMeta, DatabaseHostPortProbeCancelRequest, DatabaseHostPortProbeCapability, DatabaseHostPortProbeFeature, DatabaseHostPortProbeRequest, DatabaseHostPortProbeResult, DatabaseHostPortResult, DatabaseOpenResult, DatabaseQueryRequest, DatabaseQueryResult, DatabaseSaveConnectionRequest, DatabaseSavedConnection, DatabaseSavedConnectionList, DatabaseSavedConnectionsFeature, DatabaseScalar, DatabaseSchemaResult, DatabaseTcpFeature, DatabaseTcpOpenRequest, DatabaseTcpOpenResult, DatabaseTunnelCancelRequest, DatabaseTunnelTestCapability, DatabaseTunnelTestFeature, DatabaseTunnelTestRequest, DatabaseTunnelTestResult, DatabaseVariantId } from './databaseTypes';
export type * from './databaseTypes';
import type {DatabaseCreateTableRequest,DatabaseCreateTableApplyRequest,DatabaseCreateTableResult,DatabaseCreateTableReview} from './databaseTypes';
import type {DatabaseCreateIndexRequest,DatabaseCreateIndexApplyRequest,DatabaseCreateIndexResult,DatabaseCreateIndexReview} from './databaseTypes';
import type {GridMutationRequest,GridMutationApplyRequest,GridMutationReview,GridMutationResult} from './databaseTypes';
import type {CsvImportRequest,CsvImportApplyRequest,CsvImportReview,CsvImportResult} from './databaseTypes';
export interface PluginDatabaseClient {
  snapshotInfo(params:DatabaseHandleRequest):Promise<import('./snapshotStorage').SnapshotInfo|undefined>;
  saveSnapshot(params:DatabaseHandleRequest):Promise<import('./snapshotStorage').SnapshotInfo>;
  previewRestoreSnapshot(params:DatabaseHandleRequest):Promise<import('./databaseTypes').SnapshotRestoreReview>;
  applyRestoreSnapshot(params:DatabaseHandleRequest & {review:import('./databaseTypes').SnapshotRestoreReview}):Promise<{schema:DatabaseSchemaResult}>;
  deleteSnapshot(params:DatabaseHandleRequest):Promise<null>;
  previewRowInsert(params:RowInsertRequest):Promise<RowInsertReview>;
  applyRowInsert(params:RowInsertApplyRequest):Promise<RowInsertResult>;
  previewDropIndex(params:DropIndexRequest):Promise<DropIndexReview>;
  applyDropIndex(params:DropIndexApplyRequest):Promise<DropIndexResult>;
  previewRenameColumn(params:RenameColumnRequest):Promise<RenameColumnReview>;
  applyRenameColumn(params:RenameColumnApplyRequest):Promise<RenameColumnResult>;
  previewAddColumn(params:AddColumnRequest):Promise<AddColumnReview>;
  applyAddColumn(params:AddColumnApplyRequest):Promise<AddColumnResult>;
  previewCsvImport(params:CsvImportRequest):Promise<CsvImportReview>;
  applyCsvImport(params:CsvImportApplyRequest):Promise<CsvImportResult>;
  previewGridMutation(params:GridMutationRequest):Promise<GridMutationReview>;
  applyGridMutation(params:GridMutationApplyRequest):Promise<GridMutationResult>;
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

export interface WorkbenchContext extends HostPluginContext { readonly queryLibraryStore?: ReturnType<typeof import('./queryLibraryStorage').createQueryLibraryStorage>; readonly database: PluginDatabaseClient & { readonly capabilities: ReadonlySet<string> }; }
export type { WorkbenchContext as PluginContext };

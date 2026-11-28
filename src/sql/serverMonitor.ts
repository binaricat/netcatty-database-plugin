/**
 * Server Status Monitor & Processlist SQL Builders and Parsers.
 * Pure, browser-sandbox compatible (zero Node imports).
 *
 * Covers:
 * - MySQL / MariaDB / TiDB / OceanBase / GreatSQL / PolarDB / TDSQL / Dolt
 * - PostgreSQL / openGauss / Kingbase / CockroachDB / HighGo / Vastbase / GaussDB
 * - Microsoft SQL Server (MSSQL)
 * - ClickHouse
 */

import type {
  CellValue,
  DatabaseEngineId,
  ProcessEntry,
  QueryResultSet,
  ServerStatusMetric,
  ServerStatusSnapshot,
  ServerVariableEntry,
} from '../drivers/types';

export type MonitorDialect = 'mysql' | 'postgres' | 'mssql' | 'clickhouse';

export type StatusMap = Record<string, string>;

export interface StatusSample {
  /** Capture epoch time in milliseconds. */
  at: number;
  status: StatusMap;
}

export interface ServerDeltaMetrics {
  qpsOrTps: number;
  bytesInPerSec: number;
  bytesOutPerSec: number;
  selectPerSec?: number;
  insertPerSec?: number;
  updatePerSec?: number;
  deletePerSec?: number;
  walBytesPerSec?: number;
  tuplesReturnedPerSec?: number;
  tuplesModifiedPerSec?: number;
}

export interface ServerMonitorSqlProfile {
  dialect: MonitorDialect;
  supportsDashboard: boolean;
  supportsProcessList: boolean;
  supportsCancelQuery: boolean;
  supportsTerminateSession: boolean;
  statusSql: string;
  fallbackStatusSql?: string;
  variablesSql: string;
  processListSql: string;
  fallbackProcessListSql?: string;
  ownSessionSql: string;
  qpsLabel: string;
  cacheLabel: string;
}

export const MIN_REFRESH_SECONDS = 1;
export const MAX_REFRESH_SECONDS = 3600;
export const DEFAULT_REFRESH_SECONDS = 5;
export const MAX_MONITOR_SAMPLES = 60;

/* ============================================================================
 * SQL Queries by Engine Family
 * ============================================================================ */

export const MYSQL_GLOBAL_STATUS_SQL = 'SHOW GLOBAL STATUS';
export const MYSQL_GLOBAL_VARIABLES_SQL = 'SHOW GLOBAL VARIABLES';
export const MYSQL_PROCESS_LIST_SQL = 'SHOW FULL PROCESSLIST';
export const MYSQL_OWN_SESSION_SQL = 'SELECT CONNECTION_ID() AS session_id';

export const PG_STATUS_SQL = `WITH db_stats AS (
  SELECT
    coalesce(sum(xact_commit), 0) AS xact_commit,
    coalesce(sum(xact_rollback), 0) AS xact_rollback,
    coalesce(sum(blks_hit), 0) AS blks_hit,
    coalesce(sum(blks_read), 0) AS blks_read,
    coalesce(sum(tup_returned), 0) AS tup_returned,
    coalesce(sum(tup_fetched), 0) AS tup_fetched,
    coalesce(sum(tup_inserted), 0) AS tup_inserted,
    coalesce(sum(tup_updated), 0) AS tup_updated,
    coalesce(sum(tup_deleted), 0) AS tup_deleted,
    coalesce(sum(deadlocks), 0) AS deadlocks,
    coalesce(sum(temp_files), 0) AS temp_files,
    coalesce(sum(temp_bytes), 0) AS temp_bytes
  FROM pg_stat_database
), activity_stats AS (
  SELECT
    coalesce(sum(CASE WHEN state IS NOT NULL THEN 1 ELSE 0 END), 0) AS connections,
    coalesce(sum(CASE WHEN state = 'active' THEN 1 ELSE 0 END), 0) AS active_connections,
    coalesce(sum(CASE WHEN state = 'idle' THEN 1 ELSE 0 END), 0) AS idle_connections,
    coalesce(sum(CASE WHEN state = 'idle in transaction' THEN 1 ELSE 0 END), 0) AS idle_in_tx_connections
  FROM pg_stat_activity
  WHERE pid <> pg_backend_pid()
)
SELECT
  db_stats.*,
  activity_stats.*,
  coalesce(CASE WHEN pg_is_in_recovery()
    THEN pg_wal_lsn_diff(pg_last_wal_replay_lsn(), '0/0')
    ELSE pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')
  END, 0) AS wal_bytes,
  floor(extract(epoch FROM (now() - pg_postmaster_start_time())))::bigint AS uptime_seconds,
  current_setting('max_connections') AS max_connections,
  current_setting('server_version') AS server_version
FROM db_stats, activity_stats`;

export const PG_STATUS_LEGACY_SQL = PG_STATUS_SQL
  .replace(/\bpg_current_wal_lsn\b/g, 'pg_current_xlog_location')
  .replace(/\bpg_last_wal_replay_lsn\b/g, 'pg_last_xlog_replay_location')
  .replace(/\bpg_wal_lsn_diff\b/g, 'pg_xlog_location_diff');

export const PG_VARIABLES_SQL = `SELECT name, setting AS value, short_desc AS description
FROM pg_settings
ORDER BY name`;

export const PG_PROCESS_LIST_SQL = `SELECT pid,
       usename AS "user",
       datname AS db,
       coalesce(host(client_addr), client_hostname, 'local') AS client,
       application_name AS app,
       state,
       coalesce(nullif(wait_event_type, '') || ':' || wait_event, wait_event_type, '') AS wait,
       floor(extract(epoch FROM (now() - coalesce(query_start, xact_start, backend_start))))::bigint AS time,
       query
FROM pg_stat_activity
ORDER BY time DESC NULLS LAST`;

export const PG_PROCESS_LIST_LEGACY_SQL = `SELECT pid,
       usename AS "user",
       datname AS db,
       coalesce(host(client_addr), client_hostname, 'local') AS client,
       application_name AS app,
       state,
       CASE WHEN waiting THEN 'Lock' ELSE '' END AS wait,
       floor(extract(epoch FROM (now() - coalesce(query_start, xact_start, backend_start))))::bigint AS time,
       query
FROM pg_stat_activity
ORDER BY time DESC NULLS LAST`;

export const PG_OWN_SESSION_SQL = 'SELECT pg_backend_pid() AS session_id';

export const MSSQL_STATUS_SQL = `SELECT
  DATEDIFF(SECOND, si.sqlserver_start_time, GETDATE()) AS uptime_seconds,
  (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1) AS total_connections,
  (SELECT COUNT(*) FROM sys.dm_exec_requests WHERE session_id <> @@SPID) AS active_connections,
  (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1 AND status = 'sleeping') AS idle_connections,
  ISNULL((SELECT TOP 1 cntr_value FROM sys.dm_os_performance_counters WHERE counter_name = 'Batch Requests/sec'), 0) AS batch_requests,
  ISNULL((SELECT TOP 1 cntr_value FROM sys.dm_os_performance_counters WHERE counter_name = 'Buffer cache hit ratio'), 0) AS buffer_hit_ratio_num,
  ISNULL((SELECT TOP 1 cntr_value FROM sys.dm_os_performance_counters WHERE counter_name = 'Buffer cache hit ratio base'), 0) AS buffer_hit_ratio_base,
  ISNULL((SELECT TOP 1 cntr_value FROM sys.dm_os_performance_counters WHERE counter_name = 'Number of Deadlocks/sec' AND instance_name = '_Total'), 0) AS deadlocks,
  CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(128)) AS server_version
FROM sys.dm_os_sys_info si`;

export const MSSQL_VARIABLES_SQL = `SELECT
  name,
  CAST(value_in_use AS NVARCHAR(256)) AS value,
  description
FROM sys.configurations
ORDER BY name`;

export const MSSQL_PROCESS_LIST_SQL = `SELECT
  s.session_id AS id,
  s.login_name AS [user],
  ISNULL(c.client_net_address, '') AS host,
  DB_NAME(ISNULL(r.database_id, s.database_id)) AS db,
  ISNULL(r.command, s.status) AS command,
  ISNULL(r.status, s.status) AS state,
  ISNULL(r.wait_type, '') AS wait,
  CASE WHEN r.start_time IS NOT NULL THEN DATEDIFF(SECOND, r.start_time, GETDATE()) ELSE DATEDIFF(SECOND, s.last_request_start_time, GETDATE()) END AS time,
  ISNULL(t.text, '') AS query
FROM sys.dm_exec_sessions s
LEFT JOIN sys.dm_exec_requests r ON s.session_id = r.session_id
LEFT JOIN sys.dm_exec_connections c ON s.session_id = c.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE s.is_user_process = 1
ORDER BY time DESC`;

export const MSSQL_OWN_SESSION_SQL = 'SELECT @@SPID AS session_id';

export const CLICKHOUSE_STATUS_SQL = `SELECT metric AS name, toString(value) AS value, 'metric' AS kind
FROM system.metrics
WHERE metric IN ('Query', 'Merge', 'TCPConnection', 'HTTPConnection', 'MySQLConnection', 'MemoryTracking', 'BackgroundPoolTask', 'Read', 'Write')
UNION ALL
SELECT event AS name, toString(value) AS value, 'event' AS kind
FROM system.events
WHERE event IN ('Query', 'SelectQuery', 'InsertQuery', 'FailedQuery', 'NetworkReceiveBytes', 'NetworkSendBytes', 'MarkCacheHits', 'MarkCacheMisses')
UNION ALL
SELECT 'Uptime' AS name, toString(uptime()) AS value, 'system' AS kind
UNION ALL
SELECT 'Version' AS name, version() AS value, 'system' AS kind`;

export const CLICKHOUSE_VARIABLES_SQL = `SELECT name, value, description
FROM system.settings
ORDER BY name`;

export const CLICKHOUSE_PROCESS_LIST_SQL = `SELECT
  query_id AS id,
  user,
  address AS host,
  current_database AS db,
  'Query' AS command,
  if(is_cancelled, 'Cancelling', 'Running') AS state,
  round(elapsed) AS time,
  query
FROM system.processes
ORDER BY elapsed DESC`;

export const CLICKHOUSE_OWN_SESSION_SQL = "SELECT currentUser() AS session_id";

/* ============================================================================
 * Engine Profile Resolution
 * ============================================================================ */

const MYSQL_MONITOR_ENGINES = new Set<string>([
  'mysql',
  'mariadb',
  'tidb',
  'oceanbase',
  'polardb',
  'tdsql',
  'greatsql',
  'dolt',
  'custom_mysql',
]);

const POSTGRES_MONITOR_ENGINES = new Set<string>([
  'postgres',
  'postgresql',
  'opengauss',
  'gaussdb',
  'kingbase',
  'highgo',
  'vastbase',
  'uxdb',
  'cockroachdb',
  'redshift',
  'cloudberry',
  'opentenbase',
  'custom_postgres',
]);

export function resolveMonitorDialect(engine: string): MonitorDialect | null {
  const normalized = engine.trim().toLowerCase();
  if (MYSQL_MONITOR_ENGINES.has(normalized)) return 'mysql';
  if (POSTGRES_MONITOR_ENGINES.has(normalized)) return 'postgres';
  if (normalized === 'sqlserver' || normalized === 'mssql') return 'mssql';
  if (normalized === 'clickhouse') return 'clickhouse';
  return null;
}

export function resolveMonitorProfile(engine: string): ServerMonitorSqlProfile | null {
  const dialect = resolveMonitorDialect(engine);
  if (!dialect) return null;

  if (dialect === 'mysql') {
    return {
      dialect: 'mysql',
      supportsDashboard: true,
      supportsProcessList: true,
      supportsCancelQuery: true,
      supportsTerminateSession: true,
      statusSql: MYSQL_GLOBAL_STATUS_SQL,
      variablesSql: MYSQL_GLOBAL_VARIABLES_SQL,
      processListSql: MYSQL_PROCESS_LIST_SQL,
      ownSessionSql: MYSQL_OWN_SESSION_SQL,
      qpsLabel: 'QPS',
      cacheLabel: 'InnoDB Buffer Hit',
    };
  }

  if (dialect === 'postgres') {
    return {
      dialect: 'postgres',
      supportsDashboard: true,
      supportsProcessList: true,
      supportsCancelQuery: true,
      supportsTerminateSession: true,
      statusSql: PG_STATUS_SQL,
      fallbackStatusSql: PG_STATUS_LEGACY_SQL,
      variablesSql: PG_VARIABLES_SQL,
      processListSql: PG_PROCESS_LIST_SQL,
      fallbackProcessListSql: PG_PROCESS_LIST_LEGACY_SQL,
      ownSessionSql: PG_OWN_SESSION_SQL,
      qpsLabel: 'TPS',
      cacheLabel: 'Shared Buffer Hit',
    };
  }

  if (dialect === 'mssql') {
    return {
      dialect: 'mssql',
      supportsDashboard: true,
      supportsProcessList: true,
      supportsCancelQuery: false,
      supportsTerminateSession: true,
      statusSql: MSSQL_STATUS_SQL,
      variablesSql: MSSQL_VARIABLES_SQL,
      processListSql: MSSQL_PROCESS_LIST_SQL,
      ownSessionSql: MSSQL_OWN_SESSION_SQL,
      qpsLabel: 'Batch Req/s',
      cacheLabel: 'Buffer Cache Hit',
    };
  }

  return {
    dialect: 'clickhouse',
    supportsDashboard: true,
    supportsProcessList: true,
    supportsCancelQuery: true,
    supportsTerminateSession: false,
    statusSql: CLICKHOUSE_STATUS_SQL,
    variablesSql: CLICKHOUSE_VARIABLES_SQL,
    processListSql: CLICKHOUSE_PROCESS_LIST_SQL,
    ownSessionSql: CLICKHOUSE_OWN_SESSION_SQL,
    qpsLabel: 'QPS',
    cacheLabel: 'Mark Cache Hit',
  };
}

/* ============================================================================
 * Metric & Rate Math + Formatters
 * ============================================================================ */

export function statusNumber(status: StatusMap, key: string): number {
  const raw = status[key];
  if (raw === undefined || raw === '') return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function computeRate(prev: StatusSample, curr: StatusSample, key: string): number {
  const dtSeconds = (curr.at - prev.at) / 1000;
  if (dtSeconds <= 0) return 0;
  const delta = statusNumber(curr.status, key) - statusNumber(prev.status, key);
  if (delta < 0) return 0;
  return delta / dtSeconds;
}

export function clampRefreshInterval(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_REFRESH_SECONDS;
  const floored = Math.floor(seconds);
  if (floored < MIN_REFRESH_SECONDS) return MIN_REFRESH_SECONDS;
  if (floored > MAX_REFRESH_SECONDS) return MAX_REFRESH_SECONDS;
  return floored;
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Math.round(value).toLocaleString('en-US');
}

const RATE_FORMATTER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export function formatRate(value: number): string {
  return Number.isFinite(value) ? RATE_FORMATTER.format(value) : '0';
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), BYTE_UNITS.length - 1);
  const scaled = value / 1024 ** exponent;
  return `${scaled.toFixed(exponent === 0 ? 0 : 1)} ${BYTE_UNITS[exponent]}`;
}

export function formatBytesPerSec(value: number): string {
  return `${formatBytes(value)}/s`;
}

export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

export function computeInnodbBufferHitRatio(status: StatusMap): number | null {
  const requests = statusNumber(status, 'Innodb_buffer_pool_read_requests');
  if (requests <= 0) return null;
  const reads = statusNumber(status, 'Innodb_buffer_pool_reads');
  const ratio = (1 - reads / requests) * 100;
  if (!Number.isFinite(ratio)) return null;
  return Math.max(0, Math.min(100, ratio));
}

export function computePgCacheHitRatio(status: StatusMap): number | null {
  const hits = statusNumber(status, 'blks_hit');
  const reads = statusNumber(status, 'blks_read');
  const total = hits + reads;
  if (total <= 0) return null;
  const ratio = (hits / total) * 100;
  if (!Number.isFinite(ratio)) return null;
  return Math.max(0, Math.min(100, ratio));
}

export function computeClickHouseMarkCacheHitRatio(status: StatusMap): number | null {
  const hits = statusNumber(status, 'MarkCacheHits');
  const misses = statusNumber(status, 'MarkCacheMisses');
  const total = hits + misses;
  if (total <= 0) return null;
  return Math.max(0, Math.min(100, (hits / total) * 100));
}

export function computeMssqlBufferHitRatio(status: StatusMap): number | null {
  const base = statusNumber(status, 'buffer_hit_ratio_base');
  if (base <= 0) return null;
  const num = statusNumber(status, 'buffer_hit_ratio_num');
  return Math.max(0, Math.min(100, (num / base) * 100));
}

/* ============================================================================
 * Result Set Parsers
 * ============================================================================ */

function colIndex(result: QueryResultSet, ...candidates: string[]): number {
  const set = new Set(candidates.map((c) => c.toLowerCase()));
  return result.columns.findIndex((c) => set.has(c.name.toLowerCase()));
}

function cellStr(value: CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function cellNum(value: CellValue | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Parse a 2-column (Variable_name/Value or name/value) result set into a StatusMap. */
export function parseKeyValueStatusResult(result: QueryResultSet | null | undefined): StatusMap {
  const map: StatusMap = {};
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) return map;
  const nameIdx = colIndex(result, 'variable_name', 'name', 'metric', 'key');
  const valueIdx = colIndex(result, 'value', 'setting');
  const nCol = nameIdx >= 0 ? nameIdx : 0;
  const vCol = valueIdx >= 0 ? valueIdx : 1;
  for (const row of result.rows) {
    const k = cellStr(row[nCol]).trim();
    if (!k) continue;
    map[k] = cellStr(row[vCol]);
  }
  return map;
}

/** Parse a single-row wide aggregate result set (PG/MSSQL) into a StatusMap. */
export function parseSingleRowStatusResult(result: QueryResultSet | null | undefined): StatusMap {
  const map: StatusMap = {};
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows) || result.rows.length === 0) {
    return map;
  }
  const row = result.rows[0];
  result.columns.forEach((col, idx) => {
    map[col.name.toLowerCase()] = cellStr(row[idx]);
  });
  return map;
}

export function parseStatusMapForDialect(
  dialect: MonitorDialect,
  result: QueryResultSet | null | undefined,
): StatusMap {
  if (dialect === 'mysql' || dialect === 'clickhouse') {
    return parseKeyValueStatusResult(result);
  }
  return parseSingleRowStatusResult(result);
}

export function parseServerVariablesResult(
  result: QueryResultSet | null | undefined,
): ServerVariableEntry[] {
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) return [];
  const nameIdx = colIndex(result, 'variable_name', 'name');
  const valueIdx = colIndex(result, 'value', 'setting');
  const descIdx = colIndex(result, 'description', 'short_desc');
  const nCol = nameIdx >= 0 ? nameIdx : 0;
  const vCol = valueIdx >= 0 ? valueIdx : 1;

  const entries: ServerVariableEntry[] = [];
  for (const row of result.rows) {
    const name = cellStr(row[nCol]).trim();
    if (!name) continue;
    entries.push({
      name,
      value: cellStr(row[vCol]),
      description: descIdx >= 0 ? cellStr(row[descIdx]) || undefined : undefined,
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function computeServerDeltaMetrics(
  dialect: MonitorDialect,
  prev: StatusSample | null,
  curr: StatusSample,
): ServerDeltaMetrics {
  if (!prev) {
    return { qpsOrTps: 0, bytesInPerSec: 0, bytesOutPerSec: 0 };
  }

  if (dialect === 'mysql') {
    const qpsKey = curr.status.Queries !== undefined ? 'Queries' : 'Questions';
    return {
      qpsOrTps: computeRate(prev, curr, qpsKey),
      bytesInPerSec: computeRate(prev, curr, 'Bytes_received'),
      bytesOutPerSec: computeRate(prev, curr, 'Bytes_sent'),
      selectPerSec: computeRate(prev, curr, 'Com_select'),
      insertPerSec: computeRate(prev, curr, 'Com_insert'),
      updatePerSec: computeRate(prev, curr, 'Com_update'),
      deletePerSec: computeRate(prev, curr, 'Com_delete'),
    };
  }

  if (dialect === 'postgres') {
    const tps = computeRate(prev, curr, 'xact_commit') + computeRate(prev, curr, 'xact_rollback');
    const walRate = computeRate(prev, curr, 'wal_bytes');
    const tupModified =
      computeRate(prev, curr, 'tup_inserted') +
      computeRate(prev, curr, 'tup_updated') +
      computeRate(prev, curr, 'tup_deleted');
    return {
      qpsOrTps: tps,
      bytesInPerSec: walRate,
      bytesOutPerSec: 0,
      walBytesPerSec: walRate,
      tuplesReturnedPerSec: computeRate(prev, curr, 'tup_returned'),
      tuplesModifiedPerSec: tupModified,
    };
  }

  if (dialect === 'mssql') {
    return {
      qpsOrTps: computeRate(prev, curr, 'batch_requests'),
      bytesInPerSec: 0,
      bytesOutPerSec: 0,
    };
  }

  // ClickHouse
  return {
    qpsOrTps: computeRate(prev, curr, 'Query'),
    bytesInPerSec: computeRate(prev, curr, 'NetworkReceiveBytes'),
    bytesOutPerSec: computeRate(prev, curr, 'NetworkSendBytes'),
    selectPerSec: computeRate(prev, curr, 'SelectQuery'),
    insertPerSec: computeRate(prev, curr, 'InsertQuery'),
  };
}

export function buildServerStatusSnapshot(options: {
  engine: DatabaseEngineId;
  dialect: MonitorDialect;
  status: StatusMap;
  variables?: ServerVariableEntry[];
  delta?: ServerDeltaMetrics;
  timestamp?: number;
}): ServerStatusSnapshot {
  const { engine, dialect, status, variables = [], delta, timestamp = Date.now() } = options;
  const metrics: ServerStatusMetric[] = [];

  if (dialect === 'mysql') {
    const uptimeSeconds = statusNumber(status, 'Uptime');
    const activeConnections = statusNumber(status, 'Threads_running');
    const totalConnections = statusNumber(status, 'Threads_connected');
    const idleConnections = Math.max(0, totalConnections - activeConnections);
    const cacheHitRatio = computeInnodbBufferHitRatio(status) ?? undefined;
    const slowQueries = statusNumber(status, 'Slow_queries');
    const bytesIn = statusNumber(status, 'Bytes_received');
    const bytesOut = statusNumber(status, 'Bytes_sent');

    metrics.push(
      { key: 'Threads_connected', label: 'Threads Connected', value: formatNumber(totalConnections), group: 'Connections' },
      { key: 'Threads_running', label: 'Threads Running', value: formatNumber(activeConnections), group: 'Connections' },
      { key: 'Max_used_connections', label: 'Max Used Connections', value: formatNumber(statusNumber(status, 'Max_used_connections')), group: 'Connections' },
      { key: 'Aborted_connects', label: 'Aborted Connects', value: formatNumber(statusNumber(status, 'Aborted_connects')), group: 'Connections' },
      { key: 'Queries', label: 'Total Queries', value: formatNumber(statusNumber(status, 'Queries') || statusNumber(status, 'Questions')), group: 'Throughput' },
      { key: 'Slow_queries', label: 'Slow Queries', value: formatNumber(slowQueries), group: 'Throughput' },
      { key: 'Com_select', label: 'SELECTs', value: formatNumber(statusNumber(status, 'Com_select')), group: 'Commands' },
      { key: 'Com_insert', label: 'INSERTs', value: formatNumber(statusNumber(status, 'Com_insert')), group: 'Commands' },
      { key: 'Com_update', label: 'UPDATEs', value: formatNumber(statusNumber(status, 'Com_update')), group: 'Commands' },
      { key: 'Com_delete', label: 'DELETEs', value: formatNumber(statusNumber(status, 'Com_delete')), group: 'Commands' },
      { key: 'Bytes_received', label: 'Traffic In', value: formatBytes(bytesIn), group: 'Network' },
      { key: 'Bytes_sent', label: 'Traffic Out', value: formatBytes(bytesOut), group: 'Network' },
      { key: 'Open_tables', label: 'Open Tables', value: formatNumber(statusNumber(status, 'Open_tables')), group: 'Storage' },
    );
    if (cacheHitRatio !== undefined) {
      metrics.push({ key: 'innodb_hit_ratio', label: 'InnoDB Buffer Hit', value: `${cacheHitRatio.toFixed(2)}%`, group: 'Storage' });
    }

    return {
      engine,
      timestamp,
      uptimeSeconds,
      activeConnections,
      idleConnections,
      totalConnections,
      qpsOrTps: delta?.qpsOrTps ?? 0,
      cacheHitRatio,
      slowQueries,
      bytesIn,
      bytesOut,
      metrics,
      variables,
    };
  }

  if (dialect === 'postgres') {
    const uptimeSeconds = statusNumber(status, 'uptime_seconds');
    const activeConnections = statusNumber(status, 'active_connections');
    const idleConnections = statusNumber(status, 'idle_connections');
    const totalConnections = statusNumber(status, 'connections');
    const cacheHitRatio = computePgCacheHitRatio(status) ?? undefined;
    const deadlocks = statusNumber(status, 'deadlocks');
    const walBytes = statusNumber(status, 'wal_bytes');

    metrics.push(
      { key: 'connections', label: 'Total Connections', value: formatNumber(totalConnections), group: 'Connections' },
      { key: 'active_connections', label: 'Active Backends', value: formatNumber(activeConnections), group: 'Connections' },
      { key: 'idle_connections', label: 'Idle Backends', value: formatNumber(idleConnections), group: 'Connections' },
      { key: 'max_connections', label: 'Max Connections', value: status.max_connections || '-', group: 'Connections' },
      { key: 'xact_commit', label: 'Commits', value: formatNumber(statusNumber(status, 'xact_commit')), group: 'Transactions' },
      { key: 'xact_rollback', label: 'Rollbacks', value: formatNumber(statusNumber(status, 'xact_rollback')), group: 'Transactions' },
      { key: 'deadlocks', label: 'Deadlocks', value: formatNumber(deadlocks), group: 'Transactions' },
      { key: 'tup_returned', label: 'Tuples Returned', value: formatNumber(statusNumber(status, 'tup_returned')), group: 'Tuples' },
      { key: 'tup_fetched', label: 'Tuples Fetched', value: formatNumber(statusNumber(status, 'tup_fetched')), group: 'Tuples' },
      { key: 'tup_inserted', label: 'Tuples Inserted', value: formatNumber(statusNumber(status, 'tup_inserted')), group: 'Tuples' },
      { key: 'tup_updated', label: 'Tuples Updated', value: formatNumber(statusNumber(status, 'tup_updated')), group: 'Tuples' },
      { key: 'tup_deleted', label: 'Tuples Deleted', value: formatNumber(statusNumber(status, 'tup_deleted')), group: 'Tuples' },
      { key: 'wal_bytes', label: 'WAL Position', value: formatBytes(walBytes), group: 'Storage' },
      { key: 'temp_files', label: 'Temp Files', value: formatNumber(statusNumber(status, 'temp_files')), group: 'Storage' },
    );
    if (cacheHitRatio !== undefined) {
      metrics.push({ key: 'cache_hit_ratio', label: 'Shared Buffer Hit', value: `${cacheHitRatio.toFixed(2)}%`, group: 'Storage' });
    }

    return {
      engine,
      timestamp,
      uptimeSeconds,
      activeConnections,
      idleConnections,
      totalConnections,
      qpsOrTps: delta?.qpsOrTps ?? 0,
      cacheHitRatio,
      deadlocks,
      bytesIn: walBytes,
      metrics,
      variables,
    };
  }

  if (dialect === 'mssql') {
    const uptimeSeconds = statusNumber(status, 'uptime_seconds');
    const activeConnections = statusNumber(status, 'active_connections');
    const idleConnections = statusNumber(status, 'idle_connections');
    const totalConnections = statusNumber(status, 'total_connections');
    const cacheHitRatio = computeMssqlBufferHitRatio(status) ?? undefined;
    const deadlocks = statusNumber(status, 'deadlocks');

    metrics.push(
      { key: 'total_connections', label: 'User Sessions', value: formatNumber(totalConnections), group: 'Connections' },
      { key: 'active_connections', label: 'Active Requests', value: formatNumber(activeConnections), group: 'Connections' },
      { key: 'idle_connections', label: 'Sleeping Sessions', value: formatNumber(idleConnections), group: 'Connections' },
      { key: 'batch_requests', label: 'Batch Requests', value: formatNumber(statusNumber(status, 'batch_requests')), group: 'Throughput' },
      { key: 'deadlocks', label: 'Deadlocks', value: formatNumber(deadlocks), group: 'Transactions' },
    );
    if (cacheHitRatio !== undefined) {
      metrics.push({ key: 'buffer_hit_ratio', label: 'Buffer Cache Hit', value: `${cacheHitRatio.toFixed(2)}%`, group: 'Storage' });
    }

    return {
      engine,
      timestamp,
      uptimeSeconds,
      activeConnections,
      idleConnections,
      totalConnections,
      qpsOrTps: delta?.qpsOrTps ?? 0,
      cacheHitRatio,
      deadlocks,
      metrics,
      variables,
    };
  }

  // ClickHouse
  const uptimeSeconds = statusNumber(status, 'Uptime');
  const activeConnections = statusNumber(status, 'Query');
  const totalConnections =
    statusNumber(status, 'TCPConnection') +
    statusNumber(status, 'HTTPConnection') +
    statusNumber(status, 'MySQLConnection');
  const cacheHitRatio = computeClickHouseMarkCacheHitRatio(status) ?? undefined;
  const bytesIn = statusNumber(status, 'NetworkReceiveBytes');
  const bytesOut = statusNumber(status, 'NetworkSendBytes');

  metrics.push(
    { key: 'Query', label: 'Running Queries', value: formatNumber(activeConnections), group: 'Throughput' },
    { key: 'Merge', label: 'Active Merges', value: formatNumber(statusNumber(status, 'Merge')), group: 'Storage' },
    { key: 'TCPConnection', label: 'TCP Connections', value: formatNumber(statusNumber(status, 'TCPConnection')), group: 'Connections' },
    { key: 'HTTPConnection', label: 'HTTP Connections', value: formatNumber(statusNumber(status, 'HTTPConnection')), group: 'Connections' },
    { key: 'MemoryTracking', label: 'Memory Tracked', value: formatBytes(statusNumber(status, 'MemoryTracking')), group: 'Storage' },
    { key: 'SelectQuery', label: 'SELECT Queries', value: formatNumber(statusNumber(status, 'SelectQuery')), group: 'Throughput' },
    { key: 'InsertQuery', label: 'INSERT Queries', value: formatNumber(statusNumber(status, 'InsertQuery')), group: 'Throughput' },
    { key: 'FailedQuery', label: 'Failed Queries', value: formatNumber(statusNumber(status, 'FailedQuery')), group: 'Throughput' },
    { key: 'NetworkReceiveBytes', label: 'Network In', value: formatBytes(bytesIn), group: 'Network' },
    { key: 'NetworkSendBytes', label: 'Network Out', value: formatBytes(bytesOut), group: 'Network' },
  );

  return {
    engine,
    timestamp,
    uptimeSeconds,
    activeConnections,
    totalConnections,
    qpsOrTps: delta?.qpsOrTps ?? 0,
    cacheHitRatio,
    bytesIn,
    bytesOut,
    metrics,
    variables,
  };
}

/* ============================================================================
 * Processlist Parser & Cancel/Kill SQL Builders
 * ============================================================================ */

export function parseProcessListResult(
  dialect: MonitorDialect,
  result: QueryResultSet | null | undefined,
  ownSessionId?: string | number | null,
): ProcessEntry[] {
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) return [];
  const idIdx = colIndex(result, 'id', 'pid', 'query_id', 'session_id');
  const userIdx = colIndex(result, 'user', 'usename', 'login_name');
  const hostIdx = colIndex(result, 'host', 'client', 'address');
  const dbIdx = colIndex(result, 'db', 'datname', 'current_database', 'database');
  const cmdIdx = colIndex(result, 'command', 'app', 'application_name');
  const stateIdx = colIndex(result, 'state', 'status');
  const waitIdx = colIndex(result, 'wait', 'wait_type');
  const timeIdx = colIndex(result, 'time', 'elapsed', 'duration');
  const sqlIdx = colIndex(result, 'info', 'query', 'sql');

  const ownStr = ownSessionId !== undefined && ownSessionId !== null ? String(ownSessionId) : '';

  return result.rows
    .map((row): ProcessEntry => {
      const id = cellStr(idIdx >= 0 ? row[idIdx] : row[0]);
      const state = stateIdx >= 0 ? cellStr(row[stateIdx]) || undefined : undefined;
      const command = cmdIdx >= 0 ? cellStr(row[cmdIdx]) || undefined : dialect === 'postgres' ? state : undefined;
      return {
        id,
        user: userIdx >= 0 ? cellStr(row[userIdx]) : '',
        host: hostIdx >= 0 ? cellStr(row[hostIdx]) || undefined : undefined,
        database: dbIdx >= 0 ? cellStr(row[dbIdx]) || undefined : undefined,
        command,
        state,
        waitEvent: waitIdx >= 0 ? cellStr(row[waitIdx]) || undefined : undefined,
        durationSec: timeIdx >= 0 ? Math.max(0, cellNum(row[timeIdx])) : 0,
        sql: sqlIdx >= 0 ? cellStr(row[sqlIdx]) || undefined : undefined,
        isCurrentSession: ownStr !== '' && id === ownStr,
      };
    })
    .filter((entry) => entry.id !== '');
}

function assertPositiveIntId(raw: string | number, label: string): number {
  const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(`Invalid ${label}: ${String(raw)}`);
  }
  return num;
}

function escapeSqlSingleQuote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/**
 * Build a validated SQL statement to cancel a running query without closing the session.
 */
export function buildCancelQuerySql(dialect: MonitorDialect, processId: string | number): string {
  if (dialect === 'mysql') {
    const id = assertPositiveIntId(processId, 'MySQL thread id');
    return `KILL QUERY ${id}`;
  }
  if (dialect === 'postgres') {
    const pid = assertPositiveIntId(processId, 'PostgreSQL backend pid');
    return `SELECT pg_cancel_backend(${pid})`;
  }
  if (dialect === 'clickhouse') {
    const qid = String(processId).trim();
    if (!qid || /[\r\n\0]/.test(qid)) {
      throw new Error(`Invalid ClickHouse query_id: ${String(processId)}`);
    }
    return `KILL QUERY WHERE query_id = ${escapeSqlSingleQuote(qid)} SYNC`;
  }
  // MSSQL has no separate query-only cancel over SQL; KILL terminates the session.
  const spid = assertPositiveIntId(processId, 'SQL Server session id');
  return `KILL ${spid}`;
}

/**
 * Build a validated SQL statement to terminate/disconnect an entire session.
 */
export function buildTerminateSessionSql(dialect: MonitorDialect, processId: string | number): string {
  if (dialect === 'mysql') {
    const id = assertPositiveIntId(processId, 'MySQL thread id');
    return `KILL ${id}`;
  }
  if (dialect === 'postgres') {
    const pid = assertPositiveIntId(processId, 'PostgreSQL backend pid');
    return `SELECT pg_terminate_backend(${pid})`;
  }
  if (dialect === 'mssql') {
    const spid = assertPositiveIntId(processId, 'SQL Server session id');
    return `KILL ${spid}`;
  }
  // ClickHouse terminates active queries by query_id
  return buildCancelQuerySql('clickhouse', processId);
}

export function isPgLegacyStatusError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /(?:pg_current_wal_lsn|pg_last_wal_replay_lsn|pg_wal_lsn_diff)/i.test(msg) && /does not exist/i.test(msg);
}

export function isPgLegacyProcessListError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /(?:wait_event_type|wait_event)/i.test(msg) && /(?:does not exist|42703)/i.test(msg);
}

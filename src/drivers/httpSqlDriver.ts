/**
 * Pure-TS Browser-Sandbox HTTP/REST SQL Driver (`family: 'http_sql'`).
 * Supports:
 * - trino & prestosql (/v1/statement polling, X-Trino-* / X-Presto-*, DELETE cancel)
 * - tdengine (/rest/sql/{db}, Basic Auth, v2 head/data & v3 column_meta/data)
 * - databend (/v1/query polling, Basic Auth, X-DATABEND-DATABASE)
 * - rqlite (/db/query & /db/execute, SQLite metadata)
 * - turso (/v2/pipeline Hrana HTTP, Bearer auth, SQLite metadata)
 * - influxdb (v1 /query InfluxQL & v2 /api/v2/buckets + /api/v2/query Flux CSV)
 * - influxdb3 (/api/v3/query_sql SQL JSON, Bearer auth)
 * - victoriametrics (PromQL HTTP /api/v1/query normalized to tabular rows)
 * - cloudflare-d1 (Cloudflare D1 REST v4 /client/v4/accounts/{accountId}/d1/database/{dbId}/query)
 * - iotdb (Apache IoTDB REST v2 /rest/v2/query & /rest/v2/nonQuery, Basic Auth)
 * - kylin (Apache Kylin REST /kylin/api/{projects,tables,query}, Basic Auth)
 * - databricks (Databricks SQL Statement Execution API /api/2.0/sql/statements, Bearer PAT + polling)
 * - snowflake (Snowflake SQL REST API v2 /api/v2/statements, Bearer OAuth/PAT + polling)
 * - bigquery (Google BigQuery REST API v2 /bigquery/v2/projects/{project}/{datasets,queries}, OAuth Bearer)
 * - salesforce (Salesforce SOQL REST /services/data/v61.0/{sobjects,query}, Bearer token)
 *
 * 100% browser-sandbox compatible (no Node imports, no dynamic code execution).
 */

import {
  buildEndpointUrl,
  decodeResponseJson,
  decodeResponseText,
  encodeBasicAuth,
  resolveHttpTls,
  sendHttpRequest,
  type HttpEndpointConfig,
} from './httpClient';
import {
  buildAlterTableDdl,
  buildBatchMutations,
  buildCreateTableDdl,
  buildDropObjectSql,
  buildTruncateTableSql,
  qualifiedTableName,
  quoteIdent,
} from './sqlDialect';
import {
  base64ToBytes,
  QueryError,
  type BatchMutationApplyResult,
  type BatchMutationChanges,
  type BatchMutationPreview,
  type BrowseTableOptions,
  type BrowseTableResult,
  type ByteStreamTransport,
  type CellValue,
  type ColumnMeta,
  type ColumnStructure,
  type ConnectionConfig,
  type ConnectionInfo,
  type CreateTableSpec,
  type DatabaseEngineId,
  type DatabaseInfo,
  type DropObjectKind,
  type ExplainNode,
  type ExplainResult,
  type ForeignKeyStructure,
  type IndexStructure,
  type MultiQueryResult,
  type QueryOptions,
  type QueryResultSet,
  type RelationalDriver,
  type RoutineSummary,
  type SchemaDiffResult,
  type SchemaErEdge,
  type SchemaErGraph,
  type SchemaInfo,
  type SchemaSnapshot,
  type SqlDialect,
  type TableStructure,
  type TableStructureDiff,
  type TableSummary,
  type TestConnectionResult,
  type TriggerSummary,
  type ViewSummary,
} from './types';
import { parseSqliteExplainQueryPlan } from '../sql/explainParser';
import { diffSchemas as runSchemaDiff, generateSqlDump } from '../sql/schemaDiff';
import { splitSqlStatements } from '../sql/splitter';

export type HttpSqlEngineId =
  | 'trino'
  | 'prestosql'
  | 'tdengine'
  | 'databend'
  | 'rqlite'
  | 'turso'
  | 'influxdb'
  | 'influxdb3'
  | 'victoriametrics'
  | 'cloudflare-d1'
  | 'iotdb'
  | 'kylin'
  | 'databricks'
  | 'snowflake'
  | 'bigquery'
  | 'salesforce';

const DEFAULT_PORTS: Record<HttpSqlEngineId, number> = {
  trino: 8080,
  prestosql: 8080,
  tdengine: 6041,
  databend: 8000,
  rqlite: 4001,
  turso: 8080,
  influxdb: 8086,
  influxdb3: 8181,
  victoriametrics: 8428,
  'cloudflare-d1': 443,
  iotdb: 18080,
  kylin: 7070,
  databricks: 443,
  snowflake: 443,
  bigquery: 443,
  salesforce: 443,
};

const TDENGINE_TYPE_CODES: Record<number, string> = {
  1: 'BOOL',
  2: 'TINYINT',
  3: 'SMALLINT',
  4: 'INT',
  5: 'BIGINT',
  6: 'FLOAT',
  7: 'DOUBLE',
  8: 'VARCHAR',
  9: 'TIMESTAMP',
  10: 'NCHAR',
  11: 'TINYINT UNSIGNED',
  12: 'SMALLINT UNSIGNED',
  13: 'INT UNSIGNED',
  14: 'BIGINT UNSIGNED',
  15: 'JSON',
  16: 'VARBINARY',
  17: 'DECIMAL',
  18: 'BLOB',
  19: 'MEDIUMBLOB',
  20: 'GEOMETRY',
};

function normalizeHttpSqlEngine(engine: string): HttpSqlEngineId {
  switch (engine) {
    case 'presto':
    case 'prestosql':
      return 'prestosql';
    case 'libsql':
    case 'turso':
      return 'turso';
    case 'trino':
    case 'tdengine':
    case 'databend':
    case 'rqlite':
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
      return engine;
    default:
      throw new Error(`Unsupported HTTP SQL engine: ${engine}`);
  }
}

function dialectForEngine(engine: HttpSqlEngineId): SqlDialect {
  switch (engine) {
    case 'trino':
    case 'prestosql':
    case 'databend':
    case 'kylin':
    case 'databricks':
    case 'snowflake':
    case 'bigquery':
    case 'salesforce':
      return 'trino';
    case 'tdengine':
    case 'iotdb':
      return 'tdengine';
    case 'rqlite':
    case 'turso':
    case 'cloudflare-d1':
      return 'sqlite';
    case 'influxdb':
    case 'influxdb3':
    case 'victoriametrics':
      return 'influx';
  }
}

function stripLeadingComments(sql: string): string {
  return sql
    .replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/g, '')
    .trim();
}

function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '');
}

function isReadSqlStatement(sql: string): boolean {
  const head = stripLeadingComments(sql).toUpperCase();
  return /^(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN|PRAGMA|VALUES)\b/.test(head);
}

function looksLikeFluxQuery(text: string): boolean {
  const trimmed = text.trim();
  return (
    /(^|\n)\s*from\s*\(/i.test(trimmed) ||
    /(^|\n)\s*import\s+"/i.test(trimmed) ||
    trimmed.includes('|>')
  );
}

function escapeSqlString(val: string): string {
  return val.replaceAll("'", "''");
}

function toCellValue(val: unknown): CellValue {
  if (val === undefined || val === null) return null;
  if (
    typeof val === 'string' ||
    typeof val === 'number' ||
    typeof val === 'boolean' ||
    val instanceof Uint8Array
  ) {
    return val;
  }
  if (Array.isArray(val)) return val;
  if (typeof val === 'object') return val as Record<string, unknown>;
  return String(val);
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function coerceFluxCsvValue(raw: string, dataType: string): CellValue {
  if (raw === '') return null;
  const dt = dataType.toLowerCase();
  if (dt === 'long' || dt === 'unsignedlong' || dt === 'double') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (dt === 'boolean') {
    return raw === 'true';
  }
  return raw;
}

/**
 * Parse InfluxDB v2 Flux Annotated CSV response into columns and rows.
 */
export function parseFluxAnnotatedCsv(
  csvText: string,
  maxRows?: number,
): { columns: ColumnMeta[]; rows: CellValue[][]; truncated: boolean } {
  const lines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let datatypes: string[] = [];
  let headers: string[] = [];
  let keepIndices: number[] = [];
  let columns: ColumnMeta[] = [];
  const rows: CellValue[][] = [];
  let truncated = false;
  let expectingHeader = false;

  for (const rawLine of lines) {
    if (rawLine.trim() === '') {
      // Table boundary
      expectingHeader = false;
      continue;
    }
    if (rawLine.startsWith('#datatype,')) {
      datatypes = parseCsvLine(rawLine);
      expectingHeader = true;
      continue;
    }
    if (rawLine.startsWith('#group,') || rawLine.startsWith('#default,')) {
      expectingHeader = true;
      continue;
    }

    const parsed = parseCsvLine(rawLine);
    if (expectingHeader || headers.length === 0) {
      headers = parsed;
      expectingHeader = false;
      // Drop leading annotation empty col (index 0 when header[0] === '') and internal 'result'/'table'
      const nextKeep: number[] = [];
      for (let i = 0; i < headers.length; i++) {
        const name = headers[i];
        if (i === 0 && name === '') continue;
        if (name === 'result' || name === 'table') continue;
        nextKeep.push(i);
      }
      if (nextKeep.length === 0) {
        for (let i = 0; i < headers.length; i++) {
          if (i === 0 && headers[i] === '') continue;
          nextKeep.push(i);
        }
      }
      keepIndices = nextKeep;
      if (columns.length === 0) {
        columns = keepIndices.map((idx) => ({
          name: headers[idx] || `col_${idx}`,
          dataType: datatypes[idx] || 'string',
        }));
      }
      continue;
    }

    if (maxRows && rows.length >= maxRows) {
      truncated = true;
      break;
    }

    const row: CellValue[] = keepIndices.map((idx) => {
      const rawVal = idx < parsed.length ? parsed[idx] : '';
      const dt = idx < datatypes.length ? datatypes[idx] : 'string';
      return coerceFluxCsvValue(rawVal, dt);
    });
    rows.push(row);
  }

  return { columns, rows, truncated };
}

function buildTextExplainResult(dialect: SqlDialect, lines: string[], analyzed: boolean): ExplainResult {
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const children: ExplainNode[] = nonEmpty.map((line, i) => ({
    id: `plan-${i + 1}`,
    nodeType: line.trim().split(/\s+/)[0] || 'Plan',
    detail: line.trim(),
    children: [],
  }));
  const root: ExplainNode =
    children.length === 1
      ? children[0]
      : {
          id: 'plan-0',
          nodeType: `${dialect.toUpperCase()} Plan`,
          children,
        };
  return {
    dialect,
    analyzed,
    root,
    rawText: lines.join('\n'),
  };
}

interface TrinoResponse {
  id?: string;
  infoUri?: string;
  nextUri?: string;
  columns?: Array<{ name: string; type?: string }>;
  data?: unknown[][];
  stats?: { state?: string; processedRows?: number };
  error?: {
    message?: string;
    errorCode?: number;
    errorName?: string;
    failureInfo?: { message?: string };
  };
  updateType?: string;
  updateCount?: number;
}

interface DatabendResponse {
  id?: string;
  schema?: Array<{ name: string; type?: string }>;
  data?: unknown[][];
  state?: string;
  error?: { code?: number; message?: string; detail?: string } | string | null;
  stats?: { write_progress?: { rows?: number } };
  next_uri?: string | null;
  kill_uri?: string | null;
  final_uri?: string | null;
}

interface TdengineResponse {
  status?: string;
  code?: number;
  desc?: string;
  head?: string[];
  column_meta?: Array<[string, string | number, number?]>;
  data?: unknown[][];
  rows?: number;
}

interface RqliteResponse {
  results?: Array<{
    columns?: string[];
    types?: string[];
    values?: unknown[][];
    last_insert_id?: number;
    rows_affected?: number;
    error?: string;
  }>;
}

interface HranaValue {
  type: 'null' | 'integer' | 'float' | 'text' | 'blob';
  value?: string | number | null;
  base64?: string;
}

interface HranaPipelineResponse {
  results?: Array<{
    type: 'ok' | 'error';
    response?: {
      type: string;
      result?: {
        cols?: Array<{ name: string | null; decltype?: string | null }>;
        rows?: HranaValue[][];
        affected_row_count?: number;
        last_insert_rowid?: string | number | null;
      };
    };
    error?: { message?: string; code?: string };
  }>;
}

interface InfluxV1Response {
  error?: string;
  results?: Array<{
    statement_id?: number;
    error?: string;
    series?: Array<{
      name?: string;
      tags?: Record<string, string>;
      columns?: string[];
      values?: unknown[][];
    }>;
  }>;
}

interface PromQlResponse {
  status?: string;
  error?: string;
  errorType?: string;
  data?: {
    resultType?: 'vector' | 'matrix' | 'scalar' | 'string';
    result?: unknown;
  };
}

interface CloudflareD1Response {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: Array<{
    success?: boolean;
    results?: Array<Record<string, unknown>> | { columns?: string[]; rows?: unknown[][] };
    meta?: {
      changes?: number;
      last_row_id?: number;
      rows_read?: number;
      rows_written?: number;
    };
  }>;
}

interface IotdbResponse {
  code?: number;
  message?: string;
  expressions?: string[];
  columnNames?: string[];
  timestamps?: number[];
  values?: unknown[][];
}

interface KylinQueryResponse {
  code?: string;
  msg?: string;
  data?: KylinQueryResponse;
  columnMetas?: Array<{ name?: string; label?: string; columnTypeName?: string }>;
  results?: unknown[][];
  isException?: boolean;
  exceptionMessage?: string;
  affectedRowCount?: number;
}

interface DatabricksStatementResponse {
  statement_id?: string;
  status?: {
    state?: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'CLOSED' | string;
    error?: { error_code?: string; message?: string };
  };
  manifest?: {
    schema?: {
      columns?: Array<{ name: string; type_name?: string; type_text?: string }>;
    };
    total_row_count?: number;
  };
  result?: {
    data_array?: unknown[][];
    next_chunk_internal_link?: string;
  };
}

interface SnowflakeStatementResponse {
  code?: string;
  message?: string;
  sqlState?: string;
  statementHandle?: string;
  statementStatusUrl?: string;
  resultSetMetaData?: {
    numRows?: number;
    rowType?: Array<{ name: string; type?: string; nullable?: boolean }>;
  };
  data?: unknown[][];
}

interface BigQueryQueryResponse {
  jobComplete?: boolean;
  jobReference?: { projectId?: string; jobId?: string; location?: string };
  schema?: { fields?: Array<{ name: string; type?: string; mode?: string }> };
  rows?: Array<{ f?: Array<{ v?: unknown }> }>;
  totalRows?: string;
  numDmlAffectedRows?: string;
  pageToken?: string;
  errors?: Array<{ reason?: string; message?: string }>;
  error?: { code?: number; message?: string };
}

interface SalesforceQueryResponse {
  totalSize?: number;
  done?: boolean;
  nextRecordsUrl?: string;
  records?: Array<Record<string, unknown>>;
}

function coerceSnowflakeCell(val: unknown, typeName?: string): CellValue {
  if (val === null || val === undefined) return null;
  const t = (typeName || '').toLowerCase();
  if (t === 'boolean') {
    if (typeof val === 'boolean') return val;
    return String(val).toLowerCase() === 'true' || val === '1';
  }
  if (t === 'fixed' || t === 'real' || t === 'number' || t === 'float' || t === 'integer') {
    const n = Number(val);
    return Number.isFinite(n) && String(val).trim() !== '' ? n : String(val);
  }
  return toCellValue(val);
}

function coerceBigQueryCell(val: unknown, typeName?: string): CellValue {
  if (val === null || val === undefined) return null;
  const t = (typeName || '').toUpperCase();
  if (t === 'BOOL' || t === 'BOOLEAN') {
    if (typeof val === 'boolean') return val;
    return String(val).toLowerCase() === 'true';
  }
  if (t === 'INTEGER' || t === 'INT64' || t === 'FLOAT' || t === 'FLOAT64' || t === 'NUMERIC' || t === 'BIGNUMERIC') {
    const n = Number(val);
    return Number.isFinite(n) && String(val).trim() !== '' ? n : String(val);
  }
  return toCellValue(val);
}

export class HttpSqlDriver implements RelationalDriver {
  private _engine: HttpSqlEngineId;
  readonly family = 'http_sql' as const;

  private transport: ByteStreamTransport | null = null;
  private config: ConnectionConfig | null = null;
  private endpoint: HttpEndpointConfig | null = null;
  private _connected = false;
  private _inTransaction = false;
  private _serverVersion = '';
  private _tlsActive = false;
  private activeDatabase = '';
  private activeSchema = '';
  private activeCancelUrl: string | null = null;
  private influxVersion: 1 | 2 = 1;

  constructor(engine: DatabaseEngineId = 'trino') {
    this._engine = normalizeHttpSqlEngine(engine);
  }

  get engine(): DatabaseEngineId {
    return this._engine;
  }

  get dialect(): SqlDialect {
    return dialectForEngine(this._engine);
  }

  get connected(): boolean {
    return this._connected;
  }

  get inTransaction(): boolean {
    return this._inTransaction;
  }

  get serverVersion(): string {
    return this._serverVersion;
  }

  private requireConnected(): {
    transport: ByteStreamTransport;
    config: ConnectionConfig;
    endpoint: HttpEndpointConfig;
  } {
    if (!this._connected || !this.transport || !this.config || !this.endpoint) {
      throw new Error(`${this._engine} driver is not connected`);
    }
    return {
      transport: this.transport,
      config: this.config,
      endpoint: this.endpoint,
    };
  }

  private resolveDb(db?: string, schema?: string): string {
    return db || this.activeDatabase || this.config?.database || schema || '';
  }

  private resolveSchema(schema?: string): string {
    return schema || this.activeSchema || this.config?.schema || '';
  }

  async connect(config: ConnectionConfig, transport?: ByteStreamTransport): Promise<ConnectionInfo> {
    if (!transport) {
      throw new Error(`HTTP SQL driver (${config.engine}) requires a ByteStreamTransport`);
    }
    const started = performance.now();
    this._engine = normalizeHttpSqlEngine(config.engine);
    const port = config.port ?? DEFAULT_PORTS[this._engine];
    const tls = resolveHttpTls(config.tlsMode, port);

    this.config = { ...config, port };
    this.transport = transport;
    this._tlsActive = tls;
    const defaultHost =
      this._engine === 'cloudflare-d1'
        ? 'api.cloudflare.com'
        : this._engine === 'bigquery'
          ? 'bigquery.googleapis.com'
          : this._engine === 'snowflake' && config.accountId
            ? `${config.accountId}.snowflakecomputing.com`
            : '127.0.0.1';
    const rawHost = (config.host || defaultHost).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    this.endpoint = {
      host: rawHost || defaultHost,
      port,
      tls,
      allowSelfSigned: config.allowSelfSigned,
      caPem: config.caPem,
      basePath: config.httpPath,
      sshTunnel: config.sshTunnel,
    };
    this.activeDatabase = config.database || '';
    this.activeSchema = config.schema || '';
    this._connected = true;
    this._inTransaction = false;

    try {
      this._serverVersion = await this.probeServerVersion();
      return {
        engine: this._engine,
        family: 'http_sql',
        serverVersion: this._serverVersion,
        database: this.activeDatabase || this.defaultDatabaseName(),
        tlsActive: this._tlsActive,
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      this._connected = false;
      throw err;
    }
  }

  private defaultDatabaseName(): string {
    switch (this._engine) {
      case 'rqlite':
      case 'turso':
      case 'cloudflare-d1':
        return 'main';
      case 'victoriametrics':
        return 'metrics';
      case 'databend':
        return 'default';
      case 'iotdb':
        return 'root';
      case 'bigquery':
        return this.config?.accountId || this.config?.org || 'bigquery';
      case 'salesforce':
        return this.config?.host || 'salesforce';
      default:
        return '';
    }
  }

  async switchDatabase(db: string): Promise<ConnectionInfo> {
    this.requireConnected();
    this.activeDatabase = db;
    if (this.config) this.config.database = db;
    return {
      engine: this._engine,
      family: 'http_sql',
      serverVersion: this._serverVersion,
      database: db,
      tlsActive: this._tlsActive,
      latencyMs: 0,
    };
  }

  async testConnection(): Promise<TestConnectionResult> {
    const started = performance.now();
    try {
      const ver = await this.probeServerVersion();
      this._serverVersion = ver;
      return {
        ok: true,
        serverVersion: ver,
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
    await this.cancelQuery().catch(() => {});
    this._connected = false;
    this._inTransaction = false;
    this.activeCancelUrl = null;
  }

  async cancelQuery(): Promise<void> {
    if (!this.activeCancelUrl || !this._connected || !this.transport || !this.endpoint) {
      return;
    }
    const cancelUrl = this.activeCancelUrl;
    this.activeCancelUrl = null;
    if (this._engine === 'trino' || this._engine === 'prestosql') {
      await sendHttpRequest(this.transport, this.endpoint, cancelUrl, {
        method: 'DELETE',
        headers: this.buildTrinoHeaders(),
        timeoutMs: 5000,
      }).catch(() => {});
    } else if (this._engine === 'databend') {
      await sendHttpRequest(this.transport, this.endpoint, cancelUrl, {
        method: 'GET',
        headers: this.buildDatabendHeaders(),
        timeoutMs: 5000,
      }).catch(() => {});
    } else if (this._engine === 'databricks') {
      await sendHttpRequest(this.transport, this.endpoint, cancelUrl, {
        method: 'POST',
        headers: this.buildBearerJsonHeaders(),
        timeoutMs: 5000,
      }).catch(() => {});
    } else if (this._engine === 'snowflake') {
      await sendHttpRequest(this.transport, this.endpoint, cancelUrl, {
        method: 'POST',
        headers: this.buildSnowflakeHeaders(),
        timeoutMs: 5000,
      }).catch(() => {});
    }
  }

  private async probeServerVersion(): Promise<string> {
    const { transport, config, endpoint } = this.requireConnected();

    switch (this._engine) {
      case 'trino':
      case 'prestosql': {
        const resp = await sendHttpRequest(transport, endpoint, '/v1/info', {
          method: 'GET',
          headers: this.buildTrinoHeaders(),
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (resp.status >= 200 && resp.status < 300) {
          const info = decodeResponseJson<{ nodeVersion?: { version?: string } }>(resp);
          const v = info.nodeVersion?.version;
          if (v) return `${this._engine === 'trino' ? 'Trino' : 'Presto'} ${v}`;
        }
        const res = await this.executeSingle('SELECT 1');
        if (res.error) throw new QueryError(res.error);
        return this._engine === 'trino' ? 'Trino' : 'Presto';
      }

      case 'tdengine': {
        const res = await this.executeSingle('SELECT server_version()');
        const v = res.rows[0]?.[0];
        return v ? `TDengine ${String(v)}` : 'TDengine';
      }

      case 'databend': {
        const res = await this.executeSingle('SELECT version()');
        const v = res.rows[0]?.[0];
        return v ? `Databend ${String(v)}` : 'Databend';
      }

      case 'rqlite': {
        const res = await this.executeSingle('SELECT sqlite_version()');
        const v = res.rows[0]?.[0];
        return v ? `rqlite (SQLite ${String(v)})` : 'rqlite';
      }

      case 'turso': {
        const res = await this.executeSingle('SELECT sqlite_version()');
        const v = res.rows[0]?.[0];
        return v ? `Turso / libSQL (SQLite ${String(v)})` : 'Turso / libSQL';
      }

      case 'influxdb': {
        const hasV2Auth = Boolean(config.org || config.apiKey);
        if (hasV2Auth) {
          const healthResp = await sendHttpRequest(transport, endpoint, '/health', {
            method: 'GET',
            headers: this.buildInfluxHeaders(2),
            timeoutMs: config.timeoutMs ?? 15000,
          });
          if (healthResp.status >= 200 && healthResp.status < 300) {
            const data = decodeResponseJson<{ version?: string; status?: string }>(healthResp);
            this.influxVersion = 2;
            return data.version ? `InfluxDB ${data.version}` : 'InfluxDB 2';
          }
        }
        const pingResp = await sendHttpRequest(transport, endpoint, '/ping', {
          method: 'GET',
          headers: this.buildInfluxHeaders(hasV2Auth ? 2 : 1),
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (pingResp.status >= 400) {
          throw new Error(decodeResponseText(pingResp).trim() || `InfluxDB HTTP ${pingResp.status}`);
        }
        const verHeader = pingResp.headers['x-influxdb-version'] || '';
        if (hasV2Auth || /^v?2\./i.test(verHeader)) {
          this.influxVersion = 2;
        } else {
          this.influxVersion = 1;
        }
        return verHeader ? `InfluxDB ${verHeader}` : `InfluxDB ${this.influxVersion}`;
      }

      case 'influxdb3': {
        const resp = await sendHttpRequest(transport, endpoint, '/health', {
          method: 'GET',
          headers: this.buildInflux3Headers(),
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (resp.status >= 200 && resp.status < 300) {
          const verHeader = resp.headers['x-influxdb-version'];
          const text = decodeResponseText(resp).trim();
          if (text.startsWith('{')) {
            try {
              const parsed = JSON.parse(text) as { version?: string };
              if (parsed.version) return `InfluxDB 3 ${parsed.version}`;
            } catch {
              // ignore
            }
          }
          return verHeader ? `InfluxDB ${verHeader}` : 'InfluxDB 3';
        }
        const res = await this.executeSingle('SELECT 1');
        if (res.error) throw new QueryError(res.error);
        return 'InfluxDB 3';
      }

      case 'victoriametrics': {
        const resp = await sendHttpRequest(transport, endpoint, '/api/v1/status/buildinfo', {
          method: 'GET',
          headers: this.buildVictoriaHeaders(),
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (resp.status >= 200 && resp.status < 300) {
          const parsed = decodeResponseJson<{
            status?: string;
            data?: { version?: string };
          }>(resp);
          const v = parsed.data?.version;
          return v ? `VictoriaMetrics ${v}` : 'VictoriaMetrics';
        }
        const fallback = await sendHttpRequest(
          transport,
          endpoint,
          '/api/v1/label/__name__/values',
          {
            method: 'GET',
            headers: this.buildVictoriaHeaders(),
            timeoutMs: config.timeoutMs ?? 15000,
          },
        );
        if (fallback.status >= 400) {
          throw new Error(
            decodeResponseText(fallback).trim() || `VictoriaMetrics HTTP ${fallback.status}`,
          );
        }
        return 'VictoriaMetrics';
      }

      case 'cloudflare-d1': {
        const res = await this.executeSingle('SELECT sqlite_version()');
        const v = res.rows[0]?.[0];
        return v ? `Cloudflare D1 (SQLite ${String(v)})` : 'Cloudflare D1';
      }

      case 'iotdb': {
        try {
          const res = await this.executeSingle('SHOW VERSION');
          const v = res.rows[0]?.[0];
          if (v) return `Apache IoTDB ${String(v)}`;
        } catch {
          const ping = await sendHttpRequest(transport, endpoint, '/ping', {
            method: 'GET',
            headers: this.buildIotdbHeaders(),
            timeoutMs: config.timeoutMs ?? 15000,
          });
          if (ping.status >= 400) {
            throw new Error(decodeResponseText(ping).trim() || `IoTDB HTTP ${ping.status}`);
          }
        }
        return 'Apache IoTDB';
      }

      case 'kylin': {
        const resp = await sendHttpRequest(transport, endpoint, '/kylin/api/projects', {
          method: 'GET',
          headers: this.buildKylinHeaders(),
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `Kylin HTTP ${resp.status}`);
        }
        return 'Apache Kylin';
      }

      case 'databricks': {
        const res = await this.executeSingle('SELECT current_version()');
        const v = res.rows[0]?.[0];
        return v ? `Databricks SQL ${String(v)}` : 'Databricks SQL';
      }

      case 'snowflake': {
        const res = await this.executeSingle('SELECT CURRENT_VERSION()');
        const v = res.rows[0]?.[0];
        return v ? `Snowflake ${String(v)}` : 'Snowflake';
      }

      case 'bigquery': {
        const project = this.resolveBigQueryProject();
        const resp = await sendHttpRequest(
          transport,
          endpoint,
          `/bigquery/v2/projects/${encodeURIComponent(project)}/datasets?maxResults=1`,
          {
            method: 'GET',
            headers: this.buildBearerJsonHeaders(),
            timeoutMs: config.timeoutMs ?? 15000,
          },
        );
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `BigQuery HTTP ${resp.status}`);
        }
        return `Google BigQuery (${project})`;
      }

      case 'salesforce': {
        const resp = await sendHttpRequest(transport, endpoint, '/services/data/v61.0/sobjects', {
          method: 'GET',
          headers: this.buildBearerJsonHeaders(),
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `Salesforce HTTP ${resp.status}`);
        }
        return 'Salesforce API v61.0';
      }
    }
  }

  /* --------------------------------------------------------------------------
   * Engine-Specific Header Builders
   * -------------------------------------------------------------------------- */

  private buildTrinoHeaders(options?: QueryOptions): Record<string, string> {
    const config = this.config!;
    const prefix = this._engine === 'prestosql' ? 'X-Presto' : 'X-Trino';
    const headers: Record<string, string> = {
      [`${prefix}-User`]: config.username || 'netcatty',
    };
    const catalog = options?.database || this.activeDatabase || config.database;
    const schema = options?.schema || this.activeSchema || config.schema;
    if (catalog) headers[`${prefix}-Catalog`] = catalog;
    if (schema) headers[`${prefix}-Schema`] = schema;
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    } else if (config.username && config.password) {
      headers['Authorization'] = encodeBasicAuth(config.username, config.password);
    }
    return headers;
  }

  private buildTdengineHeaders(): Record<string, string> {
    const config = this.config!;
    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
      Authorization: encodeBasicAuth(config.username || 'root', config.password ?? 'taosdata'),
    };
    return headers;
  }

  private buildDatabendHeaders(options?: QueryOptions): Record<string, string> {
    const config = this.config!;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const db = options?.database || this.activeDatabase || config.database;
    if (db) headers['X-DATABEND-DATABASE'] = db;
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    } else if (config.username) {
      headers['Authorization'] = encodeBasicAuth(config.username, config.password ?? '');
    }
    return headers;
  }

  private buildRqliteHeaders(): Record<string, string> {
    const config = this.config!;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    } else if (config.username) {
      headers['Authorization'] = encodeBasicAuth(config.username, config.password ?? '');
    }
    return headers;
  }

  private buildTursoHeaders(): Record<string, string> {
    const config = this.config!;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const token = config.apiKey || config.password;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  private buildInfluxHeaders(version: 1 | 2): Record<string, string> {
    const config = this.config!;
    const headers: Record<string, string> = {};
    if (version === 2) {
      const token = config.apiKey || config.password;
      if (token) headers['Authorization'] = `Token ${token}`;
    } else if (config.apiKey) {
      headers['Authorization'] = `Token ${config.apiKey}`;
    } else if (config.username) {
      headers['Authorization'] = encodeBasicAuth(config.username, config.password ?? '');
    }
    return headers;
  }

  private buildInflux3Headers(): Record<string, string> {
    const config = this.config!;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const token = config.apiKey || config.password;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  private buildVictoriaHeaders(): Record<string, string> {
    const config = this.config!;
    const headers: Record<string, string> = {};
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    } else if (config.username) {
      headers['Authorization'] = encodeBasicAuth(config.username, config.password ?? '');
    }
    return headers;
  }

  private buildBearerJsonHeaders(): Record<string, string> {
    const config = this.config!;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const token = config.apiKey || config.password;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  private buildIotdbHeaders(): Record<string, string> {
    const config = this.config!;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    } else {
      headers['Authorization'] = encodeBasicAuth(config.username || 'root', config.password ?? 'root');
    }
    return headers;
  }

  private buildKylinHeaders(): Record<string, string> {
    const config = this.config!;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    } else {
      headers['Authorization'] = encodeBasicAuth(config.username || 'ADMIN', config.password ?? 'KYLIN');
    }
    return headers;
  }

  private buildSnowflakeHeaders(): Record<string, string> {
    const headers = this.buildBearerJsonHeaders();
    headers['User-Agent'] = 'Netcatty-Database/0.3.0';
    headers['X-Snowflake-Authorization-Token-Type'] = 'OAUTH';
    return headers;
  }

  private resolveCloudflareD1Path(options?: QueryOptions): string {
    const config = this.config!;
    const accountId = config.accountId || config.org || '';
    const dbId = options?.database || this.activeDatabase || config.database || '';
    if (!accountId || !dbId) {
      throw new QueryError('Cloudflare D1 requires accountId and database ID');
    }
    return `/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(dbId)}/query`;
  }

  private resolveBigQueryProject(db?: string): string {
    const config = this.config!;
    const project = db || config.accountId || this.activeDatabase || config.database || config.org || '';
    if (!project) {
      throw new QueryError('Google BigQuery requires a GCP project ID (accountId or database)');
    }
    return project;
  }

  /* --------------------------------------------------------------------------
   * Statement Execution Dispatch
   * -------------------------------------------------------------------------- */

  async query(sql: string, options?: QueryOptions): Promise<MultiQueryResult> {
    this.requireConnected();
    const totalStart = performance.now();

    // Flux scripts and PromQL expressions are single-query languages (do not SQL-split)
    const shouldSplit =
      this._engine !== 'victoriametrics' &&
      !(this._engine === 'influxdb' && (this.influxVersion === 2 || looksLikeFluxQuery(sql)));

    const statements = shouldSplit
      ? (() => {
          const parts = splitSqlStatements(sql, this.dialect);
          return parts.length > 0 ? parts.map((p) => p.sql) : [sql];
        })()
      : [sql.trim()];

    const results: QueryResultSet[] = [];
    for (const stmt of statements) {
      if (!stmt.trim()) continue;
      results.push(await this.executeSingle(stmt, options));
    }

    return {
      results,
      totalExecutionMs: Math.round(performance.now() - totalStart),
    };
  }

  private async executeSingle(sql: string, options?: QueryOptions): Promise<QueryResultSet> {
    switch (this._engine) {
      case 'trino':
      case 'prestosql':
        return this.executeTrino(sql, options);
      case 'tdengine':
        return this.executeTdengine(sql, options);
      case 'databend':
        return this.executeDatabend(sql, options);
      case 'rqlite':
        return this.executeRqlite(sql, options);
      case 'turso':
        return this.executeTurso(sql, options);
      case 'influxdb':
        return this.executeInflux(sql, options);
      case 'influxdb3':
        return this.executeInflux3(sql, options);
      case 'victoriametrics':
        return this.executeVictoriaMetrics(sql, options);
      case 'cloudflare-d1':
        return this.executeCloudflareD1(sql, options);
      case 'iotdb':
        return this.executeIotdb(sql, options);
      case 'kylin':
        return this.executeKylin(sql, options);
      case 'databricks':
        return this.executeDatabricks(sql, options);
      case 'snowflake':
        return this.executeSnowflake(sql, options);
      case 'bigquery':
        return this.executeBigQuery(sql, options);
      case 'salesforce':
        return this.executeSalesforce(sql, options);
    }
  }

  private async executeTrino(sql: string, options?: QueryOptions): Promise<QueryResultSet> {
    const { transport, config, endpoint } = this.requireConnected();
    const started = performance.now();
    const cleanSql = stripTrailingSemicolon(sql);
    const headers = {
      ...this.buildTrinoHeaders(options),
      'Content-Type': 'text/plain; charset=utf-8',
    };
    const timeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30000;

    const firstResp = await sendHttpRequest(transport, endpoint, '/v1/statement', {
      method: 'POST',
      headers,
      body: cleanSql,
      timeoutMs,
      signal: options?.signal,
    });
    if (firstResp.status >= 400) {
      throw new QueryError(
        decodeResponseText(firstResp).trim() || `${this._engine} HTTP ${firstResp.status}`,
      );
    }

    let page = decodeResponseJson<TrinoResponse>(firstResp);
    let columns: ColumnMeta[] = [];
    const rows: CellValue[][] = [];
    let truncated = false;
    let affectedRows = 0;
    let commandTag = 'SELECT';
    let polls = 0;
    const maxPolls = 500;

    const consumePage = (p: TrinoResponse) => {
      if (p.error) {
        const msg = p.error.message || p.error.failureInfo?.message || `${this._engine} query error`;
        throw new QueryError(msg, {
          code: p.error.errorName || (p.error.errorCode !== undefined ? String(p.error.errorCode) : undefined),
        });
      }
      if (columns.length === 0 && Array.isArray(p.columns)) {
        columns = p.columns.map((c) => ({
          name: c.name,
          dataType: c.type || 'varchar',
        }));
      }
      if (Array.isArray(p.data)) {
        for (const r of p.data) {
          if (options?.maxRows && rows.length >= options.maxRows) {
            truncated = true;
            break;
          }
          rows.push(r.map(toCellValue));
        }
      }
      if (p.updateType) commandTag = p.updateType;
      if (typeof p.updateCount === 'number') affectedRows = p.updateCount;
    };

    try {
      this.activeCancelUrl = page.nextUri ?? null;
      consumePage(page);

      while (page.nextUri && polls < maxPolls) {
        if (options?.signal?.aborted) {
          await sendHttpRequest(transport, endpoint, page.nextUri, {
            method: 'DELETE',
            headers: this.buildTrinoHeaders(options),
            timeoutMs: 5000,
          }).catch(() => {});
          throw new Error('Query cancelled');
        }
        if (truncated) {
          await sendHttpRequest(transport, endpoint, page.nextUri, {
            method: 'DELETE',
            headers: this.buildTrinoHeaders(options),
            timeoutMs: 5000,
          }).catch(() => {});
          break;
        }
        polls++;
        const nextUrl = page.nextUri;
        this.activeCancelUrl = nextUrl;
        const nextResp = await sendHttpRequest(transport, endpoint, nextUrl, {
          method: 'GET',
          headers: this.buildTrinoHeaders(options),
          timeoutMs,
          signal: options?.signal,
        });
        if (nextResp.status >= 400) {
          throw new QueryError(
            decodeResponseText(nextResp).trim() || `${this._engine} poll HTTP ${nextResp.status}`,
          );
        }
        page = decodeResponseJson<TrinoResponse>(nextResp);
        consumePage(page);
      }
    } finally {
      this.activeCancelUrl = null;
    }

    return {
      sql,
      columns,
      rows,
      rowCount: rows.length,
      affectedRows,
      executionMs: Math.round(performance.now() - started),
      truncated,
      commandTag,
    };
  }

  private async executeTdengine(sql: string, options?: QueryOptions): Promise<QueryResultSet> {
    const { transport, config, endpoint } = this.requireConnected();
    const started = performance.now();
    const cleanSql = stripTrailingSemicolon(sql);
    const db = options?.database || this.activeDatabase || config.database;
    const path = db ? `/rest/sql/${encodeURIComponent(db)}` : '/rest/sql';

    const resp = await sendHttpRequest(transport, endpoint, path, {
      method: 'POST',
      headers: this.buildTdengineHeaders(),
      body: cleanSql,
      timeoutMs: options?.timeoutMs ?? config.timeoutMs ?? 30000,
      signal: options?.signal,
    });

    if (resp.status >= 400) {
      throw new QueryError(decodeResponseText(resp).trim() || `TDengine HTTP ${resp.status}`);
    }

    const parsed = decodeResponseJson<TdengineResponse>(resp);
    // v3 uses numeric code !== 0; v2 uses status === 'error' or code !== 0
    if (
      parsed.status === 'error' ||
      (typeof parsed.code === 'number' && parsed.code !== 0)
    ) {
      throw new QueryError(parsed.desc || `TDengine error code ${parsed.code}`, {
        code: parsed.code !== undefined ? String(parsed.code) : undefined,
      });
    }

    let columns: ColumnMeta[] = [];
    if (Array.isArray(parsed.column_meta) && parsed.column_meta.length > 0) {
      columns = parsed.column_meta.map(([name, typeRaw]) => ({
        name: String(name),
        dataType:
          typeof typeRaw === 'number'
            ? TDENGINE_TYPE_CODES[typeRaw] || `TYPE_${typeRaw}`
            : String(typeRaw || 'VARCHAR'),
      }));
    } else if (Array.isArray(parsed.head) && parsed.head.length > 0) {
      columns = parsed.head.map((name) => ({
        name: String(name),
        dataType: 'VARCHAR',
      }));
    }

    const rawData = Array.isArray(parsed.data) ? parsed.data : [];
    const maxRows = options?.maxRows;
    const truncated = Boolean(maxRows && rawData.length > maxRows);
    const sliced = maxRows ? rawData.slice(0, maxRows) : rawData;
    const rows = sliced.map((r) => r.map(toCellValue));

    // TDengine returns rows: N with affected_rows column or empty data on INSERT/DDL
    let affectedRows = 0;
    if (columns.length === 1 && columns[0].name === 'affected_rows' && rows.length === 1) {
      affectedRows = Number(rows[0][0] ?? 0);
    } else if (rows.length === 0 && typeof parsed.rows === 'number') {
      affectedRows = parsed.rows;
    }

    return {
      sql,
      columns,
      rows,
      rowCount: rows.length,
      affectedRows,
      executionMs: Math.round(performance.now() - started),
      truncated,
      commandTag: isReadSqlStatement(cleanSql) ? 'SELECT' : 'OK',
    };
  }

  private async executeDatabend(sql: string, options?: QueryOptions): Promise<QueryResultSet> {
    const { transport, config, endpoint } = this.requireConnected();
    const started = performance.now();
    const cleanSql = stripTrailingSemicolon(sql);
    const headers = this.buildDatabendHeaders(options);
    const timeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30000;

    const firstResp = await sendHttpRequest(transport, endpoint, '/v1/query', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sql: cleanSql,
        pagination: {
          wait_time_secs: 5,
          max_rows_in_buffer: options?.maxRows ?? 10000,
          max_rows_per_page: options?.maxRows ?? 1000,
        },
      }),
      timeoutMs,
      signal: options?.signal,
    });
    if (firstResp.status >= 400) {
      throw new QueryError(decodeResponseText(firstResp).trim() || `Databend HTTP ${firstResp.status}`);
    }

    let page = decodeResponseJson<DatabendResponse>(firstResp);
    let columns: ColumnMeta[] = [];
    const rows: CellValue[][] = [];
    let truncated = false;
    let affectedRows = 0;
    let polls = 0;
    const maxPolls = 500;

    const consumePage = (p: DatabendResponse) => {
      if (p.error) {
        const msg =
          typeof p.error === 'string'
            ? p.error
            : p.error.message || p.error.detail || 'Databend query error';
        const code =
          typeof p.error === 'object' && p.error.code !== undefined
            ? String(p.error.code)
            : undefined;
        throw new QueryError(msg, { code });
      }
      if (columns.length === 0 && Array.isArray(p.schema)) {
        columns = p.schema.map((s) => ({
          name: s.name,
          dataType: s.type || 'String',
        }));
      }
      if (Array.isArray(p.data)) {
        for (const r of p.data) {
          if (options?.maxRows && rows.length >= options.maxRows) {
            truncated = true;
            break;
          }
          rows.push(r.map(toCellValue));
        }
      }
      if (typeof p.stats?.write_progress?.rows === 'number') {
        affectedRows = p.stats.write_progress.rows;
      }
    };

    try {
      this.activeCancelUrl = page.kill_uri ?? null;
      consumePage(page);

      while (page.next_uri && polls < maxPolls) {
        if (options?.signal?.aborted) {
          if (page.kill_uri) {
            await sendHttpRequest(transport, endpoint, page.kill_uri, {
              method: 'GET',
              headers: this.buildDatabendHeaders(options),
              timeoutMs: 5000,
            }).catch(() => {});
          }
          throw new Error('Query cancelled');
        }
        if (truncated) {
          const stopUrl = page.final_uri || page.kill_uri;
          if (stopUrl) {
            await sendHttpRequest(transport, endpoint, stopUrl, {
              method: 'GET',
              headers: this.buildDatabendHeaders(options),
              timeoutMs: 5000,
            }).catch(() => {});
          }
          break;
        }
        polls++;
        const nextResp = await sendHttpRequest(transport, endpoint, page.next_uri, {
          method: 'GET',
          headers: this.buildDatabendHeaders(options),
          timeoutMs,
          signal: options?.signal,
        });
        if (nextResp.status >= 400) {
          throw new QueryError(
            decodeResponseText(nextResp).trim() || `Databend poll HTTP ${nextResp.status}`,
          );
        }
        page = decodeResponseJson<DatabendResponse>(nextResp);
        this.activeCancelUrl = page.kill_uri ?? this.activeCancelUrl;
        consumePage(page);
      }
    } finally {
      this.activeCancelUrl = null;
    }

    return {
      sql,
      columns,
      rows,
      rowCount: rows.length,
      affectedRows,
      executionMs: Math.round(performance.now() - started),
      truncated,
      commandTag: isReadSqlStatement(cleanSql) ? 'SELECT' : 'OK',
    };
  }

  private async executeRqlite(sql: string, options?: QueryOptions): Promise<QueryResultSet> {
    const { transport, config, endpoint } = this.requireConnected();
    const started = performance.now();
    const cleanSql = stripTrailingSemicolon(sql);
    const isRead = isReadSqlStatement(cleanSql);
    const path = isRead ? '/db/query' : '/db/execute';
    const payload =
      options?.params && options.params.length > 0
        ? [[cleanSql, ...options.params]]
        : [cleanSql];

    const resp = await sendHttpRequest(transport, endpoint, path, {
      method: 'POST',
      headers: this.buildRqliteHeaders(),
      body: JSON.stringify(payload),
      timeoutMs: options?.timeoutMs ?? config.timeoutMs ?? 30000,
      signal: options?.signal,
    });
    if (resp.status >= 400) {
      throw new QueryError(decodeResponseText(resp).trim() || `rqlite HTTP ${resp.status}`);
    }

    const parsed = decodeResponseJson<RqliteResponse>(resp);
    const first = parsed.results?.[0];
    if (first?.error) {
      throw new QueryError(first.error);
    }

    const colNames = first?.columns ?? [];
    const colTypes = first?.types ?? [];
    const columns: ColumnMeta[] = colNames.map((name, idx) => ({
      name,
      dataType: colTypes[idx] || 'TEXT',
    }));

    const rawValues = first?.values ?? [];
    const maxRows = options?.maxRows;
    const truncated = Boolean(maxRows && rawValues.length > maxRows);
    const sliced = maxRows ? rawValues.slice(0, maxRows) : rawValues;
    const rows = sliced.map((r) => r.map(toCellValue));

    return {
      sql,
      columns,
      rows,
      rowCount: rows.length,
      affectedRows: first?.rows_affected ?? 0,
      insertId: first?.last_insert_id,
      executionMs: Math.round(performance.now() - started),
      truncated,
      commandTag: isRead ? 'SELECT' : 'OK',
    };
  }

  private async executeTurso(sql: string, options?: QueryOptions): Promise<QueryResultSet> {
    const { transport, config, endpoint } = this.requireConnected();
    const started = performance.now();
    const cleanSql = stripTrailingSemicolon(sql);

    const args = (options?.params ?? []).map((p): HranaValue => {
      if (p === null) return { type: 'null' };
      if (typeof p === 'boolean') return { type: 'integer', value: p ? '1' : '0' };
      if (typeof p === 'number') {
        return Number.isInteger(p)
          ? { type: 'integer', value: String(p) }
          : { type: 'float', value: p };
      }
      return { type: 'text', value: String(p) };
    });

    const body = JSON.stringify({
      requests: [
        {
          type: 'execute',
          stmt: args.length > 0 ? { sql: cleanSql, args } : { sql: cleanSql },
        },
        { type: 'close' },
      ],
    });

    const resp = await sendHttpRequest(transport, endpoint, '/v2/pipeline', {
      method: 'POST',
      headers: this.buildTursoHeaders(),
      body,
      timeoutMs: options?.timeoutMs ?? config.timeoutMs ?? 30000,
      signal: options?.signal,
    });
    if (resp.status >= 400) {
      throw new QueryError(decodeResponseText(resp).trim() || `Turso HTTP ${resp.status}`);
    }

    const parsed = decodeResponseJson<HranaPipelineResponse>(resp);
    const execItem = parsed.results?.[0];
    if (!execItem) {
      throw new QueryError('Turso /v2/pipeline returned empty results');
    }
    if (execItem.type === 'error') {
      throw new QueryError(execItem.error?.message || 'Turso execution error', {
        code: execItem.error?.code,
      });
    }

    const result = execItem.response?.result;
    const columns: ColumnMeta[] = (result?.cols ?? []).map((c, idx) => ({
      name: c.name ?? `col_${idx}`,
      dataType: c.decltype || 'TEXT',
    }));

    const rawRows = result?.rows ?? [];
    const maxRows = options?.maxRows;
    const truncated = Boolean(maxRows && rawRows.length > maxRows);
    const sliced = maxRows ? rawRows.slice(0, maxRows) : rawRows;
    const rows: CellValue[][] = sliced.map((r) =>
      r.map((cell): CellValue => {
        if (!cell || cell.type === 'null') return null;
        if (cell.type === 'integer') {
          const n = Number(cell.value);
          return Number.isSafeInteger(n) ? n : String(cell.value ?? '');
        }
        if (cell.type === 'float') return Number(cell.value);
        if (cell.type === 'blob') {
          return cell.base64 ? base64ToBytes(cell.base64) : new Uint8Array(0);
        }
        return String(cell.value ?? '');
      }),
    );

    return {
      sql,
      columns,
      rows,
      rowCount: rows.length,
      affectedRows: result?.affected_row_count ?? 0,
      insertId: result?.last_insert_rowid ?? undefined,
      executionMs: Math.round(performance.now() - started),
      truncated,
      commandTag: isReadSqlStatement(cleanSql) ? 'SELECT' : 'OK',
    };
  }

  private async executeInflux(sql: string, options?: QueryOptions): Promise<QueryResultSet> {
    const { transport, config, endpoint } = this.requireConnected();
    const started = performance.now();
    const trimmed = sql.trim();
    const useV2Flux =
      looksLikeFluxQuery(trimmed) ||
      (this.influxVersion === 2 && !/^(SELECT|SHOW|CREATE|DROP)\b/i.test(stripLeadingComments(trimmed)));

    if (useV2Flux) {
      const org = config.org || '';
      const path = org ? `/api/v2/query?org=${encodeURIComponent(org)}` : '/api/v2/query';
      const resp = await sendHttpRequest(transport, endpoint, path, {
        method: 'POST',
        headers: {
          ...this.buildInfluxHeaders(2),
          'Content-Type': 'application/vnd.flux',
          Accept: 'application/csv',
        },
        body: trimmed,
        timeoutMs: options?.timeoutMs ?? config.timeoutMs ?? 30000,
        signal: options?.signal,
      });
      if (resp.status >= 400) {
        throw new QueryError(decodeResponseText(resp).trim() || `InfluxDB v2 HTTP ${resp.status}`);
      }
      const csvText = decodeResponseText(resp);
      const { columns, rows, truncated } = parseFluxAnnotatedCsv(csvText, options?.maxRows);
      return {
        sql,
        columns,
        rows,
        rowCount: rows.length,
        affectedRows: 0,
        executionMs: Math.round(performance.now() - started),
        truncated,
        commandTag: 'FLUX',
      };
    }

    // InfluxDB v1 /query (InfluxQL)
    const db = options?.database || this.activeDatabase || config.database;
    const params = new URLSearchParams();
    if (db) params.set('db', db);
    const path = `/query${params.toString() ? `?${params.toString()}` : ''}`;
    const body = `q=${encodeURIComponent(stripTrailingSemicolon(trimmed))}`;
    const resp = await sendHttpRequest(transport, endpoint, path, {
      method: 'POST',
      headers: {
        ...this.buildInfluxHeaders(1),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      timeoutMs: options?.timeoutMs ?? config.timeoutMs ?? 30000,
      signal: options?.signal,
    });
    if (resp.status >= 400) {
      throw new QueryError(decodeResponseText(resp).trim() || `InfluxDB HTTP ${resp.status}`);
    }

    const parsed = decodeResponseJson<InfluxV1Response>(resp);
    if (parsed.error) throw new QueryError(parsed.error);
    const stmt = parsed.results?.[0];
    if (stmt?.error) throw new QueryError(stmt.error);

    const seriesList = stmt?.series ?? [];
    if (seriesList.length === 0) {
      return {
        sql,
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: 0,
        executionMs: Math.round(performance.now() - started),
        truncated: false,
        commandTag: 'OK',
      };
    }

    const hasTags = seriesList.some((s) => s.tags && Object.keys(s.tags).length > 0);
    const tagKeys = hasTags
      ? Array.from(new Set(seriesList.flatMap((s) => Object.keys(s.tags ?? {}))))
      : [];
    const baseCols = seriesList[0].columns ?? [];
    const columns: ColumnMeta[] = [
      ...tagKeys.map((k) => ({ name: k, dataType: 'TAG' })),
      ...baseCols.map((c) => ({ name: c, dataType: c === 'time' ? 'TIMESTAMP' : 'STRING' })),
    ];

    const rows: CellValue[][] = [];
    let truncated = false;
    for (const s of seriesList) {
      const tagVals = tagKeys.map((k) => s.tags?.[k] ?? null);
      for (const vals of s.values ?? []) {
        if (options?.maxRows && rows.length >= options.maxRows) {
          truncated = true;
          break;
        }
        rows.push([...tagVals, ...vals.map(toCellValue)]);
      }
      if (truncated) break;
    }

    return {
      sql,
      columns,
      rows,
      rowCount: rows.length,
      affectedRows: 0,
      executionMs: Math.round(performance.now() - started),
      truncated,
      commandTag: 'SELECT',
    };
  }

  private async executeInflux3(sql: string, options?: QueryOptions): Promise<QueryResultSet> {
    const { transport, config, endpoint } = this.requireConnected();
    const started = performance.now();
    const cleanSql = stripTrailingSemicolon(sql);
    const db = options?.database || this.activeDatabase || config.database || 'default';

    const resp = await sendHttpRequest(transport, endpoint, '/api/v3/query_sql', {
      method: 'POST',
      headers: this.buildInflux3Headers(),
      body: JSON.stringify({
        db,
        q: cleanSql,
        format: 'json',
      }),
      timeoutMs: options?.timeoutMs ?? config.timeoutMs ?? 30000,
      signal: options?.signal,
    });
    if (resp.status >= 400) {
      throw new QueryError(decodeResponseText(resp).trim() || `InfluxDB 3 HTTP ${resp.status}`);
    }

    const text = decodeResponseText(resp).trim();
    if (!text) {
      return {
        sql,
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: 0,
        executionMs: Math.round(performance.now() - started),
        truncated: false,
        commandTag: 'OK',
      };
    }

    const parsed = JSON.parse(text) as unknown;
    let columns: ColumnMeta[] = [];
    const rows: CellValue[][] = [];
    let truncated = false;

    if (Array.isArray(parsed)) {
      const objs = parsed as Array<Record<string, unknown>>;
      const colNames = objs.length > 0 ? Object.keys(objs[0]) : [];
      columns = colNames.map((name) => {
        const sample = objs[0]?.[name];
        const dataType =
          typeof sample === 'number'
            ? 'DOUBLE'
            : typeof sample === 'boolean'
              ? 'BOOLEAN'
              : 'STRING';
        return { name, dataType };
      });
      for (const obj of objs) {
        if (options?.maxRows && rows.length >= options.maxRows) {
          truncated = true;
          break;
        }
        rows.push(colNames.map((c) => toCellValue(obj[c])));
      }
    } else if (parsed && typeof parsed === 'object') {
      const obj = parsed as {
        columns?: Array<string | { name: string; type?: string }>;
        rows?: unknown[][];
        error?: string;
      };
      if (obj.error) throw new QueryError(obj.error);
      if (Array.isArray(obj.columns)) {
        columns = obj.columns.map((c) =>
          typeof c === 'string'
            ? { name: c, dataType: 'STRING' }
            : { name: c.name, dataType: c.type || 'STRING' },
        );
      }
      for (const r of obj.rows ?? []) {
        if (options?.maxRows && rows.length >= options.maxRows) {
          truncated = true;
          break;
        }
        rows.push(r.map(toCellValue));
      }
    }

    return {
      sql,
      columns,
      rows,
      rowCount: rows.length,
      affectedRows: 0,
      executionMs: Math.round(performance.now() - started),
      truncated,
      commandTag: 'SELECT',
    };
  }

  private async executeVictoriaMetrics(
    promql: string,
    options?: QueryOptions,
  ): Promise<QueryResultSet> {
    const { transport, config, endpoint } = this.requireConnected();
    const started = performance.now();
    const clean = promql.trim();

    const resp = await sendHttpRequest(transport, endpoint, '/api/v1/query', {
      method: 'POST',
      headers: {
        ...this.buildVictoriaHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `query=${encodeURIComponent(clean)}`,
      timeoutMs: options?.timeoutMs ?? config.timeoutMs ?? 30000,
      signal: options?.signal,
    });
    if (resp.status >= 400) {
      throw new QueryError(
        decodeResponseText(resp).trim() || `VictoriaMetrics HTTP ${resp.status}`,
      );
    }

    const parsed = decodeResponseJson<PromQlResponse>(resp);
    if (parsed.status === 'error') {
      throw new QueryError(parsed.error || 'PromQL query error', {
        code: parsed.errorType,
      });
    }

    const columns: ColumnMeta[] = [
      { name: 'metric', dataType: 'TEXT' },
      { name: 'labels', dataType: 'JSON' },
      { name: 'timestamp', dataType: 'TIMESTAMP' },
      { name: 'value', dataType: 'DOUBLE' },
    ];
    const rows: CellValue[][] = [];
    let truncated = false;
    const resultType = parsed.data?.resultType;
    const result = parsed.data?.result;

    const pushSample = (
      metricName: string,
      labels: Record<string, string>,
      tsSeconds: number,
      rawVal: string | number,
    ): boolean => {
      if (options?.maxRows && rows.length >= options.maxRows) {
        truncated = true;
        return false;
      }
      const iso = Number.isFinite(tsSeconds)
        ? new Date(tsSeconds * 1000).toISOString()
        : String(tsSeconds);
      const numVal = typeof rawVal === 'number' ? rawVal : Number(rawVal);
      const val: CellValue = Number.isFinite(numVal) ? numVal : String(rawVal);
      rows.push([metricName, labels, iso, val]);
      return true;
    };

    if (resultType === 'vector' && Array.isArray(result)) {
      for (const item of result as Array<{
        metric?: Record<string, string>;
        value?: [number, string];
      }>) {
        const metricObj = { ...(item.metric ?? {}) };
        const metricName = metricObj.__name__ ?? '';
        delete metricObj.__name__;
        const pair = item.value ?? [0, '0'];
        if (!pushSample(metricName, metricObj, Number(pair[0]), pair[1])) break;
      }
    } else if (resultType === 'matrix' && Array.isArray(result)) {
      for (const item of result as Array<{
        metric?: Record<string, string>;
        values?: Array<[number, string]>;
      }>) {
        const metricObj = { ...(item.metric ?? {}) };
        const metricName = metricObj.__name__ ?? '';
        delete metricObj.__name__;
        for (const pair of item.values ?? []) {
          if (!pushSample(metricName, metricObj, Number(pair[0]), pair[1])) break;
        }
        if (truncated) break;
      }
    } else if ((resultType === 'scalar' || resultType === 'string') && Array.isArray(result)) {
      const pair = result as [number, string];
      pushSample(resultType, {}, Number(pair[0]), pair[1]);
    }

    return {
      sql: promql,
      columns,
      rows,
      rowCount: rows.length,
      affectedRows: 0,
      executionMs: Math.round(performance.now() - started),
      truncated,
      commandTag: 'PROMQL',
    };
  }

  private async executeCloudflareD1(sql: string, options?: QueryOptions): Promise<QueryResultSet> {
    const { transport, config, endpoint } = this.requireConnected();
    const started = performance.now();
    const cleanSql = stripTrailingSemicolon(sql);
    const path = this.resolveCloudflareD1Path(options);
    const bodyObj: Record<string, unknown> = { sql: cleanSql };
    if (options?.params && options.params.length > 0) {
      bodyObj.params = options.params;
    }

    const resp = await sendHttpRequest(transport, endpoint, path, {
      method: 'POST',
      headers: this.buildBearerJsonHeaders(),
      body: JSON.stringify(bodyObj),
      timeoutMs: options?.timeoutMs ?? config.timeoutMs ?? 30000,
      signal: options?.signal,
    });
    if (resp.status >= 400) {
      throw new QueryError(decodeResponseText(resp).trim() || `Cloudflare D1 HTTP ${resp.status}`);
    }

    const parsed = decodeResponseJson<CloudflareD1Response>(resp);
    if (parsed.success === false) {
      const firstErr = parsed.errors?.[0];
      throw new QueryError(firstErr?.message || 'Cloudflare D1 query error', {
        code: firstErr?.code !== undefined ? String(firstErr.code) : undefined,
      });
    }

    const stmtResult = parsed.result?.[0];
    if (stmtResult && stmtResult.success === false) {
      throw new QueryError('Cloudflare D1 statement failed');
    }

    let columns: ColumnMeta[] = [];
    const rows: CellValue[][] = [];
    let truncated = false;
    const rawResults = stmtResult?.results;

    if (Array.isArray(rawResults)) {
      const colNames = rawResults.length > 0 ? Object.keys(rawResults[0]) : [];
      columns = colNames.map((name) => {
        const sample = rawResults[0]?.[name];
        const dataType =
          typeof sample === 'number'
            ? Number.isInteger(sample)
              ? 'INTEGER'
              : 'REAL'
            : typeof sample === 'boolean'
              ? 'BOOLEAN'
              : 'TEXT';
        return { name, dataType };
      });
      for (const obj of rawResults) {
        if (options?.maxRows && rows.length >= options.maxRows) {
          truncated = true;
          break;
        }
        rows.push(colNames.map((c) => toCellValue(obj[c])));
      }
    } else if (rawResults && typeof rawResults === 'object') {
      const cols = rawResults.columns ?? [];
      columns = cols.map((name) => ({ name, dataType: 'TEXT' }));
      for (const r of rawResults.rows ?? []) {
        if (options?.maxRows && rows.length >= options.maxRows) {
          truncated = true;
          break;
        }
        rows.push(r.map(toCellValue));
      }
    }

    return {
      sql,
      columns,
      rows,
      rowCount: rows.length,
      affectedRows: stmtResult?.meta?.changes ?? stmtResult?.meta?.rows_written ?? 0,
      insertId: stmtResult?.meta?.last_row_id,
      executionMs: Math.round(performance.now() - started),
      truncated,
      commandTag: isReadSqlStatement(cleanSql) ? 'SELECT' : 'OK',
    };
  }

  private async executeIotdb(sql: string, options?: QueryOptions): Promise<QueryResultSet> {
    const { transport, config, endpoint } = this.requireConnected();
    const started = performance.now();
    const cleanSql = stripTrailingSemicolon(sql);
    const head = stripLeadingComments(cleanSql).toUpperCase();
    const isQuery = /^(SELECT|SHOW|COUNT|LIST|DESCRIBE|DESC|EXPLAIN)\b/.test(head);
    const path = isQuery ? '/rest/v2/query' : '/rest/v2/nonQuery';

    const resp = await sendHttpRequest(transport, endpoint, path, {
      method: 'POST',
      headers: this.buildIotdbHeaders(),
      body: JSON.stringify({ sql: cleanSql }),
      timeoutMs: options?.timeoutMs ?? config.timeoutMs ?? 30000,
      signal: options?.signal,
    });
    if (resp.status >= 400) {
      throw new QueryError(decodeResponseText(resp).trim() || `IoTDB HTTP ${resp.status}`);
    }

    const parsed = decodeResponseJson<IotdbResponse>(resp);
    if (typeof parsed.code === 'number' && parsed.code !== 200 && parsed.code !== 0) {
      throw new QueryError(parsed.message || `IoTDB error code ${parsed.code}`, {
        code: String(parsed.code),
      });
    }

    if (!isQuery) {
      return {
        sql,
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: 1,
        executionMs: Math.round(performance.now() - started),
        truncated: false,
        commandTag: 'OK',
      };
    }

    const expressions = parsed.expressions ?? parsed.columnNames ?? [];
    const values = parsed.values ?? [];
    const hasTimestamps = Array.isArray(parsed.timestamps);
    const columns: ColumnMeta[] = hasTimestamps
      ? [
          { name: 'Time', dataType: 'TIMESTAMP' },
          ...expressions.map((name) => ({ name, dataType: 'TEXT' })),
        ]
      : expressions.map((name) => ({ name, dataType: 'TEXT' }));

    const rows: CellValue[][] = [];
    let truncated = false;
    const maxRows = options?.maxRows;

    if (hasTimestamps && parsed.timestamps) {
      for (let rIdx = 0; rIdx < parsed.timestamps.length; rIdx++) {
        if (maxRows && rows.length >= maxRows) {
          truncated = true;
          break;
        }
        const row: CellValue[] = [parsed.timestamps[rIdx]];
        for (let cIdx = 0; cIdx < expressions.length; cIdx++) {
          row.push(toCellValue(values[cIdx]?.[rIdx]));
        }
        rows.push(row);
      }
    } else if (values.length > 0) {
      // IoTDB REST v2 returns column-major arrays when `expressions` is present (values[col][row])
      const isColMajor =
        Array.isArray(parsed.expressions) &&
        values.length === expressions.length &&
        Array.isArray(values[0]);
      if (isColMajor) {
        const total = values[0]?.length ?? 0;
        for (let rIdx = 0; rIdx < total; rIdx++) {
          if (maxRows && rows.length >= maxRows) {
            truncated = true;
            break;
          }
          rows.push(expressions.map((_, cIdx) => toCellValue(values[cIdx]?.[rIdx])));
        }
      } else {
        for (const r of values) {
          if (maxRows && rows.length >= maxRows) {
            truncated = true;
            break;
          }
          rows.push(Array.isArray(r) ? r.map(toCellValue) : [toCellValue(r)]);
        }
      }
    }

    return {
      sql,
      columns,
      rows,
      rowCount: rows.length,
      affectedRows: 0,
      executionMs: Math.round(performance.now() - started),
      truncated,
      commandTag: 'SELECT',
    };
  }

  private async executeKylin(sql: string, options?: QueryOptions): Promise<QueryResultSet> {
    const { transport, config, endpoint } = this.requireConnected();
    const started = performance.now();
    const cleanSql = stripTrailingSemicolon(sql);
    const project = options?.database || this.activeDatabase || config.database || 'default';

    const resp = await sendHttpRequest(transport, endpoint, '/kylin/api/query', {
      method: 'POST',
      headers: this.buildKylinHeaders(),
      body: JSON.stringify({
        sql: cleanSql,
        project,
        limit: options?.maxRows ?? 500,
        offset: 0,
        acceptPartial: false,
      }),
      timeoutMs: options?.timeoutMs ?? config.timeoutMs ?? 30000,
      signal: options?.signal,
    });
    if (resp.status >= 400) {
      throw new QueryError(decodeResponseText(resp).trim() || `Kylin HTTP ${resp.status}`);
    }

    const raw = decodeResponseJson<KylinQueryResponse>(resp);
    if (raw.code && raw.code !== '000' && !raw.data) {
      throw new QueryError(raw.msg || `Kylin error ${raw.code}`, { code: raw.code });
    }
    const payload = raw.data ?? raw;
    if (payload.isException) {
      throw new QueryError(payload.exceptionMessage || 'Apache Kylin query error');
    }

    const columns: ColumnMeta[] = (payload.columnMetas ?? []).map((c, idx) => ({
      name: c.label || c.name || `col_${idx}`,
      dataType: c.columnTypeName || 'VARCHAR',
    }));
    const rawRows = payload.results ?? [];
    const maxRows = options?.maxRows;
    const truncated = Boolean(maxRows && rawRows.length > maxRows);
    const sliced = maxRows ? rawRows.slice(0, maxRows) : rawRows;
    const rows = sliced.map((r) => r.map(toCellValue));

    return {
      sql,
      columns,
      rows,
      rowCount: rows.length,
      affectedRows: payload.affectedRowCount ?? 0,
      executionMs: Math.round(performance.now() - started),
      truncated,
      commandTag: 'SELECT',
    };
  }

  private async executeDatabricks(sql: string, options?: QueryOptions): Promise<QueryResultSet> {
    const { transport, config, endpoint } = this.requireConnected();
    const started = performance.now();
    const cleanSql = stripTrailingSemicolon(sql);
    const timeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30000;
    const warehouseId = config.warehouseId || config.httpPath?.split('/').filter(Boolean).pop() || '';
    const catalog = options?.database || this.activeDatabase || config.database || undefined;
    const schema = options?.schema || this.activeSchema || config.schema || undefined;

    const reqBody: Record<string, unknown> = {
      statement: cleanSql,
      warehouse_id: warehouseId,
      wait_timeout: '30s',
      disposition: 'INLINE',
      format: 'JSON_ARRAY',
    };
    if (catalog) reqBody.catalog = catalog;
    if (schema) reqBody.schema = schema;
    if (options?.maxRows) reqBody.row_limit = options.maxRows;

    const firstResp = await sendHttpRequest(transport, endpoint, '/api/2.0/sql/statements', {
      method: 'POST',
      headers: this.buildBearerJsonHeaders(),
      body: JSON.stringify(reqBody),
      timeoutMs,
      signal: options?.signal,
    });
    if (firstResp.status >= 400) {
      throw new QueryError(decodeResponseText(firstResp).trim() || `Databricks HTTP ${firstResp.status}`);
    }

    let page = decodeResponseJson<DatabricksStatementResponse>(firstResp);
    const statementId = page.statement_id;
    let polls = 0;
    const maxPolls = 120;

    try {
      if (statementId) {
        this.activeCancelUrl = `/api/2.0/sql/statements/${encodeURIComponent(statementId)}/cancel`;
      }
      while (
        statementId &&
        (page.status?.state === 'PENDING' || page.status?.state === 'RUNNING') &&
        polls < maxPolls
      ) {
        if (options?.signal?.aborted) {
          await this.cancelQuery();
          throw new Error('Query cancelled');
        }
        polls++;
        const pollResp = await sendHttpRequest(
          transport,
          endpoint,
          `/api/2.0/sql/statements/${encodeURIComponent(statementId)}`,
          {
            method: 'GET',
            headers: this.buildBearerJsonHeaders(),
            timeoutMs,
            signal: options?.signal,
          },
        );
        if (pollResp.status >= 400) {
          throw new QueryError(
            decodeResponseText(pollResp).trim() || `Databricks poll HTTP ${pollResp.status}`,
          );
        }
        page = decodeResponseJson<DatabricksStatementResponse>(pollResp);
      }
    } finally {
      this.activeCancelUrl = null;
    }

    if (page.status?.state === 'FAILED' || page.status?.state === 'CANCELED') {
      throw new QueryError(
        page.status.error?.message || `Databricks statement ${page.status.state}`,
        { code: page.status.error?.error_code },
      );
    }

    const columns: ColumnMeta[] = (page.manifest?.schema?.columns ?? []).map((c) => ({
      name: c.name,
      dataType: c.type_text || c.type_name || 'STRING',
    }));
    const rawData = page.result?.data_array ?? [];
    const maxRows = options?.maxRows;
    const truncated = Boolean(maxRows && rawData.length > maxRows);
    const sliced = maxRows ? rawData.slice(0, maxRows) : rawData;
    const rows = sliced.map((r) => r.map(toCellValue));

    return {
      sql,
      columns,
      rows,
      rowCount: rows.length,
      affectedRows: 0,
      executionMs: Math.round(performance.now() - started),
      truncated,
      commandTag: isReadSqlStatement(cleanSql) ? 'SELECT' : 'OK',
    };
  }

  private async executeSnowflake(sql: string, options?: QueryOptions): Promise<QueryResultSet> {
    const { transport, config, endpoint } = this.requireConnected();
    const started = performance.now();
    const cleanSql = stripTrailingSemicolon(sql);
    const timeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30000;
    const database = options?.database || this.activeDatabase || config.database || undefined;
    const schema = options?.schema || this.activeSchema || config.schema || undefined;

    const reqBody: Record<string, unknown> = {
      statement: cleanSql,
      timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
    };
    if (database) reqBody.database = database;
    if (schema) reqBody.schema = schema;
    if (config.warehouseId) reqBody.warehouse = config.warehouseId;
    if (config.org) reqBody.role = config.org;

    let resp = await sendHttpRequest(transport, endpoint, '/api/v2/statements', {
      method: 'POST',
      headers: this.buildSnowflakeHeaders(),
      body: JSON.stringify(reqBody),
      timeoutMs,
      signal: options?.signal,
    });
    if (resp.status >= 400) {
      const errBody = decodeResponseText(resp).trim();
      let msg = errBody || `Snowflake HTTP ${resp.status}`;
      try {
        const parsedErr = JSON.parse(errBody) as { message?: string; code?: string };
        if (parsedErr.message) msg = parsedErr.message;
      } catch {
        // ignore
      }
      throw new QueryError(msg);
    }

    let page = decodeResponseJson<SnowflakeStatementResponse>(resp);
    let polls = 0;
    const maxPolls = 120;

    try {
      if (page.statementHandle) {
        this.activeCancelUrl = `/api/v2/statements/${encodeURIComponent(page.statementHandle)}/cancel`;
      }
      while (resp.status === 202 && page.statementHandle && polls < maxPolls) {
        if (options?.signal?.aborted) {
          await this.cancelQuery();
          throw new Error('Query cancelled');
        }
        polls++;
        const statusPath =
          page.statementStatusUrl || `/api/v2/statements/${encodeURIComponent(page.statementHandle)}`;
        resp = await sendHttpRequest(transport, endpoint, statusPath, {
          method: 'GET',
          headers: this.buildSnowflakeHeaders(),
          timeoutMs,
          signal: options?.signal,
        });
        if (resp.status >= 400) {
          throw new QueryError(decodeResponseText(resp).trim() || `Snowflake poll HTTP ${resp.status}`);
        }
        page = decodeResponseJson<SnowflakeStatementResponse>(resp);
      }
    } finally {
      this.activeCancelUrl = null;
    }

    const rowTypes = page.resultSetMetaData?.rowType ?? [];
    const columns: ColumnMeta[] = rowTypes.map((c) => ({
      name: c.name,
      dataType: c.type || 'text',
      nullable: c.nullable,
    }));

    const rawData = page.data ?? [];
    const maxRows = options?.maxRows;
    const truncated = Boolean(maxRows && rawData.length > maxRows);
    const sliced = maxRows ? rawData.slice(0, maxRows) : rawData;
    const rows: CellValue[][] = sliced.map((r) =>
      r.map((cell, idx) => coerceSnowflakeCell(cell, rowTypes[idx]?.type)),
    );

    return {
      sql,
      columns,
      rows,
      rowCount: rows.length,
      affectedRows: 0,
      executionMs: Math.round(performance.now() - started),
      truncated,
      commandTag: isReadSqlStatement(cleanSql) ? 'SELECT' : 'OK',
    };
  }

  private async executeBigQuery(sql: string, options?: QueryOptions): Promise<QueryResultSet> {
    const { transport, config, endpoint } = this.requireConnected();
    const started = performance.now();
    const cleanSql = stripTrailingSemicolon(sql);
    const timeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30000;
    const project = this.resolveBigQueryProject(options?.database);
    const dataset = options?.schema || this.activeSchema || config.schema;

    const reqBody: Record<string, unknown> = {
      query: cleanSql,
      useLegacySql: false,
      timeoutMs: Math.min(timeoutMs, 30000),
    };
    if (options?.maxRows) reqBody.maxResults = options.maxRows;
    if (config.region) reqBody.location = config.region;
    if (dataset) reqBody.defaultDataset = { projectId: project, datasetId: dataset };

    const resp = await sendHttpRequest(
      transport,
      endpoint,
      `/bigquery/v2/projects/${encodeURIComponent(project)}/queries`,
      {
        method: 'POST',
        headers: this.buildBearerJsonHeaders(),
        body: JSON.stringify(reqBody),
        timeoutMs,
        signal: options?.signal,
      },
    );
    if (resp.status >= 400) {
      throw new QueryError(decodeResponseText(resp).trim() || `BigQuery HTTP ${resp.status}`);
    }

    let page = decodeResponseJson<BigQueryQueryResponse>(resp);
    let polls = 0;
    const maxPolls = 120;

    while (page.jobComplete === false && page.jobReference?.jobId && polls < maxPolls) {
      if (options?.signal?.aborted) {
        throw new Error('Query cancelled');
      }
      polls++;
      const locParam = page.jobReference.location
        ? `?location=${encodeURIComponent(page.jobReference.location)}`
        : '';
      const pollResp = await sendHttpRequest(
        transport,
        endpoint,
        `/bigquery/v2/projects/${encodeURIComponent(project)}/queries/${encodeURIComponent(page.jobReference.jobId)}${locParam}`,
        {
          method: 'GET',
          headers: this.buildBearerJsonHeaders(),
          timeoutMs,
          signal: options?.signal,
        },
      );
      if (pollResp.status >= 400) {
        throw new QueryError(decodeResponseText(pollResp).trim() || `BigQuery poll HTTP ${pollResp.status}`);
      }
      page = decodeResponseJson<BigQueryQueryResponse>(pollResp);
    }

    if (page.error) {
      throw new QueryError(page.error.message || 'BigQuery error', {
        code: page.error.code !== undefined ? String(page.error.code) : undefined,
      });
    }
    if (page.errors && page.errors.length > 0) {
      throw new QueryError(page.errors[0].message || 'BigQuery query error', {
        code: page.errors[0].reason,
      });
    }

    const fields = page.schema?.fields ?? [];
    const columns: ColumnMeta[] = fields.map((f) => ({
      name: f.name,
      dataType: f.type || 'STRING',
      nullable: f.mode !== 'REQUIRED',
    }));

    const rawRows = page.rows ?? [];
    const maxRows = options?.maxRows;
    const truncated = Boolean(maxRows && rawRows.length > maxRows);
    const sliced = maxRows ? rawRows.slice(0, maxRows) : rawRows;
    const rows: CellValue[][] = sliced.map((r) =>
      (r.f ?? []).map((cell, idx) => coerceBigQueryCell(cell?.v, fields[idx]?.type)),
    );

    return {
      sql,
      columns,
      rows,
      rowCount: rows.length,
      affectedRows: page.numDmlAffectedRows ? Number(page.numDmlAffectedRows) : 0,
      executionMs: Math.round(performance.now() - started),
      truncated,
      commandTag: isReadSqlStatement(cleanSql) ? 'SELECT' : 'OK',
    };
  }

  private async executeSalesforce(sql: string, options?: QueryOptions): Promise<QueryResultSet> {
    const { transport, config, endpoint } = this.requireConnected();
    const started = performance.now();
    const cleanSql = stripTrailingSemicolon(sql);
    const timeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30000;

    let path = `/services/data/v61.0/query?q=${encodeURIComponent(cleanSql)}`;
    const allRecords: Array<Record<string, unknown>> = [];
    let truncated = false;
    let pages = 0;

    while (path && pages < 20) {
      pages++;
      const resp = await sendHttpRequest(transport, endpoint, path, {
        method: 'GET',
        headers: this.buildBearerJsonHeaders(),
        timeoutMs,
        signal: options?.signal,
      });
      if (resp.status >= 400) {
        const text = decodeResponseText(resp).trim();
        let msg = text || `Salesforce HTTP ${resp.status}`;
        try {
          const errs = JSON.parse(text) as Array<{ message?: string; errorCode?: string }>;
          if (Array.isArray(errs) && errs[0]?.message) {
            throw new QueryError(errs[0].message, { code: errs[0].errorCode });
          }
        } catch (err) {
          if (err instanceof QueryError) throw err;
        }
        throw new QueryError(msg);
      }

      const parsed = decodeResponseJson<SalesforceQueryResponse>(resp);
      for (const rec of parsed.records ?? []) {
        if (options?.maxRows && allRecords.length >= options.maxRows) {
          truncated = true;
          break;
        }
        allRecords.push(rec);
      }
      if (truncated || parsed.done !== false || !parsed.nextRecordsUrl) {
        break;
      }
      path = parsed.nextRecordsUrl;
    }

    const colSet = new Set<string>();
    for (const rec of allRecords) {
      for (const key of Object.keys(rec)) {
        if (key === 'attributes') continue;
        colSet.add(key);
      }
    }
    const colNames = Array.from(colSet);
    const columns: ColumnMeta[] = colNames.map((name) => ({
      name,
      dataType: name === 'Id' ? 'ID' : 'STRING',
      isPrimaryKey: name === 'Id',
    }));
    const rows: CellValue[][] = allRecords.map((rec) =>
      colNames.map((k) => {
        const val = rec[k];
        if (val && typeof val === 'object' && !Array.isArray(val) && 'attributes' in (val as Record<string, unknown>)) {
          const copy = { ...(val as Record<string, unknown>) };
          delete copy.attributes;
          return copy;
        }
        return toCellValue(val);
      }),
    );

    return {
      sql,
      columns,
      rows,
      rowCount: rows.length,
      affectedRows: 0,
      executionMs: Math.round(performance.now() - started),
      truncated,
      commandTag: 'SOQL',
    };
  }

  /* --------------------------------------------------------------------------
   * Transactions
   * -------------------------------------------------------------------------- */

  async beginTransaction(): Promise<void> {
    this.requireConnected();
    if (this._engine === 'rqlite' || this._engine === 'turso' || this._engine === 'cloudflare-d1') {
      this._inTransaction = true;
    }
  }

  async commitTransaction(): Promise<void> {
    this.requireConnected();
    this._inTransaction = false;
  }

  async rollbackTransaction(): Promise<void> {
    this.requireConnected();
    this._inTransaction = false;
  }

  /* --------------------------------------------------------------------------
   * Metadata Introspection
   * -------------------------------------------------------------------------- */

  async listDatabases(): Promise<DatabaseInfo[]> {
    const { transport, config, endpoint } = this.requireConnected();

    switch (this._engine) {
      case 'trino':
      case 'prestosql': {
        const res = await this.query('SHOW CATALOGS');
        return (res.results[0]?.rows ?? []).map((r) => ({ name: String(r[0]) }));
      }
      case 'tdengine':
      case 'databend': {
        const res = await this.query('SHOW DATABASES');
        return (res.results[0]?.rows ?? []).map((r) => ({ name: String(r[0]) }));
      }
      case 'rqlite':
      case 'turso': {
        try {
          const res = await this.query('PRAGMA database_list');
          const rows = res.results[0]?.rows ?? [];
          if (rows.length > 0) {
            return rows.map((r) => ({ name: String(r[1] ?? r[0] ?? 'main') }));
          }
        } catch {
          // fallback
        }
        return [{ name: this.activeDatabase || 'main' }];
      }
      case 'influxdb': {
        if (this.influxVersion === 2) {
          const org = config.org ? `?org=${encodeURIComponent(config.org)}` : '';
          const resp = await sendHttpRequest(transport, endpoint, `/api/v2/buckets${org}`, {
            method: 'GET',
            headers: this.buildInfluxHeaders(2),
            timeoutMs: config.timeoutMs ?? 15000,
          });
          if (resp.status >= 400) {
            throw new QueryError(
              decodeResponseText(resp).trim() || `InfluxDB buckets HTTP ${resp.status}`,
            );
          }
          const parsed = decodeResponseJson<{
            buckets?: Array<{ name: string; orgID?: string; type?: string }>;
          }>(resp);
          return (parsed.buckets ?? []).map((b) => ({ name: b.name }));
        }
        const res = await this.query('SHOW DATABASES');
        return (res.results[0]?.rows ?? []).map((r) => ({ name: String(r[0]) }));
      }
      case 'influxdb3': {
        try {
          const res = await this.query('SHOW DATABASES');
          const rows = res.results[0]?.rows ?? [];
          if (rows.length > 0) {
            return rows.map((r) => ({ name: String(r[0]) }));
          }
        } catch {
          // fallback
        }
        return [{ name: this.activeDatabase || 'default' }];
      }
      case 'victoriametrics':
        return [{ name: this.activeDatabase || 'metrics' }];
      case 'cloudflare-d1':
        return [{ name: this.activeDatabase || config.database || 'main' }];
      case 'iotdb': {
        try {
          const res = await this.query('SHOW DATABASES');
          const rows = res.results[0]?.rows ?? [];
          if (rows.length > 0) return rows.map((r) => ({ name: String(r[0]) }));
        } catch {
          try {
            const res = await this.query('SHOW STORAGE GROUP');
            return (res.results[0]?.rows ?? []).map((r) => ({ name: String(r[0]) }));
          } catch {
            // fallback
          }
        }
        return [{ name: 'root' }];
      }
      case 'kylin': {
        const resp = await sendHttpRequest(transport, endpoint, '/kylin/api/projects', {
          method: 'GET',
          headers: this.buildKylinHeaders(),
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (resp.status >= 400) {
          throw new QueryError(decodeResponseText(resp).trim() || `Kylin projects HTTP ${resp.status}`);
        }
        const parsed = decodeResponseJson<
          Array<{ name: string }> | { data?: { projects?: Array<{ name: string }> } | Array<{ name: string }> }
        >(resp);
        const list = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed.data)
            ? parsed.data
            : parsed.data?.projects ?? [];
        return list.map((p) => ({ name: p.name }));
      }
      case 'databricks': {
        const res = await this.query('SHOW CATALOGS');
        return (res.results[0]?.rows ?? []).map((r) => ({ name: String(r[0]) }));
      }
      case 'snowflake': {
        const res = await this.query('SHOW DATABASES');
        const cols = res.results[0]?.columns ?? [];
        const nameIdx = Math.max(0, cols.findIndex((c) => c.name.toLowerCase() === 'name'));
        return (res.results[0]?.rows ?? []).map((r) => ({ name: String(r[nameIdx] ?? r[0]) }));
      }
      case 'bigquery': {
        return [{ name: this.resolveBigQueryProject() }];
      }
      case 'salesforce': {
        return [{ name: this.activeDatabase || config.database || config.host || 'Salesforce Org' }];
      }
    }
  }

  async listSchemas(db?: string): Promise<SchemaInfo[]> {
    this.requireConnected();
    const targetDb = this.resolveDb(db);

    switch (this._engine) {
      case 'trino':
      case 'prestosql': {
        const sql = targetDb
          ? `SHOW SCHEMAS FROM ${quoteIdent(targetDb, 'trino')}`
          : 'SHOW SCHEMAS';
        const res = await this.query(sql, { database: targetDb || undefined });
        return (res.results[0]?.rows ?? []).map((r) => {
          const name = String(r[0]);
          return { name, isSystem: name.toLowerCase() === 'information_schema' };
        });
      }
      case 'tdengine':
      case 'databend': {
        if (targetDb) {
          return [{
            name: targetDb,
            isSystem: ['information_schema', 'performance_schema', 'system'].includes(
              targetDb.toLowerCase(),
            ),
          }];
        }
        const dbs = await this.listDatabases();
        return dbs.map((d) => ({
          name: d.name,
          isSystem: ['information_schema', 'performance_schema', 'system'].includes(
            d.name.toLowerCase(),
          ),
        }));
      }
      case 'rqlite':
      case 'turso':
        return [{ name: 'main', isSystem: false }];
      case 'influxdb':
        return [{ name: targetDb || 'default', isSystem: false }];
      case 'influxdb3':
        return [{ name: 'iox', isSystem: false }];
      case 'victoriametrics':
        return [{ name: 'promql', isSystem: false }];
      case 'cloudflare-d1':
        return [{ name: 'main', isSystem: false }];
      case 'iotdb':
        return [{ name: targetDb || 'root', isSystem: false }];
      case 'kylin': {
        const { transport, config, endpoint } = this.requireConnected();
        const project = targetDb || config.database || 'default';
        const resp = await sendHttpRequest(
          transport,
          endpoint,
          `/kylin/api/tables?project=${encodeURIComponent(project)}`,
          {
            method: 'GET',
            headers: this.buildKylinHeaders(),
            timeoutMs: config.timeoutMs ?? 15000,
          },
        );
        if (resp.status >= 400) return [{ name: 'DEFAULT', isSystem: false }];
        const parsed = decodeResponseJson<
          Array<{ database?: string }> | { data?: { tables?: Array<{ database?: string }> } | Array<{ database?: string }> }
        >(resp);
        const list = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed.data)
            ? parsed.data
            : parsed.data?.tables ?? [];
        const schemas = Array.from(new Set(list.map((t) => t.database || 'DEFAULT')));
        return schemas.length > 0
          ? schemas.map((name) => ({ name, isSystem: false }))
          : [{ name: 'DEFAULT', isSystem: false }];
      }
      case 'databricks': {
        const sql = targetDb
          ? `SHOW SCHEMAS IN ${quoteIdent(targetDb, 'trino')}`
          : 'SHOW SCHEMAS';
        const res = await this.query(sql, { database: targetDb || undefined });
        return (res.results[0]?.rows ?? []).map((r) => {
          const name = String(r[0]);
          return { name, isSystem: name.toLowerCase() === 'information_schema' };
        });
      }
      case 'snowflake': {
        const sql = targetDb
          ? `SHOW SCHEMAS IN DATABASE ${quoteIdent(targetDb, 'trino')}`
          : 'SHOW SCHEMAS';
        const res = await this.query(sql, { database: targetDb || undefined });
        const cols = res.results[0]?.columns ?? [];
        const nameIdx = Math.max(0, cols.findIndex((c) => c.name.toLowerCase() === 'name'));
        return (res.results[0]?.rows ?? []).map((r) => {
          const name = String(r[nameIdx] ?? r[0]);
          return { name, isSystem: name.toLowerCase() === 'information_schema' };
        });
      }
      case 'bigquery': {
        const { transport, config, endpoint } = this.requireConnected();
        const project = this.resolveBigQueryProject(targetDb);
        const resp = await sendHttpRequest(
          transport,
          endpoint,
          `/bigquery/v2/projects/${encodeURIComponent(project)}/datasets`,
          {
            method: 'GET',
            headers: this.buildBearerJsonHeaders(),
            timeoutMs: config.timeoutMs ?? 15000,
          },
        );
        if (resp.status >= 400) {
          throw new QueryError(decodeResponseText(resp).trim() || `BigQuery datasets HTTP ${resp.status}`);
        }
        const parsed = decodeResponseJson<{
          datasets?: Array<{ datasetReference?: { datasetId?: string } }>;
        }>(resp);
        return (parsed.datasets ?? [])
          .map((d) => d.datasetReference?.datasetId || '')
          .filter(Boolean)
          .map((name) => ({ name, isSystem: false }));
      }
      case 'salesforce':
        return [{ name: 'sobjects', isSystem: false }];
    }
  }

  async listTables(db?: string, schema?: string): Promise<TableSummary[]> {
    const { transport, config, endpoint } = this.requireConnected();
    const targetDb = this.resolveDb(db, schema);
    const targetSchema = this.resolveSchema(schema);

    switch (this._engine) {
      case 'trino':
      case 'prestosql': {
        const fromPart =
          targetDb && targetSchema
            ? ` FROM ${quoteIdent(targetDb, 'trino')}.${quoteIdent(targetSchema, 'trino')}`
            : targetSchema
              ? ` FROM ${quoteIdent(targetSchema, 'trino')}`
              : '';
        const res = await this.query(`SHOW TABLES${fromPart}`, {
          database: targetDb || undefined,
          schema: targetSchema || undefined,
        });
        return (res.results[0]?.rows ?? []).map((r) => ({
          name: String(r[0]),
          schema: targetSchema || 'default',
          database: targetDb,
          kind: 'table',
        }));
      }

      case 'tdengine': {
        const effectiveDb = targetDb || targetSchema;
        const [stablesRes, tablesRes] = await Promise.all([
          this.query('SHOW STABLES', { database: effectiveDb || undefined }).catch(() => null),
          this.query('SHOW TABLES', { database: effectiveDb || undefined }),
        ]);
        const seen = new Set<string>();
        const out: TableSummary[] = [];
        for (const r of stablesRes?.results[0]?.rows ?? []) {
          const name = String(r[0]);
          if (seen.has(name)) continue;
          seen.add(name);
          out.push({
            name,
            schema: effectiveDb,
            database: effectiveDb,
            kind: 'table',
            engine: 'STABLE',
          });
        }
        for (const r of tablesRes.results[0]?.rows ?? []) {
          const name = String(r[0]);
          if (seen.has(name)) continue;
          seen.add(name);
          out.push({
            name,
            schema: effectiveDb,
            database: effectiveDb,
            kind: 'table',
            engine: 'TABLE',
          });
        }
        return out;
      }

      case 'databend': {
        const effectiveDb = targetDb || targetSchema || 'default';
        const res = await this.query(`SHOW TABLES FROM ${quoteIdent(effectiveDb, 'trino')}`, {
          database: effectiveDb,
        });
        return (res.results[0]?.rows ?? []).map((r) => ({
          name: String(r[0]),
          schema: effectiveDb,
          database: effectiveDb,
          kind: 'table',
        }));
      }

      case 'rqlite':
      case 'turso':
      case 'cloudflare-d1': {
        const res = await this.query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        );
        return (res.results[0]?.rows ?? []).map((r) => ({
          name: String(r[0]),
          schema: 'main',
          database: targetDb || 'main',
          kind: 'table',
        }));
      }

      case 'influxdb': {
        const bucket = targetDb || targetSchema || 'default';
        if (this.influxVersion === 2) {
          const flux = `import "influxdata/influxdb/schema"\nschema.measurements(bucket: "${bucket.replaceAll('"', '\\"')}")`;
          const res = await this.query(flux);
          const rows = res.results[0]?.rows ?? [];
          const valIdx = Math.max(
            0,
            (res.results[0]?.columns ?? []).findIndex((c) => c.name === '_value'),
          );
          return rows
            .map((r) => String(r[valIdx] ?? r[0] ?? ''))
            .filter(Boolean)
            .map((name) => ({
              name,
              schema: bucket,
              database: bucket,
              kind: 'table',
              engine: 'measurement',
            }));
        }
        const res = await this.query('SHOW MEASUREMENTS', { database: bucket });
        return (res.results[0]?.rows ?? []).map((r) => ({
          name: String(r[0]),
          schema: bucket,
          database: bucket,
          kind: 'table',
          engine: 'measurement',
        }));
      }

      case 'influxdb3': {
        const effectiveDb = targetDb || 'default';
        const res = await this.query(
          "SELECT table_name, table_schema FROM information_schema.tables WHERE table_schema NOT IN ('information_schema', 'system') ORDER BY table_name",
          { database: effectiveDb },
        );
        return (res.results[0]?.rows ?? []).map((r) => ({
          name: String(r[0]),
          schema: String(r[1] ?? 'iox'),
          database: effectiveDb,
          kind: 'table',
        }));
      }

      case 'victoriametrics': {
        const resp = await sendHttpRequest(
          transport,
          endpoint,
          '/api/v1/label/__name__/values',
          {
            method: 'GET',
            headers: this.buildVictoriaHeaders(),
            timeoutMs: config.timeoutMs ?? 15000,
          },
        );
        if (resp.status >= 400) {
          throw new QueryError(
            decodeResponseText(resp).trim() || `VictoriaMetrics HTTP ${resp.status}`,
          );
        }
        const parsed = decodeResponseJson<{ data?: string[] }>(resp);
        return (parsed.data ?? []).map((name) => ({
          name,
          schema: 'promql',
          database: targetDb || 'metrics',
          kind: 'table',
          engine: 'metric',
        }));
      }

      case 'iotdb': {
        const prefix = targetDb || 'root';
        try {
          const res = await this.query(`SHOW DEVICES ${prefix}.**`);
          const rows = res.results[0]?.rows ?? [];
          if (rows.length > 0) {
            return rows.map((r) => ({
              name: String(r[0]),
              schema: prefix,
              database: prefix,
              kind: 'table',
              engine: 'device',
            }));
          }
        } catch {
          // fallback to SHOW TIMESERIES
        }
        const tsRes = await this.query(`SHOW TIMESERIES ${prefix}.**`);
        return (tsRes.results[0]?.rows ?? []).map((r) => ({
          name: String(r[0]),
          schema: prefix,
          database: prefix,
          kind: 'table',
          engine: 'timeseries',
        }));
      }

      case 'kylin': {
        const project = targetDb || config.database || 'default';
        const resp = await sendHttpRequest(
          transport,
          endpoint,
          `/kylin/api/tables?project=${encodeURIComponent(project)}`,
          {
            method: 'GET',
            headers: this.buildKylinHeaders(),
            timeoutMs: config.timeoutMs ?? 15000,
          },
        );
        if (resp.status >= 400) {
          throw new QueryError(decodeResponseText(resp).trim() || `Kylin tables HTTP ${resp.status}`);
        }
        const parsed = decodeResponseJson<
          | Array<{ name: string; database?: string }>
          | { data?: { tables?: Array<{ name: string; database?: string }> } | Array<{ name: string; database?: string }> }
        >(resp);
        const list = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed.data)
            ? parsed.data
            : parsed.data?.tables ?? [];
        return list
          .filter((t) => !targetSchema || !t.database || t.database === targetSchema)
          .map((t) => ({
            name: t.name,
            schema: t.database || targetSchema || 'DEFAULT',
            database: project,
            kind: 'table',
          }));
      }

      case 'databricks': {
        const inTarget =
          targetDb && targetSchema
            ? ` IN ${quoteIdent(targetDb, 'trino')}.${quoteIdent(targetSchema, 'trino')}`
            : targetSchema
              ? ` IN ${quoteIdent(targetSchema, 'trino')}`
              : '';
        const res = await this.query(`SHOW TABLES${inTarget}`, {
          database: targetDb || undefined,
          schema: targetSchema || undefined,
        });
        const cols = res.results[0]?.columns ?? [];
        const nameIdx = Math.max(0, cols.findIndex((c) => /tableName|table_name|name/i.test(c.name)));
        return (res.results[0]?.rows ?? []).map((r) => ({
          name: String(r[nameIdx] ?? r[1] ?? r[0]),
          schema: targetSchema || 'default',
          database: targetDb,
          kind: 'table',
        }));
      }

      case 'snowflake': {
        const inTarget =
          targetDb && targetSchema
            ? ` IN SCHEMA ${quoteIdent(targetDb, 'trino')}.${quoteIdent(targetSchema, 'trino')}`
            : targetSchema
              ? ` IN SCHEMA ${quoteIdent(targetSchema, 'trino')}`
              : '';
        const res = await this.query(`SHOW TABLES${inTarget}`, {
          database: targetDb || undefined,
          schema: targetSchema || undefined,
        });
        const cols = res.results[0]?.columns ?? [];
        const nameIdx = Math.max(0, cols.findIndex((c) => c.name.toLowerCase() === 'name'));
        return (res.results[0]?.rows ?? []).map((r) => ({
          name: String(r[nameIdx] ?? r[1] ?? r[0]),
          schema: targetSchema || 'PUBLIC',
          database: targetDb,
          kind: 'table',
        }));
      }

      case 'bigquery': {
        const project = this.resolveBigQueryProject(targetDb);
        const dataset = targetSchema;
        if (!dataset) return [];
        const resp = await sendHttpRequest(
          transport,
          endpoint,
          `/bigquery/v2/projects/${encodeURIComponent(project)}/datasets/${encodeURIComponent(dataset)}/tables`,
          {
            method: 'GET',
            headers: this.buildBearerJsonHeaders(),
            timeoutMs: config.timeoutMs ?? 15000,
          },
        );
        if (resp.status >= 400) {
          throw new QueryError(decodeResponseText(resp).trim() || `BigQuery tables HTTP ${resp.status}`);
        }
        const parsed = decodeResponseJson<{
          tables?: Array<{
            tableReference?: { tableId?: string };
            type?: string;
          }>;
        }>(resp);
        return (parsed.tables ?? [])
          .filter((t) => t.type !== 'VIEW')
          .map((t) => ({
            name: t.tableReference?.tableId || '',
            schema: dataset,
            database: project,
            kind: t.type === 'MATERIALIZED_VIEW' ? ('materialized_view' as const) : ('table' as const),
          }))
          .filter((t) => Boolean(t.name));
      }

      case 'salesforce': {
        const resp = await sendHttpRequest(transport, endpoint, '/services/data/v61.0/sobjects', {
          method: 'GET',
          headers: this.buildBearerJsonHeaders(),
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (resp.status >= 400) {
          throw new QueryError(decodeResponseText(resp).trim() || `Salesforce sobjects HTTP ${resp.status}`);
        }
        const parsed = decodeResponseJson<{
          sobjects?: Array<{ name: string; label?: string; queryable?: boolean; custom?: boolean }>;
        }>(resp);
        return (parsed.sobjects ?? [])
          .filter((s) => s.queryable !== false)
          .map((s) => ({
            name: s.name,
            schema: 'sobjects',
            database: targetDb || config.host || 'Salesforce Org',
            kind: 'table',
            engine: s.custom ? 'CustomObject' : 'SObject',
            comment: s.label,
          }));
      }
    }
  }

  async listViews(db?: string, schema?: string): Promise<ViewSummary[]> {
    this.requireConnected();
    const targetDb = this.resolveDb(db, schema);
    const targetSchema = this.resolveSchema(schema);

    if (this._engine === 'rqlite' || this._engine === 'turso' || this._engine === 'cloudflare-d1') {
      const res = await this.query(
        "SELECT name, sql FROM sqlite_master WHERE type = 'view' ORDER BY name",
      );
      return (res.results[0]?.rows ?? []).map((r) => ({
        name: String(r[0]),
        schema: 'main',
        database: targetDb || 'main',
        definition: r[1] ? String(r[1]) : undefined,
      }));
    }

    if (this._engine === 'bigquery') {
      const { transport, config, endpoint } = this.requireConnected();
      const project = this.resolveBigQueryProject(targetDb);
      const dataset = targetSchema;
      if (!dataset) return [];
      try {
        const resp = await sendHttpRequest(
          transport,
          endpoint,
          `/bigquery/v2/projects/${encodeURIComponent(project)}/datasets/${encodeURIComponent(dataset)}/tables`,
          {
            method: 'GET',
            headers: this.buildBearerJsonHeaders(),
            timeoutMs: config.timeoutMs ?? 15000,
          },
        );
        if (resp.status >= 400) return [];
        const parsed = decodeResponseJson<{
          tables?: Array<{ tableReference?: { tableId?: string }; type?: string }>;
        }>(resp);
        return (parsed.tables ?? [])
          .filter((t) => t.type === 'VIEW' || t.type === 'MATERIALIZED_VIEW')
          .map((t) => ({
            name: t.tableReference?.tableId || '',
            schema: dataset,
            database: project,
            isMaterialized: t.type === 'MATERIALIZED_VIEW',
          }))
          .filter((v) => Boolean(v.name));
      } catch {
        return [];
      }
    }

    if (this._engine === 'trino' || this._engine === 'prestosql') {
      try {
        const infoSchema = targetDb
          ? `${quoteIdent(targetDb, 'trino')}.information_schema.views`
          : 'information_schema.views';
        const where = targetSchema
          ? ` WHERE table_schema = '${escapeSqlString(targetSchema)}'`
          : '';
        const res = await this.query(
          `SELECT table_name, view_definition FROM ${infoSchema}${where} ORDER BY table_name`,
          { database: targetDb || undefined, schema: targetSchema || undefined },
        );
        return (res.results[0]?.rows ?? []).map((r) => ({
          name: String(r[0]),
          schema: targetSchema || 'default',
          database: targetDb,
          definition: r[1] ? String(r[1]) : undefined,
        }));
      } catch {
        return [];
      }
    }

    if (this._engine === 'databend') {
      try {
        const effectiveDb = targetDb || targetSchema || 'default';
        const res = await this.query(
          `SELECT table_name, view_definition FROM information_schema.views WHERE table_schema = '${escapeSqlString(effectiveDb)}' ORDER BY table_name`,
          { database: effectiveDb },
        );
        return (res.results[0]?.rows ?? []).map((r) => ({
          name: String(r[0]),
          schema: effectiveDb,
          database: effectiveDb,
          definition: r[1] ? String(r[1]) : undefined,
        }));
      } catch {
        return [];
      }
    }

    return [];
  }

  async listRoutines(): Promise<RoutineSummary[]> {
    this.requireConnected();
    return [];
  }

  async listTriggers(db?: string): Promise<TriggerSummary[]> {
    this.requireConnected();
    if (this._engine === 'rqlite' || this._engine === 'turso' || this._engine === 'cloudflare-d1') {
      const targetDb = this.resolveDb(db) || 'main';
      const res = await this.query(
        "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
      );
      return (res.results[0]?.rows ?? []).map((r) => ({
        name: String(r[0]),
        schema: 'main',
        database: targetDb,
        tableName: String(r[1] ?? ''),
        definition: r[2] ? String(r[2]) : undefined,
      }));
    }
    return [];
  }

  async getTableStructure(db: string, schema: string, table: string): Promise<TableStructure> {
    this.requireConnected();
    const targetDb = this.resolveDb(db, schema);
    const targetSchema = this.resolveSchema(schema);

    if (this._engine === 'rqlite' || this._engine === 'turso' || this._engine === 'cloudflare-d1') {
      return this.getSqliteTableStructure(targetDb || 'main', table);
    }

    if (this._engine === 'iotdb') {
      const res = await this.query(`SHOW TIMESERIES ${table}.*`).catch(() => null);
      const columns: ColumnStructure[] = [
        {
          name: 'Time',
          dataType: 'TIMESTAMP',
          nullable: false,
          defaultValue: null,
          isPrimaryKey: true,
          isAutoIncrement: false,
        },
        ...(res?.results[0]?.rows ?? []).map((r) => ({
          name: String(r[0]),
          dataType: String(r[3] ?? r[1] ?? 'TEXT'),
          nullable: true,
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        })),
      ];
      return {
        database: targetDb || 'root',
        schema: targetSchema || targetDb || 'root',
        table,
        columns,
        indexes: [],
        foreignKeys: [],
        checkConstraints: [],
        createDdl: '',
      };
    }

    if (this._engine === 'kylin') {
      const { transport, config, endpoint } = this.requireConnected();
      const project = targetDb || config.database || 'default';
      const resp = await sendHttpRequest(
        transport,
        endpoint,
        `/kylin/api/tables?project=${encodeURIComponent(project)}&ext=true`,
        {
          method: 'GET',
          headers: this.buildKylinHeaders(),
          timeoutMs: config.timeoutMs ?? 15000,
        },
      );
      if (resp.status >= 400) {
        throw new QueryError(decodeResponseText(resp).trim() || `Kylin describe HTTP ${resp.status}`);
      }
      const parsed = decodeResponseJson<
        | Array<{ name: string; database?: string; columns?: Array<{ name: string; datatype?: string; is_nullable?: boolean; comment?: string }> }>
        | { data?: { tables?: Array<{ name: string; database?: string; columns?: Array<{ name: string; datatype?: string; is_nullable?: boolean; comment?: string }> }> } }
      >(resp);
      const list = Array.isArray(parsed) ? parsed : parsed.data?.tables ?? [];
      const found = list.find(
        (t) =>
          t.name.toLowerCase() === table.toLowerCase() &&
          (!targetSchema || !t.database || t.database.toLowerCase() === targetSchema.toLowerCase()),
      );
      const columns: ColumnStructure[] = (found?.columns ?? []).map((c) => ({
        name: c.name,
        dataType: c.datatype || 'VARCHAR',
        nullable: c.is_nullable !== false,
        defaultValue: null,
        isPrimaryKey: false,
        isAutoIncrement: false,
        comment: c.comment ?? null,
      }));
      return {
        database: project,
        schema: found?.database || targetSchema || 'DEFAULT',
        table,
        columns,
        indexes: [],
        foreignKeys: [],
        checkConstraints: [],
        createDdl: '',
      };
    }

    if (this._engine === 'databricks' || this._engine === 'snowflake') {
      const qTable = qualifiedTableName(targetDb, targetSchema, table, 'trino');
      const res = await this.query(`DESCRIBE TABLE ${qTable}`, {
        database: targetDb || undefined,
        schema: targetSchema || undefined,
      });
      const columns: ColumnStructure[] = (res.results[0]?.rows ?? [])
        .filter((r) => {
          const n = String(r[0] ?? '').trim();
          return n.length > 0 && !n.startsWith('#');
        })
        .map((r) => ({
          name: String(r[0]),
          dataType: String(r[1] ?? 'STRING'),
          nullable: r[3] !== undefined ? String(r[3]).toUpperCase() !== 'N' : true,
          defaultValue: null,
          isPrimaryKey: r[5] !== undefined ? String(r[5]).toUpperCase() === 'Y' : false,
          isAutoIncrement: false,
          comment: r[2] ? String(r[2]) : null,
        }));
      return {
        database: targetDb,
        schema: targetSchema,
        table,
        columns,
        indexes: [],
        foreignKeys: [],
        checkConstraints: [],
        createDdl: buildCreateTableDdl('trino', targetDb, targetSchema, {
          name: table,
          columns: columns.map((c) => ({
            name: c.name,
            dataType: c.dataType,
            nullable: c.nullable,
          })),
        }),
      };
    }

    if (this._engine === 'bigquery') {
      const { transport, config, endpoint } = this.requireConnected();
      const project = this.resolveBigQueryProject(targetDb);
      const dataset = targetSchema;
      const resp = await sendHttpRequest(
        transport,
        endpoint,
        `/bigquery/v2/projects/${encodeURIComponent(project)}/datasets/${encodeURIComponent(dataset)}/tables/${encodeURIComponent(table)}`,
        {
          method: 'GET',
          headers: this.buildBearerJsonHeaders(),
          timeoutMs: config.timeoutMs ?? 15000,
        },
      );
      if (resp.status >= 400) {
        throw new QueryError(decodeResponseText(resp).trim() || `BigQuery table HTTP ${resp.status}`);
      }
      const parsed = decodeResponseJson<{
        schema?: { fields?: Array<{ name: string; type?: string; mode?: string; description?: string }> };
        numRows?: string;
        numBytes?: string;
        description?: string;
      }>(resp);
      const columns: ColumnStructure[] = (parsed.schema?.fields ?? []).map((f) => ({
        name: f.name,
        dataType: f.mode === 'REPEATED' ? `ARRAY<${f.type || 'STRING'}>` : f.type || 'STRING',
        nullable: f.mode !== 'REQUIRED',
        defaultValue: null,
        isPrimaryKey: false,
        isAutoIncrement: false,
        comment: f.description ?? null,
      }));
      return {
        database: project,
        schema: dataset,
        table,
        columns,
        indexes: [],
        foreignKeys: [],
        checkConstraints: [],
        rowCountEstimate: parsed.numRows ? Number(parsed.numRows) : undefined,
        dataBytes: parsed.numBytes ? Number(parsed.numBytes) : undefined,
        comment: parsed.description ?? null,
        createDdl: '',
      };
    }

    if (this._engine === 'salesforce') {
      const { transport, config, endpoint } = this.requireConnected();
      const resp = await sendHttpRequest(
        transport,
        endpoint,
        `/services/data/v61.0/sobjects/${encodeURIComponent(table)}/describe`,
        {
          method: 'GET',
          headers: this.buildBearerJsonHeaders(),
          timeoutMs: config.timeoutMs ?? 15000,
        },
      );
      if (resp.status >= 400) {
        throw new QueryError(decodeResponseText(resp).trim() || `Salesforce describe HTTP ${resp.status}`);
      }
      const parsed = decodeResponseJson<{
        label?: string;
        fields?: Array<{
          name: string;
          label?: string;
          type?: string;
          nillable?: boolean;
          length?: number;
          defaultValue?: unknown;
          unique?: boolean;
        }>;
      }>(resp);
      const columns: ColumnStructure[] = (parsed.fields ?? []).map((f) => ({
        name: f.name,
        dataType: f.type || 'string',
        nullable: f.nillable !== false,
        defaultValue: f.defaultValue !== null && f.defaultValue !== undefined ? String(f.defaultValue) : null,
        isPrimaryKey: f.name === 'Id' || f.type === 'id',
        isAutoIncrement: false,
        unique: Boolean(f.unique),
        maxLength: typeof f.length === 'number' && f.length > 0 ? f.length : null,
        comment: f.label ?? null,
      }));
      return {
        database: targetDb || 'Salesforce Org',
        schema: 'sobjects',
        table,
        columns,
        indexes: [],
        foreignKeys: [],
        checkConstraints: [],
        comment: parsed.label ?? null,
        createDdl: '',
      };
    }

    if (this._engine === 'trino' || this._engine === 'prestosql') {
      const qTable = qualifiedTableName(targetDb, targetSchema, table, 'trino');
      const res = await this.query(`DESCRIBE ${qTable}`, {
        database: targetDb || undefined,
        schema: targetSchema || undefined,
      });
      const columns: ColumnStructure[] = (res.results[0]?.rows ?? []).map((r) => ({
        name: String(r[0]),
        dataType: String(r[1] ?? 'varchar'),
        nullable: true,
        defaultValue: null,
        isPrimaryKey: false,
        isAutoIncrement: false,
        extra: r[2] ? String(r[2]) : null,
        comment: r[3] ? String(r[3]) : null,
      }));
      return {
        database: targetDb,
        schema: targetSchema,
        table,
        columns,
        indexes: [],
        foreignKeys: [],
        checkConstraints: [],
        createDdl: buildCreateTableDdl('trino', targetDb, targetSchema, {
          name: table,
          columns: columns.map((c) => ({
            name: c.name,
            dataType: c.dataType,
            nullable: c.nullable,
          })),
        }),
      };
    }

    if (this._engine === 'tdengine') {
      const effectiveDb = targetDb || targetSchema;
      const qTable = qualifiedTableName(effectiveDb, '', table, 'tdengine');
      const res = await this.query(`DESCRIBE ${qTable}`, {
        database: effectiveDb || undefined,
      });
      const columns: ColumnStructure[] = (res.results[0]?.rows ?? []).map((r, idx) => {
        const dataType = String(r[1] ?? 'VARCHAR');
        const note = r[3] ? String(r[3]) : null;
        return {
          name: String(r[0]),
          dataType,
          nullable: idx !== 0,
          defaultValue: null,
          isPrimaryKey: idx === 0 && /timestamp/i.test(dataType),
          isAutoIncrement: false,
          maxLength: r[2] !== null && r[2] !== undefined ? Number(r[2]) : null,
          extra: note,
        };
      });
      return {
        database: effectiveDb,
        schema: effectiveDb,
        table,
        columns,
        indexes: [],
        foreignKeys: [],
        checkConstraints: [],
        createDdl: buildCreateTableDdl('tdengine', effectiveDb, '', {
          name: table,
          columns: columns.map((c) => ({
            name: c.name,
            dataType: c.dataType,
            nullable: c.nullable,
          })),
        }),
      };
    }

    if (this._engine === 'databend') {
      const effectiveDb = targetDb || targetSchema || 'default';
      const qTable = qualifiedTableName(effectiveDb, '', table, 'trino');
      const res = await this.query(`DESCRIBE ${qTable}`, { database: effectiveDb });
      const columns: ColumnStructure[] = (res.results[0]?.rows ?? []).map((r) => ({
        name: String(r[0]),
        dataType: String(r[1] ?? 'VARCHAR'),
        nullable: r[2] === undefined ? true : String(r[2]).toUpperCase() !== 'NO',
        defaultValue: r[3] !== undefined && r[3] !== null && String(r[3]) !== '' ? String(r[3]) : null,
        isPrimaryKey: false,
        isAutoIncrement: false,
        extra: r[4] ? String(r[4]) : null,
      }));
      return {
        database: effectiveDb,
        schema: effectiveDb,
        table,
        columns,
        indexes: [],
        foreignKeys: [],
        checkConstraints: [],
        createDdl: buildCreateTableDdl('trino', effectiveDb, '', {
          name: table,
          columns: columns.map((c) => ({
            name: c.name,
            dataType: c.dataType,
            nullable: c.nullable,
            defaultValue: c.defaultValue,
          })),
        }),
      };
    }

    if (this._engine === 'influxdb') {
      const effectiveDb = targetDb || targetSchema || 'default';
      if (this.influxVersion === 1) {
        const qTbl = quoteIdent(table, 'influx');
        const [tagsRes, fieldsRes] = await Promise.all([
          this.query(`SHOW TAG KEYS FROM ${qTbl}`, { database: effectiveDb }).catch(() => null),
          this.query(`SHOW FIELD KEYS FROM ${qTbl}`, { database: effectiveDb }).catch(() => null),
        ]);
        const columns: ColumnStructure[] = [
          {
            name: 'time',
            dataType: 'TIMESTAMP',
            nullable: false,
            defaultValue: null,
            isPrimaryKey: true,
            isAutoIncrement: false,
          },
        ];
        for (const r of tagsRes?.results[0]?.rows ?? []) {
          columns.push({
            name: String(r[0]),
            dataType: 'TAG',
            nullable: true,
            defaultValue: null,
            isPrimaryKey: false,
            isAutoIncrement: false,
            extra: 'TAG',
          });
        }
        for (const r of fieldsRes?.results[0]?.rows ?? []) {
          columns.push({
            name: String(r[0]),
            dataType: String(r[1] ?? 'FLOAT'),
            nullable: true,
            defaultValue: null,
            isPrimaryKey: false,
            isAutoIncrement: false,
            extra: 'FIELD',
          });
        }
        return {
          database: effectiveDb,
          schema: effectiveDb,
          table,
          columns,
          indexes: [],
          foreignKeys: [],
          checkConstraints: [],
          createDdl: '',
        };
      }
      return {
        database: effectiveDb,
        schema: effectiveDb,
        table,
        columns: [
          { name: '_time', dataType: 'dateTime:RFC3339', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: false },
          { name: '_measurement', dataType: 'string', nullable: false, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
          { name: '_field', dataType: 'string', nullable: false, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
          { name: '_value', dataType: 'double', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
        ],
        indexes: [],
        foreignKeys: [],
        checkConstraints: [],
        createDdl: '',
      };
    }

    if (this._engine === 'influxdb3') {
      const effectiveDb = targetDb || 'default';
      const res = await this.query(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = '${escapeSqlString(table)}' ORDER BY ordinal_position`,
        { database: effectiveDb },
      );
      const columns: ColumnStructure[] = (res.results[0]?.rows ?? []).map((r) => ({
        name: String(r[0]),
        dataType: String(r[1] ?? 'STRING'),
        nullable: String(r[2] ?? 'YES').toUpperCase() !== 'NO',
        defaultValue: null,
        isPrimaryKey: String(r[0]) === 'time',
        isAutoIncrement: false,
      }));
      return {
        database: effectiveDb,
        schema: targetSchema || 'iox',
        table,
        columns,
        indexes: [],
        foreignKeys: [],
        checkConstraints: [],
        createDdl: '',
      };
    }

    // VictoriaMetrics normalized schema
    return {
      database: targetDb || 'metrics',
      schema: 'promql',
      table,
      columns: [
        { name: 'metric', dataType: 'TEXT', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: false },
        { name: 'labels', dataType: 'JSON', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
        { name: 'timestamp', dataType: 'TIMESTAMP', nullable: false, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
        { name: 'value', dataType: 'DOUBLE', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
      ],
      indexes: [],
      foreignKeys: [],
      checkConstraints: [],
      createDdl: '',
    };
  }

  private async getSqliteTableStructure(db: string, table: string): Promise<TableStructure> {
    const qTbl = quoteIdent(table, 'sqlite');
    const [infoRes, fkRes, idxRes, ddlRes] = await Promise.all([
      this.query(`PRAGMA table_info(${qTbl})`),
      this.query(`PRAGMA foreign_key_list(${qTbl})`).catch(() => null),
      this.query(`PRAGMA index_list(${qTbl})`).catch(() => null),
      this.query(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${escapeSqlString(table)}'`,
      ).catch(() => null),
    ]);

    const columns: ColumnStructure[] = (infoRes.results[0]?.rows ?? []).map((r) => {
      const pkOrdinal = Number(r[5] ?? 0);
      return {
        name: String(r[1]),
        dataType: String(r[2] || 'TEXT'),
        nullable: Number(r[3] ?? 0) === 0 && pkOrdinal === 0,
        defaultValue: r[4] !== null && r[4] !== undefined ? String(r[4]) : null,
        isPrimaryKey: pkOrdinal > 0,
        primaryKeyOrdinal: pkOrdinal > 0 ? pkOrdinal : undefined,
        isAutoIncrement: false,
      };
    });

    const fkGroups = new Map<number, ForeignKeyStructure>();
    for (const r of fkRes?.results[0]?.rows ?? []) {
      const id = Number(r[0]);
      const existing = fkGroups.get(id);
      if (existing) {
        existing.columns.push(String(r[3]));
        existing.referencedColumns.push(String(r[4]));
      } else {
        fkGroups.set(id, {
          name: `fk_${table}_${id}`,
          columns: [String(r[3])],
          referencedSchema: 'main',
          referencedTable: String(r[2]),
          referencedColumns: [String(r[4])],
          onUpdate: r[5] ? String(r[5]) : undefined,
          onDelete: r[6] ? String(r[6]) : undefined,
        });
      }
    }

    const indexes: IndexStructure[] = (idxRes?.results[0]?.rows ?? []).map((r) => ({
      name: String(r[1]),
      columns: [],
      unique: Number(r[2] ?? 0) === 1,
      primary: String(r[3] ?? '') === 'pk',
    }));

    const ddlRaw = ddlRes?.results[0]?.rows[0]?.[0];
    const createDdl = ddlRaw ? `${String(ddlRaw).trim()};` : '';

    return {
      database: db,
      schema: 'main',
      table,
      columns,
      indexes,
      foreignKeys: Array.from(fkGroups.values()),
      checkConstraints: [],
      createDdl,
    };
  }

  async getSchemaErGraph(db: string, schema = ''): Promise<SchemaErGraph> {
    const targetDb = this.resolveDb(db, schema);
    const targetSchema = this.resolveSchema(schema);
    const tables = await this.listTables(targetDb, targetSchema);
    const erTables: SchemaErGraph['tables'] = [];
    const edges: SchemaErEdge[] = [];

    for (const t of tables) {
      const s = await this.getTableStructure(targetDb, targetSchema, t.name);
      erTables.push({ name: t.name, schema: s.schema, columns: s.columns });
      for (const fk of s.foreignKeys) {
        edges.push({
          id: `${t.name}.${fk.name}`,
          name: fk.name,
          sourceTable: t.name,
          sourceColumns: fk.columns,
          targetTable: fk.referencedTable,
          targetColumns: fk.referencedColumns,
          onDelete: fk.onDelete,
          onUpdate: fk.onUpdate,
        });
      }
    }

    return { database: targetDb, schema: targetSchema, tables: erTables, edges };
  }

  /* --------------------------------------------------------------------------
   * Browse / Mutations / Explain / DDL / Dump / Diff
   * -------------------------------------------------------------------------- */

  async browseTable(
    db: string,
    schema: string,
    table: string,
    options?: BrowseTableOptions,
  ): Promise<BrowseTableResult> {
    this.requireConnected();
    const targetDb = this.resolveDb(db, schema);
    const targetSchema = this.resolveSchema(schema);
    const page = Math.max(1, options?.page ?? 1);
    const pageSize = Math.min(1000, Math.max(1, options?.pageSize ?? 50));
    const offset = (page - 1) * pageSize;
    const started = performance.now();

    if (this._engine === 'victoriametrics') {
      const expr = options?.whereClause?.trim() ? `${table}{${options.whereClause.trim()}}` : table;
      const res = await this.query(expr, { signal: options?.signal });
      const rs = res.results[0];
      const allRows = rs?.rows ?? [];
      return {
        database: targetDb || 'metrics',
        schema: 'promql',
        table,
        columns: rs?.columns ?? [],
        rows: allRows.slice(offset, offset + pageSize),
        page,
        pageSize,
        totalRows: allRows.length,
        totalEstimated: false,
        executionMs: Math.round(performance.now() - started),
        sql: expr,
      };
    }

    if (this._engine === 'influxdb' && this.influxVersion === 2) {
      const bucket = targetDb || 'default';
      const flux = [
        `from(bucket: "${bucket.replaceAll('"', '\\"')}")`,
        `  |> range(start: -30d)`,
        `  |> filter(fn: (r) => r._measurement == "${table.replaceAll('"', '\\"')}")`,
        `  |> limit(n: ${pageSize}, offset: ${offset})`,
      ].join('\n');
      const res = await this.query(flux, { signal: options?.signal });
      const rs = res.results[0];
      return {
        database: bucket,
        schema: bucket,
        table,
        columns: rs?.columns ?? [],
        rows: rs?.rows ?? [],
        page,
        pageSize,
        totalRows: rs?.rowCount ?? 0,
        totalEstimated: true,
        executionMs: Math.round(performance.now() - started),
        sql: flux,
      };
    }

    if (this._engine === 'salesforce') {
      const structure = await this.getTableStructure(targetDb, targetSchema, table).catch(() => null);
      const fieldNames = (structure?.columns ?? []).slice(0, 25).map((c) => c.name);
      const selectCols = fieldNames.length > 0 ? fieldNames.join(', ') : 'Id, Name';
      const where = options?.whereClause?.trim() ? ` WHERE ${options.whereClause.trim()}` : '';
      const order = options?.sortBy
        ? ` ORDER BY ${options.sortBy} ${options.sortDir === 'desc' ? 'DESC' : 'ASC'}`
        : '';
      const soql = `SELECT ${selectCols} FROM ${table}${where}${order} LIMIT ${pageSize} OFFSET ${offset}`;
      const res = await this.query(soql, { maxRows: pageSize, signal: options?.signal });
      const rs = res.results[0];
      return {
        database: targetDb || 'Salesforce Org',
        schema: 'sobjects',
        table,
        columns: rs?.columns ?? [],
        rows: rs?.rows ?? [],
        page,
        pageSize,
        totalRows: rs?.rowCount ?? 0,
        totalEstimated: true,
        executionMs: Math.round(performance.now() - started),
        sql: soql,
      };
    }

    const qTable =
      this._engine === 'bigquery'
        ? `\`${targetDb}.${targetSchema}.${table}\``
        : this._engine === 'iotdb'
          ? table
          : qualifiedTableName(targetDb, targetSchema, table, this.dialect);
    const where = options?.whereClause?.trim() ? ` WHERE ${options.whereClause.trim()}` : '';
    const order = options?.sortBy
      ? ` ORDER BY ${quoteIdent(options.sortBy, this.dialect)} ${options.sortDir === 'desc' ? 'DESC' : 'ASC'}`
      : '';
    const limitClause =
      this._engine === 'trino' || this._engine === 'prestosql'
        ? ` OFFSET ${offset} LIMIT ${pageSize}`
        : ` LIMIT ${pageSize} OFFSET ${offset}`;

    const dataSql = `SELECT * FROM ${qTable}${where}${order}${limitClause}`;
    const countSql = `SELECT COUNT(*) FROM ${qTable}${where}`;

    const [dataRes, countRes] = await Promise.all([
      this.query(dataSql, {
        maxRows: pageSize,
        signal: options?.signal,
        database: targetDb || undefined,
        schema: targetSchema || undefined,
      }),
      this.query(countSql, {
        maxRows: 1,
        signal: options?.signal,
        database: targetDb || undefined,
        schema: targetSchema || undefined,
      }).catch(() => null),
    ]);

    const rs = dataRes.results[0];
    const countCell = countRes?.results[0]?.rows[0]?.[0];
    const totalRows = countCell !== undefined && countCell !== null ? Number(countCell) : rs?.rowCount ?? 0;

    return {
      database: targetDb,
      schema: targetSchema,
      table,
      columns: rs?.columns ?? [],
      rows: rs?.rows ?? [],
      page,
      pageSize,
      totalRows: Number.isFinite(totalRows) ? totalRows : rs?.rowCount ?? 0,
      totalEstimated: countCell === undefined || countCell === null,
      executionMs: Math.round(performance.now() - started),
      sql: dataSql,
    };
  }

  generateBatchMutations(
    db: string,
    schema: string,
    table: string,
    structure: TableStructure,
    changes: BatchMutationChanges,
  ): BatchMutationPreview {
    return buildBatchMutations(
      this.dialect,
      this.resolveDb(db, schema),
      this.resolveSchema(schema),
      table,
      structure,
      changes,
    );
  }

  async applyBatchMutations(sqlStatements: readonly string[]): Promise<BatchMutationApplyResult> {
    this.requireConnected();
    const started = performance.now();
    let affectedRows = 0;
    for (const stmt of sqlStatements) {
      const res = await this.query(stmt);
      for (const rs of res.results) {
        affectedRows += rs.affectedRows || 1;
      }
    }
    return {
      applied: sqlStatements.length,
      affectedRows,
      executionMs: Math.round(performance.now() - started),
    };
  }

  async explain(sql: string, analyze = false): Promise<ExplainResult> {
    this.requireConnected();
    const clean = stripTrailingSemicolon(sql);

    if (this._engine === 'rqlite' || this._engine === 'turso' || this._engine === 'cloudflare-d1') {
      const res = await this.query(`EXPLAIN QUERY PLAN ${clean}`);
      const rows = (res.results[0]?.rows ?? []).map((r) => ({
        id: Number(r[0] ?? 0),
        parent: Number(r[1] ?? 0),
        detail: String(r[3] ?? r[2] ?? ''),
      }));
      return parseSqliteExplainQueryPlan(rows);
    }

    if (this._engine === 'victoriametrics' || this._engine === 'influxdb' || this._engine === 'salesforce') {
      return buildTextExplainResult(
        this.dialect,
        [`Direct query execution (${this._engine}): ${clean}`],
        analyze,
      );
    }

    const prefix =
      analyze && (this._engine === 'trino' || this._engine === 'prestosql')
        ? 'EXPLAIN ANALYZE'
        : 'EXPLAIN';
    const res = await this.query(`${prefix} ${clean}`);
    const lines = (res.results[0]?.rows ?? []).flatMap((r) =>
      String(r[0] ?? '').split('\n'),
    );
    return buildTextExplainResult(this.dialect, lines, analyze);
  }

  generateAlterTableDdl(
    db: string,
    schema: string,
    table: string,
    diff: TableStructureDiff,
  ): string[] {
    return buildAlterTableDdl(
      this.dialect,
      this.resolveDb(db, schema),
      this.resolveSchema(schema),
      table,
      diff,
    );
  }

  generateCreateTableDdl(db: string, schema: string, spec: CreateTableSpec): string {
    return buildCreateTableDdl(
      this.dialect,
      this.resolveDb(db, schema),
      this.resolveSchema(schema),
      spec,
    );
  }

  async dropObject(
    db: string,
    schema: string,
    name: string,
    kind: DropObjectKind,
    cascade = false,
  ): Promise<void> {
    await this.query(
      buildDropObjectSql(
        this.dialect,
        this.resolveDb(db, schema),
        this.resolveSchema(schema),
        name,
        kind,
        cascade,
      ),
    );
  }

  async truncateTable(db: string, schema: string, table: string, cascade = false): Promise<void> {
    await this.query(
      buildTruncateTableSql(
        this.dialect,
        this.resolveDb(db, schema),
        this.resolveSchema(schema),
        table,
        cascade,
      ),
    );
  }

  async dumpDatabaseSql(
    db: string,
    schema = '',
    tables?: string[],
    includeData = true,
  ): Promise<string> {
    const targetDb = this.resolveDb(db, schema);
    const targetSchema = this.resolveSchema(schema);
    const list = tables ?? (await this.listTables(targetDb, targetSchema)).map((t) => t.name);
    const dumpTables = [];
    for (const table of list) {
      const structure = await this.getTableStructure(targetDb, targetSchema, table);
      let columns = structure.columns.map((c) => c.name);
      let rows: CellValue[][] = [];
      if (includeData) {
        const browse = await this.browseTable(targetDb, targetSchema, table, {
          page: 1,
          pageSize: 1000,
        });
        columns = browse.columns.map((c) => c.name);
        rows = browse.rows;
      }
      dumpTables.push({ structure, columns, rows });
    }
    return generateSqlDump(this.dialect, targetDb, targetSchema, dumpTables, includeData);
  }

  diffSchemas(leftSchema: SchemaSnapshot, rightSchema: SchemaSnapshot): SchemaDiffResult {
    return runSchemaDiff(leftSchema, rightSchema);
  }

  /** Helper exposing resolved base endpoint URL for diagnostics/tests. */
  getEndpointUrl(path = '/'): string {
    const { endpoint } = this.requireConnected();
    return buildEndpointUrl(endpoint, path);
  }
}

/**
 * Pure-TS ClickHouse HTTP/HTTPS Driver (100% browser-sandbox compatible).
 * Works over EITHER:
 * 1. `transport.httpRequest` (Netcatty `context.network.request` or fetch), OR
 * 2. Raw HTTP/1.1 over `ByteStream` (`transport.connect`), enabling seamless ClickHouse access
 *    over Vault SSH tunnels as well as direct TCP/TLS!
 */

import {
  buildAlterTableDdl,
  buildBatchMutations,
  buildCreateTableDdl,
  buildDropObjectSql,
  buildTruncateTableSql,
  qualifiedTableName,
  quoteIdent,
} from './sqlDialect';
import { BufferedByteStream, concatBytes } from './streamBuffer';
import type {
  BatchMutationApplyResult,
  BatchMutationChanges,
  BatchMutationPreview,
  BrowseTableOptions,
  BrowseTableResult,
  ByteStreamTransport,
  CellValue,
  ColumnMeta,
  ColumnStructure,
  ConnectionConfig,
  ConnectionInfo,
  CreateTableSpec,
  DatabaseInfo,
  DropObjectKind,
  ExplainResult,
  HttpRequestOptions,
  HttpResponseData,
  MultiQueryResult,
  QueryOptions,
  QueryResultSet,
  RelationalDriver,
  RoutineSummary,
  SchemaDiffResult,
  SchemaErGraph,
  SchemaInfo,
  SchemaSnapshot,
  TableStructure,
  TableStructureDiff,
  TableSummary,
  TestConnectionResult,
  TriggerSummary,
  ViewSummary,
} from './types';
import { parseClickHouseExplainText } from '../sql/explainParser';
import { diffSchemas as runSchemaDiff, generateSqlDump } from '../sql/schemaDiff';
import { splitSqlStatements } from '../sql/splitter';

const te = new TextEncoder();
const td = new TextDecoder('utf-8');

/**
 * Minimal HTTP/1.1 client over ByteStream supporting Content-Length and chunked transfer encoding.
 */
async function httpOverByteStream(
  transport: ByteStreamTransport,
  host: string,
  port: number,
  tls: boolean,
  req: HttpRequestOptions,
  tlsOpts?: { allowSelfSigned?: boolean; caPem?: string },
): Promise<HttpResponseData> {
  const url = new URL(req.url);
  const path = `${url.pathname}${url.search}`;
  const bodyBytes =
    req.body === undefined
      ? new Uint8Array(0)
      : typeof req.body === 'string'
        ? te.encode(req.body)
        : req.body;

  const rawStream = await transport.connect({
    host,
    port,
    tls,
    servername: host,
    allowSelfSigned: tlsOpts?.allowSelfSigned,
    caPem: tlsOpts?.caPem,
    timeoutMs: req.timeoutMs ?? 30000,
    signal: req.signal,
  });
  const bs = new BufferedByteStream(rawStream);

  try {
    const headerLines: string[] = [
      `${req.method} ${path} HTTP/1.1`,
      `Host: ${host}:${port}`,
      'Connection: close',
      `Content-Length: ${bodyBytes.length}`,
    ];
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      if (k.toLowerCase() === 'host' || k.toLowerCase() === 'content-length') continue;
      headerLines.push(`${k}: ${v}`);
    }
    headerLines.push('', '');
    const headBytes = te.encode(headerLines.join('\r\n'));
    await bs.write(bodyBytes.length > 0 ? concatBytes(headBytes, bodyBytes) : headBytes);

    const statusLine = td.decode(await bs.readLineCRLF());
    const statusMatch = /^HTTP\/\d+\.\d+\s+(\d{3})/.exec(statusLine);
    const status = statusMatch ? Number(statusMatch[1]) : 500;

    const headers: Record<string, string> = {};
    while (true) {
      const lineBytes = await bs.readLineCRLF();
      if (lineBytes.length === 0) break;
      const line = td.decode(lineBytes);
      const colon = line.indexOf(':');
      if (colon > 0) {
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
    }

    let body: Uint8Array;
    if ((headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
      const chunks: Uint8Array[] = [];
      while (true) {
        const sizeLine = td.decode(await bs.readLineCRLF()).trim();
        const semi = sizeLine.indexOf(';');
        const hex = semi >= 0 ? sizeLine.slice(0, semi) : sizeLine;
        const size = parseInt(hex, 16);
        if (!Number.isFinite(size) || size <= 0) {
          // Consume trailing CRLF
          await bs.readLineCRLF().catch(() => {});
          break;
        }
        chunks.push(await bs.readExact(size));
        await bs.readLineCRLF(); // trailing CRLF after chunk
      }
      body = concatBytes(...chunks);
    } else if (headers['content-length'] !== undefined) {
      const len = Number(headers['content-length']);
      body = len > 0 ? await bs.readExact(len) : new Uint8Array(0);
    } else {
      body = await bs.readAllToEof();
    }

    return { status, headers, body };
  } finally {
    await bs.close().catch(() => {});
  }
}

function hasExplicitFormat(sql: string): boolean {
  return /\bFORMAT\s+[A-Za-z0-9_]+\s*;?\s*$/i.test(sql.trim());
}

function returnsRowsSql(sql: string): boolean {
  const head = sql
    .replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/g, '')
    .trim()
    .toUpperCase();
  return /^(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN|EXISTS|CHECK)\b/.test(head);
}

export class ClickHouseDriver implements RelationalDriver {
  readonly engine = 'clickhouse' as const;
  readonly family = 'clickhouse' as const;

  private transport: ByteStreamTransport | null = null;
  private config: ConnectionConfig | null = null;
  private _connected = false;
  private _serverVersion = '';
  private _tlsActive = false;
  private activeQueryId: string | null = null;

  get connected(): boolean {
    return this._connected;
  }
  get inTransaction(): boolean {
    return false;
  }
  get serverVersion(): string {
    return this._serverVersion;
  }

  async connect(config: ConnectionConfig, transport?: ByteStreamTransport): Promise<ConnectionInfo> {
    if (!transport) throw new Error('ClickHouse driver requires a ByteStreamTransport');
    const started = performance.now();
    this.config = config;
    this.transport = transport;
    this._tlsActive = (config.tlsMode ?? 'disable') !== 'disable';
    this._connected = true;

    try {
      const res = await this.query('SELECT version()');
      this._serverVersion = String(res.results[0]?.rows[0]?.[0] ?? 'ClickHouse');
      return {
        engine: 'clickhouse',
        family: 'clickhouse',
        serverVersion: this._serverVersion,
        database: config.database || 'default',
        tlsActive: this._tlsActive,
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      this._connected = false;
      throw err;
    }
  }

  async testConnection(): Promise<TestConnectionResult> {
    const started = performance.now();
    try {
      const res = await this.query('SELECT version()');
      const ver = String(res.results[0]?.rows[0]?.[0] ?? this._serverVersion);
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
    this._connected = false;
    this.activeQueryId = null;
  }

  async cancelQuery(): Promise<void> {
    if (!this.activeQueryId || !this._connected) return;
    const qid = this.activeQueryId.replaceAll("'", "''");
    await this.executeRaw(`KILL QUERY WHERE query_id = '${qid}' SYNC`, false).catch(() => {});
  }

  private async sendHttp(
    sql: string,
    extraParams: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<HttpResponseData> {
    if (!this.transport || !this.config) throw new Error('ClickHouse is not connected');
    const host = this.config.host ?? '127.0.0.1';
    const port = this.config.port ?? (this._tlsActive ? 8443 : 8123);
    const scheme = this._tlsActive ? 'https' : 'http';
    const pathPrefix = this.config.httpPath || '/';
    const url = new URL(`${scheme}://${host}:${port}${pathPrefix}`);
    if (this.config.database) url.searchParams.set('database', this.config.database);
    for (const [k, v] of Object.entries(extraParams)) {
      url.searchParams.set(k, v);
    }

    const headers: Record<string, string> = {
      'content-type': 'text/plain; charset=utf-8',
    };
    if (this.config.username) {
      headers['x-clickhouse-user'] = this.config.username;
      headers['x-clickhouse-key'] = this.config.password ?? '';
    }

    const req: HttpRequestOptions = {
      url: url.href,
      method: 'POST',
      headers,
      body: sql,
      timeoutMs: this.config.timeoutMs ?? 30000,
      signal,
    };

    // Prefer raw HTTP over ByteStream when sshTunnel is active or httpRequest isn't provided
    if (this.config.sshTunnel || !this.transport.httpRequest) {
      return httpOverByteStream(this.transport, host, port, this._tlsActive, req, {
        allowSelfSigned: this.config.allowSelfSigned,
        caPem: this.config.caPem,
      });
    }
    return this.transport.httpRequest(req);
  }

  private async executeRaw(
    sql: string,
    expectJsonCompact: boolean,
    options?: QueryOptions,
  ): Promise<QueryResultSet> {
    const started = performance.now();
    const queryId = `nc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    this.activeQueryId = queryId;
    const params: Record<string, string> = {
      query_id: queryId,
      output_format_json_quote_64bit_integers: '0',
    };
    if (options?.database) params.database = options.database;
    if (expectJsonCompact && !hasExplicitFormat(sql)) {
      params.default_format = 'JSONCompact';
    }
    if (options?.maxRows && expectJsonCompact) {
      params.max_result_rows = String(options.maxRows);
      params.result_overflow_mode = 'break';
    }

    try {
      const resp = await this.sendHttp(sql, params, options?.signal);
      const bodyText = td.decode(resp.body);
      if (resp.status >= 400 || resp.headers['x-clickhouse-exception-code']) {
        throw new Error(bodyText.trim() || `ClickHouse HTTP ${resp.status}`);
      }

      if (!bodyText.trim()) {
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

      // Check JSONCompact format
      if (expectJsonCompact && bodyText.trimStart().startsWith('{')) {
        try {
          const parsed = JSON.parse(bodyText) as {
            meta?: Array<{ name: string; type: string }>;
            data?: CellValue[][];
            rows?: number;
            rows_before_limit_at_least?: number;
          };
          if (Array.isArray(parsed.meta) && Array.isArray(parsed.data)) {
            const columns: ColumnMeta[] = parsed.meta.map((m) => ({
              name: m.name,
              dataType: m.type,
            }));
            return {
              sql,
              columns,
              rows: parsed.data,
              rowCount: parsed.data.length,
              affectedRows: 0,
              executionMs: Math.round(performance.now() - started),
              truncated: Boolean(options?.maxRows && parsed.data.length >= options.maxRows),
              commandTag: 'SELECT',
            };
          }
        } catch {
          // Fall through to JSONEachRow or raw text
        }
      }

      // Check JSONEachRow (NDJSON)
      const lines = bodyText.trim().split('\n').filter(Boolean);
      if (lines.length > 0 && lines[0].startsWith('{')) {
        try {
          const objs = lines.map((l) => JSON.parse(l) as Record<string, CellValue>);
          const colNames = Object.keys(objs[0]);
          const columns: ColumnMeta[] = colNames.map((name) => ({ name, dataType: 'String' }));
          const rows = objs.map((o) => colNames.map((c) => o[c] ?? null));
          return {
            sql,
            columns,
            rows,
            rowCount: rows.length,
            affectedRows: 0,
            executionMs: Math.round(performance.now() - started),
            truncated: false,
            commandTag: 'SELECT',
          };
        } catch {
          // Fall through to plain text
        }
      }

      return {
        sql,
        columns: [{ name: 'result', dataType: 'String' }],
        rows: lines.map((l) => [l]),
        rowCount: lines.length,
        affectedRows: 0,
        executionMs: Math.round(performance.now() - started),
        truncated: false,
        commandTag: 'OK',
      };
    } finally {
      if (this.activeQueryId === queryId) this.activeQueryId = null;
    }
  }

  async query(sql: string, options?: QueryOptions): Promise<MultiQueryResult> {
    if (!this._connected) throw new Error('ClickHouse is not connected');
    const totalStart = performance.now();
    const stmts = splitSqlStatements(sql, 'clickhouse');
    const statements = stmts.length > 0 ? stmts.map((s) => s.sql) : [sql];
    const results: QueryResultSet[] = [];
    for (const stmt of statements) {
      const expectJson = returnsRowsSql(stmt) && !hasExplicitFormat(stmt);
      results.push(await this.executeRaw(stmt, expectJson, options));
    }
    return {
      results,
      totalExecutionMs: Math.round(performance.now() - totalStart),
    };
  }

  async beginTransaction(): Promise<void> {
    // ClickHouse HTTP interface is auto-commit per statement
  }
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}

  async listDatabases(): Promise<DatabaseInfo[]> {
    const res = await this.query('SELECT name FROM system.databases ORDER BY name');
    return (res.results[0]?.rows ?? []).map((r) => ({ name: String(r[0]) }));
  }

  async listSchemas(db?: string): Promise<SchemaInfo[]> {
    if (db) return [{ name: db, isSystem: db === 'system' || db === 'INFORMATION_SCHEMA' }];
    const dbs = await this.listDatabases();
    return dbs.map((d) => ({
      name: d.name,
      isSystem: ['system', 'information_schema', 'INFORMATION_SCHEMA'].includes(d.name),
    }));
  }

  private resolveDb(db?: string, schema?: string): string {
    return db || schema || this.config?.database || 'default';
  }

  async listTables(db?: string, schema?: string): Promise<TableSummary[]> {
    const targetDb = this.resolveDb(db, schema);
    const esc = targetDb.replaceAll("'", "''");
    const res = await this.query(
      `SELECT name, engine, total_rows, total_bytes, comment
       FROM system.tables
       WHERE database = '${esc}' AND engine NOT IN ('View', 'MaterializedView', 'LiveView')
       ORDER BY name`,
    );
    return (res.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      schema: targetDb,
      database: targetDb,
      kind: 'table',
      engine: r[1] ? String(r[1]) : undefined,
      rowCountEstimate: r[2] !== null ? Number(r[2]) : undefined,
      sizeBytes: r[3] !== null ? Number(r[3]) : undefined,
      comment: r[4] ? String(r[4]) : undefined,
    }));
  }

  async listViews(db?: string, schema?: string): Promise<ViewSummary[]> {
    const targetDb = this.resolveDb(db, schema);
    const esc = targetDb.replaceAll("'", "''");
    const res = await this.query(
      `SELECT name, engine, create_table_query, comment
       FROM system.tables
       WHERE database = '${esc}' AND engine IN ('View', 'MaterializedView', 'LiveView')
       ORDER BY name`,
    );
    return (res.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      schema: targetDb,
      database: targetDb,
      isMaterialized: String(r[1]) === 'MaterializedView',
      definition: r[2] ? String(r[2]) : undefined,
      comment: r[3] ? String(r[3]) : undefined,
    }));
  }

  async listRoutines(): Promise<RoutineSummary[]> {
    return [];
  }

  async listTriggers(): Promise<TriggerSummary[]> {
    return [];
  }

  async getTableStructure(db: string, schema: string, table: string): Promise<TableStructure> {
    const targetDb = this.resolveDb(db, schema);
    const escDb = targetDb.replaceAll("'", "''");
    const escTbl = table.replaceAll("'", "''");
    const qTable = qualifiedTableName(targetDb, targetDb, table, 'clickhouse');

    const [colsRes, ddlRes] = await Promise.all([
      this.query(
        `SELECT name, type, default_expression, is_in_primary_key, comment
         FROM system.columns
         WHERE database = '${escDb}' AND table = '${escTbl}'
         ORDER BY position`,
      ),
      this.query(`SHOW CREATE TABLE ${qTable}`).catch(() => null),
    ]);

    const columns: ColumnStructure[] = (colsRes.results[0]?.rows ?? []).map((r) => {
      const dataType = String(r[1]);
      return {
        name: String(r[0]),
        dataType,
        nullable: /^Nullable\(/i.test(dataType),
        defaultValue: r[2] ? String(r[2]) : null,
        isPrimaryKey: Number(r[3]) === 1,
        isAutoIncrement: false,
        comment: r[4] ? String(r[4]) : null,
      };
    });

    const createDdl = ddlRes?.results[0]?.rows[0]?.[0]
      ? String(ddlRes.results[0].rows[0][0]) + ';'
      : '';

    return {
      database: targetDb,
      schema: targetDb,
      table,
      columns,
      indexes: [],
      foreignKeys: [],
      checkConstraints: [],
      createDdl,
    };
  }

  async getSchemaErGraph(db: string, schema = ''): Promise<SchemaErGraph> {
    const targetDb = this.resolveDb(db, schema);
    const tables = await this.listTables(targetDb, targetDb);
    const erTables = [];
    for (const t of tables) {
      const s = await this.getTableStructure(targetDb, targetDb, t.name);
      erTables.push({ name: t.name, schema: targetDb, columns: s.columns });
    }
    return { database: targetDb, schema: targetDb, tables: erTables, edges: [] };
  }

  async browseTable(
    db: string,
    schema: string,
    table: string,
    options?: BrowseTableOptions,
  ): Promise<BrowseTableResult> {
    const targetDb = this.resolveDb(db, schema);
    const page = Math.max(1, options?.page ?? 1);
    const pageSize = Math.min(1000, Math.max(1, options?.pageSize ?? 50));
    const offset = (page - 1) * pageSize;
    const qTable = qualifiedTableName(targetDb, targetDb, table, 'clickhouse');

    const where = options?.whereClause?.trim() ? ` WHERE ${options.whereClause.trim()}` : '';
    const order = options?.sortBy
      ? ` ORDER BY ${quoteIdent(options.sortBy, 'clickhouse')} ${options.sortDir === 'desc' ? 'DESC' : 'ASC'}`
      : '';
    const dataSql = `SELECT * FROM ${qTable}${where}${order} LIMIT ${pageSize} OFFSET ${offset}`;
    const countSql = `SELECT count() FROM ${qTable}${where}`;

    const started = performance.now();
    const [dataRes, countRes] = await Promise.all([
      this.query(dataSql, { maxRows: pageSize, signal: options?.signal }),
      this.query(countSql, { maxRows: 1, signal: options?.signal }),
    ]);

    const rs = dataRes.results[0];
    const totalRows = Number(countRes.results[0]?.rows[0]?.[0] ?? rs?.rowCount ?? 0);
    return {
      database: targetDb,
      schema: targetDb,
      table,
      columns: rs?.columns ?? [],
      rows: rs?.rows ?? [],
      page,
      pageSize,
      totalRows,
      totalEstimated: false,
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
    return buildBatchMutations('clickhouse', this.resolveDb(db, schema), schema, table, structure, changes);
  }

  async applyBatchMutations(sqlStatements: readonly string[]): Promise<BatchMutationApplyResult> {
    const started = performance.now();
    for (const stmt of sqlStatements) {
      await this.query(stmt);
    }
    return {
      applied: sqlStatements.length,
      affectedRows: sqlStatements.length,
      executionMs: Math.round(performance.now() - started),
    };
  }

  async explain(sql: string, _analyze = false): Promise<ExplainResult> {
    const res = await this.query(`EXPLAIN PLAN ${sql}`);
    const lines = (res.results[0]?.rows ?? []).map((r) => String(r[0] ?? ''));
    return parseClickHouseExplainText(lines);
  }

  generateAlterTableDdl(db: string, schema: string, table: string, diff: TableStructureDiff): string[] {
    return buildAlterTableDdl('clickhouse', this.resolveDb(db, schema), schema, table, diff);
  }

  generateCreateTableDdl(db: string, schema: string, spec: CreateTableSpec): string {
    return buildCreateTableDdl('clickhouse', this.resolveDb(db, schema), schema, spec);
  }

  async dropObject(
    db: string,
    schema: string,
    name: string,
    kind: DropObjectKind,
    cascade = false,
  ): Promise<void> {
    await this.query(buildDropObjectSql('clickhouse', this.resolveDb(db, schema), schema, name, kind, cascade));
  }

  async truncateTable(db: string, schema: string, table: string, cascade = false): Promise<void> {
    await this.query(buildTruncateTableSql('clickhouse', this.resolveDb(db, schema), schema, table, cascade));
  }

  async dumpDatabaseSql(
    db: string,
    schema = '',
    tables?: string[],
    includeData = true,
  ): Promise<string> {
    const targetDb = this.resolveDb(db, schema);
    const list = tables ?? (await this.listTables(targetDb, targetDb)).map((t) => t.name);
    const dumpTables = [];
    for (const table of list) {
      const structure = await this.getTableStructure(targetDb, targetDb, table);
      let columns = structure.columns.map((c) => c.name);
      let rows: CellValue[][] = [];
      if (includeData) {
        const qTable = qualifiedTableName(targetDb, targetDb, table, 'clickhouse');
        const res = await this.query(`SELECT * FROM ${qTable}`, { maxRows: 50000 });
        columns = res.results[0]?.columns.map((c) => c.name) ?? columns;
        rows = res.results[0]?.rows ?? [];
      }
      dumpTables.push({ structure, columns, rows });
    }
    return generateSqlDump('clickhouse', targetDb, targetDb, dumpTables, includeData);
  }

  diffSchemas(leftSchema: SchemaSnapshot, rightSchema: SchemaSnapshot): SchemaDiffResult {
    return runSchemaDiff(leftSchema, rightSchema);
  }
}

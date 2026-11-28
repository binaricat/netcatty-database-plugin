/**
 * SQL Dump Restore & Cross-Connection Table Data Transfer Engine (P0-8).
 * Translates column types across dialects (PostgreSQL <-> MySQL <-> SQLite <-> ClickHouse)
 * and copies table structure + batched rows with live progress callbacks.
 */

import {
  buildCreateTableDdl,
  buildDropObjectSql,
  qualifiedTableName,
  quoteIdent,
  quoteSqlLiteral,
} from '../drivers/sqlDialect';
import type {
  CellValue,
  RelationalDriver,
  SqlDialect,
} from '../drivers/types';
import { splitSqlStatements } from './splitter';

export interface RestoreProgress {
  completed: number;
  total: number;
  succeeded: number;
  failed: number;
  currentStatement: string;
}

export interface RestoreOptions {
  continueOnError?: boolean;
  signal?: AbortSignal;
}

export interface RestoreResult {
  totalStatements: number;
  succeeded: number;
  failed: number;
  errors: Array<{ index: number; sql: string; message: string }>;
  executionMs: number;
}

function resolveDriverDialect(driver: RelationalDriver): SqlDialect {
  if (
    driver.family === 'postgres' ||
    driver.family === 'mysql' ||
    driver.family === 'sqlite' ||
    driver.family === 'clickhouse' ||
    driver.family === 'mssql'
  ) {
    return driver.family;
  }
  if (driver.engine === 'trino' || driver.engine === 'prestosql') return 'trino';
  if (driver.engine === 'tdengine') return 'tdengine';
  if (driver.engine === 'influxdb' || driver.engine === 'influxdb3' || driver.engine === 'victoriametrics') {
    return 'influx';
  }
  if (driver.engine === 'rqlite' || driver.engine === 'turso') return 'sqlite';
  return 'postgres';
}

export async function restoreSqlDump(
  driver: RelationalDriver,
  sqlText: string,
  options?: RestoreOptions,
  onProgress?: (progress: RestoreProgress) => void,
): Promise<RestoreResult> {
  const started = performance.now();
  const statements = splitSqlStatements(sqlText, resolveDriverDialect(driver));
  const total = statements.length;
  let succeeded = 0;
  let failed = 0;
  const errors: RestoreResult['errors'] = [];

  for (let i = 0; i < total; i++) {
    if (options?.signal?.aborted) {
      throw new Error('SQL restore aborted');
    }
    const stmt = statements[i].sql;
    onProgress?.({
      completed: i,
      total,
      succeeded,
      failed,
      currentStatement: stmt.slice(0, 140),
    });

    try {
      await driver.query(stmt, { signal: options?.signal });
      succeeded++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ index: i, sql: stmt, message });
      if (!options?.continueOnError) {
        return {
          totalStatements: total,
          succeeded,
          failed,
          errors,
          executionMs: Math.round(performance.now() - started),
        };
      }
    }
  }

  onProgress?.({
    completed: total,
    total,
    succeeded,
    failed,
    currentStatement: '',
  });

  return {
    totalStatements: total,
    succeeded,
    failed,
    errors,
    executionMs: Math.round(performance.now() - started),
  };
}

/**
 * Translates a column data type from source dialect to a compatible target dialect type.
 */
export function translateColumnType(
  sourceType: string,
  sourceDialect: SqlDialect,
  targetDialect: SqlDialect,
  nullable = true,
): string {
  if (sourceDialect === targetDialect) return sourceType;
  const raw = sourceType.trim();
  const lower = raw.toLowerCase();

  // Base semantic category
  const isBool = /\bbool(?:ean)?\b/.test(lower) || lower === 'tinyint(1)';
  const isBigInt = /\b(?:bigint|int8|int64|uint64|bigserial)\b/.test(lower);
  const isInt = !isBigInt && /\b(?:int|integer|int2|int4|int32|int16|smallint|mediumint|tinyint|serial|smallserial)\b/.test(lower);
  const isDecimal = /\b(?:numeric|decimal|money)\b/.test(lower);
  const isFloat = /\b(?:float|double|real|float4|float8|float32|float64)\b/.test(lower);
  const isJson = /\bjsonb?\b/.test(lower);
  const isBinary = /\b(?:bytea|blob|varbinary|binary|mediumblob|longblob)\b/.test(lower);
  const isTimestamp = /\b(?:timestamp|datetime)\b/.test(lower);
  const isDate = !isTimestamp && /\bdate\b/.test(lower);
  const isUuid = /\buuid\b/.test(lower);

  let mapped: string;
  if (targetDialect === 'sqlite') {
    if (isBool || isBigInt || isInt) mapped = 'INTEGER';
    else if (isDecimal || isFloat) mapped = 'REAL';
    else if (isBinary) mapped = 'BLOB';
    else mapped = 'TEXT';
  } else if (targetDialect === 'postgres') {
    if (isBool) mapped = 'BOOLEAN';
    else if (isBigInt) mapped = 'BIGINT';
    else if (isInt) mapped = 'INTEGER';
    else if (isDecimal) mapped = 'NUMERIC';
    else if (isFloat) mapped = 'DOUBLE PRECISION';
    else if (isJson) mapped = 'JSONB';
    else if (isBinary) mapped = 'BYTEA';
    else if (isTimestamp) mapped = 'TIMESTAMPTZ';
    else if (isDate) mapped = 'DATE';
    else if (isUuid) mapped = 'UUID';
    else mapped = 'TEXT';
  } else if (targetDialect === 'mysql') {
    if (isBool) mapped = 'TINYINT(1)';
    else if (isBigInt) mapped = 'BIGINT';
    else if (isInt) mapped = 'INT';
    else if (isDecimal) mapped = 'DECIMAL(18, 4)';
    else if (isFloat) mapped = 'DOUBLE';
    else if (isJson) mapped = 'JSON';
    else if (isBinary) mapped = 'LONGBLOB';
    else if (isTimestamp) mapped = 'DATETIME';
    else if (isDate) mapped = 'DATE';
    else if (isUuid) mapped = 'CHAR(36)';
    else mapped = 'TEXT';
  } else if (targetDialect === 'mssql') {
    if (isBool) mapped = 'BIT';
    else if (isBigInt) mapped = 'BIGINT';
    else if (isInt) mapped = 'INT';
    else if (isDecimal) mapped = 'DECIMAL(18, 4)';
    else if (isFloat) mapped = 'FLOAT';
    else if (isBinary) mapped = 'VARBINARY(MAX)';
    else if (isTimestamp) mapped = 'DATETIME2';
    else if (isDate) mapped = 'DATE';
    else if (isUuid) mapped = 'UNIQUEIDENTIFIER';
    else mapped = 'NVARCHAR(MAX)';
  } else if (targetDialect === 'trino' || targetDialect === 'tdengine' || targetDialect === 'influx') {
    if (isBool) mapped = 'BOOLEAN';
    else if (isBigInt) mapped = 'BIGINT';
    else if (isInt) mapped = 'INTEGER';
    else if (isDecimal || isFloat) mapped = 'DOUBLE';
    else if (isTimestamp) mapped = 'TIMESTAMP';
    else if (isDate) mapped = 'DATE';
    else mapped = 'VARCHAR';
  } else {
    // ClickHouse
    if (isBool) mapped = 'Bool';
    else if (isBigInt) mapped = 'Int64';
    else if (isInt) mapped = 'Int32';
    else if (isDecimal || isFloat) mapped = 'Float64';
    else if (isTimestamp) mapped = 'DateTime64(3)';
    else if (isDate) mapped = 'Date';
    else mapped = 'String';
    if (nullable) mapped = `Nullable(${mapped})`;
  }

  return mapped;
}

export interface TransferTablesOptions {
  sourceDatabase?: string;
  sourceSchema?: string;
  targetDatabase?: string;
  targetSchema?: string;
  createTables?: boolean;
  dropTargetIfExists?: boolean;
  includeData?: boolean;
  batchSize?: number;
  pageSize?: number;
  signal?: AbortSignal;
}

export interface TransferProgress {
  table: string;
  tableIndex: number;
  totalTables: number;
  rowsCopied: number;
  totalRowsEstimate: number;
  stage: 'ddl' | 'data' | 'done';
}

export interface TransferTableResult {
  table: string;
  rowsCopied: number;
  ddlExecuted?: string;
  error?: string;
}

export interface TransferResult {
  tables: TransferTableResult[];
  totalRowsCopied: number;
  executionMs: number;
}

export async function transferTables(
  sourceDriver: RelationalDriver,
  targetDriver: RelationalDriver,
  tables: readonly string[],
  options?: TransferTablesOptions,
  onProgress?: (progress: TransferProgress) => void,
): Promise<TransferResult> {
  const started = performance.now();
  const srcDb = options?.sourceDatabase ?? '';
  const srcSchema = options?.sourceSchema ?? (sourceDriver.family === 'postgres' ? 'public' : sourceDriver.family === 'sqlite' ? 'main' : srcDb);
  const tgtDb = options?.targetDatabase ?? '';
  const tgtSchema = options?.targetSchema ?? (targetDriver.family === 'postgres' ? 'public' : targetDriver.family === 'sqlite' ? 'main' : tgtDb);
  const createTables = options?.createTables ?? true;
  const includeData = options?.includeData ?? true;
  const batchSize = Math.max(1, Math.min(500, options?.batchSize ?? 100));
  const pageSize = Math.max(batchSize, Math.min(2000, options?.pageSize ?? 500));

  const results: TransferTableResult[] = [];
  let totalRowsCopied = 0;

  for (let tIdx = 0; tIdx < tables.length; tIdx++) {
    if (options?.signal?.aborted) throw new Error('Data transfer aborted');
    const tableName = tables[tIdx];
    const structure = await sourceDriver.getTableStructure(srcDb, srcSchema, tableName);

    let ddlExecuted: string | undefined;
    if (createTables) {
      onProgress?.({
        table: tableName,
        tableIndex: tIdx,
        totalTables: tables.length,
        rowsCopied: 0,
        totalRowsEstimate: 0,
        stage: 'ddl',
      });

      const srcDialect = resolveDriverDialect(sourceDriver);
      const tgtDialect = resolveDriverDialect(targetDriver);

      if (options?.dropTargetIfExists) {
        const dropSql = buildDropObjectSql(tgtDialect, tgtDb, tgtSchema, tableName, 'table', false);
        await targetDriver.query(dropSql, { signal: options?.signal });
      }

      const ddl = buildCreateTableDdl(tgtDialect, tgtDb, tgtSchema, {
        name: tableName,
        ifNotExists: !options?.dropTargetIfExists,
        columns: structure.columns.map((c) => ({
          name: c.name,
          dataType: translateColumnType(c.dataType, srcDialect, tgtDialect, c.nullable),
          nullable: c.isPrimaryKey ? false : c.nullable,
          isPrimaryKey: c.isPrimaryKey,
          isAutoIncrement: false,
        })),
      });
      await targetDriver.query(ddl, { signal: options?.signal });
      ddlExecuted = ddl;
    }

    let rowsCopied = 0;
    if (includeData) {
      const tgtDialect = resolveDriverDialect(targetDriver);
      const qTarget = qualifiedTableName(tgtDb, tgtSchema, tableName, tgtDialect);
      let page = 1;
      let totalEstimate = 0;

      while (true) {
        if (options?.signal?.aborted) throw new Error('Data transfer aborted');
        const batch = await sourceDriver.browseTable(srcDb, srcSchema, tableName, {
          page,
          pageSize,
          signal: options?.signal,
        });
        totalEstimate = batch.totalRows;
        if (batch.rows.length === 0) break;

        const colNames = batch.columns.map((c) => c.name);
        const qCols = colNames.map((c) => quoteIdent(c, tgtDialect)).join(', ');

        for (let offset = 0; offset < batch.rows.length; offset += batchSize) {
          const slice = batch.rows.slice(offset, offset + batchSize);
          const valuesSql = slice
            .map((row) => '(' + row.map((cell) => normalizeTransferCell(cell, tgtDialect)).join(', ') + ')')
            .join(', ');
          const insertSql = `INSERT INTO ${qTarget} (${qCols}) VALUES ${valuesSql};`;
          await targetDriver.query(insertSql, { signal: options?.signal });
          rowsCopied += slice.length;
          totalRowsCopied += slice.length;
          onProgress?.({
            table: tableName,
            tableIndex: tIdx,
            totalTables: tables.length,
            rowsCopied,
            totalRowsEstimate: totalEstimate,
            stage: 'data',
          });
        }

        if (batch.rows.length < pageSize || rowsCopied >= totalEstimate) break;
        page++;
      }
    }

    onProgress?.({
      table: tableName,
      tableIndex: tIdx,
      totalTables: tables.length,
      rowsCopied,
      totalRowsEstimate: rowsCopied,
      stage: 'done',
    });

    results.push({ table: tableName, rowsCopied, ddlExecuted });
  }

  return {
    tables: results,
    totalRowsCopied,
    executionMs: Math.round(performance.now() - started),
  };
}

function normalizeTransferCell(cell: CellValue, targetDialect: SqlDialect): string {
  if (cell === null || cell === undefined) return 'NULL';
  if (typeof cell === 'object' && !(cell instanceof Uint8Array)) {
    return quoteSqlLiteral(JSON.stringify(cell), targetDialect);
  }
  return quoteSqlLiteral(cell, targetDialect);
}

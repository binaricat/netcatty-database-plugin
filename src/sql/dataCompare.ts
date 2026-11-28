/**
 * Row-by-Row Table Data Diff Engine & Dialect-Aware Sync SQL Generator.
 * Pure, browser-sandbox compatible (zero Node imports).
 */

import type { CellValue, SqlDialect } from '../drivers/types';

export type DataCompareInputRow = readonly CellValue[] | Record<string, CellValue>;

export interface DataCompareOptions {
  columns: readonly string[];
  /** Key column names used to match source and target rows. Falls back to all non-ignored columns if empty. */
  keyColumns?: readonly string[];
  /** Columns excluded from value comparison (still included in INSERT values). */
  ignoredColumns?: readonly string[];
  sourceRows: readonly DataCompareInputRow[];
  targetRows: readonly DataCompareInputRow[];
  /** When true, numeric strings like "42" equal number 42 and Date/ISO normalization is looser. Default true. */
  looseTypeEquality?: boolean;
}

export interface DataCompareChangedCell {
  column: string;
  source: CellValue;
  target: CellValue;
}

export interface DataCompareRow {
  key: string;
  keyValues: Record<string, CellValue>;
  values: Record<string, CellValue>;
}

export interface DataCompareModifiedRow {
  key: string;
  keyValues: Record<string, CellValue>;
  sourceValues: Record<string, CellValue>;
  targetValues: Record<string, CellValue>;
  changes: DataCompareChangedCell[];
}

export interface DataCompareResult {
  columns: string[];
  keyColumns: string[];
  ignoredColumns: string[];
  /** Present in source, absent in target -> INSERT into target. */
  added: DataCompareRow[];
  /** Present in target, absent in source -> DELETE from target. */
  removed: DataCompareRow[];
  /** Present in both with differing non-ignored cells -> UPDATE target. */
  modified: DataCompareModifiedRow[];
  unchangedCount: number;
  ignoredOnlyCount: number;
  duplicateSourceKeys: string[];
  duplicateTargetKeys: string[];
}

export interface DataSyncSqlOptions {
  dialect: SqlDialect;
  tableName: string;
  schema?: string;
  diff: DataCompareResult;
  /** Optional subset of diff row keys to sync. When omitted, all diff rows are synced. */
  selectedKeys?: readonly string[];
  includeInserts?: boolean;
  includeUpdates?: boolean;
  includeDeletes?: boolean;
  /** Sync direction: 'sourceToTarget' makes target match source; 'targetToSource' reverses operations. */
  direction?: 'sourceToTarget' | 'targetToSource';
  /** Number of rows per batched INSERT statement (default 100, set 1 for single-row INSERTs). */
  insertBatchSize?: number;
}

export interface DataSyncPlan {
  dialect: SqlDialect;
  insertCount: number;
  updateCount: number;
  deleteCount: number;
  statements: string[];
  sql: string;
}

/* ============================================================================
 * Value Normalization & Canonical Comparison
 * ============================================================================ */

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Uint8Array) return `"__bytes:${bytesToHex(value)}"`;
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(rec[k])}`).join(',')}}`;
}

export function canonicalizeCellValue(value: CellValue | undefined, loose = true): string {
  if (value === null || value === undefined) return '__NULL__';
  if (value instanceof Uint8Array) return `__BYTES__:${bytesToHex(value)}`;
  if (typeof value === 'boolean') {
    return loose ? (value ? '1' : '0') : `bool:${value}`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `num:${String(value)}`;
    return loose ? `num:${String(value)}` : `num:${String(value)}`;
  }
  if (typeof value === 'string') {
    if (loose) {
      const trimmed = value.trim();
      if (trimmed !== '' && /^[+-]?(?:\d+|\d+\.\d+)$/.test(trimmed)) {
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed) && String(parsed) === trimmed.replace(/^\+/, '').replace(/^0+(?=\d)/, '')) {
          return `num:${String(parsed)}`;
        }
      }
      const lower = trimmed.toLowerCase();
      if (lower === 'true') return '1';
      if (lower === 'false') return '0';
    }
    return `str:${value}`;
  }
  return `json:${stableJson(value)}`;
}

export function cellsEqual(a: CellValue | undefined, b: CellValue | undefined, loose = true): boolean {
  return canonicalizeCellValue(a, loose) === canonicalizeCellValue(b, loose);
}

function rowToRecord(row: DataCompareInputRow, columns: readonly string[]): Record<string, CellValue> {
  const out: Record<string, CellValue> = {};
  if (Array.isArray(row)) {
    for (let i = 0; i < columns.length; i += 1) {
      const val = row[i];
      out[columns[i]] = val === undefined ? null : val;
    }
    return out;
  }
  const obj = row as Record<string, CellValue>;
  for (const col of columns) {
    out[col] = obj[col] === undefined ? null : obj[col];
  }
  return out;
}

function buildCompositeKey(
  record: Record<string, CellValue>,
  keyColumns: readonly string[],
  loose: boolean,
): { key: string; keyValues: Record<string, CellValue> } {
  const keyValues: Record<string, CellValue> = {};
  const parts: string[] = [];
  for (const col of keyColumns) {
    const val = record[col] ?? null;
    keyValues[col] = val;
    parts.push(`${col}=${canonicalizeCellValue(val, loose)}`);
  }
  return { key: parts.join('\u001f'), keyValues };
}

/* ============================================================================
 * Row-by-Row Diff Engine
 * ============================================================================ */

export function compareTableData(options: DataCompareOptions): DataCompareResult {
  const columns = Array.from(new Set(options.columns.filter(Boolean)));
  const ignoredSet = new Set((options.ignoredColumns ?? []).filter((c) => columns.includes(c)));
  const requestedKeys = (options.keyColumns ?? []).filter((c) => columns.includes(c));
  const keyColumns =
    requestedKeys.length > 0
      ? Array.from(new Set(requestedKeys))
      : columns.filter((c) => !ignoredSet.has(c));
  const effectiveKeys = keyColumns.length > 0 ? keyColumns : columns;
  const loose = options.looseTypeEquality !== false;

  const sourceMap = new Map<string, { keyValues: Record<string, CellValue>; values: Record<string, CellValue> }>();
  const targetMap = new Map<string, { keyValues: Record<string, CellValue>; values: Record<string, CellValue> }>();
  const duplicateSourceKeys: string[] = [];
  const duplicateTargetKeys: string[] = [];

  for (const raw of options.sourceRows) {
    const values = rowToRecord(raw, columns);
    const { key, keyValues } = buildCompositeKey(values, effectiveKeys, loose);
    if (sourceMap.has(key)) {
      duplicateSourceKeys.push(key);
    } else {
      sourceMap.set(key, { keyValues, values });
    }
  }

  for (const raw of options.targetRows) {
    const values = rowToRecord(raw, columns);
    const { key, keyValues } = buildCompositeKey(values, effectiveKeys, loose);
    if (targetMap.has(key)) {
      duplicateTargetKeys.push(key);
    } else {
      targetMap.set(key, { keyValues, values });
    }
  }

  const added: DataCompareRow[] = [];
  const removed: DataCompareRow[] = [];
  const modified: DataCompareModifiedRow[] = [];
  let unchangedCount = 0;
  let ignoredOnlyCount = 0;

  const compareCols = columns.filter((c) => !ignoredSet.has(c));
  const ignoredCols = columns.filter((c) => ignoredSet.has(c));

  for (const [key, src] of sourceMap.entries()) {
    const tgt = targetMap.get(key);
    if (!tgt) {
      added.push({ key, keyValues: src.keyValues, values: src.values });
      continue;
    }

    const changes: DataCompareChangedCell[] = [];
    for (const col of compareCols) {
      if (!cellsEqual(src.values[col], tgt.values[col], loose)) {
        changes.push({ column: col, source: src.values[col], target: tgt.values[col] });
      }
    }

    if (changes.length > 0) {
      modified.push({
        key,
        keyValues: src.keyValues,
        sourceValues: src.values,
        targetValues: tgt.values,
        changes,
      });
    } else {
      unchangedCount += 1;
      if (ignoredCols.some((col) => !cellsEqual(src.values[col], tgt.values[col], loose))) {
        ignoredOnlyCount += 1;
      }
    }
  }

  for (const [key, tgt] of targetMap.entries()) {
    if (!sourceMap.has(key)) {
      removed.push({ key, keyValues: tgt.keyValues, values: tgt.values });
    }
  }

  return {
    columns,
    keyColumns: effectiveKeys,
    ignoredColumns: ignoredCols,
    added,
    removed,
    modified,
    unchangedCount,
    ignoredOnlyCount,
    duplicateSourceKeys,
    duplicateTargetKeys,
  };
}

/* ============================================================================
 * Dialect-Aware Sync SQL Generator
 * ============================================================================ */

function quoteIdent(dialect: SqlDialect, name: string): string {
  if (dialect === 'mysql' || dialect === 'clickhouse' || dialect === 'tdengine') {
    return `\`${name.replace(/`/g, '``')}\``;
  }
  if (dialect === 'mssql') {
    return `[${name.replace(/\]/g, ']]')}]`;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

function qualifyTable(dialect: SqlDialect, tableName: string, schema?: string): string {
  const s = schema?.trim();
  if (!s || dialect === 'sqlite') return quoteIdent(dialect, tableName);
  return `${quoteIdent(dialect, s)}.${quoteIdent(dialect, tableName)}`;
}

export function formatSqlLiteral(dialect: SqlDialect, value: CellValue | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') {
    if (dialect === 'mssql' || dialect === 'sqlite') return value ? '1' : '0';
    return value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL';
  }
  if (value instanceof Uint8Array) {
    const hex = bytesToHex(value);
    if (dialect === 'postgres') return `'\\x${hex}'::bytea`;
    if (dialect === 'mssql') return `0x${hex}`;
    return `X'${hex}'`;
  }
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    return formatSqlLiteral(dialect, json);
  }
  if (dialect === 'mysql' || dialect === 'clickhouse') {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function buildWhereClause(
  dialect: SqlDialect,
  keyColumns: readonly string[],
  keyValues: Record<string, CellValue>,
): string {
  return keyColumns
    .map((col) => {
      const val = keyValues[col];
      const ident = quoteIdent(dialect, col);
      if (val === null || val === undefined) return `${ident} IS NULL`;
      return `${ident} = ${formatSqlLiteral(dialect, val)}`;
    })
    .join(' AND ');
}

export function generateDataSyncSql(options: DataSyncSqlOptions): DataSyncPlan {
  const {
    dialect,
    tableName,
    schema,
    diff,
    includeInserts = true,
    includeUpdates = true,
    includeDeletes = true,
    direction = 'sourceToTarget',
  } = options;

  const selectedSet = options.selectedKeys ? new Set(options.selectedKeys) : null;
  const keep = (key: string) => !selectedSet || selectedSet.has(key);

  const tableSql = qualifyTable(dialect, tableName, schema);
  const colsSql = diff.columns.map((c) => quoteIdent(dialect, c)).join(', ');
  const batchSize = Math.max(1, Math.min(1000, Math.floor(options.insertBatchSize ?? 100)));

  const inserts = (direction === 'sourceToTarget' ? diff.added : diff.removed).filter((r) => keep(r.key));
  const deletes = (direction === 'sourceToTarget' ? diff.removed : diff.added).filter((r) => keep(r.key));
  const updates = diff.modified.filter((r) => keep(r.key));

  const statements: string[] = [];
  let insertCount = 0;
  let updateCount = 0;
  let deleteCount = 0;

  if (includeInserts && inserts.length > 0) {
    for (let i = 0; i < inserts.length; i += batchSize) {
      const chunk = inserts.slice(i, i + batchSize);
      const tuples = chunk.map(
        (row) => `(${diff.columns.map((c) => formatSqlLiteral(dialect, row.values[c])).join(', ')})`,
      );
      statements.push(`INSERT INTO ${tableSql} (${colsSql}) VALUES\n  ${tuples.join(',\n  ')};`);
      insertCount += chunk.length;
    }
  }

  if (includeUpdates && updates.length > 0) {
    for (const row of updates) {
      const assignments = row.changes
        .map((ch) => {
          const nextVal = direction === 'sourceToTarget' ? ch.source : ch.target;
          return `${quoteIdent(dialect, ch.column)} = ${formatSqlLiteral(dialect, nextVal)}`;
        })
        .join(', ');
      const where = buildWhereClause(dialect, diff.keyColumns, row.keyValues);
      if (dialect === 'clickhouse') {
        statements.push(`ALTER TABLE ${tableSql} UPDATE ${assignments} WHERE ${where};`);
      } else {
        statements.push(`UPDATE ${tableSql} SET ${assignments} WHERE ${where};`);
      }
      updateCount += 1;
    }
  }

  if (includeDeletes && deletes.length > 0) {
    for (const row of deletes) {
      const where = buildWhereClause(dialect, diff.keyColumns, row.keyValues);
      if (dialect === 'clickhouse') {
        statements.push(`ALTER TABLE ${tableSql} DELETE WHERE ${where};`);
      } else {
        statements.push(`DELETE FROM ${tableSql} WHERE ${where};`);
      }
      deleteCount += 1;
    }
  }

  return {
    dialect,
    insertCount,
    updateCount,
    deleteCount,
    statements,
    sql: statements.join('\n\n'),
  };
}

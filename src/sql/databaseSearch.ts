/**
 * Global Object Search (tables/views/columns/routines/comments across schemas)
 * and Cross-Table Database Data Search SQL Builder & Match Aggregator.
 * Pure, browser-sandbox compatible (zero Node imports).
 */

import type {
  CellValue,
  ColumnStructure,
  QueryResultSet,
  RoutineSummary,
  SqlDialect,
  TableStructure,
  TableSummary,
  ViewSummary,
} from '../drivers/types';

export type SearchableObjectKind = 'table' | 'view' | 'materialized_view' | 'column' | 'routine';

export interface GlobalObjectSearchHit {
  schema: string;
  objectKind: SearchableObjectKind;
  tableName: string;
  columnName?: string;
  dataType?: string;
  comment?: string;
  matchedIn: Array<'name' | 'column' | 'comment'>;
}

export interface GlobalObjectSearchSqlOptions {
  dialect: SqlDialect;
  database: string;
  schema?: string;
  term: string;
  limit?: number;
}

export interface CachedSchemaObjectsSlice {
  schema: string;
  tables: readonly TableSummary[];
  views: readonly ViewSummary[];
  routines: readonly RoutineSummary[];
  structures: Record<string, TableStructure>;
}

export interface TableDataSearchSqlOptions {
  dialect: SqlDialect;
  schema?: string;
  tableName: string;
  columns: readonly Pick<ColumnStructure, 'name' | 'dataType'>[];
  term: string;
  limit?: number;
}

export interface TableDataSearchSql {
  sql: string;
  searchableColumns: string[];
}

export interface DataSearchRowMatch {
  schema: string;
  tableName: string;
  matchedColumns: string[];
  rowValues: Record<string, CellValue>;
  whereClause: string;
}

export interface DataSearchTableSummary {
  schema: string;
  tableName: string;
  matches: DataSearchRowMatch[];
  error?: string;
}

/* ============================================================================
 * Helpers
 * ============================================================================ */

const TEXT_TYPES = [
  'char',
  'text',
  'clob',
  'varchar',
  'nvarchar',
  'nchar',
  'uuid',
  'uniqueidentifier',
  'enum',
  'json',
  'xml',
  'string',
  'fixedstring',
];

const NUMBER_TYPES = [
  'int',
  'serial',
  'number',
  'numeric',
  'decimal',
  'float',
  'double',
  'real',
  'money',
  'uint',
];

const SKIPPED_TYPES = ['blob', 'binary', 'bytea', 'image', 'geometry', 'geography', 'varbinary'];

export function isTextSearchColumn(column: Pick<ColumnStructure, 'dataType'>): boolean {
  const t = column.dataType.toLowerCase();
  if (SKIPPED_TYPES.some((s) => t.includes(s))) return false;
  return TEXT_TYPES.some((k) => t.includes(k));
}

export function isNumericSearchColumn(column: Pick<ColumnStructure, 'dataType'>): boolean {
  const t = column.dataType.toLowerCase();
  if (SKIPPED_TYPES.some((s) => t.includes(s))) return false;
  return NUMBER_TYPES.some((k) => t.includes(k));
}

export function parseNumericTerm(term: string): string | null {
  const trimmed = term.trim();
  if (!/^[+-]?(?:\d+|\d+\.\d+|\.\d+)$/.test(trimmed)) return null;
  return trimmed;
}

function escapeSqlLiteral(dialect: SqlDialect, value: string): string {
  if (dialect === 'mysql' || dialect === 'clickhouse') {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function escapeLikePattern(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

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

/* ============================================================================
 * 1. Global Object Search SQL Builder & Parser
 * ============================================================================ */

export function buildGlobalObjectSearchSql(options: GlobalObjectSearchSqlOptions): string | null {
  const term = options.term.trim();
  if (!term) return null;
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 200)));
  const likeLiteral = escapeSqlLiteral(options.dialect, `%${escapeLikePattern(term.toLowerCase())}%`);
  const schema = options.schema?.trim();

  if (options.dialect === 'postgres') {
    const schemaFilter = schema
      ? `n.nspname = ${escapeSqlLiteral('postgres', schema)}`
      : `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'`;
    return `SELECT object_schema, object_kind, object_name, column_name, data_type, comment FROM (
  SELECT n.nspname AS object_schema,
         CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view' ELSE 'table' END AS object_kind,
         c.relname AS object_name,
         '' AS column_name,
         '' AS data_type,
         COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm')
    AND ${schemaFilter}
    AND (LOWER(c.relname) LIKE ${likeLiteral} ESCAPE '\\'
      OR LOWER(COALESCE(obj_description(c.oid, 'pg_class'), '')) LIKE ${likeLiteral} ESCAPE '\\')
  UNION ALL
  SELECT n.nspname AS object_schema,
         'column' AS object_kind,
         c.relname AS object_name,
         a.attname AS column_name,
         pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
         COALESCE(col_description(c.oid, a.attnum), '') AS comment
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE a.attnum > 0 AND NOT a.attisdropped
    AND c.relkind IN ('r', 'p', 'f', 'v', 'm')
    AND ${schemaFilter}
    AND (LOWER(a.attname) LIKE ${likeLiteral} ESCAPE '\\'
      OR LOWER(COALESCE(col_description(c.oid, a.attnum), '')) LIKE ${likeLiteral} ESCAPE '\\')
  UNION ALL
  SELECT n.nspname AS object_schema,
         'routine' AS object_kind,
         p.proname AS object_name,
         '' AS column_name,
         '' AS data_type,
         COALESCE(obj_description(p.oid, 'pg_proc'), '') AS comment
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE ${schemaFilter}
    AND LOWER(p.proname) LIKE ${likeLiteral} ESCAPE '\\'
) hits
ORDER BY object_schema, object_name, column_name
LIMIT ${limit}`;
  }

  if (options.dialect === 'mysql') {
    const dbName = schema || options.database;
    const dbFilter = dbName
      ? `TABLE_SCHEMA = ${escapeSqlLiteral('mysql', dbName)}`
      : `TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')`;
    const rFilter = dbName
      ? `ROUTINE_SCHEMA = ${escapeSqlLiteral('mysql', dbName)}`
      : `ROUTINE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')`;
    return `SELECT object_schema, object_kind, object_name, column_name, data_type, comment FROM (
  SELECT TABLE_SCHEMA AS object_schema,
         CASE WHEN TABLE_TYPE = 'VIEW' THEN 'view' ELSE 'table' END AS object_kind,
         TABLE_NAME AS object_name,
         '' AS column_name,
         '' AS data_type,
         COALESCE(TABLE_COMMENT, '') AS comment
  FROM information_schema.TABLES
  WHERE ${dbFilter}
    AND (LOWER(TABLE_NAME) LIKE ${likeLiteral} ESCAPE '\\\\'
      OR LOWER(COALESCE(TABLE_COMMENT, '')) LIKE ${likeLiteral} ESCAPE '\\\\')
  UNION ALL
  SELECT TABLE_SCHEMA AS object_schema,
         'column' AS object_kind,
         TABLE_NAME AS object_name,
         COLUMN_NAME AS column_name,
         COLUMN_TYPE AS data_type,
         COALESCE(COLUMN_COMMENT, '') AS comment
  FROM information_schema.COLUMNS
  WHERE ${dbFilter}
    AND (LOWER(COLUMN_NAME) LIKE ${likeLiteral} ESCAPE '\\\\'
      OR LOWER(COALESCE(COLUMN_COMMENT, '')) LIKE ${likeLiteral} ESCAPE '\\\\')
  UNION ALL
  SELECT ROUTINE_SCHEMA AS object_schema,
         'routine' AS object_kind,
         ROUTINE_NAME AS object_name,
         '' AS column_name,
         ROUTINE_TYPE AS data_type,
         COALESCE(ROUTINE_COMMENT, '') AS comment
  FROM information_schema.ROUTINES
  WHERE ${rFilter}
    AND LOWER(ROUTINE_NAME) LIKE ${likeLiteral} ESCAPE '\\\\'
) hits
ORDER BY object_schema, object_name, column_name
LIMIT ${limit}`;
  }

  if (options.dialect === 'mssql') {
    const schemaFilter = schema
      ? `s.name = ${escapeSqlLiteral('mssql', schema)}`
      : `s.name NOT IN ('sys', 'INFORMATION_SCHEMA')`;
    return `SELECT TOP (${limit}) object_schema, object_kind, object_name, column_name, data_type, comment FROM (
  SELECT s.name AS object_schema,
         CASE WHEN o.type = 'V' THEN 'view' ELSE 'table' END AS object_kind,
         o.name AS object_name,
         '' AS column_name,
         '' AS data_type,
         CAST(ISNULL(ep.value, '') AS NVARCHAR(4000)) AS comment
  FROM sys.objects o
  JOIN sys.schemas s ON s.schema_id = o.schema_id
  LEFT JOIN sys.extended_properties ep ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
  WHERE o.type IN ('U', 'V') AND ${schemaFilter}
    AND (LOWER(o.name) LIKE ${likeLiteral} ESCAPE '\\'
      OR LOWER(CAST(ISNULL(ep.value, '') AS NVARCHAR(4000))) LIKE ${likeLiteral} ESCAPE '\\')
  UNION ALL
  SELECT s.name AS object_schema,
         'column' AS object_kind,
         o.name AS object_name,
         c.name AS column_name,
         TYPE_NAME(c.user_type_id) AS data_type,
         CAST(ISNULL(ep.value, '') AS NVARCHAR(4000)) AS comment
  FROM sys.columns c
  JOIN sys.objects o ON o.object_id = c.object_id
  JOIN sys.schemas s ON s.schema_id = o.schema_id
  LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
  WHERE o.type IN ('U', 'V') AND ${schemaFilter}
    AND (LOWER(c.name) LIKE ${likeLiteral} ESCAPE '\\'
      OR LOWER(CAST(ISNULL(ep.value, '') AS NVARCHAR(4000))) LIKE ${likeLiteral} ESCAPE '\\')
  UNION ALL
  SELECT s.name AS object_schema,
         'routine' AS object_kind,
         o.name AS object_name,
         '' AS column_name,
         o.type_desc AS data_type,
         '' AS comment
  FROM sys.objects o
  JOIN sys.schemas s ON s.schema_id = o.schema_id
  WHERE o.type IN ('P', 'FN', 'IF', 'TF') AND ${schemaFilter}
    AND LOWER(o.name) LIKE ${likeLiteral} ESCAPE '\\'
) hits
ORDER BY object_schema, object_name, column_name`;
  }

  if (options.dialect === 'clickhouse') {
    const dbName = schema || options.database;
    const dbFilter = dbName
      ? `database = ${escapeSqlLiteral('clickhouse', dbName)}`
      : `database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA')`;
    const termLit = escapeSqlLiteral('clickhouse', term);
    return `SELECT object_schema, object_kind, object_name, column_name, data_type, comment FROM (
  SELECT database AS object_schema,
         if(engine = 'MaterializedView', 'materialized_view', if(engine = 'View', 'view', 'table')) AS object_kind,
         name AS object_name,
         '' AS column_name,
         engine AS data_type,
         comment
  FROM system.tables
  WHERE ${dbFilter}
    AND (positionCaseInsensitive(name, ${termLit}) > 0 OR positionCaseInsensitive(comment, ${termLit}) > 0)
  UNION ALL
  SELECT database AS object_schema,
         'column' AS object_kind,
         table AS object_name,
         name AS column_name,
         type AS data_type,
         comment
  FROM system.columns
  WHERE ${dbFilter}
    AND (positionCaseInsensitive(name, ${termLit}) > 0 OR positionCaseInsensitive(comment, ${termLit}) > 0)
)
ORDER BY object_schema, object_name, column_name
LIMIT ${limit}`;
  }

  if (options.dialect === 'sqlite') {
    return `SELECT 'main' AS object_schema,
       type AS object_kind,
       name AS object_name,
       '' AS column_name,
       '' AS data_type,
       '' AS comment
FROM sqlite_master
WHERE type IN ('table', 'view')
  AND name NOT LIKE 'sqlite_%'
  AND (LOWER(name) LIKE ${likeLiteral} ESCAPE '\\' OR LOWER(COALESCE(sql, '')) LIKE ${likeLiteral} ESCAPE '\\')
ORDER BY name
LIMIT ${limit}`;
  }

  return null;
}

export function parseGlobalObjectSearchRows(
  result: QueryResultSet | null | undefined,
  term: string,
): GlobalObjectSearchHit[] {
  const q = term.trim().toLowerCase();
  if (!result || !q || !Array.isArray(result.rows)) return [];
  const colMap = new Map(result.columns.map((c, i) => [c.name.toLowerCase(), i]));
  const get = (row: readonly CellValue[], key: string): string => {
    const idx = colMap.get(key);
    if (idx === undefined || row[idx] === null || row[idx] === undefined) return '';
    return String(row[idx]);
  };

  const hits: GlobalObjectSearchHit[] = [];
  for (const row of result.rows) {
    const schema = get(row, 'object_schema');
    const rawKind = get(row, 'object_kind').toLowerCase();
    const tableName = get(row, 'object_name');
    const columnName = get(row, 'column_name') || undefined;
    const dataType = get(row, 'data_type') || undefined;
    const comment = get(row, 'comment') || undefined;
    if (!tableName) continue;

    const objectKind: SearchableObjectKind =
      rawKind === 'view' || rawKind === 'materialized_view' || rawKind === 'column' || rawKind === 'routine'
        ? rawKind
        : 'table';

    const matchedIn: Array<'name' | 'column' | 'comment'> = [];
    if (tableName.toLowerCase().includes(q)) matchedIn.push('name');
    if (columnName && columnName.toLowerCase().includes(q)) matchedIn.push('column');
    if (comment && comment.toLowerCase().includes(q)) matchedIn.push('comment');
    if (matchedIn.length === 0) matchedIn.push(columnName ? 'column' : 'name');

    hits.push({ schema, objectKind, tableName, columnName, dataType, comment, matchedIn });
  }
  return hits;
}

export function searchCachedSchemaObjects(
  slices: readonly CachedSchemaObjectsSlice[],
  term: string,
  limit = 200,
): GlobalObjectSearchHit[] {
  const q = term.trim().toLowerCase();
  if (!q) return [];
  const hits: GlobalObjectSearchHit[] = [];

  for (const slice of slices) {
    for (const tbl of slice.tables) {
      const matchedIn: Array<'name' | 'column' | 'comment'> = [];
      if (tbl.name.toLowerCase().includes(q)) matchedIn.push('name');
      if (tbl.comment && tbl.comment.toLowerCase().includes(q)) matchedIn.push('comment');
      if (matchedIn.length > 0) {
        hits.push({
          schema: tbl.schema || slice.schema,
          objectKind: tbl.kind === 'materialized_view' ? 'materialized_view' : 'table',
          tableName: tbl.name,
          comment: tbl.comment,
          matchedIn,
        });
      }
      const struct = slice.structures[tbl.name];
      if (struct) {
        for (const col of struct.columns) {
          const colMatched: Array<'name' | 'column' | 'comment'> = [];
          if (col.name.toLowerCase().includes(q)) colMatched.push('column');
          if (col.comment && col.comment.toLowerCase().includes(q)) colMatched.push('comment');
          if (colMatched.length > 0) {
            hits.push({
              schema: tbl.schema || slice.schema,
              objectKind: 'column',
              tableName: tbl.name,
              columnName: col.name,
              dataType: col.dataType,
              comment: col.comment ?? undefined,
              matchedIn: colMatched,
            });
          }
        }
      }
      if (hits.length >= limit) return hits;
    }

    for (const v of slice.views) {
      const matchedIn: Array<'name' | 'column' | 'comment'> = [];
      if (v.name.toLowerCase().includes(q)) matchedIn.push('name');
      if (v.comment && v.comment.toLowerCase().includes(q)) matchedIn.push('comment');
      if (matchedIn.length > 0) {
        hits.push({
          schema: v.schema || slice.schema,
          objectKind: v.isMaterialized ? 'materialized_view' : 'view',
          tableName: v.name,
          comment: v.comment,
          matchedIn,
        });
      }
      if (hits.length >= limit) return hits;
    }

    for (const r of slice.routines) {
      if (r.name.toLowerCase().includes(q)) {
        hits.push({
          schema: r.schema || slice.schema,
          objectKind: 'routine',
          tableName: r.name,
          dataType: r.kind,
          matchedIn: ['name'],
        });
      }
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

/* ============================================================================
 * 2. Cross-Table Database Data Search SQL Builder & Match Aggregator
 * ============================================================================ */

export function buildTableDataSearchSql(options: TableDataSearchSqlOptions): TableDataSearchSql | null {
  const term = options.term.trim();
  if (!term || options.columns.length === 0) return null;

  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50)));
  const numericTerm = parseNumericTerm(term);
  const predicates: string[] = [];
  const searchableColumns: string[] = [];

  for (const col of options.columns) {
    const ident = quoteIdent(options.dialect, col.name);
    if (isTextSearchColumn(col)) {
      searchableColumns.push(col.name);
      if (options.dialect === 'postgres') {
        const pat = escapeSqlLiteral('postgres', `%${escapeLikePattern(term)}%`);
        predicates.push(`CAST(${ident} AS TEXT) ILIKE ${pat} ESCAPE '\\'`);
      } else if (options.dialect === 'clickhouse') {
        predicates.push(`positionCaseInsensitive(toString(${ident}), ${escapeSqlLiteral('clickhouse', term)}) > 0`);
      } else if (options.dialect === 'mysql') {
        const pat = escapeSqlLiteral('mysql', `%${escapeLikePattern(term.toLowerCase())}%`);
        predicates.push(`LOWER(CAST(${ident} AS CHAR)) LIKE ${pat} ESCAPE '\\\\'`);
      } else if (options.dialect === 'mssql') {
        const pat = escapeSqlLiteral('mssql', `%${escapeLikePattern(term.toLowerCase())}%`);
        predicates.push(`LOWER(CAST(${ident} AS NVARCHAR(MAX))) LIKE ${pat} ESCAPE '\\'`);
      } else {
        const pat = escapeSqlLiteral(options.dialect, `%${escapeLikePattern(term.toLowerCase())}%`);
        predicates.push(`LOWER(CAST(${ident} AS TEXT)) LIKE ${pat} ESCAPE '\\'`);
      }
    } else if (numericTerm && isNumericSearchColumn(col)) {
      searchableColumns.push(col.name);
      predicates.push(`${ident} = ${numericTerm}`);
    }
  }

  if (predicates.length === 0) return null;

  const qualTable = qualifyTable(options.dialect, options.tableName, options.schema);
  const where = predicates.join(' OR ');

  const sql =
    options.dialect === 'mssql'
      ? `SELECT TOP (${limit}) * FROM ${qualTable} WHERE ${where}`
      : `SELECT * FROM ${qualTable} WHERE ${where} LIMIT ${limit}`;

  return { sql, searchableColumns };
}

export function findMatchedColumnsInRow(
  resultColumns: readonly string[],
  row: readonly CellValue[],
  schemaColumns: readonly Pick<ColumnStructure, 'name' | 'dataType'>[],
  term: string,
): string[] {
  const query = term.trim().toLowerCase();
  const numericTerm = parseNumericTerm(term);
  if (!query) return [];

  const byLower = new Map(schemaColumns.map((c) => [c.name.toLowerCase(), c]));
  const matched: string[] = [];

  for (let i = 0; i < resultColumns.length; i += 1) {
    const colName = resultColumns[i];
    const value = row[i];
    if (value === null || value === undefined) continue;
    const schemaCol = byLower.get(colName.toLowerCase());
    const text = String(value);

    if (schemaCol && isNumericSearchColumn(schemaCol)) {
      if (numericTerm && text.trim() === numericTerm) {
        matched.push(colName);
      }
      continue;
    }

    if (!schemaCol || isTextSearchColumn(schemaCol)) {
      if (text.toLowerCase().includes(query)) {
        matched.push(colName);
      }
    }
  }
  return matched;
}

export function buildJumpToRowWhereClause(options: {
  dialect: SqlDialect;
  columns: readonly ColumnStructure[];
  rowValues: Record<string, CellValue>;
  matchedColumns?: readonly string[];
}): string {
  const pkCols = options.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
  const targetCols =
    pkCols.length > 0
      ? pkCols
      : options.matchedColumns && options.matchedColumns.length > 0
        ? options.matchedColumns.slice(0, 3)
        : Object.keys(options.rowValues).slice(0, 3);

  return targetCols
    .map((col) => {
      const ident = quoteIdent(options.dialect, col);
      const val = options.rowValues[col];
      if (val === null || val === undefined) return `${ident} IS NULL`;
      if (typeof val === 'number' && Number.isFinite(val)) return `${ident} = ${val}`;
      if (typeof val === 'boolean') {
        if (options.dialect === 'mssql' || options.dialect === 'sqlite') return `${ident} = ${val ? 1 : 0}`;
        return `${ident} = ${val ? 'TRUE' : 'FALSE'}`;
      }
      return `${ident} = ${escapeSqlLiteral(options.dialect, String(val))}`;
    })
    .join(' AND ');
}

export function aggregateDataSearchMatches(options: {
  dialect: SqlDialect;
  schema: string;
  tableName: string;
  schemaColumns: readonly ColumnStructure[];
  result: QueryResultSet;
  term: string;
}): DataSearchTableSummary {
  const { dialect, schema, tableName, schemaColumns, result, term } = options;
  const colNames = result.columns.map((c) => c.name);
  const matches: DataSearchRowMatch[] = [];

  for (const row of result.rows) {
    const matchedColumns = findMatchedColumnsInRow(colNames, row, schemaColumns, term);
    if (matchedColumns.length === 0) continue;
    const rowValues: Record<string, CellValue> = {};
    colNames.forEach((c, idx) => {
      rowValues[c] = row[idx] ?? null;
    });
    const whereClause = buildJumpToRowWhereClause({
      dialect,
      columns: schemaColumns,
      rowValues,
      matchedColumns,
    });
    matches.push({ schema, tableName, matchedColumns, rowValues, whereClause });
  }

  return { schema, tableName, matches };
}

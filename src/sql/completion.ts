/**
 * Schema-aware SQL completion builder.
 * Produces Monaco-compatible completion items (tables, views, alias-resolved columns,
 * dialect functions, keywords, and SQL snippets) with zero runtime UI dependencies.
 */

import type { SqlDialect } from '../drivers/types';

export type CompletionItemKind = 'table' | 'view' | 'column' | 'function' | 'keyword' | 'snippet';

export interface SqlCompletionItem {
  label: string;
  kind: CompletionItemKind;
  detail?: string;
  insertText: string;
  documentation?: string;
  sortPriority?: number;
}

export interface CompletionTableSchema {
  name: string;
  schema?: string;
  kind?: 'table' | 'view';
  columns: Array<{
    name: string;
    dataType: string;
    isPrimaryKey?: boolean;
    nullable?: boolean;
  }>;
}

export interface CompletionSchemaInput {
  dialect: SqlDialect;
  tables: CompletionTableSchema[];
}

export interface MonacoCompletionSchemaPayload {
  tables: Array<{ name: string; schema?: string; columns: Array<{ name: string; type: string }> }>;
  keywords: string[];
  functions: string[];
}

const COMMON_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'RIGHT JOIN', 'FULL OUTER JOIN',
  'ON', 'GROUP BY', 'HAVING', 'ORDER BY', 'ASC', 'DESC', 'LIMIT', 'OFFSET', 'DISTINCT',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE',
  'DROP TABLE', 'CREATE INDEX', 'CREATE VIEW', 'WITH', 'AS', 'AND', 'OR', 'NOT', 'IN',
  'EXISTS', 'BETWEEN', 'LIKE', 'IS NULL', 'IS NOT NULL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'UNION', 'UNION ALL', 'EXPLAIN', 'BEGIN', 'COMMIT', 'ROLLBACK',
];

const DIALECT_KEYWORDS: Record<SqlDialect, string[]> = {
  postgres: ['ILIKE', 'RETURNING', 'ON CONFLICT', 'DO NOTHING', 'DO UPDATE', 'JSONB', 'SERIAL', 'BIGSERIAL', 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)', 'LATERAL'],
  mysql: ['AUTO_INCREMENT', 'ON DUPLICATE KEY UPDATE', 'SHOW TABLES', 'SHOW CREATE TABLE', 'DESCRIBE', 'EXPLAIN FORMAT=JSON', 'ENGINE=InnoDB'],
  sqlite: ['AUTOINCREMENT', 'PRAGMA', 'EXPLAIN QUERY PLAN', 'WITHOUT ROWID', 'STRICT', 'VACUUM'],
  clickhouse: ['PREWHERE', 'FINAL', 'SAMPLE', 'ARRAY JOIN', 'ENGINE = MergeTree()', 'FORMAT JSONCompact', 'FORMAT JSONEachRow', 'SETTINGS'],
};

const DIALECT_FUNCTIONS: Record<SqlDialect, Array<{ name: string; detail: string }>> = {
  postgres: [
    { name: 'COUNT', detail: 'COUNT(expr) -> bigint' },
    { name: 'SUM', detail: 'SUM(expr) -> numeric' },
    { name: 'AVG', detail: 'AVG(expr) -> numeric' },
    { name: 'MIN', detail: 'MIN(expr)' },
    { name: 'MAX', detail: 'MAX(expr)' },
    { name: 'COALESCE', detail: 'COALESCE(val1, val2, ...)' },
    { name: 'NOW', detail: 'NOW() -> timestamptz' },
    { name: 'DATE_TRUNC', detail: "DATE_TRUNC('day', ts)" },
    { name: 'JSONB_BUILD_OBJECT', detail: 'JSONB_BUILD_OBJECT(k, v, ...)' },
    { name: 'STRING_AGG', detail: "STRING_AGG(col, ',')" },
    { name: 'ROW_NUMBER', detail: 'ROW_NUMBER() OVER (...)' },
  ],
  mysql: [
    { name: 'COUNT', detail: 'COUNT(expr)' },
    { name: 'SUM', detail: 'SUM(expr)' },
    { name: 'AVG', detail: 'AVG(expr)' },
    { name: 'IFNULL', detail: 'IFNULL(expr1, expr2)' },
    { name: 'COALESCE', detail: 'COALESCE(val1, val2, ...)' },
    { name: 'NOW', detail: 'NOW() -> datetime' },
    { name: 'DATE_FORMAT', detail: "DATE_FORMAT(dt, '%Y-%m-%d')" },
    { name: 'GROUP_CONCAT', detail: 'GROUP_CONCAT(col)' },
    { name: 'JSON_EXTRACT', detail: "JSON_EXTRACT(doc, '$.path')" },
  ],
  sqlite: [
    { name: 'COUNT', detail: 'COUNT(expr)' },
    { name: 'SUM', detail: 'SUM(expr)' },
    { name: 'AVG', detail: 'AVG(expr)' },
    { name: 'COALESCE', detail: 'COALESCE(val1, val2, ...)' },
    { name: 'IFNULL', detail: 'IFNULL(x, y)' },
    { name: 'DATETIME', detail: "DATETIME('now')" },
    { name: 'STRFTIME', detail: "STRFTIME('%Y-%m-%d', ts)" },
    { name: 'GROUP_CONCAT', detail: 'GROUP_CONCAT(x, sep)' },
    { name: 'JSON_EXTRACT', detail: "JSON_EXTRACT(json, '$.key')" },
  ],
  clickhouse: [
    { name: 'count', detail: 'count()' },
    { name: 'uniqExact', detail: 'uniqExact(x)' },
    { name: 'sum', detail: 'sum(x)' },
    { name: 'avg', detail: 'avg(x)' },
    { name: 'toStartOfDay', detail: 'toStartOfDay(ts)' },
    { name: 'toStartOfHour', detail: 'toStartOfHour(ts)' },
    { name: 'now', detail: 'now()' },
    { name: 'groupArray', detail: 'groupArray(x)' },
    { name: 'JSONExtractString', detail: "JSONExtractString(json, 'key')" },
  ],
};

/**
 * Extracts table -> alias mappings from FROM / JOIN clauses in SQL.
 */
export function extractTableAliases(sql: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const re = /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\.)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?(?:\s+(?:AS\s+)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?)?/gi;
  const reservedAfterTable = new Set([
    'WHERE', 'ON', 'SET', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS',
    'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'VALUES', 'SELECT', 'AS', 'USING',
  ]);
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const tableName = m[2];
    const maybeAlias = m[3];
    if (tableName) {
      aliases.set(tableName.toLowerCase(), tableName);
      if (maybeAlias && !reservedAfterTable.has(maybeAlias.toUpperCase())) {
        aliases.set(maybeAlias.toLowerCase(), tableName);
      }
    }
  }
  return aliases;
}

/**
 * Builds Monaco-ready completionSchema JSON payload for the host-rendered code-editor widget.
 */
export function buildMonacoCompletionSchema(schema: CompletionSchemaInput): MonacoCompletionSchemaPayload {
  return {
    tables: schema.tables.map((t) => ({
      name: t.name,
      schema: t.schema,
      columns: t.columns.map((c) => ({ name: c.name, type: c.dataType })),
    })),
    keywords: [...COMMON_KEYWORDS, ...(DIALECT_KEYWORDS[schema.dialect] ?? [])],
    functions: (DIALECT_FUNCTIONS[schema.dialect] ?? []).map((f) => f.name),
  };
}

/**
 * Computes ranked completion items at a cursor offset inside SQL text.
 */
export function getSqlCompletions(
  sql: string,
  cursorOffset: number,
  schema: CompletionSchemaInput,
): SqlCompletionItem[] {
  const before = sql.slice(0, Math.max(0, Math.min(cursorOffset, sql.length)));
  const items: SqlCompletionItem[] = [];
  const tableMap = new Map<string, CompletionTableSchema>();
  for (const t of schema.tables) {
    tableMap.set(t.name.toLowerCase(), t);
  }

  // Case 1: Qualified column completion after "alias." or "table."
  const dotMatch = /([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_]*)$/.exec(before);
  if (dotMatch) {
    const prefix = dotMatch[1].toLowerCase();
    const partial = dotMatch[2].toLowerCase();
    const aliases = extractTableAliases(sql);
    const resolvedTableName = aliases.get(prefix) ?? prefix;
    const table = tableMap.get(resolvedTableName.toLowerCase());
    if (table) {
      for (const col of table.columns) {
        if (!partial || col.name.toLowerCase().startsWith(partial)) {
          items.push({
            label: col.name,
            kind: 'column',
            detail: `${table.name}.${col.name} (${col.dataType}${col.isPrimaryKey ? ', PK' : ''})`,
            insertText: col.name,
            sortPriority: 1,
          });
        }
      }
      return items;
    }
    // Check if prefix is a schema name
    for (const t of schema.tables) {
      if (t.schema?.toLowerCase() === prefix && (!partial || t.name.toLowerCase().startsWith(partial))) {
        items.push({
          label: t.name,
          kind: t.kind === 'view' ? 'view' : 'table',
          detail: `${t.schema}.${t.name}`,
          insertText: t.name,
          sortPriority: 1,
        });
      }
    }
    return items;
  }

  // Extract partial word at cursor
  const wordMatch = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(before);
  const partial = (wordMatch?.[1] ?? '').toLowerCase();
  const prevClause = before.slice(0, before.length - partial.length).trimEnd();
  const expectsTable = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s*$/i.test(prevClause);

  const aliases = extractTableAliases(sql);
  const referencedTables = new Set(Array.from(aliases.values()).map((v) => v.toLowerCase()));

  // Columns from referenced tables first
  if (!expectsTable) {
    for (const tName of referencedTables) {
      const tbl = tableMap.get(tName);
      if (!tbl) continue;
      for (const col of tbl.columns) {
        if (!partial || col.name.toLowerCase().includes(partial)) {
          items.push({
            label: col.name,
            kind: 'column',
            detail: `${tbl.name} (${col.dataType})`,
            insertText: col.name,
            sortPriority: col.name.toLowerCase().startsWith(partial) ? 1 : 3,
          });
        }
      }
    }
  }

  // Tables and views
  for (const t of schema.tables) {
    if (!partial || t.name.toLowerCase().includes(partial)) {
      items.push({
        label: t.name,
        kind: t.kind === 'view' ? 'view' : 'table',
        detail: t.schema ? `${t.schema}.${t.name}` : t.kind ?? 'table',
        insertText: t.name,
        sortPriority: expectsTable ? 0 : 2,
      });
    }
  }

  // Dialect functions
  if (!expectsTable) {
    for (const fn of DIALECT_FUNCTIONS[schema.dialect] ?? []) {
      if (!partial || fn.name.toLowerCase().includes(partial)) {
        items.push({
          label: fn.name,
          kind: 'function',
          detail: fn.detail,
          insertText: `${fn.name}()`,
          sortPriority: 4,
        });
      }
    }
  }

  // Keywords
  const allKw = [...COMMON_KEYWORDS, ...(DIALECT_KEYWORDS[schema.dialect] ?? [])];
  for (const kw of allKw) {
    if (!partial || kw.toLowerCase().startsWith(partial)) {
      items.push({
        label: kw,
        kind: 'keyword',
        insertText: kw,
        sortPriority: 5,
      });
    }
  }

  return items.sort((a, b) => (a.sortPriority ?? 10) - (b.sortPriority ?? 10) || a.label.localeCompare(b.label));
}

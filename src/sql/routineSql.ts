/**
 * multi-database SQL builders for Routine execution (IN/OUT/INOUT), Sequences,
 * MySQL Scheduled Events, Trigger Enable/Disable, Materialized View refresh,
 * and Create/Drop Database & Schema.
 * 100% pure TypeScript — zero Node imports.
 */

import { qualifiedTableName, quoteIdent, quoteSqlLiteral } from '../drivers/sqlDialect';
import type { CellValue, SqlDialect } from '../drivers/types';

export interface ParsedRoutineParam {
  name: string;
  mode: 'IN' | 'OUT' | 'INOUT';
  dataType: string;
  defaultValue?: string;
}

/**
 * Parse PostgreSQL / MySQL / MSSQL routine parameter signature string into structured params.
 * Handles e.g. `IN p_id integer, OUT p_total numeric, INOUT p_tag text DEFAULT 'x'`
 * or MSSQL `@id INT, @total DECIMAL(10,2) OUTPUT`.
 */
export function parseRoutineParameters(
  rawArgs: string | undefined,
  dialect: SqlDialect,
): ParsedRoutineParam[] {
  const text = (rawArgs ?? '').trim();
  if (!text) return [];
  // Strip outer parentheses if present
  const inner = text.startsWith('(') && text.endsWith(')') ? text.slice(1, -1).trim() : text;
  if (!inner) return [];

  // Split by top-level commas (respecting nested parens e.g. DECIMAL(10, 2))
  const parts: string[] = [];
  let depth = 0;
  let inQuote: string | null = null;
  let current = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inQuote) {
      current += ch;
      if (ch === inQuote && inner[i - 1] !== '\\') inQuote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inQuote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());

  const results: ParsedRoutineParam[] = [];
  for (let idx = 0; idx < parts.length; idx++) {
    let seg = parts[idx].trim();
    if (!seg) continue;

    // Extract DEFAULT clause if present
    let defaultValue: string | undefined;
    const defMatch = seg.match(/\s+(?:DEFAULT|=)\s+(.+)$/i);
    if (defMatch) {
      defaultValue = defMatch[1].trim();
      seg = seg.slice(0, defMatch.index).trim();
    }

    let mode: 'IN' | 'OUT' | 'INOUT' = 'IN';
    if (dialect === 'mssql') {
      if (/\b(?:OUTPUT|OUT)\b/i.test(seg)) {
        mode = 'OUT';
        seg = seg.replace(/\s*\b(?:OUTPUT|OUT)\b/gi, '').trim();
      }
      const tokens = seg.split(/\s+/);
      const rawName = tokens[0]?.startsWith('@') ? tokens[0] : `@param_${idx + 1}`;
      const dataType = tokens.length > 1 ? tokens.slice(1).join(' ') : 'NVARCHAR(MAX)';
      results.push({ name: rawName, mode, dataType, defaultValue });
      continue;
    }

    const modeMatch = seg.match(/^(INOUT|IN|OUT|VARIADIC)\s+(.+)$/i);
    if (modeMatch) {
      const kw = modeMatch[1].toUpperCase();
      if (kw === 'OUT' || kw === 'INOUT') mode = kw;
      seg = modeMatch[2].trim();
    }

    const tokens = seg.split(/\s+/);
    if (tokens.length === 1) {
      results.push({ name: `arg_${idx + 1}`, mode, dataType: tokens[0], defaultValue });
    } else {
      const name = tokens[0].replace(/^["`]|["`]$/g, '');
      const dataType = tokens.slice(1).join(' ');
      results.push({ name, mode, dataType, defaultValue });
    }
  }
  return results;
}

function coerceRoutineValue(raw: string | undefined, dataType: string): CellValue {
  if (raw === undefined || raw.trim() === '' || /^null$/i.test(raw.trim())) return null;
  const trimmed = raw.trim();
  const upper = dataType.toUpperCase();
  if (/^(BOOL|BOOLEAN|BIT)\b/.test(upper)) {
    return trimmed === '1' || /^true$/i.test(trimmed);
  }
  if (/^(INT|BIGINT|SMALLINT|TINYINT|INTEGER|NUMERIC|DECIMAL|REAL|FLOAT|DOUBLE|MONEY)/.test(upper)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  return trimmed;
}

/**
 * Generate dialect-aware executable SQL for invoking a Function or Stored Procedure
 * with IN / OUT / INOUT parameter bindings.
 */
export function buildRoutineExecutionSql(opts: {
  dialect: SqlDialect;
  db: string;
  schema: string;
  name: string;
  kind: 'function' | 'procedure';
  params: readonly ParsedRoutineParam[];
  values: Record<string, string>;
}): string {
  const { dialect, db, schema, name, kind, params, values } = opts;
  const qName = qualifiedTableName(db, schema, name, dialect);

  if (dialect === 'mysql') {
    const preStmts: string[] = [];
    const argExprs: string[] = [];
    const outVars: Array<{ varName: string; alias: string }> = [];
    let outIdx = 0;

    for (const p of params) {
      if (p.mode === 'OUT' || p.mode === 'INOUT') {
        outIdx++;
        const varName = `@ndb_output_${outIdx}`;
        if (p.mode === 'INOUT') {
          const val = coerceRoutineValue(values[p.name], p.dataType);
          preStmts.push(`SET ${varName} = ${quoteSqlLiteral(val, 'mysql')};`);
        } else {
          preStmts.push(`SET ${varName} = NULL;`);
        }
        argExprs.push(varName);
        outVars.push({ varName, alias: p.name });
      } else {
        const val = coerceRoutineValue(values[p.name], p.dataType);
        argExprs.push(quoteSqlLiteral(val, 'mysql'));
      }
    }

    if (kind === 'procedure') {
      const lines = [...preStmts, `CALL ${qName}(${argExprs.join(', ')});`];
      if (outVars.length > 0) {
        const sel = outVars.map((v) => `${v.varName} AS ${quoteIdent(v.alias, 'mysql')}`).join(', ');
        lines.push(`SELECT ${sel};`);
      }
      return lines.join('\n');
    }
    return `SELECT ${qName}(${argExprs.join(', ')}) AS result;`;
  }

  if (dialect === 'mssql') {
    const preStmts: string[] = [];
    const argExprs: string[] = [];
    const outVars: Array<{ varName: string; alias: string }> = [];
    let outIdx = 0;

    for (const p of params) {
      const pName = p.name.startsWith('@') ? p.name : `@${p.name}`;
      if (p.mode === 'OUT' || p.mode === 'INOUT') {
        outIdx++;
        const varName = `@ndb_output_${outIdx}`;
        preStmts.push(`DECLARE ${varName} ${p.dataType || 'NVARCHAR(MAX)'};`);
        if (p.mode === 'INOUT') {
          const val = coerceRoutineValue(values[p.name], p.dataType);
          preStmts.push(`SET ${varName} = ${quoteSqlLiteral(val, 'mssql')};`);
        }
        argExprs.push(`${pName} = ${varName} OUTPUT`);
        outVars.push({ varName, alias: p.name.replace(/^@/, '') });
      } else {
        const val = coerceRoutineValue(values[p.name], p.dataType);
        argExprs.push(kind === 'procedure' ? `${pName} = ${quoteSqlLiteral(val, 'mssql')}` : quoteSqlLiteral(val, 'mssql'));
      }
    }

    if (kind === 'procedure') {
      const lines = [...preStmts, `EXEC ${qName}${argExprs.length ? ' ' + argExprs.join(', ') : ''};`];
      if (outVars.length > 0) {
        const sel = outVars.map((v) => `${v.varName} AS ${quoteIdent(v.alias, 'mssql')}`).join(', ');
        lines.push(`SELECT ${sel};`);
      }
      return lines.join('\n');
    }
    return `SELECT ${qName}(${argExprs.join(', ')}) AS result;`;
  }

  // PostgreSQL & standard SQL
  const argExprs = params
    .filter((p) => p.mode !== 'OUT' || kind === 'procedure')
    .map((p) => {
      if (p.mode === 'OUT') return 'NULL';
      const val = coerceRoutineValue(values[p.name], p.dataType);
      return quoteSqlLiteral(val, dialect);
    });
  if (kind === 'procedure') {
    return `CALL ${qName}(${argExprs.join(', ')});`;
  }
  return `SELECT * FROM ${qName}(${argExprs.join(', ')});`;
}

export function buildSequenceAlterSql(opts: {
  dialect: SqlDialect;
  db: string;
  schema: string;
  name: string;
  restartWith?: string;
  increment?: string;
  minValue?: string;
  maxValue?: string;
  cycle?: boolean;
}): string {
  const qName = qualifiedTableName(opts.db, opts.schema, opts.name, opts.dialect);
  const clauses: string[] = [];
  if (opts.increment && /^-?\d+$/.test(opts.increment.trim())) {
    clauses.push(`INCREMENT BY ${opts.increment.trim()}`);
  }
  if (opts.minValue && /^-?\d+$/.test(opts.minValue.trim())) {
    clauses.push(`MINVALUE ${opts.minValue.trim()}`);
  }
  if (opts.maxValue && /^-?\d+$/.test(opts.maxValue.trim())) {
    clauses.push(`MAXVALUE ${opts.maxValue.trim()}`);
  }
  if (opts.restartWith && /^-?\d+$/.test(opts.restartWith.trim())) {
    clauses.push(`RESTART WITH ${opts.restartWith.trim()}`);
  }
  if (opts.cycle === true) clauses.push('CYCLE');
  else if (opts.cycle === false) clauses.push('NO CYCLE');
  if (clauses.length === 0) clauses.push('RESTART');
  return `ALTER SEQUENCE ${qName} ${clauses.join(' ')};`;
}

export function buildMysqlEventToggleSql(db: string, name: string, enable: boolean): string {
  const qName = qualifiedTableName(db, db, name, 'mysql');
  return `ALTER EVENT ${qName} ${enable ? 'ENABLE' : 'DISABLE'};`;
}

export function buildTriggerToggleSql(opts: {
  dialect: SqlDialect;
  db: string;
  schema: string;
  tableName: string;
  triggerName: string;
  enable: boolean;
}): string {
  const { dialect, db, schema, tableName, triggerName, enable } = opts;
  const qTable = qualifiedTableName(db, schema, tableName, dialect);
  const qTrigger = quoteIdent(triggerName, dialect);
  if (dialect === 'mssql') {
    return `${enable ? 'ENABLE' : 'DISABLE'} TRIGGER ${qTrigger} ON ${qTable};`;
  }
  return `ALTER TABLE ${qTable} ${enable ? 'ENABLE' : 'DISABLE'} TRIGGER ${qTrigger};`;
}

export function buildRefreshMaterializedViewSql(opts: {
  dialect: SqlDialect;
  db: string;
  schema: string;
  name: string;
  concurrently?: boolean;
}): string {
  const qName = qualifiedTableName(opts.db, opts.schema, opts.name, opts.dialect);
  if (opts.dialect === 'postgres') {
    return `REFRESH MATERIALIZED VIEW ${opts.concurrently ? 'CONCURRENTLY ' : ''}${qName};`;
  }
  if (opts.dialect === 'clickhouse') {
    return `SYSTEM REFRESH VIEW ${qName};`;
  }
  return `REFRESH MATERIALIZED VIEW ${qName};`;
}

export function buildCreateDatabaseSql(opts: {
  dialect: SqlDialect;
  name: string;
  charset?: string;
  collation?: string;
  owner?: string;
}): string {
  const qName = quoteIdent(opts.name, opts.dialect);
  if (opts.dialect === 'mysql') {
    const parts = [`CREATE DATABASE ${qName}`];
    if (opts.charset) parts.push(`CHARACTER SET ${opts.charset.replace(/[^a-zA-Z0-9_]/g, '')}`);
    if (opts.collation) parts.push(`COLLATE ${opts.collation.replace(/[^a-zA-Z0-9_]/g, '')}`);
    return `${parts.join(' ')};`;
  }
  if (opts.dialect === 'postgres') {
    const parts = [`CREATE DATABASE ${qName}`];
    if (opts.owner) parts.push(`OWNER ${quoteIdent(opts.owner, 'postgres')}`);
    if (opts.charset) parts.push(`ENCODING '${opts.charset.replaceAll("'", "''")}'`);
    return `${parts.join(' ')};`;
  }
  return `CREATE DATABASE ${qName};`;
}

export function buildCreateSchemaSql(opts: {
  dialect: SqlDialect;
  name: string;
  owner?: string;
}): string {
  const qName = quoteIdent(opts.name, opts.dialect);
  if (opts.dialect === 'postgres' && opts.owner) {
    return `CREATE SCHEMA ${qName} AUTHORIZATION ${quoteIdent(opts.owner, 'postgres')};`;
  }
  return `CREATE SCHEMA ${qName};`;
}

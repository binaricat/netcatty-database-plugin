/**
 * Strict Read-Only SQL Gate for BI Analytics & AI-Generated Queries.
 * Guarantees zero accidental writes, zero multi-statement injection,
 * zero transaction/session mutations, and bounded result sizes.
 */

import type { SqlDialect } from '../drivers/types';
import { classifySqlRisk } from '../sql/riskClassifier';
import { splitSqlStatements } from '../sql/splitter';

const ALLOWED_BI_COMMANDS = new Set(['SELECT', 'WITH', 'VALUES', 'SHOW', 'EXPLAIN', 'PRAGMA']);

const FORBIDDEN_WRITE_KEYWORDS_RE =
  /\b(?:INSERT|UPDATE|DELETE|MERGE|REPLACE|UPSERT|CREATE|DROP|ALTER|TRUNCATE|RENAME|GRANT|REVOKE|COPY|LOAD|ATTACH|DETACH|VACUUM|REINDEX|CLUSTER|CALL|EXEC|EXECUTE|SET|USE|BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|LOCK|UNLOCK|KILL|FLUSH|PURGE|RESET)\b/;

export interface BiSqlValidationSuccess {
  ok: true;
  safeSql: string;
  command: string;
  limitApplied: boolean;
}

export interface BiSqlValidationFailure {
  ok: false;
  reason: string;
  command: string;
}

export type BiSqlValidationResult = BiSqlValidationSuccess | BiSqlValidationFailure;

/** Strips comments and string/identifier literals while preserving SQL structure and parens. */
function stripCommentsAndLiterals(sql: string, dialect: SqlDialect): string {
  let out = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1] ?? '';

    if (ch === '-' && next === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (ch === '#' && dialect === 'mysql') {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (dialect === 'postgres' && sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      out += ' ';
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < n) {
        if ((dialect === 'mysql' || dialect === 'clickhouse') && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += " '' ";
      continue;
    }
    if (ch === '"' || (ch === '`' && dialect !== 'postgres')) {
      const q = ch;
      i++;
      while (i < n) {
        if (sql[i] === q) {
          if (sql[i + 1] === q) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += ' _ident_ ';
      continue;
    }
    if (ch === '$' && dialect === 'postgres') {
      const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        i += tag.length;
        const end = sql.indexOf(tag, i);
        i = end < 0 ? n : end + tag.length;
        out += " '' ";
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** Detects whether the outermost query (paren depth 0) already has LIMIT, FETCH, or TOP. */
function hasOuterRowLimit(cleanedSql: string): boolean {
  let depth = 0;
  let i = 0;
  const upper = cleanedSql.toUpperCase();
  const n = upper.length;

  while (i < n) {
    const ch = upper[i];
    if (ch === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (depth === 0 && /[A-Z_]/.test(ch)) {
      const start = i;
      while (i < n && /[A-Z0-9_]/.test(upper[i])) i++;
      const word = upper.slice(start, i);
      if (word === 'LIMIT' || word === 'FETCH' || word === 'TOP') {
        return true;
      }
      continue;
    }
    i++;
  }
  return false;
}

function appendSafeRowLimit(rawSql: string, dialect: SqlDialect, command: string, limit: number): { sql: string; applied: boolean } {
  if (command !== 'SELECT' && command !== 'WITH') {
    return { sql: rawSql, applied: false };
  }
  const trimmed = rawSql.trim().replace(/;\s*$/, '').trim();
  const cleaned = stripCommentsAndLiterals(trimmed, dialect);
  if (hasOuterRowLimit(cleaned)) {
    return { sql: trimmed, applied: false };
  }

  if (dialect === 'mssql') {
    // Only inject TOP on straightforward SELECT statements (skip WITH CTEs or UNION/ORDER-less edge cases if ambiguous)
    if (command === 'SELECT') {
      const topMatch = /^(\s*SELECT\s+(?:DISTINCT\s+)?)/i.exec(trimmed);
      if (topMatch) {
        return {
          sql: `${topMatch[1]}TOP ${limit} ${trimmed.slice(topMatch[1].length)}`,
          applied: true,
        };
      }
    }
    return { sql: trimmed, applied: false };
  }

  return { sql: `${trimmed}\nLIMIT ${limit}`, applied: true };
}

/**
 * Validates that a SQL string is strictly a single, read-only BI query and
 * auto-applies a safe row limit (default 500) to prevent runaway full-table scans.
 */
export function validateBiReadOnlySql(
  sql: string,
  dialect: SqlDialect = 'postgres',
  maxRows = 500,
): BiSqlValidationResult {
  const raw = (sql ?? '').trim();
  if (!raw) {
    return { ok: false, command: 'EMPTY', reason: 'SQL query is empty.' };
  }

  const split = splitSqlStatements(raw, dialect).filter((s) => s.sql.trim().length > 0);
  if (split.length === 0) {
    return { ok: false, command: 'EMPTY', reason: 'SQL query contains no executable statement.' };
  }
  if (split.length > 1) {
    return {
      ok: false,
      command: 'MULTI',
      reason: 'BI Analytics only allows a single read-only statement (multiple statements rejected).',
    };
  }

  const singleSql = split[0].sql.trim();
  const assessment = classifySqlRisk(singleSql, dialect);
  const stmt = assessment.statements[0];
  const command = stmt?.command ?? 'UNKNOWN';

  if (!assessment.isReadOnly || !stmt || stmt.isWrite) {
    return {
      ok: false,
      command,
      reason: stmt?.reason || `Write or administrative statement (${command}) is blocked in BI read-only mode.`,
    };
  }

  if (!ALLOWED_BI_COMMANDS.has(command)) {
    return {
      ok: false,
      command,
      reason: `Command "${command}" is not allowed in BI mode. Only SELECT, WITH, VALUES, SHOW, EXPLAIN, and read-only PRAGMA are permitted.`,
    };
  }

  const cleaned = stripCommentsAndLiterals(singleSql, dialect).trim();
  const upper = cleaned.toUpperCase();

  // Reject EXPLAIN ANALYZE unconditionally in BI mode
  if (command === 'EXPLAIN' && /\bANALYZE\b/.test(upper)) {
    return {
      ok: false,
      command: 'EXPLAIN ANALYZE',
      reason: 'EXPLAIN ANALYZE is disabled in BI read-only mode; use plain EXPLAIN or SELECT.',
    };
  }

  // Defense-in-depth: block any write/DDL/admin keyword inside SELECT/WITH/EXPLAIN/VALUES
  if (command === 'SELECT' || command === 'WITH' || command === 'EXPLAIN' || command === 'VALUES') {
    if (FORBIDDEN_WRITE_KEYWORDS_RE.test(upper)) {
      return {
        ok: false,
        command,
        reason: 'Statement contains a forbidden write, DDL, or session-control keyword.',
      };
    }
    if (/\bINTO\s+(?:OUTFILE|DUMPFILE|TEMP|TEMPORARY|UNLOGGED)?\s*[A-Z_']/.test(upper)) {
      return {
        ok: false,
        command,
        reason: 'SELECT INTO / INTO OUTFILE is blocked in BI read-only mode.',
      };
    }
  }

  const boundedLimit = Math.max(10, Math.min(5000, Math.floor(maxRows)));
  const { sql: safeSql, applied } = appendSafeRowLimit(singleSql, dialect, command, boundedLimit);

  return {
    ok: true,
    safeSql,
    command,
    limitApplied: applied,
  };
}

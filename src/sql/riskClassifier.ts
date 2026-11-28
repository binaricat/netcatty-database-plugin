/**
 * Dialect-aware SQL Risk Classifier (P0-2: Read-Only Mode & Destructive SQL Guardrail).
 * Detects write statements vs read-only queries AND destructive DDL/DML operations
 * (DROP, TRUNCATE, ALTER, DELETE/UPDATE without WHERE, FLUSHDB/FLUSHALL).
 */

import type { SqlDialect } from '../drivers/types';
import { splitSqlStatements } from './splitter';

export type SqlRiskLevel = 'safe' | 'write' | 'destructive';

export interface StatementRiskInfo {
  sql: string;
  command: string;
  isWrite: boolean;
  level: SqlRiskLevel;
  reason?: string;
}

export interface SqlRiskAssessment {
  isReadOnly: boolean;
  isWrite: boolean;
  level: SqlRiskLevel;
  destructiveReasons: string[];
  statements: StatementRiskInfo[];
}

/**
 * Strips comments and replaces string/dollar-quoted literals with spaces so keyword
 * inspection never matches text inside comments or quoted strings.
 */
function stripLiteralsAndComments(sql: string, dialect: SqlDialect): string {
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

/**
 * Checks whether a top-level WHERE keyword exists outside parentheses.
 */
function hasTopLevelWhere(cleanedSql: string): boolean {
  let depth = 0;
  let i = 0;
  const upper = cleanedSql.toUpperCase();
  while (i < upper.length) {
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
      while (i < upper.length && /[A-Z0-9_]/.test(upper[i])) i++;
      if (upper.slice(start, i) === 'WHERE') return true;
      continue;
    }
    i++;
  }
  return false;
}

function classifySingleStatement(rawSql: string, dialect: SqlDialect): StatementRiskInfo {
  const cleaned = stripLiteralsAndComments(rawSql, dialect).trim();
  const upper = cleaned.toUpperCase();
  const firstWord = /^([A-Z]+)/.exec(upper)?.[1] ?? '';

  if (!firstWord) {
    return { sql: rawSql, command: 'EMPTY', isWrite: false, level: 'safe' };
  }

  // Pure read commands
  if (['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'VALUES', 'TABLE'].includes(firstWord)) {
    // Check SELECT ... INTO (creates table in PG)
    if (firstWord === 'SELECT' && /\bINTO\s+(?:TEMP|TEMPORARY|UNLOGGED)?\s*[A-Z_]/.test(upper)) {
      return { sql: rawSql, command: 'SELECT INTO', isWrite: true, level: 'write', reason: 'Creates table via SELECT INTO' };
    }
    return { sql: rawSql, command: firstWord, isWrite: false, level: 'safe' };
  }

  // PRAGMA: read unless assigning with '='
  if (firstWord === 'PRAGMA') {
    if (upper.includes('=')) {
      return { sql: rawSql, command: 'PRAGMA', isWrite: true, level: 'write', reason: 'Modifies PRAGMA setting' };
    }
    return { sql: rawSql, command: 'PRAGMA', isWrite: false, level: 'safe' };
  }

  // EXPLAIN: safe unless EXPLAIN ANALYZE wraps a write statement
  if (firstWord === 'EXPLAIN') {
    const isAnalyze = /\bANALYZE\b/.test(upper);
    const hasDml = /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b/.test(upper);
    if (isAnalyze && hasDml) {
      return {
        sql: rawSql,
        command: 'EXPLAIN ANALYZE',
        isWrite: true,
        level: 'destructive',
        reason: 'EXPLAIN ANALYZE executes the underlying write statement',
      };
    }
    return { sql: rawSql, command: 'EXPLAIN', isWrite: false, level: 'safe' };
  }

  // WITH CTE: check main statement after CTEs
  if (firstWord === 'WITH') {
    if (/\b(?:DELETE)\b/.test(upper)) {
      const noWhere = !hasTopLevelWhere(cleaned);
      return {
        sql: rawSql,
        command: 'WITH DELETE',
        isWrite: true,
        level: noWhere ? 'destructive' : 'write',
        reason: noWhere ? 'DELETE statement without WHERE clause' : undefined,
      };
    }
    if (/\b(?:UPDATE)\b/.test(upper)) {
      const noWhere = !hasTopLevelWhere(cleaned);
      return {
        sql: rawSql,
        command: 'WITH UPDATE',
        isWrite: true,
        level: noWhere ? 'destructive' : 'write',
        reason: noWhere ? 'UPDATE statement without WHERE clause' : undefined,
      };
    }
    if (/\b(?:INSERT|MERGE)\b/.test(upper)) {
      return { sql: rawSql, command: 'WITH INSERT', isWrite: true, level: 'write' };
    }
    return { sql: rawSql, command: 'WITH', isWrite: false, level: 'safe' };
  }

  // Destructive DDL
  if (firstWord === 'DROP') {
    return {
      sql: rawSql,
      command: 'DROP',
      isWrite: true,
      level: 'destructive',
      reason: 'DROP permanently removes database objects and data',
    };
  }
  if (firstWord === 'TRUNCATE') {
    return {
      sql: rawSql,
      command: 'TRUNCATE',
      isWrite: true,
      level: 'destructive',
      reason: 'TRUNCATE removes all rows from the table',
    };
  }
  if (firstWord === 'ALTER') {
    return {
      sql: rawSql,
      command: 'ALTER',
      isWrite: true,
      level: 'destructive',
      reason: 'ALTER modifies database schema structure',
    };
  }

  // DELETE / UPDATE with or without WHERE
  if (firstWord === 'DELETE') {
    if (!hasTopLevelWhere(cleaned)) {
      return {
        sql: rawSql,
        command: 'DELETE',
        isWrite: true,
        level: 'destructive',
        reason: 'DELETE without WHERE clause will delete every row in the table',
      };
    }
    return { sql: rawSql, command: 'DELETE', isWrite: true, level: 'write' };
  }

  if (firstWord === 'UPDATE') {
    if (!hasTopLevelWhere(cleaned)) {
      return {
        sql: rawSql,
        command: 'UPDATE',
        isWrite: true,
        level: 'destructive',
        reason: 'UPDATE without WHERE clause will modify every row in the table',
      };
    }
    return { sql: rawSql, command: 'UPDATE', isWrite: true, level: 'write' };
  }

  // Transaction control & read-ish session commands
  if (['BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'USE'].includes(firstWord)) {
    return { sql: rawSql, command: firstWord, isWrite: false, level: 'safe' };
  }

  // Any other DDL / DML (INSERT, REPLACE, CREATE, RENAME, GRANT, REVOKE, MERGE, CALL, EXEC, VACUUM, etc.)
  if (['REVOKE', 'PURGE', 'RESET'].includes(firstWord)) {
    return {
      sql: rawSql,
      command: firstWord,
      isWrite: true,
      level: 'destructive',
      reason: `${firstWord} is a high-impact administrative operation`,
    };
  }

  return { sql: rawSql, command: firstWord, isWrite: true, level: 'write' };
}

export function classifySqlRisk(
  sql: string,
  dialect: SqlDialect = 'postgres',
): SqlRiskAssessment {
  const split = splitSqlStatements(sql, dialect);
  const rawList = split.length > 0 ? split.map((s) => s.sql) : [sql];
  const statements = rawList.map((s) => classifySingleStatement(s, dialect));

  const destructiveReasons: string[] = [];
  let isWrite = false;
  let level: SqlRiskLevel = 'safe';

  for (const st of statements) {
    if (st.isWrite) isWrite = true;
    if (st.level === 'destructive') {
      level = 'destructive';
      if (st.reason) destructiveReasons.push(st.reason);
    } else if (st.level === 'write' && level === 'safe') {
      level = 'write';
    }
  }

  return {
    isReadOnly: !isWrite,
    isWrite,
    level,
    destructiveReasons,
    statements,
  };
}

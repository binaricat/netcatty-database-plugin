/**
 * Dialect-aware SQL statement splitter.
 * Handles single-quoted strings, double-quoted / backtick / bracket identifiers,
 * PostgreSQL dollar-quoted strings ($tag$...$tag$), MySQL backslash escapes & # comments,
 * -- line comments, and /* ... *\/ block comments (including nested block comments in PG).
 */

import type { SqlDialect } from '../drivers/types';

export interface SplitSqlStatement {
  sql: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}

function matchDollarTag(sql: string, index: number): string | null {
  if (sql[index] !== '$') return null;
  let i = index + 1;
  if (i < sql.length && sql[i] === '$') return '$$';
  if (i >= sql.length || !/[A-Za-z_\x80-\xff]/.test(sql[i])) return null;
  i++;
  while (i < sql.length && /[A-Za-z0-9_\x80-\xff]/.test(sql[i])) i++;
  if (i < sql.length && sql[i] === '$') {
    return sql.slice(index, i + 1);
  }
  return null;
}

function lineNumberAt(sql: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < sql.length; i++) {
    if (sql.charCodeAt(i) === 10) line++;
  }
  return line;
}

export function splitSqlStatements(
  sql: string,
  dialect: SqlDialect = 'postgres',
): SplitSqlStatement[] {
  const results: SplitSqlStatement[] = [];
  const len = sql.length;
  let stmtStart = 0;
  let hasCodeToken = false;
  let i = 0;

  const pushSegment = (endIdx: number) => {
    const raw = sql.slice(stmtStart, endIdx);
    const trimmed = raw.trim();
    if (trimmed.length > 0 && hasCodeToken) {
      const leadTrim = raw.length - raw.trimStart().length;
      const trailTrim = raw.length - raw.trimEnd().length;
      const startOffset = stmtStart + leadTrim;
      const endOffset = endIdx - trailTrim;
      results.push({
        sql: trimmed,
        startOffset,
        endOffset,
        startLine: lineNumberAt(sql, startOffset),
        endLine: lineNumberAt(sql, Math.max(startOffset, endOffset - 1)),
      });
    }
    stmtStart = endIdx + 1;
    hasCodeToken = false;
  };

  while (i < len) {
    const ch = sql[i];
    const next = i + 1 < len ? sql[i + 1] : '';

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }

    // Line comment: --
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < len && sql[i] !== '\n') i++;
      continue;
    }

    // MySQL # line comment
    if (ch === '#' && dialect === 'mysql') {
      i++;
      while (i < len && sql[i] !== '\n') i++;
      continue;
    }

    // Block comment: /* ... */ (supports nesting in PostgreSQL)
    if (ch === '/' && next === '*') {
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
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
      continue;
    }

    // Single-quoted string literal
    if (ch === "'") {
      hasCodeToken = true;
      i++;
      while (i < len) {
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
      continue;
    }

    // Double-quoted identifier / string
    if (ch === '"') {
      hasCodeToken = true;
      i++;
      while (i < len) {
        if (dialect === 'mysql' && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Backtick-quoted identifier (MySQL / ClickHouse / SQLite)
    if (ch === '`' && dialect !== 'postgres') {
      hasCodeToken = true;
      i++;
      while (i < len) {
        if (sql[i] === '`') {
          if (sql[i + 1] === '`') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Bracket-quoted identifier (SQLite)
    if (ch === '[' && dialect === 'sqlite') {
      hasCodeToken = true;
      i++;
      while (i < len && sql[i] !== ']') i++;
      if (i < len) i++;
      continue;
    }

    // PostgreSQL dollar-quoted string ($tag$...$tag$)
    if (ch === '$' && dialect === 'postgres') {
      const tag = matchDollarTag(sql, i);
      if (tag) {
        hasCodeToken = true;
        i += tag.length;
        const closeIdx = sql.indexOf(tag, i);
        if (closeIdx < 0) {
          i = len;
        } else {
          i = closeIdx + tag.length;
        }
        continue;
      }
    }

    // Statement terminator
    if (ch === ';') {
      pushSegment(i);
      i++;
      continue;
    }

    hasCodeToken = true;
    i++;
  }

  if (stmtStart < len) {
    pushSegment(len);
  }

  return results;
}

export function statementAtOffset(
  sql: string,
  offset: number,
  dialect: SqlDialect = 'postgres',
): SplitSqlStatement | null {
  const stmts = splitSqlStatements(sql, dialect);
  if (stmts.length === 0) return null;
  for (const s of stmts) {
    if (offset >= s.startOffset && offset <= s.endOffset + 1) {
      return s;
    }
  }
  // If cursor is after the last statement or between statements, pick closest preceding
  let best = stmts[0];
  for (const s of stmts) {
    if (s.startOffset <= offset) best = s;
  }
  return best;
}

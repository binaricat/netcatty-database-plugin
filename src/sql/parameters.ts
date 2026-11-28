/**
 * SQL Parameter Extraction, Safe Binding, and Live Syntax Diagnostics (P0-6).
 * Supports :name, $1, ?, {{var}} outside strings/comments/dollar-quotes,
 * skips PostgreSQL ::type casts, and computes exact 1-based line/column positions.
 */

import { quoteSqlLiteral } from '../drivers/sqlDialect';
import type { CellValue, SqlDialect } from '../drivers/types';

export type SqlParameterKind = 'named' | 'positional' | 'question' | 'template';

export interface SqlParameterInfo {
  name: string;
  raw: string;
  kind: SqlParameterKind;
  index: number;
  occurrences: number;
}

export interface SqlSyntaxDiagnostic {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  message: string;
  severity: 'error' | 'warning';
}

export function offsetToLineColumn(sql: string, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, sql.length));
  let line = 1;
  let col = 1;
  for (let i = 0; i < clamped; i++) {
    if (sql.charCodeAt(i) === 10) {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, column: col };
}

interface ParamMatch {
  start: number;
  end: number;
  name: string;
  raw: string;
  kind: SqlParameterKind;
}

function scanSqlParameters(sql: string, dialect: SqlDialect): ParamMatch[] {
  const matches: ParamMatch[] = [];
  let i = 0;
  const n = sql.length;
  let qIndex = 0;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1] ?? '';

    // -- line comment
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    // MySQL # line comment
    if (ch === '#' && dialect === 'mysql') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    // /* block comment */
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
      continue;
    }
    // Single-quoted string
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
      continue;
    }
    // Double-quoted or backtick identifier
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
      continue;
    }
    // PG dollar-quoted string ($tag$...$tag$)
    if (ch === '$' && dialect === 'postgres') {
      const tagMatch = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        i += tag.length;
        const close = sql.indexOf(tag, i);
        i = close < 0 ? n : close + tag.length;
        continue;
      }
    }

    // {{var}} template parameter
    if (ch === '{' && next === '{') {
      const m = /^\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/.exec(sql.slice(i));
      if (m) {
        matches.push({
          start: i,
          end: i + m[0].length,
          name: m[1],
          raw: m[0],
          kind: 'template',
        });
        i += m[0].length;
        continue;
      }
    }

    // :name named parameter (skip ::type PostgreSQL cast and := assignment)
    if (ch === ':') {
      const prev = i > 0 ? sql[i - 1] : '';
      if (prev === ':' || next === ':' || next === '=') {
        i += next === ':' || next === '=' ? 2 : 1;
        continue;
      }
      const m = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
      if (m) {
        matches.push({
          start: i,
          end: i + m[0].length,
          name: m[1],
          raw: m[0],
          kind: 'named',
        });
        i += m[0].length;
        continue;
      }
    }

    // $1, $2 positional parameter
    if (ch === '$') {
      const m = /^\$([1-9][0-9]*)\b/.exec(sql.slice(i));
      if (m) {
        matches.push({
          start: i,
          end: i + m[0].length,
          name: m[0],
          raw: m[0],
          kind: 'positional',
        });
        i += m[0].length;
        continue;
      }
    }

    // ? anonymous placeholder (skip PG jsonb ?| / ?& operators)
    if (ch === '?') {
      if (dialect === 'postgres' && (next === '|' || next === '&')) {
        i += 2;
        continue;
      }
      qIndex++;
      matches.push({
        start: i,
        end: i + 1,
        name: `?${qIndex}`,
        raw: '?',
        kind: 'question',
      });
      i++;
      continue;
    }

    i++;
  }

  return matches;
}

export function extractSqlParameters(
  sql: string,
  dialect: SqlDialect = 'postgres',
): SqlParameterInfo[] {
  const raw = scanSqlParameters(sql, dialect);
  const byName = new Map<string, SqlParameterInfo>();
  let idx = 0;

  for (const m of raw) {
    const existing = byName.get(m.name);
    if (existing) {
      existing.occurrences++;
    } else {
      byName.set(m.name, {
        name: m.name,
        raw: m.raw,
        kind: m.kind,
        index: ++idx,
        occurrences: 1,
      });
    }
  }

  return Array.from(byName.values());
}

export function bindSqlParameters(
  sql: string,
  values: Record<string, CellValue>,
  dialect: SqlDialect = 'postgres',
): string {
  const matches = scanSqlParameters(sql, dialect);
  if (matches.length === 0) return sql;

  let out = '';
  let cursor = 0;
  for (const m of matches) {
    out += sql.slice(cursor, m.start);
    const lookupKey =
      Object.prototype.hasOwnProperty.call(values, m.name)
        ? m.name
        : m.kind === 'positional' && Object.prototype.hasOwnProperty.call(values, m.name.slice(1))
          ? m.name.slice(1)
          : m.kind === 'question' && Object.prototype.hasOwnProperty.call(values, m.name.slice(1))
            ? m.name.slice(1)
            : null;
    if (lookupKey !== null) {
      out += quoteSqlLiteral(values[lookupKey], dialect);
    } else {
      out += m.raw;
    }
    cursor = m.end;
  }
  out += sql.slice(cursor);
  return out;
}

/**
 * Lightweight browser-safe live SQL syntax checker (unclosed strings, quotes,
 * dollar-quoted blocks, block comments, and mismatched parentheses).
 */
export function checkSqlSyntaxDiagnostics(
  sql: string,
  dialect: SqlDialect = 'postgres',
): SqlSyntaxDiagnostic[] {
  const diagnostics: SqlSyntaxDiagnostic[] = [];
  const parenStack: number[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1] ?? '';

    if (ch === '-' && next === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '#' && dialect === 'mysql') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
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
      if (depth > 0) {
        const pos = offsetToLineColumn(sql, start);
        diagnostics.push({
          line: pos.line,
          column: pos.column,
          endLine: pos.line,
          endColumn: pos.column + 2,
          message: 'Unclosed block comment (/* ... */)',
          severity: 'error',
        });
      }
      continue;
    }
    if (ch === "'") {
      const start = i++;
      let closed = false;
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
          closed = true;
          i++;
          break;
        }
        i++;
      }
      if (!closed) {
        const pos = offsetToLineColumn(sql, start);
        diagnostics.push({
          line: pos.line,
          column: pos.column,
          endLine: pos.line,
          endColumn: pos.column + 1,
          message: "Unclosed single-quoted string literal (')",
          severity: 'error',
        });
      }
      continue;
    }
    if (ch === '"' || (ch === '`' && dialect !== 'postgres')) {
      const q = ch;
      const start = i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === q) {
          if (sql[i + 1] === q) {
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        i++;
      }
      if (!closed) {
        const pos = offsetToLineColumn(sql, start);
        diagnostics.push({
          line: pos.line,
          column: pos.column,
          endLine: pos.line,
          endColumn: pos.column + 1,
          message: `Unclosed quoted identifier (${q})`,
          severity: 'error',
        });
      }
      continue;
    }
    if (ch === '$' && dialect === 'postgres') {
      const tagMatch = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const start = i;
        i += tag.length;
        const close = sql.indexOf(tag, i);
        if (close < 0) {
          const pos = offsetToLineColumn(sql, start);
          diagnostics.push({
            line: pos.line,
            column: pos.column,
            endLine: pos.line,
            endColumn: pos.column + tag.length,
            message: `Unclosed PostgreSQL dollar-quoted string (${tag})`,
            severity: 'error',
          });
          i = n;
        } else {
          i = close + tag.length;
        }
        continue;
      }
    }
    if (ch === '(') {
      parenStack.push(i);
      i++;
      continue;
    }
    if (ch === ')') {
      if (parenStack.length === 0) {
        const pos = offsetToLineColumn(sql, i);
        diagnostics.push({
          line: pos.line,
          column: pos.column,
          endLine: pos.line,
          endColumn: pos.column + 1,
          message: 'Unexpected closing parenthesis )',
          severity: 'error',
        });
      } else {
        parenStack.pop();
      }
      i++;
      continue;
    }
    i++;
  }

  for (const openIdx of parenStack) {
    const pos = offsetToLineColumn(sql, openIdx);
    diagnostics.push({
      line: pos.line,
      column: pos.column,
      endLine: pos.line,
      endColumn: pos.column + 1,
      message: 'Unclosed opening parenthesis (',
      severity: 'error',
    });
  }

  return diagnostics;
}

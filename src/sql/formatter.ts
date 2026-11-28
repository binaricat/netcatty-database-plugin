/**
 * Dialect-aware SQL formatter.
 * Uppercases SQL keywords, formats clauses with clean indentation, and preserves
 * string literals, quoted identifiers, dollar-quoted strings, and comments.
 */

import type { SqlDialect } from '../drivers/types';
import { splitSqlStatements } from './splitter';

interface Token {
  type: 'word' | 'string' | 'ident' | 'comment' | 'operator' | 'paren' | 'comma' | 'semicolon';
  value: string;
}

const KEYWORDS = new Set([
  'SELECT', 'DISTINCT', 'ALL', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL',
  'TRUE', 'FALSE', 'AS', 'ON', 'USING', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER',
  'CROSS', 'NATURAL', 'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST',
  'LIMIT', 'OFFSET', 'FETCH', 'NEXT', 'ROWS', 'ONLY', 'UNION', 'INTERSECT', 'EXCEPT',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'RETURNING', 'ON', 'CONFLICT', 'DO',
  'NOTHING', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'TABLE', 'VIEW', 'MATERIALIZED', 'INDEX',
  'UNIQUE', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'CONSTRAINT', 'CHECK', 'DEFAULT',
  'IF', 'EXISTS', 'CASCADE', 'RESTRICT', 'WITH', 'RECURSIVE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'BETWEEN', 'LIKE', 'ILIKE', 'SIMILAR', 'TO', 'CAST', 'EXPLAIN', 'ANALYZE', 'BEGIN', 'COMMIT',
  'ROLLBACK', 'SAVEPOINT', 'TRANSACTION', 'OVER', 'PARTITION', 'WINDOW', 'RANGE', 'PRECEDING',
  'FOLLOWING', 'UNBOUNDED', 'CURRENT', 'ROW', 'ADD', 'COLUMN', 'RENAME', 'MODIFY', 'ENGINE',
]);

const MAJOR_CLAUSES = new Set([
  'SELECT', 'FROM', 'WHERE', 'HAVING', 'LIMIT', 'OFFSET', 'VALUES', 'SET', 'RETURNING', 'WITH',
]);

const MULTI_WORD_CLAUSES = [
  ['GROUP', 'BY'],
  ['ORDER', 'BY'],
  ['LEFT', 'OUTER', 'JOIN'],
  ['RIGHT', 'OUTER', 'JOIN'],
  ['FULL', 'OUTER', 'JOIN'],
  ['INNER', 'JOIN'],
  ['LEFT', 'JOIN'],
  ['RIGHT', 'JOIN'],
  ['FULL', 'JOIN'],
  ['CROSS', 'JOIN'],
  ['UNION', 'ALL'],
  ['INSERT', 'INTO'],
  ['DELETE', 'FROM'],
  ['ON', 'CONFLICT'],
];

function tokenizeSql(sql: string, dialect: SqlDialect): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const start = i;
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      tokens.push({ type: 'comment', value: sql.slice(start, i) });
      continue;
    }
    if (ch === '#' && dialect === 'mysql') {
      const start = i;
      while (i < n && sql[i] !== '\n') i++;
      tokens.push({ type: 'comment', value: sql.slice(start, i) });
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      if (i < n) i += 2;
      tokens.push({ type: 'comment', value: sql.slice(start, i) });
      continue;
    }
    if (ch === "'") {
      const start = i++;
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
      tokens.push({ type: 'string', value: sql.slice(start, i) });
      continue;
    }
    if (ch === '"' || (ch === '`' && dialect !== 'postgres')) {
      const quote = ch;
      const start = i++;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      tokens.push({ type: 'ident', value: sql.slice(start, i) });
      continue;
    }
    if (ch === '$' && dialect === 'postgres') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const start = i;
        i += tag.length;
        const close = sql.indexOf(tag, i);
        i = close < 0 ? n : close + tag.length;
        tokens.push({ type: 'string', value: sql.slice(start, i) });
        continue;
      }
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma', value: ',' });
      i++;
      continue;
    }
    if (ch === ';') {
      tokens.push({ type: 'semicolon', value: ';' });
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i++;
      while (i < n && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      tokens.push({ type: 'word', value: sql.slice(start, i) });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = i++;
      while (i < n && /[0-9.eE+-]/.test(sql[i])) {
        if ((sql[i] === '+' || sql[i] === '-') && sql[i - 1] !== 'e' && sql[i - 1] !== 'E') break;
        i++;
      }
      tokens.push({ type: 'word', value: sql.slice(start, i) });
      continue;
    }
    // Multi-char operators
    const two = sql.slice(i, i + 2);
    if (['<>', '!=', '<=', '>=', '::', '||', '->', '->>', '#>', '#>>', '@>', '<@'].includes(two)) {
      const three = sql.slice(i, i + 3);
      if (three === '->>' || three === '#>>') {
        tokens.push({ type: 'operator', value: three });
        i += 3;
      } else {
        tokens.push({ type: 'operator', value: two });
        i += 2;
      }
      continue;
    }
    tokens.push({ type: 'operator', value: ch });
    i++;
  }
  return tokens;
}

function matchMultiWordClause(tokens: Token[], index: number): string[] | null {
  for (const seq of MULTI_WORD_CLAUSES) {
    if (index + seq.length > tokens.length) continue;
    let ok = true;
    for (let j = 0; j < seq.length; j++) {
      const tok = tokens[index + j];
      if (tok.type !== 'word' || tok.value.toUpperCase() !== seq[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return seq;
  }
  return null;
}

export interface FormatSqlOptions {
  dialect?: SqlDialect;
  indent?: string;
  uppercaseKeywords?: boolean;
}

function formatSingleStatement(sql: string, opts: Required<FormatSqlOptions>): string {
  const tokens = tokenizeSql(sql, opts.dialect);
  if (tokens.length === 0) return '';

  const lines: string[] = [];
  let current = '';
  let depth = 0;
  let inSelectList = false;
  let prevToken: Token | null = null;

  const pad = (extra = 0) => opts.indent.repeat(Math.max(0, depth + extra));
  const flush = () => {
    const trimmed = current.trimEnd();
    if (trimmed.length > 0) lines.push(trimmed);
    current = '';
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const upper = tok.type === 'word' ? tok.value.toUpperCase() : '';

    if (tok.type === 'comment') {
      if (current.trim().length > 0) current += ' ' + tok.value;
      else current = pad() + tok.value;
      if (tok.value.startsWith('--') || tok.value.startsWith('#')) {
        flush();
      }
      prevToken = tok;
      continue;
    }

    if (tok.type === 'paren') {
      if (tok.value === '(') {
        const noSpaceBefore =
          prevToken?.type === 'word' && !KEYWORDS.has(prevToken.value.toUpperCase());
        if (current.length > 0 && !current.endsWith(' ') && !current.endsWith('(') && !noSpaceBefore) {
          current += ' ';
        }
        current += '(';
        depth++;
      } else {
        depth = Math.max(0, depth - 1);
        current = current.trimEnd() + ')';
      }
      prevToken = tok;
      continue;
    }

    if (tok.type === 'comma') {
      current = current.trimEnd() + ',';
      if (inSelectList && depth === 0) {
        flush();
        current = pad(1);
      } else {
        current += ' ';
      }
      prevToken = tok;
      continue;
    }

    if (tok.type === 'semicolon') {
      current = current.trimEnd() + ';';
      flush();
      prevToken = tok;
      continue;
    }

    if (depth === 0 && tok.type === 'word') {
      const multi = matchMultiWordClause(tokens, i);
      if (multi) {
        inSelectList = false;
        if (current.trim().length > 0) flush();
        const text = opts.uppercaseKeywords ? multi.join(' ') : multi.join(' ').toLowerCase();
        current = pad() + text;
        i += multi.length - 1;
        prevToken = tokens[i];
        continue;
      }

      if (MAJOR_CLAUSES.has(upper) || upper === 'JOIN' || upper === 'UNION') {
        if (current.trim().length > 0) flush();
        const kw = opts.uppercaseKeywords ? upper : upper.toLowerCase();
        if (upper === 'SELECT') {
          current = pad() + kw;
          inSelectList = true;
        } else {
          inSelectList = false;
          current = pad() + kw;
        }
        prevToken = tok;
        continue;
      }

      if (upper === 'AND' || upper === 'OR') {
        if (current.trim().length > 0) flush();
        const kw = opts.uppercaseKeywords ? upper : upper.toLowerCase();
        current = pad(1) + kw;
        prevToken = tok;
        continue;
      }
    }

    const rendered =
      tok.type === 'word' && opts.uppercaseKeywords && KEYWORDS.has(upper)
        ? upper
        : tok.value;

    const noSpaceAroundDot =
      rendered === '.' ||
      rendered === '::' ||
      prevToken?.value === '.' ||
      prevToken?.value === '::' ||
      prevToken?.value === '(';

    if (current.length === 0) {
      current = pad() + rendered;
    } else if (noSpaceAroundDot || current.endsWith(' ') || current.endsWith('(')) {
      current += rendered;
    } else {
      current += ' ' + rendered;
    }
    prevToken = tok;
  }

  flush();
  return lines.join('\n');
}

export function formatSql(sql: string, options?: FormatSqlOptions): string {
  const opts: Required<FormatSqlOptions> = {
    dialect: options?.dialect ?? 'postgres',
    indent: options?.indent ?? '  ',
    uppercaseKeywords: options?.uppercaseKeywords ?? true,
  };
  const statements = splitSqlStatements(sql, opts.dialect);
  if (statements.length === 0) return sql.trim();
  const formatted = statements.map((s) => {
    const out = formatSingleStatement(s.sql, opts);
    return out.endsWith(';') ? out : `${out};`;
  });
  return formatted.join('\n\n');
}

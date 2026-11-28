/**
 * Visual WHERE Filter Builder (P0-5).
 * Compiles structured filter rules into dialect-safe WHERE SQL clauses.
 */

import { quoteIdent, quoteSqlLiteral } from '../drivers/sqlDialect';
import type { CellValue, SqlDialect } from '../drivers/types';

export type FilterOperator =
  | '='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'LIKE'
  | 'NOT LIKE'
  | 'ILIKE'
  | 'IN'
  | 'NOT IN'
  | 'IS NULL'
  | 'IS NOT NULL';

export interface FilterRule {
  id?: string;
  column: string;
  operator: FilterOperator;
  value?: string;
  combinator?: 'AND' | 'OR';
  enabled?: boolean;
}

function parseFilterScalar(raw: string): CellValue {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (/^(?:true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n) && (!Number.isInteger(n) || Number.isSafeInteger(n))) {
      return n;
    }
  }
  // If user wrapped value in single quotes, unwrap them so quoteSqlLiteral escapes cleanly
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return raw;
}

function parseInList(raw: string, dialect: SqlDialect): string {
  const items: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "'") {
      inQuotes = !inQuotes;
      cur += ch;
    } else if (ch === ',' && !inQuotes) {
      if (cur.trim().length > 0) items.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length > 0) items.push(cur.trim());
  if (items.length === 0) return '(NULL)';
  return '(' + items.map((item) => quoteSqlLiteral(parseFilterScalar(item), dialect)).join(', ') + ')';
}

export function buildWhereFromRules(
  rules: readonly FilterRule[],
  dialect: SqlDialect = 'postgres',
): string {
  const active = rules.filter((r) => r.enabled !== false && r.column.trim().length > 0);
  if (active.length === 0) return '';

  const parts: string[] = [];

  for (let i = 0; i < active.length; i++) {
    const rule = active[i];
    const col = quoteIdent(rule.column.trim(), dialect);
    const val = rule.value ?? '';
    let expr = '';

    switch (rule.operator) {
      case 'IS NULL':
        expr = `${col} IS NULL`;
        break;
      case 'IS NOT NULL':
        expr = `${col} IS NOT NULL`;
        break;
      case 'IN':
        expr = `${col} IN ${parseInList(val, dialect)}`;
        break;
      case 'NOT IN':
        expr = `${col} NOT IN ${parseInList(val, dialect)}`;
        break;
      case 'LIKE':
      case 'NOT LIKE':
        expr = `${col} ${rule.operator} ${quoteSqlLiteral(val, dialect)}`;
        break;
      case 'ILIKE':
        if (dialect === 'postgres') {
          expr = `${col} ILIKE ${quoteSqlLiteral(val, dialect)}`;
        } else {
          expr = `LOWER(${col}) LIKE LOWER(${quoteSqlLiteral(val, dialect)})`;
        }
        break;
      case '=':
      case '!=':
      case '>':
      case '>=':
      case '<':
      case '<=': {
        const scalar = parseFilterScalar(val);
        expr = `${col} ${rule.operator} ${quoteSqlLiteral(scalar, dialect)}`;
        break;
      }
      default:
        continue;
    }

    if (parts.length > 0) {
      const comb = rule.combinator === 'OR' ? 'OR' : 'AND';
      parts.push(`${comb} ${expr}`);
    } else {
      parts.push(expr);
    }
  }

  return parts.join(' ');
}

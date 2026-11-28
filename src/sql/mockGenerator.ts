/**
 * Mock / Test Data Generator & Batched Dialect-Aware INSERT SQL Builder.
 * Pure, deterministic (seeded PRNG), browser-sandbox compatible (zero Node imports).
 */

import type { CellValue, ColumnStructure, SqlDialect } from '../drivers/types';

export type MockPresetId =
  | 'skip'
  | 'uuid'
  | 'sequence'
  | 'int'
  | 'float'
  | 'boolean'
  | 'full_name'
  | 'email'
  | 'phone'
  | 'address'
  | 'city'
  | 'company'
  | 'date'
  | 'datetime'
  | 'time'
  | 'enum'
  | 'regex'
  | 'text'
  | 'ipv4'
  | 'url'
  | 'hostname'
  | 'credit_card'
  | 'foreign_key'
  | 'constant';

export interface MockPresetOption {
  id: MockPresetId;
  label: string;
  category: 'general' | 'person' | 'location' | 'network' | 'finance' | 'relation';
}

export const MOCK_PRESET_OPTIONS: readonly MockPresetOption[] = [
  { id: 'sequence', label: 'Sequence (1, 2, 3...)', category: 'general' },
  { id: 'uuid', label: 'UUID v4', category: 'general' },
  { id: 'int', label: 'Integer Range', category: 'general' },
  { id: 'float', label: 'Float / Decimal Range', category: 'general' },
  { id: 'boolean', label: 'Boolean', category: 'general' },
  { id: 'text', label: 'Lorem Text', category: 'general' },
  { id: 'enum', label: 'Enum / Weighted Choices', category: 'general' },
  { id: 'regex', label: 'Regex Pattern', category: 'general' },
  { id: 'date', label: 'Date (YYYY-MM-DD)', category: 'general' },
  { id: 'datetime', label: 'DateTime (ISO)', category: 'general' },
  { id: 'time', label: 'Time (HH:MM:SS)', category: 'general' },
  { id: 'full_name', label: 'Full Name', category: 'person' },
  { id: 'email', label: 'Email Address', category: 'person' },
  { id: 'phone', label: 'Phone Number', category: 'person' },
  { id: 'company', label: 'Company Name', category: 'person' },
  { id: 'address', label: 'Street Address', category: 'location' },
  { id: 'city', label: 'City', category: 'location' },
  { id: 'ipv4', label: 'IPv4 Address', category: 'network' },
  { id: 'url', label: 'URL', category: 'network' },
  { id: 'hostname', label: 'Hostname', category: 'network' },
  { id: 'credit_card', label: 'Credit Card (Luhn)', category: 'finance' },
  { id: 'foreign_key', label: 'Foreign Key Lookup', category: 'relation' },
  { id: 'constant', label: 'Constant Value', category: 'general' },
  { id: 'skip', label: 'Skip (Auto / Default)', category: 'general' },
];

export interface ColumnMockRule {
  columnName: string;
  dataType: string;
  preset: MockPresetId;
  /** Probability (0..100) of emitting NULL. */
  nullPercent?: number;
  /** Sequence start value (default 1). */
  seqStart?: number;
  /** Sequence step (default 1). */
  seqStep?: number;
  /** Numeric min (int/float) or word count min (text). */
  min?: number;
  /** Numeric max (int/float) or word count max (text). */
  max?: number;
  /** Decimal precision for float preset (default 2). */
  decimals?: number;
  /** ISO date start bound (default '2023-01-01'). */
  startDate?: string;
  /** ISO date end bound (default '2026-12-31'). */
  endDate?: string;
  /** Enum choices: comma-separated values or weighted `value:weight` pairs. */
  enumValues?: string;
  /** Regex-lite pattern (e.g. `[A-Z]{2}-[0-9]{4}`). */
  pattern?: string;
  /** Allowed lookup values for `foreign_key` preset. */
  foreignKeyValues?: CellValue[];
  /** Constant literal for `constant` preset. */
  constantValue?: string;
  /** Enforce uniqueness within generated batch where possible. */
  unique?: boolean;
}

export interface GeneratedMockDataset {
  columns: string[];
  rows: CellValue[][];
}

export interface MockInsertSqlOptions {
  dialect: SqlDialect;
  tableName: string;
  schema?: string;
  columns: readonly string[];
  rows: readonly (readonly CellValue[])[];
  batchSize?: number;
}

/* ============================================================================
 * Seeded PRNG (Mulberry32)
 * ============================================================================ */

export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, min: number, max: number): number {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pick<T>(rng: () => number, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length)];
}

/* ============================================================================
 * Built-in Dictionaries (ASCII-clean)
 * ============================================================================ */

const FIRST_NAMES = [
  'Alice', 'Benjamin', 'Clara', 'David', 'Elena', 'Felix', 'Grace', 'Henry',
  'Iris', 'Julian', 'Kira', 'Liam', 'Maya', 'Nathan', 'Olivia', 'Owen',
  'Priya', 'Quinn', 'Rachel', 'Samuel', 'Tessa', 'Victor', 'Wendy', 'Zoe',
];

const LAST_NAMES = [
  'Anderson', 'Bennett', 'Carter', 'Chen', 'Diaz', 'Edwards', 'Foster', 'Garcia',
  'Hayes', 'Kim', 'Lin', 'Martin', 'Nakamura', 'Patel', 'Reed', 'Rivera',
  'Ross', 'Singh', 'Taylor', 'Walker', 'Wang', 'Wilson', 'Young', 'Zhang',
];

const CITIES = [
  'San Francisco', 'New York', 'London', 'Tokyo', 'Berlin', 'Toronto', 'Singapore',
  'Sydney', 'Seattle', 'Austin', 'Amsterdam', 'Dublin', 'Seoul', 'Zurich', 'Boston', 'Chicago',
];

const STREETS = [
  'Market St', 'Broadway', 'Oak Ave', 'Maple Rd', 'Cedar Ln', 'Pine St',
  'Park Blvd', 'Harbor Way', 'Summit Dr', 'Valley Rd', 'Tech Pkwy', 'Main St',
];

const COMPANIES = [
  'Acme Systems', 'Northwind Labs', 'Vertex Cloud', 'Helios Data', 'Cobalt Works',
  'Stratos Analytics', 'Pulse Robotics', 'Summit Digital', 'Aether Networks', 'Cascade IO',
  'Nova Dynamics', 'Atlas Compute', 'Kestrel Software', 'Horizon Freight',
];

const DOMAINS = ['example.com', 'acme.io', 'northwind.dev', 'cloudops.net', 'mailtest.org'];

const LOREM_WORDS = [
  'alpha', 'beacon', 'cluster', 'delta', 'engine', 'fabric', 'gateway', 'horizon',
  'index', 'journal', 'kernel', 'ledger', 'matrix', 'nexus', 'orbit', 'packet',
  'query', 'replica', 'schema', 'telemetry', 'uplink', 'vector', 'worker', 'zenith',
];

/* ============================================================================
 * Specialized Generators
 * ============================================================================ */

function generateUuid(rng: () => number): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += '-';
    } else if (i === 14) {
      out += '4';
    } else if (i === 19) {
      out += hex[8 + Math.floor(rng() * 4)];
    } else {
      out += hex[Math.floor(rng() * 16)];
    }
  }
  return out;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function generateDateInRange(rng: () => number, startStr?: string, endStr?: string): Date {
  const startMs = Date.parse(startStr || '2023-01-01T00:00:00Z');
  const endMs = Date.parse(endStr || '2026-12-31T23:59:59Z');
  const lo = Number.isFinite(startMs) ? startMs : Date.UTC(2023, 0, 1);
  const hi = Number.isFinite(endMs) && endMs >= lo ? endMs : lo + 86400 * 365 * 1000;
  return new Date(lo + Math.floor(rng() * (hi - lo + 1)));
}

function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function formatTime(d: Date): string {
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

function formatDateTime(d: Date): string {
  return `${formatDate(d)} ${formatTime(d)}`;
}

interface WeightedOption {
  value: string;
  weight: number;
}

function parseWeightedChoices(raw?: string): WeightedOption[] {
  const text = (raw ?? '').trim();
  if (!text) return [{ value: 'active', weight: 1 }, { value: 'inactive', weight: 1 }];
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.lastIndexOf(':');
      if (idx > 0) {
        const w = Number(part.slice(idx + 1).trim());
        if (Number.isFinite(w) && w > 0) {
          return { value: part.slice(0, idx).trim(), weight: w };
        }
      }
      return { value: part, weight: 1 };
    });
}

function pickWeighted(rng: () => number, choices: readonly WeightedOption[]): string {
  const total = choices.reduce((sum, c) => sum + c.weight, 0);
  let cursor = rng() * total;
  for (const c of choices) {
    cursor -= c.weight;
    if (cursor <= 0) return c.value;
  }
  return choices[choices.length - 1].value;
}

/** Generate a Luhn-valid 16-digit Visa/Mastercard test number. */
export function generateLuhnCreditCard(rng: () => number): string {
  const prefix = rng() < 0.5 ? '4' : '5' + String(randInt(rng, 1, 5));
  const digits: number[] = prefix.split('').map(Number);
  while (digits.length < 15) {
    digits.push(randInt(rng, 0, 9));
  }
  let sum = 0;
  for (let i = 0; i < 15; i += 1) {
    let d = digits[14 - i];
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  const check = (10 - (sum % 10)) % 10;
  digits.push(check);
  return digits.join('');
}

/** Lightweight regex-to-string generator supporting char classes, \d/\w, groups (a|b), ?, {n}, {n,m}. */
export function generateFromRegexLite(pattern: string, rng: () => number): string {
  const src = pattern || '[A-Z]{3}-[0-9]{4}';
  let out = '';
  let i = 0;

  const readQuantifier = (): number => {
    if (i >= src.length) return 1;
    const ch = src[i];
    if (ch === '?') {
      i += 1;
      return rng() < 0.5 ? 0 : 1;
    }
    if (ch === '+') {
      i += 1;
      return randInt(rng, 1, 4);
    }
    if (ch === '*') {
      i += 1;
      return randInt(rng, 0, 4);
    }
    if (ch === '{') {
      const end = src.indexOf('}', i);
      if (end > i) {
        const inner = src.slice(i + 1, end);
        const parts = inner.split(',').map((s) => Number(s.trim()));
        i = end + 1;
        if (parts.length === 1 && Number.isFinite(parts[0])) {
          return Math.max(0, Math.min(64, Math.floor(parts[0])));
        }
        if (parts.length === 2 && Number.isFinite(parts[0])) {
          const lo = Math.max(0, Math.min(64, Math.floor(parts[0])));
          const hi = Number.isFinite(parts[1]) ? Math.max(lo, Math.min(64, Math.floor(parts[1]))) : lo + 3;
          return randInt(rng, lo, hi);
        }
      }
    }
    return 1;
  };

  while (i < src.length) {
    const ch = src[i];
    if (ch === '^' || ch === '$') {
      i += 1;
      continue;
    }

    if (ch === '\\' && i + 1 < src.length) {
      const esc = src[i + 1];
      i += 2;
      const count = readQuantifier();
      const pool =
        esc === 'd'
          ? '0123456789'
          : esc === 'w'
            ? 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'
            : esc;
      for (let k = 0; k < count; k += 1) {
        out += pool[Math.floor(rng() * pool.length)];
      }
      continue;
    }

    if (ch === '[') {
      const end = src.indexOf(']', i + 1);
      if (end > i) {
        const body = src.slice(i + 1, end);
        i = end + 1;
        const chars: string[] = [];
        for (let j = 0; j < body.length; j += 1) {
          if (j + 2 < body.length && body[j + 1] === '-') {
            const startCode = body.charCodeAt(j);
            const endCode = body.charCodeAt(j + 2);
            for (let c = Math.min(startCode, endCode); c <= Math.max(startCode, endCode); c += 1) {
              chars.push(String.fromCharCode(c));
            }
            j += 2;
          } else {
            chars.push(body[j]);
          }
        }
        const count = readQuantifier();
        if (chars.length > 0) {
          for (let k = 0; k < count; k += 1) {
            out += chars[Math.floor(rng() * chars.length)];
          }
        }
        continue;
      }
    }

    if (ch === '(') {
      const end = src.indexOf(')', i + 1);
      if (end > i) {
        const alts = src.slice(i + 1, end).split('|');
        i = end + 1;
        const count = readQuantifier();
        for (let k = 0; k < count; k += 1) {
          out += generateFromRegexLite(pick(rng, alts), rng);
        }
        continue;
      }
    }

    i += 1;
    const count = readQuantifier();
    for (let k = 0; k < count; k += 1) {
      out += ch;
    }
  }
  return out;
}

/* ============================================================================
 * Auto-Inference from ColumnStructure
 * ============================================================================ */

export function inferColumnMockRule(col: ColumnStructure): ColumnMockRule {
  const name = col.name.toLowerCase();
  const type = col.dataType.toLowerCase();
  const nullPercent = col.nullable && !col.isPrimaryKey ? 10 : 0;

  if (col.isAutoIncrement) {
    return { columnName: col.name, dataType: col.dataType, preset: 'skip', nullPercent: 0 };
  }

  if (type.includes('uuid') || name === 'uuid' || name.endsWith('_uuid')) {
    return { columnName: col.name, dataType: col.dataType, preset: 'uuid', nullPercent, unique: col.isPrimaryKey || col.unique };
  }

  if (col.isPrimaryKey && (type.includes('int') || type.includes('serial') || type.includes('num'))) {
    return { columnName: col.name, dataType: col.dataType, preset: 'sequence', seqStart: 1, seqStep: 1, nullPercent: 0, unique: true };
  }

  if (type.includes('bool') || type === 'bit' || name.startsWith('is_') || name.startsWith('has_')) {
    return { columnName: col.name, dataType: col.dataType, preset: 'boolean', nullPercent };
  }

  if (type.includes('timestamp') || type.includes('datetime')) {
    return { columnName: col.name, dataType: col.dataType, preset: 'datetime', startDate: '2024-01-01', endDate: '2026-12-31', nullPercent };
  }
  if (type === 'date' || name.endsWith('_date') || name === 'birthday') {
    return { columnName: col.name, dataType: col.dataType, preset: 'date', startDate: '2020-01-01', endDate: '2026-12-31', nullPercent };
  }
  if (type === 'time' || type.startsWith('time(')) {
    return { columnName: col.name, dataType: col.dataType, preset: 'time', nullPercent };
  }

  if (type.includes('dec') || type.includes('num') || type.includes('float') || type.includes('double') || type.includes('real') || type.includes('money')) {
    return { columnName: col.name, dataType: col.dataType, preset: 'float', min: 1, max: 1000, decimals: col.numericScale ?? 2, nullPercent };
  }
  if (type.includes('int') || type.includes('serial')) {
    return { columnName: col.name, dataType: col.dataType, preset: 'int', min: 1, max: 10000, nullPercent };
  }

  // Inline MySQL ENUM('a','b')
  const enumMatch = /^enum\((.+)\)$/i.exec(col.dataType.trim());
  if (enumMatch) {
    const vals = enumMatch[1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
      .join(',');
    return { columnName: col.name, dataType: col.dataType, preset: 'enum', enumValues: vals, nullPercent };
  }

  if (name.includes('email')) {
    return { columnName: col.name, dataType: col.dataType, preset: 'email', nullPercent, unique: col.unique };
  }
  if (name.includes('phone') || name.includes('mobile') || name.includes('tel')) {
    return { columnName: col.name, dataType: col.dataType, preset: 'phone', nullPercent };
  }
  if (name.includes('city')) {
    return { columnName: col.name, dataType: col.dataType, preset: 'city', nullPercent };
  }
  if (name.includes('address') || name.includes('street')) {
    return { columnName: col.name, dataType: col.dataType, preset: 'address', nullPercent };
  }
  if (name.includes('company') || name.includes('org') || name.includes('vendor')) {
    return { columnName: col.name, dataType: col.dataType, preset: 'company', nullPercent };
  }
  if (name.includes('url') || name.includes('website') || name.includes('homepage')) {
    return { columnName: col.name, dataType: col.dataType, preset: 'url', nullPercent };
  }
  if (name.includes('host')) {
    return { columnName: col.name, dataType: col.dataType, preset: 'hostname', nullPercent };
  }
  if (name === 'ip' || name.endsWith('_ip') || name.includes('ipv4')) {
    return { columnName: col.name, dataType: col.dataType, preset: 'ipv4', nullPercent };
  }
  if (name.includes('card')) {
    return { columnName: col.name, dataType: col.dataType, preset: 'credit_card', nullPercent };
  }
  if (name === 'name' || name.includes('full_name') || name.includes('username') || name.includes('author')) {
    return { columnName: col.name, dataType: col.dataType, preset: 'full_name', nullPercent };
  }
  if (name.includes('status') || name.includes('state') || name.includes('tier') || name.includes('role')) {
    return { columnName: col.name, dataType: col.dataType, preset: 'enum', enumValues: 'active:60,pending:25,archived:15', nullPercent };
  }

  return { columnName: col.name, dataType: col.dataType, preset: 'text', min: 2, max: 6, nullPercent };
}

/* ============================================================================
 * Row Generator
 * ============================================================================ */

function generateSingleValue(rule: ColumnMockRule, rowIndex: number, rng: () => number): CellValue {
  const nullPct = Math.max(0, Math.min(100, rule.nullPercent ?? 0));
  if (nullPct > 0 && rng() * 100 < nullPct) {
    return null;
  }

  switch (rule.preset) {
    case 'uuid':
      return generateUuid(rng);
    case 'sequence': {
      const start = Number.isFinite(rule.seqStart) ? (rule.seqStart as number) : 1;
      const step = Number.isFinite(rule.seqStep) ? (rule.seqStep as number) : 1;
      return start + rowIndex * step;
    }
    case 'int':
      return randInt(rng, rule.min ?? 1, rule.max ?? 10000);
    case 'float': {
      const lo = rule.min ?? 0;
      const hi = rule.max ?? 1000;
      const dec = Math.max(0, Math.min(8, rule.decimals ?? 2));
      const raw = lo + rng() * (hi - lo);
      return Number(raw.toFixed(dec));
    }
    case 'boolean':
      return rng() < 0.5;
    case 'full_name':
      return `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;
    case 'email': {
      const first = pick(rng, FIRST_NAMES).toLowerCase();
      const last = pick(rng, LAST_NAMES).toLowerCase();
      const suffix = randInt(rng, 10, 9999);
      return `${first}.${last}${suffix}@${pick(rng, DOMAINS)}`;
    }
    case 'phone':
      return `+1-${randInt(rng, 200, 999)}-${randInt(rng, 200, 999)}-${String(randInt(rng, 0, 9999)).padStart(4, '0')}`;
    case 'address':
      return `${randInt(rng, 10, 9999)} ${pick(rng, STREETS)}`;
    case 'city':
      return pick(rng, CITIES);
    case 'company':
      return pick(rng, COMPANIES);
    case 'date':
      return formatDate(generateDateInRange(rng, rule.startDate, rule.endDate));
    case 'datetime':
      return formatDateTime(generateDateInRange(rng, rule.startDate, rule.endDate));
    case 'time':
      return formatTime(generateDateInRange(rng, rule.startDate, rule.endDate));
    case 'enum':
      return pickWeighted(rng, parseWeightedChoices(rule.enumValues));
    case 'regex':
      return generateFromRegexLite(rule.pattern || '[A-Z]{2}-[0-9]{4}', rng);
    case 'text': {
      const wordCount = randInt(rng, Math.max(1, rule.min ?? 3), Math.max(1, rule.max ?? 8));
      const words: string[] = [];
      for (let i = 0; i < wordCount; i += 1) {
        words.push(pick(rng, LOREM_WORDS));
      }
      const sentence = words.join(' ');
      return sentence.charAt(0).toUpperCase() + sentence.slice(1);
    }
    case 'ipv4':
      return `${randInt(rng, 10, 223)}.${randInt(rng, 0, 255)}.${randInt(rng, 0, 255)}.${randInt(rng, 1, 254)}`;
    case 'url':
      return `https://app.${pick(rng, DOMAINS)}/${pick(rng, LOREM_WORDS)}/${randInt(rng, 1, 999)}`;
    case 'hostname':
      return `${pick(rng, LOREM_WORDS)}-${String(randInt(rng, 1, 99)).padStart(2, '0')}.${pick(rng, DOMAINS)}`;
    case 'credit_card':
      return generateLuhnCreditCard(rng);
    case 'foreign_key': {
      const vals = rule.foreignKeyValues ?? [];
      if (vals.length === 0) return randInt(rng, 1, 100);
      return vals[Math.floor(rng() * vals.length)];
    }
    case 'constant':
      return rule.constantValue ?? '';
    case 'skip':
    default:
      return null;
  }
}

export function generateMockRows(
  rules: readonly ColumnMockRule[],
  rowCount: number,
  seed = 1337,
): GeneratedMockDataset {
  const activeRules = rules.filter((r) => r.preset !== 'skip');
  const count = Math.max(0, Math.min(100_000, Math.floor(rowCount)));
  const rng = createSeededRng(seed);
  const seenPerCol = activeRules.map((r) => (r.unique ? new Set<string>() : null));
  const rows: CellValue[][] = [];

  for (let r = 0; r < count; r += 1) {
    const row: CellValue[] = [];
    for (let c = 0; c < activeRules.length; c += 1) {
      const rule = activeRules[c];
      const seen = seenPerCol[c];
      let val = generateSingleValue(rule, r, rng);
      if (seen && val !== null) {
        let attempts = 0;
        while (seen.has(String(val)) && attempts < 16) {
          val = generateSingleValue(rule, r + attempts + 1, rng);
          attempts += 1;
        }
        if (val !== null) seen.add(String(val));
      }
      row.push(val);
    }
    rows.push(row);
  }

  return {
    columns: activeRules.map((r) => r.columnName),
    rows,
  };
}

/* ============================================================================
 * Batched Dialect-Aware INSERT SQL Builder
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

function formatLiteral(dialect: SqlDialect, value: CellValue): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') {
    if (dialect === 'mssql' || dialect === 'sqlite') return value ? '1' : '0';
    return value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'object') return formatLiteral(dialect, JSON.stringify(value));
  if (dialect === 'mysql' || dialect === 'clickhouse') {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildMockInsertStatements(options: MockInsertSqlOptions): string[] {
  const { dialect, tableName, schema, columns, rows } = options;
  if (columns.length === 0 || rows.length === 0) return [];

  const batchSize = Math.max(1, Math.min(1000, Math.floor(options.batchSize ?? 100)));
  const qualTable =
    schema && schema.trim() && dialect !== 'sqlite'
      ? `${quoteIdent(dialect, schema.trim())}.${quoteIdent(dialect, tableName)}`
      : quoteIdent(dialect, tableName);
  const colList = columns.map((c) => quoteIdent(dialect, c)).join(', ');

  const statements: string[] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const valuesSql = chunk
      .map((row) => `(${row.map((cell) => formatLiteral(dialect, cell)).join(', ')})`)
      .join(',\n  ');
    statements.push(`INSERT INTO ${qualTable} (${colList}) VALUES\n  ${valuesSql};`);
  }
  return statements;
}

/**
 * Data Export & Import Engines (CSV, JSON, Markdown, SQL INSERT, XLSX).
 * 100% pure TypeScript & browser-sandbox compatible (zero external ZIP/XLSX deps).
 */

import type { CellValue, SqlDialect } from '../drivers/types';
import { quoteIdent, quoteSqlLiteral } from '../drivers/sqlDialect';
import { splitSqlStatements } from './splitter';

const te = new TextEncoder();
const td = new TextDecoder('utf-8');

function cellToString(val: CellValue): string {
  if (val === null || val === undefined) return '';
  if (val instanceof Uint8Array) {
    return '0x' + Array.from(val, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

/* ============================================================================
 * CSV Export & Import (RFC 4180)
 * ============================================================================ */

export interface CsvExportOptions {
  delimiter?: string;
  includeHeader?: boolean;
  bom?: boolean;
  nullText?: string;
}

export function exportCsv(
  columns: readonly string[],
  rows: readonly (readonly CellValue[])[],
  options?: CsvExportOptions,
): string {
  const delimiter = options?.delimiter ?? ',';
  const includeHeader = options?.includeHeader ?? true;
  const nullText = options?.nullText ?? '';

  const escapeField = (raw: string): string => {
    if (
      raw.includes(delimiter) ||
      raw.includes('"') ||
      raw.includes('\n') ||
      raw.includes('\r')
    ) {
      return '"' + raw.replaceAll('"', '""') + '"';
    }
    return raw;
  };

  const lines: string[] = [];
  if (includeHeader) {
    lines.push(columns.map((c) => escapeField(c)).join(delimiter));
  }
  for (const row of rows) {
    lines.push(
      row
        .map((cell) => escapeField(cell === null || cell === undefined ? nullText : cellToString(cell)))
        .join(delimiter),
    );
  }
  const content = lines.join('\r\n');
  return options?.bom ? '\uFEFF' + content : content;
}

/**
 * Tab-Separated Values export (spreadsheet paste friendly: Excel / Google Sheets / Numbers).
 */
export function exportTsv(
  columns: readonly string[],
  rows: readonly (readonly CellValue[])[],
  options?: Omit<CsvExportOptions, 'delimiter'>,
): string {
  return exportCsv(columns, rows, { ...options, delimiter: '\t' });
}

/**
 * Format selected column values into a SQL `IN (...)` list (deduplicated, dialect-quoted).
 */
export function exportSqlInList(
  values: readonly CellValue[],
  dialect: SqlDialect = 'postgres',
  columnName?: string,
): string {
  const seen = new Set<string>();
  const literals: string[] = [];
  for (const val of values) {
    if (val === null || val === undefined) continue;
    const lit = quoteSqlLiteral(val, dialect);
    if (seen.has(lit)) continue;
    seen.add(lit);
    literals.push(lit);
  }
  const list = `(${literals.join(', ')})`;
  return columnName ? `${quoteIdent(columnName, dialect)} IN ${list}` : `IN ${list}`;
}

export interface ImportedTableData {
  columns: string[];
  rows: CellValue[][];
  inferredTypes: Record<string, string>;
}

export interface CsvImportOptions {
  delimiter?: string;
  hasHeader?: boolean;
  dialect?: SqlDialect;
}

export function importCsv(text: string, options?: CsvImportOptions): ImportedTableData {
  const delimiter = options?.delimiter ?? ',';
  const hasHeader = options?.hasHeader ?? true;
  const clean = text.startsWith('\uFEFF') ? text.slice(1) : text;

  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < clean.length) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
      continue;
    }

    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      i++;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\r') {
      row.push(field);
      field = '';
      records.push(row);
      row = [];
      i += clean[i + 1] === '\n' ? 2 : 1;
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      records.push(row);
      row = [];
      i++;
    } else {
      field += ch;
      i++;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }

  if (records.length === 0) {
    return { columns: [], rows: [], inferredTypes: {} };
  }

  const columns = hasHeader
    ? records[0].map((c, idx) => c.trim() || `col_${idx + 1}`)
    : records[0].map((_, idx) => `col_${idx + 1}`);
  const dataRecords = hasHeader ? records.slice(1) : records;
  const rows: CellValue[][] = dataRecords
    .filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''))
    .map((r) =>
      columns.map((_, idx) => {
        const v = r[idx];
        if (v === undefined || v === '') return null;
        return parseScalarString(v);
      }),
    );

  return {
    columns,
    rows,
    inferredTypes: inferColumnTypes(columns, rows, options?.dialect ?? 'postgres'),
  };
}

/* ============================================================================
 * JSON Export & Import
 * ============================================================================ */

export interface JsonExportOptions {
  pretty?: boolean;
  ndjson?: boolean;
}

export function exportJson(
  columns: readonly string[],
  rows: readonly (readonly CellValue[])[],
  options?: JsonExportOptions,
): string {
  const objects = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      const val = row[i];
      obj[columns[i]] = val instanceof Uint8Array ? cellToString(val) : val ?? null;
    }
    return obj;
  });
  if (options?.ndjson) {
    return objects.map((o) => JSON.stringify(o)).join('\n');
  }
  return JSON.stringify(objects, null, options?.pretty === false ? 0 : 2);
}

export function importJson(text: string, dialect: SqlDialect = 'postgres'): ImportedTableData {
  const trimmed = text.trim();
  if (!trimmed) return { columns: [], rows: [], inferredTypes: {} };

  let objects: Record<string, unknown>[];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('Expected JSON array');
    objects = parsed.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'));
  } else if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed.columns) && Array.isArray(parsed.rows)) {
      const columns = parsed.columns.map(String);
      const rows = parsed.rows as CellValue[][];
      return { columns, rows, inferredTypes: inferColumnTypes(columns, rows, dialect) };
    }
    // Maybe NDJSON
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
    objects = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  } else {
    throw new Error('Unsupported JSON import format');
  }

  const colSet = new Set<string>();
  for (const obj of objects) {
    for (const key of Object.keys(obj)) colSet.add(key);
  }
  const columns = Array.from(colSet);
  const rows: CellValue[][] = objects.map((obj) =>
    columns.map((c) => {
      const val = obj[c];
      if (val === undefined || val === null) return null;
      if (typeof val === 'boolean' || typeof val === 'number' || typeof val === 'string') return val;
      return val as CellValue;
    }),
  );
  return { columns, rows, inferredTypes: inferColumnTypes(columns, rows, dialect) };
}

/* ============================================================================
 * Markdown & SQL INSERT Export + SQL Script Import
 * ============================================================================ */

export function exportMarkdown(
  columns: readonly string[],
  rows: readonly (readonly CellValue[])[],
): string {
  const esc = (s: string) => s.replaceAll('|', '\\|').replaceAll('\r\n', ' ').replaceAll('\n', ' ');
  const header = '| ' + columns.map((c) => esc(c)).join(' | ') + ' |';
  const sep = '| ' + columns.map(() => '---').join(' | ') + ' |';
  const body = rows.map(
    (r) => '| ' + r.map((v) => esc(v === null || v === undefined ? 'NULL' : cellToString(v))).join(' | ') + ' |',
  );
  return [header, sep, ...body].join('\n');
}

export interface SqlInsertExportOptions {
  batchSize?: number;
  schema?: string;
}

export function exportSqlInserts(
  tableName: string,
  columns: readonly string[],
  rows: readonly (readonly CellValue[])[],
  dialect: SqlDialect = 'postgres',
  options?: SqlInsertExportOptions,
): string {
  if (rows.length === 0) return '';
  const batchSize = Math.max(1, options?.batchSize ?? 1);
  const qTable = options?.schema
    ? `${quoteIdent(options.schema, dialect)}.${quoteIdent(tableName, dialect)}`
    : quoteIdent(tableName, dialect);
  const qCols = columns.map((c) => quoteIdent(c, dialect)).join(', ');
  const statements: string[] = [];

  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const values = chunk
      .map((row) => '(' + row.map((v) => quoteSqlLiteral(v, dialect)).join(', ') + ')')
      .join(',\n  ');
    statements.push(`INSERT INTO ${qTable} (${qCols}) VALUES\n  ${values};`);
  }
  return statements.join('\n\n');
}

export function importSqlScript(
  text: string,
  dialect: SqlDialect = 'postgres',
): { statements: string[] } {
  return { statements: splitSqlStatements(text, dialect).map((s) => s.sql) };
}

/* ============================================================================
 * Pure-TS Minimal ZIP (STORE) & OOXML XLSX Export / Import
 * ============================================================================ */

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntryInput {
  name: string;
  data: Uint8Array;
}

function buildZipStore(entries: ZipEntryInput[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = te.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true); // STORE
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    localParts.push(local, entry.data);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length + size;
  }

  let centralSize = 0;
  for (const p of centralParts) centralSize += p.length;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of localParts) {
    out.set(p, pos);
    pos += p.length;
  }
  for (const p of centralParts) {
    out.set(p, pos);
    pos += p.length;
  }
  out.set(eocd, pos);
  return out;
}

async function inflateRawBytes(compressed: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    await writer.write(compressed as BufferSource);
    await writer.close();
    const reader = ds.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }
  throw new Error('DecompressionStream is unavailable for deflated XLSX files');
}

async function readZipEntries(zipBytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  // Find End of Central Directory signature 0x06054b50
  let eocdOffset = -1;
  for (let i = zipBytes.length - 22; i >= Math.max(0, zipBytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('Invalid ZIP/XLSX archive');
  const entryCount = dv.getUint16(eocdOffset + 10, true);
  const centralOffset = dv.getUint32(eocdOffset + 16, true);

  const files = new Map<string, Uint8Array>();
  let pos = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    if (dv.getUint32(pos, true) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
    const method = dv.getUint16(pos + 10, true);
    const compSize = dv.getUint32(pos + 20, true);
    const nameLen = dv.getUint16(pos + 28, true);
    const extraLen = dv.getUint16(pos + 30, true);
    const commentLen = dv.getUint16(pos + 32, true);
    const localOffset = dv.getUint32(pos + 42, true);
    const name = td.decode(zipBytes.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;

    const localNameLen = dv.getUint16(localOffset + 26, true);
    const localExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const rawData = zipBytes.subarray(dataStart, dataStart + compSize);
    if (method === 0) {
      files.set(name, rawData.slice());
    } else if (method === 8) {
      files.set(name, await inflateRawBytes(rawData));
    } else {
      throw new Error(`Unsupported ZIP compression method: ${method}`);
    }
  }
  return files;
}

function xmlEscape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function xmlUnescape(s: string): string {
  return s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function colIndexToLetter(idx: number): string {
  let n = idx + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function colLetterToIndex(letters: string): number {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

export function exportXlsx(
  sheetName: string,
  columns: readonly string[],
  rows: readonly (readonly CellValue[])[],
): Uint8Array {
  const safeSheet = (sheetName || 'Sheet1').replace(/[\\/*?:[\]]/g, '_').slice(0, 31);
  const sheetRows: string[] = [];

  // Header row (row 1)
  const headerCells = columns
    .map(
      (col, idx) =>
        `<c r="${colIndexToLetter(idx)}1" t="inlineStr"><is><t>${xmlEscape(col)}</t></is></c>`,
    )
    .join('');
  sheetRows.push(`<row r="1">${headerCells}</row>`);

  // Data rows
  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    const rowNum = rIdx + 2;
    const row = rows[rIdx];
    const cells: string[] = [];
    for (let cIdx = 0; cIdx < columns.length; cIdx++) {
      const val = row[cIdx];
      const ref = `${colIndexToLetter(cIdx)}${rowNum}`;
      if (val === null || val === undefined) continue;
      if (typeof val === 'number' && Number.isFinite(val)) {
        cells.push(`<c r="${ref}"><v>${val}</v></c>`);
      } else if (typeof val === 'boolean') {
        cells.push(`<c r="${ref}" t="b"><v>${val ? 1 : 0}</v></c>`);
      } else {
        cells.push(`<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(cellToString(val))}</t></is></c>`);
      }
    }
    sheetRows.push(`<row r="${rowNum}">${cells.join('')}</row>`);
  }

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${xmlEscape(safeSheet)}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${sheetRows.join('')}</sheetData>
</worksheet>`;

  return buildZipStore([
    { name: '[Content_Types].xml', data: te.encode(contentTypes) },
    { name: '_rels/.rels', data: te.encode(rels) },
    { name: 'xl/workbook.xml', data: te.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: te.encode(workbookRels) },
    { name: 'xl/worksheets/sheet1.xml', data: te.encode(sheetXml) },
  ]);
}

export async function importXlsx(
  bytes: Uint8Array,
  dialect: SqlDialect = 'postgres',
): Promise<ImportedTableData & { sheetName: string }> {
  const files = await readZipEntries(bytes);
  const workbookBytes = files.get('xl/workbook.xml');
  let sheetName = 'Sheet1';
  if (workbookBytes) {
    const wbXml = td.decode(workbookBytes);
    const m = /<sheet[^>]*name="([^"]+)"/.exec(wbXml);
    if (m) sheetName = xmlUnescape(m[1]);
  }

  // Parse sharedStrings.xml if present
  const sharedStrings: string[] = [];
  const ssBytes = files.get('xl/sharedStrings.xml');
  if (ssBytes) {
    const ssXml = td.decode(ssBytes);
    const siRe = /<si>([\s\S]*?)<\/si>/g;
    let m: RegExpExecArray | null;
    while ((m = siRe.exec(ssXml)) !== null) {
      const tParts: string[] = [];
      const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
      let tm: RegExpExecArray | null;
      while ((tm = tRe.exec(m[1])) !== null) {
        tParts.push(xmlUnescape(tm[1]));
      }
      sharedStrings.push(tParts.join(''));
    }
  }

  const sheetBytes = files.get('xl/worksheets/sheet1.xml');
  if (!sheetBytes) throw new Error('XLSX missing xl/worksheets/sheet1.xml');
  const sheetXml = td.decode(sheetBytes);

  const parsedRows: CellValue[][] = [];
  let maxCol = 0;
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(sheetXml)) !== null) {
    const rowContent = rm[1];
    const rowCells: CellValue[] = [];
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rowContent)) !== null) {
      const attrs = cm[1];
      const inner = cm[2];
      const refMatch = /r="([A-Z]+)\d+"/.exec(attrs);
      const typeMatch = /t="([^"]+)"/.exec(attrs);
      const colIdx = refMatch ? colLetterToIndex(refMatch[1]) : rowCells.length;
      while (rowCells.length <= colIdx) rowCells.push(null);
      if (colIdx + 1 > maxCol) maxCol = colIdx + 1;

      const cellType = typeMatch?.[1] ?? 'n';
      if (cellType === 'inlineStr') {
        const tm = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
        rowCells[colIdx] = tm ? xmlUnescape(tm[1]) : '';
      } else if (cellType === 's') {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        const idx = vm ? Number(vm[1]) : -1;
        rowCells[colIdx] = sharedStrings[idx] ?? '';
      } else if (cellType === 'b') {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        rowCells[colIdx] = vm?.[1] === '1';
      } else if (cellType === 'str') {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        rowCells[colIdx] = vm ? xmlUnescape(vm[1]) : '';
      } else {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (vm) {
          const num = Number(vm[1]);
          rowCells[colIdx] = Number.isFinite(num) ? num : vm[1];
        }
      }
    }
    parsedRows.push(rowCells);
  }

  if (parsedRows.length === 0) {
    return { sheetName, columns: [], rows: [], inferredTypes: {} };
  }

  const columns = Array.from({ length: maxCol }, (_, i) => {
    const h = parsedRows[0][i];
    return h !== null && h !== undefined && String(h).trim() !== ''
      ? String(h).trim()
      : `col_${i + 1}`;
  });
  const rows = parsedRows.slice(1).map((r) =>
    columns.map((_, i) => (i < r.length ? r[i] : null)),
  );

  return {
    sheetName,
    columns,
    rows,
    inferredTypes: inferColumnTypes(columns, rows, dialect),
  };
}

/* ============================================================================
 * Type Inference & Auto-Column Mapping
 * ============================================================================ */

function parseScalarString(raw: string): CellValue {
  const t = raw.trim();
  if (t === '') return '';
  if (t.toLowerCase() === 'true') return true;
  if (t.toLowerCase() === 'false') return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(t)) {
    const num = Number(t);
    if (Number.isFinite(num) && (!Number.isInteger(num) || Number.isSafeInteger(num))) {
      return num;
    }
  }
  return raw;
}

export function inferColumnTypes(
  columns: readonly string[],
  rows: readonly (readonly CellValue[])[],
  dialect: SqlDialect = 'postgres',
): Record<string, string> {
  const result: Record<string, string> = {};
  for (let c = 0; c < columns.length; c++) {
    let allBool = true;
    let allInt = true;
    let allFloat = true;
    let allDate = true;
    let nonNull = 0;

    for (const row of rows) {
      const val = row[c];
      if (val === null || val === undefined || val === '') continue;
      nonNull++;
      if (typeof val === 'boolean') {
        allInt = false;
        allFloat = false;
        allDate = false;
      } else if (typeof val === 'number') {
        allBool = false;
        allDate = false;
        if (!Number.isInteger(val)) allInt = false;
      } else {
        allBool = false;
        const s = String(val);
        if (!/^-?\d+$/.test(s)) allInt = false;
        if (!/^-?\d+(?:\.\d+)?$/.test(s)) allFloat = false;
        if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) {
          allDate = false;
        }
      }
    }

    if (nonNull === 0) {
      result[columns[c]] = dialect === 'mysql' ? 'VARCHAR(255)' : dialect === 'clickhouse' ? 'Nullable(String)' : 'TEXT';
    } else if (allBool) {
      result[columns[c]] = dialect === 'sqlite' ? 'INTEGER' : dialect === 'clickhouse' ? 'Bool' : 'BOOLEAN';
    } else if (allInt) {
      result[columns[c]] = dialect === 'clickhouse' ? 'Int64' : 'BIGINT';
    } else if (allFloat) {
      result[columns[c]] = dialect === 'clickhouse' ? 'Float64' : dialect === 'sqlite' ? 'REAL' : 'DOUBLE PRECISION';
    } else if (allDate) {
      result[columns[c]] = dialect === 'mysql' ? 'DATETIME' : dialect === 'clickhouse' ? 'DateTime64(3)' : 'TIMESTAMP';
    } else {
      result[columns[c]] = dialect === 'mysql' ? 'TEXT' : dialect === 'clickhouse' ? 'String' : 'TEXT';
    }
  }
  return result;
}

export function autoMapImportColumns(
  sourceColumns: readonly string[],
  targetColumns: readonly string[],
): Record<string, string | null> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const targetNormMap = new Map(targetColumns.map((t) => [norm(t), t]));
  const mapping: Record<string, string | null> = {};
  for (const src of sourceColumns) {
    const exact = targetColumns.find((t) => t.toLowerCase() === src.toLowerCase());
    if (exact) {
      mapping[src] = exact;
    } else {
      mapping[src] = targetNormMap.get(norm(src)) ?? null;
    }
  }
  return mapping;
}

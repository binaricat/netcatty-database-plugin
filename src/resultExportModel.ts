import type { DatabaseQueryResult, DatabaseScalar } from './databaseTypes';
export type ResultExportFormat = 'csv' | 'json' | 'markdown' | 'sql';
export interface ResultExportOptions { format: ResultExportFormat; tableName?: string; }
export interface ResultExport { text: string; rowCount: number; truncated: boolean; scope: 'returned-rows-only'; notes: string[]; }
export const RESULT_EXPORT_MAX_BYTES = 96 * 1024;
const quoteIdentifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const scalarValid = (value: unknown): value is DatabaseScalar => value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value);
/** Strings are always quoted, so a quoted empty string differs from an unquoted NULL
 * sentinel in the textual CSV. Readers must use the documented CSV NULL convention.
 * CSV has no standard null/type marker and is not a lossless typed interchange format.
 */
function csv(value: DatabaseScalar): string {
  if(value === null)return '\\N';
  if(typeof value !== 'string')return String(value);
  const safe = /^[\t\r\n ]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"','""') + '"';
}
function markdown(value: DatabaseScalar): string {
  if(value === null)return '*NULL*';
  if(value === '')return '*empty string*';
  // Encode HTML and Markdown controls rather than permitting links/images/raw HTML.
  return String(value).replace(/&/g,'&amp;').replace(/[<>|\\`*_\[\]{}()!#]/g,char=>`&#${char.charCodeAt(0)};`).replace(/\r\n|\r|\n/g,'<br>');
}
function sqlValue(value: DatabaseScalar): string {
  if(value===null)return 'NULL';if(typeof value==='boolean')return value?'TRUE':'FALSE';
  if(typeof value==='number')return String(value);
  if(value.includes('\0')) throw new Error('SQL export cannot represent NUL text safely; use JSON.');
  return "'" + value.replaceAll("'","''") + "'";
}
/** Exports only rows already returned to the plugin. Never queries, writes files,
 * reads credentials or claims that a bounded result is the whole table.
 * SQL output is SQLite-oriented literal SQL; no binary restoration is implied.
 */
export function exportQueryResult(result: DatabaseQueryResult, options: ResultExportOptions): ResultExport {
  if(!['csv','json','markdown','sql'].includes(options.format))throw new Error('Unsupported export format.');
  if(!Array.isArray(result.columns)||result.columns.length>64||!result.columns.every(column=>typeof column==='string'&&column.length<=8192)||!Array.isArray(result.rows)||result.rows.length>100||typeof result.truncated!=='boolean')throw new Error('Invalid or oversized result export.');
  let inputBytes = new TextEncoder().encode(JSON.stringify(result.columns)).length;
  for(const row of result.rows) {
    if(!Array.isArray(row)||row.length!==result.columns.length||!row.every(scalarValid))throw new Error('Export rows must match columns and contain finite scalars only.');
    inputBytes += new TextEncoder().encode(JSON.stringify(row)).length;
    if(inputBytes>RESULT_EXPORT_MAX_BYTES)throw new Error('Result export exceeds the 96 KiB limit.');
  }
  const notes=['Only returned rows are exported, not the whole table.'];
  if(result.truncated)notes.push('The query result was truncated upstream; omitted data is not included.');
  if(result.rows.some(row=>row.some(value=>typeof value==='string'&&/^<BLOB \d+ bytes>$/.test(value))))notes.push('BLOB placeholders remain literal text; this export cannot restore binary data.');
  let text: string;
  if(options.format==='csv') {
    notes.push('CSV convention: unquoted \\N means NULL; quoted "" means empty string. Text \\N is quoted. Many CSV readers discard this distinction; use JSON for lossless null/type preservation.');
    notes.push('Potential spreadsheet formulas in text are prefixed with an apostrophe, including column names; numeric cells are unchanged.');
    text=[result.columns.map(csv).join(','),...result.rows.map(row=>row.map(csv).join(','))].join('\r\n')+'\r\n';
  } else if(options.format==='json') {
    // Column/row arrays preserve duplicate column names and every scalar type.
    text=JSON.stringify({scope:'returned-rows-only',columns:result.columns,rows:result.rows,truncated:result.truncated},null,2);
  } else if(options.format==='markdown') {
    notes.push('NULL and empty strings use display labels; Markdown is a presentation format, not lossless interchange.');
    const line=(cells: string[])=>'| '+cells.join(' | ')+' |';
    text=[line(result.columns.map(markdown)),line(result.columns.map(()=> '---')),...result.rows.map(row=>line(row.map(markdown)))].join('\n');
  } else {
    const name=options.tableName;
    if(typeof name!=='string'||!name.trim()||name.length>256||name.includes('\0'))throw new Error('SQL export requires a valid destination table name.');
    if(!result.columns.length||result.columns.some(column=>!column||column.includes('\0'))||new Set(result.columns.map(column=>column.toLowerCase())).size!==result.columns.length)throw new Error('SQL export requires nonempty, unique destination column names.');
    notes.push('SQL is SQLite-oriented and is not executed. Confirm destination schema and types before importing.');
    const target=quoteIdentifier(name);const columns=result.columns.map(quoteIdentifier).join(', ');
    text=['-- Returned rows only; not a full table export.',...(result.truncated?['-- Source query was truncated.']:[]),...result.rows.map(row=>`INSERT INTO ${target} (${columns}) VALUES (${row.map(sqlValue).join(', ')});`)].join('\n');
  }
  if(new TextEncoder().encode(text).length>RESULT_EXPORT_MAX_BYTES)throw new Error('Result export exceeds the 96 KiB limit; no partial export was produced.');
  return {text,rowCount:result.rows.length,truncated:result.truncated,scope:'returned-rows-only',notes};
}

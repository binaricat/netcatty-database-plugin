/**
 * Schema Data Dictionary Exporter (Markdown, Standalone HTML, DBML)
 * and Multi-Language Model Code Generator (TypeScript, Zod, Prisma, Go, Rust, Python, Java).
 * Pure, browser-sandbox compatible (zero Node imports).
 */

import type {
  ColumnStructure,
  RoutineSummary,
  TableStructure,
  ViewSummary,
} from '../drivers/types';

export interface DataDictionaryInput {
  projectName: string;
  engine?: string;
  database: string;
  schema: string;
  generatedAt?: string;
  tables: readonly TableStructure[];
  views?: readonly ViewSummary[];
  routines?: readonly RoutineSummary[];
}

export type ModelCodeFormat =
  | 'typescript'
  | 'zod'
  | 'prisma'
  | 'go'
  | 'rust'
  | 'python-dataclass'
  | 'python-sqlalchemy'
  | 'java';

export interface ModelCodeFormatMeta {
  id: ModelCodeFormat;
  label: string;
  extension: string;
  language: 'plaintext' | 'json';
}

export const MODEL_CODE_FORMATS: readonly ModelCodeFormatMeta[] = [
  { id: 'typescript', label: 'TypeScript Interface', extension: 'ts', language: 'plaintext' },
  { id: 'zod', label: 'Zod Schema', extension: 'ts', language: 'plaintext' },
  { id: 'prisma', label: 'Prisma Model', extension: 'prisma', language: 'plaintext' },
  { id: 'go', label: 'Go Struct', extension: 'go', language: 'plaintext' },
  { id: 'rust', label: 'Rust Struct (Serde)', extension: 'rs', language: 'plaintext' },
  { id: 'python-dataclass', label: 'Python Dataclass', extension: 'py', language: 'plaintext' },
  { id: 'python-sqlalchemy', label: 'Python SQLAlchemy 2.0', extension: 'py', language: 'plaintext' },
  { id: 'java', label: 'Java POJO', extension: 'java', language: 'plaintext' },
];

export interface ModelCodeOptions {
  includeComments?: boolean;
  packageName?: string;
  camelCaseFields?: boolean;
}

export interface GeneratedModelCode {
  format: ModelCodeFormat;
  fileName: string;
  extension: string;
  code: string;
}

/* ============================================================================
 * Naming & Escaping Helpers
 * ============================================================================ */

function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^a-zA-Z0-9]+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

export function toPascalCase(name: string): string {
  const words = splitWords(name);
  if (words.length === 0) return 'Model';
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
}

export function toCamelCase(name: string): string {
  const pascal = toPascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

export function toSnakeCase(name: string): string {
  const words = splitWords(name);
  if (words.length === 0) return 'field';
  return words.map((w) => w.toLowerCase()).join('_');
}

function escapeMdCell(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function escapeHtml(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ============================================================================
 * 1. Markdown Data Dictionary Exporter
 * ============================================================================ */

export function exportDataDictionaryMarkdown(input: DataDictionaryInput): string {
  const ts = input.generatedAt || new Date().toISOString();
  const lines: string[] = [];

  lines.push(`# Data Dictionary: ${input.projectName}`);
  lines.push('');
  lines.push(`- **Database**: \`${input.database}\``);
  if (input.schema) lines.push(`- **Schema**: \`${input.schema}\``);
  if (input.engine) lines.push(`- **Engine**: \`${input.engine}\``);
  lines.push(`- **Tables**: ${input.tables.length}`);
  if (input.views?.length) lines.push(`- **Views**: ${input.views.length}`);
  if (input.routines?.length) lines.push(`- **Routines**: ${input.routines.length}`);
  lines.push(`- **Generated**: ${ts}`);
  lines.push('');

  if (input.tables.length > 0) {
    lines.push('## Table of Contents');
    lines.push('');
    for (const tbl of input.tables) {
      const anchor = tbl.table.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
      const note = tbl.comment ? ` — ${escapeMdCell(tbl.comment)}` : '';
      lines.push(`- [\`${tbl.table}\`](#${anchor})${note}`);
    }
    lines.push('');
  }

  for (const tbl of input.tables) {
    lines.push(`## ${tbl.table}`);
    lines.push('');
    if (tbl.comment) {
      lines.push(`> ${tbl.comment.trim()}`);
      lines.push('');
    }
    const metaParts: string[] = [];
    if (tbl.engine) metaParts.push(`Engine: \`${tbl.engine}\``);
    if (tbl.charset) metaParts.push(`Charset: \`${tbl.charset}\``);
    if (tbl.rowCountEstimate !== undefined) metaParts.push(`Est. Rows: \`${tbl.rowCountEstimate}\``);
    if (metaParts.length > 0) {
      lines.push(metaParts.join(' · '));
      lines.push('');
    }

    lines.push('| Column | Type | Nullable | Keys | Default | Comment |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const col of tbl.columns) {
      const keys: string[] = [];
      if (col.isPrimaryKey) keys.push('PK');
      if (col.isForeignKey) keys.push('FK');
      if (col.unique) keys.push('UQ');
      if (col.isAutoIncrement) keys.push('AI');
      lines.push(
        `| \`${escapeMdCell(col.name)}\` | \`${escapeMdCell(col.dataType)}\` | ${col.nullable ? 'YES' : 'NO'} | ${keys.join(', ')} | ${col.defaultValue !== null ? `\`${escapeMdCell(col.defaultValue)}\`` : ''} | ${escapeMdCell(col.comment)} |`,
      );
    }
    lines.push('');

    if (tbl.indexes.length > 0) {
      lines.push('### Indexes');
      lines.push('');
      lines.push('| Name | Columns | Unique | Primary | Type |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const idx of tbl.indexes) {
        lines.push(
          `| \`${escapeMdCell(idx.name)}\` | ${idx.columns.map((c) => `\`${escapeMdCell(c)}\``).join(', ')} | ${idx.unique ? 'YES' : 'NO'} | ${idx.primary ? 'YES' : 'NO'} | ${escapeMdCell(idx.type)} |`,
        );
      }
      lines.push('');
    }

    if (tbl.foreignKeys.length > 0) {
      lines.push('### Foreign Keys');
      lines.push('');
      lines.push('| Constraint | Columns | References | On Delete | On Update |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const fk of tbl.foreignKeys) {
        const ref = `${fk.referencedSchema ? `${fk.referencedSchema}.` : ''}${fk.referencedTable}(${fk.referencedColumns.join(', ')})`;
        lines.push(
          `| \`${escapeMdCell(fk.name)}\` | ${fk.columns.map((c) => `\`${escapeMdCell(c)}\``).join(', ')} | \`${escapeMdCell(ref)}\` | ${escapeMdCell(fk.onDelete)} | ${escapeMdCell(fk.onUpdate)} |`,
        );
      }
      lines.push('');
    }

    if (tbl.checkConstraints.length > 0) {
      lines.push('### Check Constraints');
      lines.push('');
      for (const chk of tbl.checkConstraints) {
        lines.push(`- \`${chk.name}\`: \`${chk.expression}\``);
      }
      lines.push('');
    }
  }

  if (input.views && input.views.length > 0) {
    lines.push('## Views');
    lines.push('');
    for (const v of input.views) {
      lines.push(`- **\`${v.name}\`**${v.isMaterialized ? ' (Materialized)' : ''}${v.comment ? ` — ${escapeMdCell(v.comment)}` : ''}`);
    }
    lines.push('');
  }

  if (input.routines && input.routines.length > 0) {
    lines.push('## Routines');
    lines.push('');
    for (const r of input.routines) {
      lines.push(`- **\`${r.name}\`** (${r.kind}${r.returnType ? ` -> ${r.returnType}` : ''})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/* ============================================================================
 * 2. Standalone HTML Data Dictionary Exporter
 * ============================================================================ */

export function exportDataDictionaryHtml(input: DataDictionaryInput): string {
  const ts = input.generatedAt || new Date().toISOString();
  const navItems = input.tables
    .map(
      (tbl) =>
        `<a class="nav-item" href="#tbl-${escapeHtml(tbl.table)}" data-search="${escapeHtml(tbl.table.toLowerCase())}">${escapeHtml(tbl.table)}<span class="nav-count">${tbl.columns.length}</span></a>`,
    )
    .join('\n');

  const tableSections = input.tables
    .map((tbl) => {
      const colRows = tbl.columns
        .map((col) => {
          const badges: string[] = [];
          if (col.isPrimaryKey) badges.push('<span class="badge pk">PK</span>');
          if (col.isForeignKey) badges.push('<span class="badge fk">FK</span>');
          if (col.unique) badges.push('<span class="badge uq">UQ</span>');
          if (col.isAutoIncrement) badges.push('<span class="badge ai">AI</span>');
          return `<tr>
            <td class="mono"><strong>${escapeHtml(col.name)}</strong> ${badges.join(' ')}</td>
            <td class="mono muted">${escapeHtml(col.dataType)}</td>
            <td>${col.nullable ? 'NULL' : '<strong>NOT NULL</strong>'}</td>
            <td class="mono">${col.defaultValue !== null ? escapeHtml(col.defaultValue) : ''}</td>
            <td>${escapeHtml(col.comment)}</td>
          </tr>`;
        })
        .join('\n');

      const fkBlock =
        tbl.foreignKeys.length > 0
          ? `<div class="sub-block"><h3>Foreign Keys</h3><ul>${tbl.foreignKeys
              .map(
                (fk) =>
                  `<li class="mono">${escapeHtml(fk.name)}: (${escapeHtml(fk.columns.join(', '))}) -> ${escapeHtml(fk.referencedTable)}(${escapeHtml(fk.referencedColumns.join(', '))})</li>`,
              )
              .join('')}</ul></div>`
          : '';

      const idxBlock =
        tbl.indexes.length > 0
          ? `<div class="sub-block"><h3>Indexes</h3><ul>${tbl.indexes
              .map(
                (idx) =>
                  `<li class="mono">${escapeHtml(idx.name)} (${escapeHtml(idx.columns.join(', '))})${idx.unique ? ' [UNIQUE]' : ''}</li>`,
              )
              .join('')}</ul></div>`
          : '';

      return `<section class="table-card" id="tbl-${escapeHtml(tbl.table)}" data-table="${escapeHtml(tbl.table.toLowerCase())}">
        <div class="table-head">
          <h2>${escapeHtml(tbl.table)}</h2>
          <span class="muted mono">${tbl.columns.length} columns${tbl.rowCountEstimate !== undefined ? ` · ~${tbl.rowCountEstimate} rows` : ''}</span>
        </div>
        ${tbl.comment ? `<p class="table-note">${escapeHtml(tbl.comment)}</p>` : ''}
        <table>
          <thead><tr><th>Column</th><th>Type</th><th>Nullability</th><th>Default</th><th>Comment</th></tr></thead>
          <tbody>${colRows}</tbody>
        </table>
        ${idxBlock}
        ${fkBlock}
      </section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.projectName)} — Data Dictionary</title>
<style>
  :root { --bg:#fafafa; --surface:#ffffff; --fg:#18181b; --muted:#71717a; --border:#e4e4e7; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#09090b; --surface:#111113; --fg:#f4f4f5; --muted:#a1a1aa; --border:#27272a; --accent:#60a5fa; }
  }
  * { box-sizing:border-box; }
  body { margin:0; font-family:system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--fg); display:flex; min-height:100vh; font-size:13px; }
  aside { width:260px; flex-shrink:0; border-right:1px solid var(--border); padding:16px; position:sticky; top:0; height:100vh; overflow:auto; background:var(--surface); }
  main { flex:1; padding:24px 32px; max-width:1100px; }
  h1 { font-size:18px; margin:0 0 6px; }
  h2 { font-size:15px; margin:0; }
  h3 { font-size:12px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); margin:12px 0 6px; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .muted { color:var(--muted); }
  input.filter { width:100%; padding:7px 10px; margin:12px 0; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--fg); }
  .nav-item { display:flex; justify-content:space-between; padding:6px 8px; border-radius:5px; text-decoration:none; color:var(--fg); font-family:ui-monospace,monospace; font-size:12px; }
  .nav-item:hover { background:var(--bg); }
  .nav-count { color:var(--muted); }
  .table-card { background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:16px; margin-bottom:20px; }
  .table-head { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:10px; }
  .table-note { margin:0 0 12px; color:var(--muted); }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--border); vertical-align:top; }
  th { font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }
  .badge { display:inline-block; padding:1px 5px; border-radius:4px; font-size:10px; font-weight:600; background:rgba(37,99,235,0.12); color:var(--accent); }
  .badge.fk { background:rgba(16,185,129,0.12); color:#10b981; }
  .sub-block ul { margin:0; padding-left:18px; line-height:1.6; }
</style>
</head>
<body>
<aside>
  <h1>${escapeHtml(input.projectName)}</h1>
  <div class="muted mono">${escapeHtml(input.database)}${input.schema ? `.${escapeHtml(input.schema)}` : ''}</div>
  <input class="filter" id="filter" placeholder="Filter tables..." />
  <nav id="nav">${navItems}</nav>
</aside>
<main>
  <p class="muted">Generated ${escapeHtml(ts)} · ${input.tables.length} tables</p>
  ${tableSections}
</main>
<script>
  const input = document.getElementById('filter');
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    document.querySelectorAll('.nav-item').forEach((el) => {
      el.style.display = !q || el.dataset.search.includes(q) ? 'flex' : 'none';
    });
    document.querySelectorAll('.table-card').forEach((el) => {
      el.style.display = !q || el.dataset.table.includes(q) ? 'block' : 'none';
    });
  });
</script>
</body>
</html>
`;
}

/* ============================================================================
 * 3. DBML Exporter
 * ============================================================================ */

function dbmlQuoteIdent(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name;
  return `"${name.replace(/"/g, '\\"')}"`;
}

function dbmlQualify(schema: string | undefined, name: string, qualify: boolean): string {
  if (qualify && schema && schema.trim()) {
    return `${dbmlQuoteIdent(schema.trim())}.${dbmlQuoteIdent(name)}`;
  }
  return dbmlQuoteIdent(name);
}

function dbmlNote(value: string): string {
  let escaped = value.replace(/'''/g, "\\'''");
  if (escaped.endsWith("'")) {
    escaped = `${escaped.slice(0, -1)}\\'`;
  }
  return `'''${escaped}'''`;
}

function dbmlDefault(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v) return null;
  if ((v.startsWith("'") && v.endsWith("'")) || /^-?\d+(?:\.\d+)?$/.test(v) || /^(?:true|false|null)$/i.test(v)) {
    return `default: ${v}`;
  }
  return `default: \`${v.replace(/`/g, '\\`')}\``;
}

export function exportDataDictionaryDbml(input: DataDictionaryInput): string {
  const schemas = new Set(input.tables.map((t) => t.schema).filter(Boolean));
  const qualify = schemas.size > 1;
  const out: string[] = [];

  out.push(`Project ${dbmlQuoteIdent(input.projectName || input.database)} {`);
  if (input.engine) out.push(`  database_type: '${input.engine.replace(/'/g, "\\'")}'`);
  out.push(`  Note: ${dbmlNote(`Database: ${input.database}${input.schema ? ` (${input.schema})` : ''}`)}`);
  out.push('}');
  out.push('');

  const refs: string[] = [];

  for (const tbl of input.tables) {
    const tblName = dbmlQualify(tbl.schema, tbl.table, qualify);
    out.push(`Table ${tblName} {`);
    for (const col of tbl.columns) {
      const settings: string[] = [];
      if (col.isPrimaryKey) settings.push('pk');
      if (col.isAutoIncrement) settings.push('increment');
      if (!col.nullable && !col.isPrimaryKey) settings.push('not null');
      if (col.unique && !col.isPrimaryKey) settings.push('unique');
      const def = dbmlDefault(col.defaultValue);
      if (def) settings.push(def);
      if (col.comment && col.comment.trim()) {
        settings.push(`note: ${dbmlNote(col.comment.trim())}`);
      }
      const settingsStr = settings.length > 0 ? ` [${settings.join(', ')}]` : '';
      const typeStr = col.dataType.includes(' ') ? `"${col.dataType.replace(/"/g, '\\"')}"` : col.dataType;
      out.push(`  ${dbmlQuoteIdent(col.name)} ${typeStr}${settingsStr}`);
    }

    const nonPkIndexes = tbl.indexes.filter((idx) => !idx.primary && idx.columns.length > 0);
    if (nonPkIndexes.length > 0) {
      out.push('');
      out.push('  Indexes {');
      for (const idx of nonPkIndexes) {
        const cols = idx.columns.map(dbmlQuoteIdent).join(', ');
        const idxOpts = [`name: '${idx.name.replace(/'/g, "\\'")}'`];
        if (idx.unique) idxOpts.push('unique');
        out.push(`    (${cols}) [${idxOpts.join(', ')}]`);
      }
      out.push('  }');
    }

    if (tbl.comment && tbl.comment.trim()) {
      out.push('');
      out.push(`  Note: ${dbmlNote(tbl.comment.trim())}`);
    }
    out.push('}');
    out.push('');

    for (const fk of tbl.foreignKeys) {
      if (fk.columns.length === 0 || fk.referencedColumns.length === 0) continue;
      const srcCol =
        fk.columns.length === 1
          ? `${tblName}.${dbmlQuoteIdent(fk.columns[0])}`
          : `${tblName}.(${fk.columns.map(dbmlQuoteIdent).join(', ')})`;
      const refTbl = dbmlQualify(fk.referencedSchema, fk.referencedTable, qualify);
      const tgtCol =
        fk.referencedColumns.length === 1
          ? `${refTbl}.${dbmlQuoteIdent(fk.referencedColumns[0])}`
          : `${refTbl}.(${fk.referencedColumns.map(dbmlQuoteIdent).join(', ')})`;
      const actions: string[] = [];
      if (fk.onDelete) actions.push(`delete: ${fk.onDelete.toLowerCase()}`);
      if (fk.onUpdate) actions.push(`update: ${fk.onUpdate.toLowerCase()}`);
      const actionStr = actions.length > 0 ? ` [${actions.join(', ')}]` : '';
      refs.push(`Ref ${dbmlQuoteIdent(fk.name)}: ${srcCol} > ${tgtCol}${actionStr}`);
    }
  }

  if (refs.length > 0) {
    out.push(...refs);
    out.push('');
  }

  return out.join('\n');
}

/* ============================================================================
 * 4. Multi-Language Model Code Generator (7 Languages / 8 Targets)
 * ============================================================================ */

type NormalizedKind =
  | 'int'
  | 'bigint'
  | 'float'
  | 'decimal'
  | 'boolean'
  | 'string'
  | 'uuid'
  | 'date'
  | 'datetime'
  | 'time'
  | 'json'
  | 'bytes';

function normalizeSqlType(dataType: string): NormalizedKind {
  const t = dataType.toLowerCase().trim();
  if (t.includes('bool') || t === 'bit') return 'boolean';
  if (t.includes('uuid') || t.includes('uniqueidentifier')) return 'uuid';
  if (t.includes('json')) return 'json';
  if (t.includes('bytea') || t.includes('blob') || t.includes('binary') || t.includes('varbinary')) return 'bytes';
  if (t.includes('bigint') || t.includes('int8') || t.includes('bigserial')) return 'bigint';
  if (t.includes('int') || t.includes('serial') || t.includes('year')) return 'int';
  if (t.includes('dec') || t.includes('numeric') || t.includes('money')) return 'decimal';
  if (t.includes('float') || t.includes('double') || t.includes('real')) return 'float';
  if (t.includes('timestamp') || t.includes('datetime')) return 'datetime';
  if (t === 'date') return 'date';
  if (t === 'time' || t.startsWith('time(') || t.startsWith('time ')) return 'time';
  return 'string';
}

function fieldNameFor(col: ColumnStructure, style: 'camel' | 'snake' | 'pascal' | 'raw'): string {
  if (style === 'raw') return col.name;
  if (style === 'camel') return toCamelCase(col.name);
  if (style === 'pascal') return toPascalCase(col.name);
  return toSnakeCase(col.name);
}

function generateTypeScript(table: TableStructure, opts: ModelCodeOptions): string {
  const typeName = toPascalCase(table.table);
  const lines: string[] = [];
  if (opts.includeComments && table.comment) {
    lines.push(`/** ${table.comment.trim()} */`);
  }
  lines.push(`export interface ${typeName} {`);
  for (const col of table.columns) {
    if (opts.includeComments && col.comment) {
      lines.push(`  /** ${col.comment.trim()} */`);
    }
    const kind = normalizeSqlType(col.dataType);
    let tsType = 'string';
    if (kind === 'int' || kind === 'bigint' || kind === 'float' || kind === 'decimal') tsType = 'number';
    else if (kind === 'boolean') tsType = 'boolean';
    else if (kind === 'json') tsType = 'Record<string, unknown>';
    else if (kind === 'bytes') tsType = 'Uint8Array';
    const prop = opts.camelCaseFields ? toCamelCase(col.name) : col.name;
    const safeProp = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(prop) ? prop : JSON.stringify(prop);
    lines.push(`  ${safeProp}: ${tsType}${col.nullable ? ' | null' : ''};`);
  }
  lines.push('}');
  return lines.join('\n');
}

function generateZod(table: TableStructure, opts: ModelCodeOptions): string {
  const typeName = toPascalCase(table.table);
  const schemaName = `${typeName}Schema`;
  const lines: string[] = ["import { z } from 'zod';", ''];
  lines.push(`export const ${schemaName} = z.object({`);
  for (const col of table.columns) {
    const kind = normalizeSqlType(col.dataType);
    let expr = 'z.string()';
    if (kind === 'int' || kind === 'bigint') expr = 'z.number().int()';
    else if (kind === 'float' || kind === 'decimal') expr = 'z.number()';
    else if (kind === 'boolean') expr = 'z.boolean()';
    else if (kind === 'uuid') expr = 'z.string().uuid()';
    else if (kind === 'datetime') expr = 'z.string().datetime()';
    else if (kind === 'json') expr = 'z.record(z.string(), z.unknown())';
    else if (kind === 'bytes') expr = 'z.instanceof(Uint8Array)';
    if (col.nullable) expr += '.nullable()';
    const prop = opts.camelCaseFields ? toCamelCase(col.name) : col.name;
    const safeProp = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(prop) ? prop : JSON.stringify(prop);
    lines.push(`  ${safeProp}: ${expr},`);
  }
  lines.push('});');
  lines.push('');
  lines.push(`export type ${typeName} = z.infer<typeof ${schemaName}>;`);
  return lines.join('\n');
}

function generatePrisma(table: TableStructure, opts: ModelCodeOptions): string {
  const modelName = toPascalCase(table.table);
  const lines: string[] = [];
  if (opts.includeComments && table.comment) {
    lines.push(`/// ${table.comment.trim()}`);
  }
  lines.push(`model ${modelName} {`);
  for (const col of table.columns) {
    const kind = normalizeSqlType(col.dataType);
    let pType = 'String';
    if (kind === 'int') pType = 'Int';
    else if (kind === 'bigint') pType = 'BigInt';
    else if (kind === 'float') pType = 'Float';
    else if (kind === 'decimal') pType = 'Decimal';
    else if (kind === 'boolean') pType = 'Boolean';
    else if (kind === 'datetime' || kind === 'date') pType = 'DateTime';
    else if (kind === 'json') pType = 'Json';
    else if (kind === 'bytes') pType = 'Bytes';

    const prop = opts.camelCaseFields ? toCamelCase(col.name) : col.name;
    const attrs: string[] = [];
    if (col.isPrimaryKey && table.columns.filter((c) => c.isPrimaryKey).length === 1) {
      attrs.push('@id');
    }
    if (col.isAutoIncrement) attrs.push('@default(autoincrement())');
    else if (kind === 'uuid' && col.isPrimaryKey) attrs.push('@default(uuid())');
    if (col.unique && !col.isPrimaryKey) attrs.push('@unique');
    if (prop !== col.name) attrs.push(`@map("${col.name}")`);
    const nullMark = col.nullable ? '?' : '';
    lines.push(`  ${prop} ${pType}${nullMark}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}`);
  }
  const pks = table.columns.filter((c) => c.isPrimaryKey);
  if (pks.length > 1) {
    lines.push('');
    lines.push(`  @@id([${pks.map((c) => (opts.camelCaseFields ? toCamelCase(c.name) : c.name)).join(', ')}])`);
  }
  if (modelName !== table.table) {
    lines.push(`  @@map("${table.table}")`);
  }
  lines.push('}');
  return lines.join('\n');
}

function generateGo(table: TableStructure, opts: ModelCodeOptions): string {
  const structName = toPascalCase(table.table);
  const pkg = opts.packageName?.trim() || 'models';
  const needsTime = table.columns.some((c) => {
    const k = normalizeSqlType(c.dataType);
    return k === 'date' || k === 'datetime';
  });
  const lines: string[] = [`package ${pkg}`, ''];
  if (needsTime) {
    lines.push('import "time"', '');
  }
  if (opts.includeComments && table.comment) {
    lines.push(`// ${structName}: ${table.comment.trim()}`);
  }
  lines.push(`type ${structName} struct {`);
  for (const col of table.columns) {
    const kind = normalizeSqlType(col.dataType);
    let goType = 'string';
    if (kind === 'int') goType = 'int32';
    else if (kind === 'bigint') goType = 'int64';
    else if (kind === 'float' || kind === 'decimal') goType = 'float64';
    else if (kind === 'boolean') goType = 'bool';
    else if (kind === 'date' || kind === 'datetime') goType = 'time.Time';
    else if (kind === 'json') goType = 'map[string]any';
    else if (kind === 'bytes') goType = '[]byte';
    if (col.nullable && goType !== '[]byte' && goType !== 'map[string]any') {
      goType = `*${goType}`;
    }
    const field = fieldNameFor(col, 'pascal');
    const jsonName = opts.camelCaseFields ? toCamelCase(col.name) : col.name;
    lines.push(`\t${field} ${goType} \`json:"${jsonName}" db:"${col.name}"\``);
  }
  lines.push('}');
  return lines.join('\n');
}

function generateRust(table: TableStructure, opts: ModelCodeOptions): string {
  const structName = toPascalCase(table.table);
  const lines: string[] = ['use serde::{Deserialize, Serialize};', ''];
  if (opts.includeComments && table.comment) {
    lines.push(`/// ${table.comment.trim()}`);
  }
  lines.push('#[derive(Debug, Clone, Serialize, Deserialize)]');
  lines.push(`pub struct ${structName} {`);
  for (const col of table.columns) {
    const kind = normalizeSqlType(col.dataType);
    let rsType = 'String';
    if (kind === 'int') rsType = 'i32';
    else if (kind === 'bigint') rsType = 'i64';
    else if (kind === 'float' || kind === 'decimal') rsType = 'f64';
    else if (kind === 'boolean') rsType = 'bool';
    else if (kind === 'json') rsType = 'serde_json::Value';
    else if (kind === 'bytes') rsType = 'Vec<u8>';
    if (col.nullable) rsType = `Option<${rsType}>`;
    const field = fieldNameFor(col, 'snake');
    if (field !== col.name) {
      lines.push(`    #[serde(rename = "${col.name}")]`);
    }
    lines.push(`    pub ${field}: ${rsType},`);
  }
  lines.push('}');
  return lines.join('\n');
}

function generatePythonDataclass(table: TableStructure, opts: ModelCodeOptions): string {
  const clsName = toPascalCase(table.table);
  const imports = new Set<string>(['from dataclasses import dataclass']);
  const typingImports = new Set<string>();
  const dtImports = new Set<string>();
  let needsDecimal = false;

  for (const col of table.columns) {
    const kind = normalizeSqlType(col.dataType);
    if (col.nullable) typingImports.add('Optional');
    if (kind === 'json') typingImports.add('Any');
    if (kind === 'datetime') dtImports.add('datetime');
    if (kind === 'date') dtImports.add('date');
    if (kind === 'time') dtImports.add('time');
    if (kind === 'decimal') needsDecimal = true;
  }

  const lines: string[] = [...imports];
  if (dtImports.size > 0) lines.push(`from datetime import ${[...dtImports].sort().join(', ')}`);
  if (needsDecimal) lines.push('from decimal import Decimal');
  if (typingImports.size > 0) lines.push(`from typing import ${[...typingImports].sort().join(', ')}`);
  lines.push('', '@dataclass', `class ${clsName}:`);
  if (opts.includeComments && table.comment) {
    lines.push(`    """${table.comment.trim()}"""`);
  }
  for (const col of table.columns) {
    const kind = normalizeSqlType(col.dataType);
    let pyType = 'str';
    if (kind === 'int' || kind === 'bigint') pyType = 'int';
    else if (kind === 'float') pyType = 'float';
    else if (kind === 'decimal') pyType = 'Decimal';
    else if (kind === 'boolean') pyType = 'bool';
    else if (kind === 'datetime') pyType = 'datetime';
    else if (kind === 'date') pyType = 'date';
    else if (kind === 'time') pyType = 'time';
    else if (kind === 'json') pyType = 'dict[str, Any]';
    else if (kind === 'bytes') pyType = 'bytes';
    const field = fieldNameFor(col, 'snake');
    if (col.nullable) {
      lines.push(`    ${field}: Optional[${pyType}] = None`);
    } else {
      lines.push(`    ${field}: ${pyType}`);
    }
  }
  return lines.join('\n');
}

function generatePythonSqlAlchemy(table: TableStructure, opts: ModelCodeOptions): string {
  const clsName = toPascalCase(table.table);
  const lines: string[] = [
    'from typing import Optional',
    'from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column',
    '',
    'class Base(DeclarativeBase):',
    '    pass',
    '',
    `class ${clsName}(Base):`,
    `    __tablename__ = "${table.table}"`,
  ];
  if (opts.includeComments && table.comment) {
    lines.push(`    """${table.comment.trim()}"""`);
  }
  lines.push('');
  for (const col of table.columns) {
    const kind = normalizeSqlType(col.dataType);
    let pyType = 'str';
    if (kind === 'int' || kind === 'bigint') pyType = 'int';
    else if (kind === 'float' || kind === 'decimal') pyType = 'float';
    else if (kind === 'boolean') pyType = 'bool';
    else if (kind === 'bytes') pyType = 'bytes';
    const mappedType = col.nullable ? `Optional[${pyType}]` : pyType;
    const args: string[] = [];
    const field = fieldNameFor(col, 'snake');
    if (field !== col.name) args.push(`"${col.name}"`);
    if (col.isPrimaryKey) args.push('primary_key=True');
    if (col.isAutoIncrement) args.push('autoincrement=True');
    if (col.unique && !col.isPrimaryKey) args.push('unique=True');
    args.push(`nullable=${col.nullable ? 'True' : 'False'}`);
    lines.push(`    ${field}: Mapped[${mappedType}] = mapped_column(${args.join(', ')})`);
  }
  return lines.join('\n');
}

function generateJava(table: TableStructure, opts: ModelCodeOptions): string {
  const clsName = toPascalCase(table.table);
  const pkg = opts.packageName?.trim() || 'com.example.model';
  const imports = new Set<string>();
  for (const col of table.columns) {
    const kind = normalizeSqlType(col.dataType);
    if (kind === 'decimal') imports.add('import java.math.BigDecimal;');
    if (kind === 'date') imports.add('import java.time.LocalDate;');
    if (kind === 'datetime') imports.add('import java.time.LocalDateTime;');
    if (kind === 'time') imports.add('import java.time.LocalTime;');
    if (kind === 'uuid') imports.add('import java.util.UUID;');
  }

  const lines: string[] = [`package ${pkg};`, ''];
  if (imports.size > 0) {
    lines.push(...[...imports].sort(), '');
  }
  if (opts.includeComments && table.comment) {
    lines.push(`/** ${table.comment.trim()} */`);
  }
  lines.push(`public class ${clsName} {`);

  const fields: Array<{ name: string; pascal: string; type: string }> = [];
  for (const col of table.columns) {
    const kind = normalizeSqlType(col.dataType);
    let jType = 'String';
    if (kind === 'int') jType = col.nullable ? 'Integer' : 'int';
    else if (kind === 'bigint') jType = col.nullable ? 'Long' : 'long';
    else if (kind === 'float') jType = col.nullable ? 'Double' : 'double';
    else if (kind === 'decimal') jType = 'BigDecimal';
    else if (kind === 'boolean') jType = col.nullable ? 'Boolean' : 'boolean';
    else if (kind === 'date') jType = 'LocalDate';
    else if (kind === 'datetime') jType = 'LocalDateTime';
    else if (kind === 'time') jType = 'LocalTime';
    else if (kind === 'uuid') jType = 'UUID';
    else if (kind === 'bytes') jType = 'byte[]';

    const name = toCamelCase(col.name);
    const pascal = toPascalCase(col.name);
    fields.push({ name, pascal, type: jType });
    lines.push(`    private ${jType} ${name};`);
  }

  lines.push('');
  for (const f of fields) {
    lines.push(`    public ${f.type} get${f.pascal}() { return this.${f.name}; }`);
    lines.push(`    public void set${f.pascal}(${f.type} ${f.name}) { this.${f.name} = ${f.name}; }`);
  }
  lines.push('}');
  return lines.join('\n');
}

export function generateModelCode(
  table: TableStructure,
  format: ModelCodeFormat,
  options: ModelCodeOptions = {},
): GeneratedModelCode {
  const meta = MODEL_CODE_FORMATS.find((f) => f.id === format) ?? MODEL_CODE_FORMATS[0];
  const baseName = format === 'rust' || format.startsWith('python') ? toSnakeCase(table.table) : toPascalCase(table.table);

  let code: string;
  switch (format) {
    case 'typescript':
      code = generateTypeScript(table, options);
      break;
    case 'zod':
      code = generateZod(table, options);
      break;
    case 'prisma':
      code = generatePrisma(table, options);
      break;
    case 'go':
      code = generateGo(table, options);
      break;
    case 'rust':
      code = generateRust(table, options);
      break;
    case 'python-dataclass':
      code = generatePythonDataclass(table, options);
      break;
    case 'python-sqlalchemy':
      code = generatePythonSqlAlchemy(table, options);
      break;
    case 'java':
      code = generateJava(table, options);
      break;
  }

  return {
    format,
    fileName: `${baseName}.${meta.extension}`,
    extension: meta.extension,
    code,
  };
}

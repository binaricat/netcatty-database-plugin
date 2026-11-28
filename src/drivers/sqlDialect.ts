/**
 * Dialect-aware SQL quoting, DDL generation, and batch mutation SQL builder.
 * Pure TypeScript — shared across PostgreSQL, MySQL/MariaDB, SQLite, and ClickHouse.
 */

import type {
  BatchMutationChanges,
  BatchMutationPreview,
  CellValue,
  CreateColumnSpec,
  CreateTableSpec,
  DropObjectKind,
  SqlDialect,
  TableStructure,
  TableStructureDiff,
} from './types';

export function quoteIdent(name: string, dialect: SqlDialect): string {
  if (dialect === 'mysql' || dialect === 'clickhouse' || dialect === 'tdengine') {
    return '`' + name.replaceAll('`', '``') + '`';
  }
  if (dialect === 'mssql') {
    return '[' + name.replaceAll(']', ']]') + ']';
  }
  return '"' + name.replaceAll('"', '""') + '"';
}

export function qualifiedTableName(
  db: string,
  schema: string,
  table: string,
  dialect: SqlDialect,
): string {
  if (dialect === 'mysql' || dialect === 'clickhouse' || dialect === 'tdengine') {
    const dbPart = db || schema;
    return dbPart ? `${quoteIdent(dbPart, dialect)}.${quoteIdent(table, dialect)}` : quoteIdent(table, dialect);
  }
  if (dialect === 'sqlite' || dialect === 'influx') {
    return schema && schema !== 'main'
      ? `${quoteIdent(schema, dialect)}.${quoteIdent(table, dialect)}`
      : quoteIdent(table, dialect);
  }
  if (dialect === 'mssql') {
    const s = schema || 'dbo';
    return db
      ? `${quoteIdent(db, dialect)}.${quoteIdent(s, dialect)}.${quoteIdent(table, dialect)}`
      : `${quoteIdent(s, dialect)}.${quoteIdent(table, dialect)}`;
  }
  if (dialect === 'trino') {
    if (db && schema) return `${quoteIdent(db, dialect)}.${quoteIdent(schema, dialect)}.${quoteIdent(table, dialect)}`;
    return schema ? `${quoteIdent(schema, dialect)}.${quoteIdent(table, dialect)}` : quoteIdent(table, dialect);
  }
  // PostgreSQL
  return schema ? `${quoteIdent(schema, dialect)}.${quoteIdent(table, dialect)}` : quoteIdent(table, dialect);
}

export function quoteSqlLiteral(value: CellValue, dialect: SqlDialect): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') {
    if (dialect === 'sqlite' || dialect === 'mssql') return value ? '1' : '0';
    return value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'NULL';
    return String(value);
  }
  if (value instanceof Uint8Array) {
    const hex = Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('');
    if (dialect === 'postgres') return `'\\x${hex}'::bytea`;
    if (dialect === 'clickhouse') return `unhex('${hex}')`;
    if (dialect === 'mssql') return `0x${hex}`;
    return `X'${hex}'`;
  }
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    return quoteString(json, dialect);
  }
  return quoteString(String(value), dialect);
}

function quoteString(text: string, dialect: SqlDialect): string {
  if (dialect === 'mysql' || dialect === 'clickhouse') {
    return (
      "'" +
      text
        .replaceAll('\\', '\\\\')
        .replaceAll("'", "\\'")
        .replaceAll('\0', '\\0')
        .replaceAll('\n', '\\n')
        .replaceAll('\r', '\\r') +
      "'"
    );
  }
  return "'" + text.replaceAll("'", "''") + "'";
}

function buildWhereClause(
  keyValues: Record<string, CellValue>,
  dialect: SqlDialect,
): string {
  const entries = Object.entries(keyValues);
  if (entries.length === 0) {
    throw new Error('Cannot generate row mutation without key column values');
  }
  return entries
    .map(([col, val]) => {
      const qCol = quoteIdent(col, dialect);
      if (val === null || val === undefined) return `${qCol} IS NULL`;
      return `${qCol} = ${quoteSqlLiteral(val, dialect)}`;
    })
    .join(' AND ');
}

export function buildBatchMutations(
  dialect: SqlDialect,
  db: string,
  schema: string,
  table: string,
  structure: TableStructure,
  changes: BatchMutationChanges,
): BatchMutationPreview {
  const qTable = qualifiedTableName(db, schema, table, dialect);
  const validCols = new Set(structure.columns.map((c) => c.name));
  const pkCols = structure.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
  const statements: string[] = [];

  const inserts = changes.inserts ?? [];
  const updates = changes.updates ?? [];
  const deletes = changes.deletes ?? [];

  for (const ins of inserts) {
    const entries = Object.entries(ins.values).filter(([k]) => validCols.size === 0 || validCols.has(k));
    if (entries.length === 0) continue;
    const cols = entries.map(([k]) => quoteIdent(k, dialect)).join(', ');
    const vals = entries.map(([, v]) => quoteSqlLiteral(v, dialect)).join(', ');
    statements.push(`INSERT INTO ${qTable} (${cols}) VALUES (${vals});`);
  }

  for (const upd of updates) {
    const setEntries = Object.entries(upd.changes).filter(([k]) => validCols.size === 0 || validCols.has(k));
    if (setEntries.length === 0) continue;
    const keyEntries: Record<string, CellValue> = {};
    if (pkCols.length > 0 && pkCols.every((pk) => Object.prototype.hasOwnProperty.call(upd.keyValues, pk))) {
      for (const pk of pkCols) keyEntries[pk] = upd.keyValues[pk];
    } else {
      Object.assign(keyEntries, upd.keyValues);
    }
    const setSql = setEntries
      .map(([k, v]) => `${quoteIdent(k, dialect)} = ${quoteSqlLiteral(v, dialect)}`)
      .join(', ');
    const whereSql = buildWhereClause(keyEntries, dialect);
    if (dialect === 'clickhouse') {
      statements.push(`ALTER TABLE ${qTable} UPDATE ${setSql} WHERE ${whereSql};`);
    } else {
      statements.push(`UPDATE ${qTable} SET ${setSql} WHERE ${whereSql};`);
    }
  }

  for (const del of deletes) {
    const keyEntries: Record<string, CellValue> = {};
    if (pkCols.length > 0 && pkCols.every((pk) => Object.prototype.hasOwnProperty.call(del.keyValues, pk))) {
      for (const pk of pkCols) keyEntries[pk] = del.keyValues[pk];
    } else {
      Object.assign(keyEntries, del.keyValues);
    }
    const whereSql = buildWhereClause(keyEntries, dialect);
    if (dialect === 'clickhouse') {
      statements.push(`ALTER TABLE ${qTable} DELETE WHERE ${whereSql};`);
    } else {
      statements.push(`DELETE FROM ${qTable} WHERE ${whereSql};`);
    }
  }

  return {
    dialect,
    statements,
    sql: statements.join('\n'),
    insertCount: inserts.length,
    updateCount: updates.length,
    deleteCount: deletes.length,
  };
}

function formatColumnDef(col: CreateColumnSpec, dialect: SqlDialect, inlinePk: boolean): string {
  const parts: string[] = [quoteIdent(col.name, dialect)];
  let dataType = col.dataType;
  if (col.isAutoIncrement) {
    if (dialect === 'postgres') {
      const upper = dataType.toUpperCase();
      if (upper === 'BIGINT' || upper === 'INT8') dataType = 'BIGSERIAL';
      else if (upper === 'SMALLINT' || upper === 'INT2') dataType = 'SMALLSERIAL';
      else if (!upper.includes('SERIAL')) dataType = 'SERIAL';
    } else if (dialect === 'sqlite') {
      dataType = 'INTEGER';
    }
  }
  parts.push(dataType);

  if (inlinePk) {
    parts.push('PRIMARY KEY');
    if (col.isAutoIncrement && dialect === 'sqlite') {
      parts.push('AUTOINCREMENT');
    }
  }
  if (col.isAutoIncrement && dialect === 'mysql') {
    parts.push('AUTO_INCREMENT');
  }
  if (col.isAutoIncrement && dialect === 'mssql') {
    parts.push('IDENTITY(1,1)');
  }
  if (col.nullable === false && !inlinePk) {
    parts.push('NOT NULL');
  }
  if (col.unique && !inlinePk) {
    parts.push('UNIQUE');
  }
  if (col.defaultValue !== undefined && col.defaultValue !== null && col.defaultValue !== '') {
    parts.push(`DEFAULT ${col.defaultValue}`);
  }
  if (col.comment && dialect === 'mysql') {
    parts.push(`COMMENT ${quoteString(col.comment, dialect)}`);
  }
  return parts.join(' ');
}

export function buildCreateTableDdl(
  dialect: SqlDialect,
  db: string,
  schema: string,
  spec: CreateTableSpec,
): string {
  const qTable = qualifiedTableName(db, schema, spec.name, dialect);
  const explicitPk = spec.primaryKey?.length
    ? spec.primaryKey
    : spec.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
  const useInlinePk = explicitPk.length === 1;

  const lines: string[] = [];
  for (const col of spec.columns) {
    const inlinePk = useInlinePk && explicitPk[0] === col.name;
    lines.push(`  ${formatColumnDef(col, dialect, inlinePk)}`);
  }
  if (explicitPk.length > 1) {
    const pkCols = explicitPk.map((c) => quoteIdent(c, dialect)).join(', ');
    lines.push(`  PRIMARY KEY (${pkCols})`);
  }
  for (const fk of spec.foreignKeys ?? []) {
    const fkCols = fk.columns.map((c) => quoteIdent(c, dialect)).join(', ');
    const refTable = qualifiedTableName(db, fk.referencedSchema ?? schema, fk.referencedTable, dialect);
    const refCols = fk.referencedColumns.map((c) => quoteIdent(c, dialect)).join(', ');
    const constraintPrefix = fk.name ? `CONSTRAINT ${quoteIdent(fk.name, dialect)} ` : '';
    let fkLine = `  ${constraintPrefix}FOREIGN KEY (${fkCols}) REFERENCES ${refTable} (${refCols})`;
    if (fk.onDelete) fkLine += ` ON DELETE ${fk.onDelete}`;
    if (fk.onUpdate) fkLine += ` ON UPDATE ${fk.onUpdate}`;
    lines.push(fkLine);
  }

  const ifNotExists = spec.ifNotExists ? 'IF NOT EXISTS ' : '';
  let suffix = '';
  if (dialect === 'clickhouse') {
    const orderKey = explicitPk.length > 0 ? explicitPk.map((c) => quoteIdent(c, dialect)).join(', ') : 'tuple()';
    suffix = ` ENGINE = MergeTree() ORDER BY (${orderKey})`;
  } else if (dialect === 'mysql' && spec.comment) {
    suffix = ` COMMENT=${quoteString(spec.comment, dialect)}`;
  }

  return `CREATE TABLE ${ifNotExists}${qTable} (\n${lines.join(',\n')}\n)${suffix};`;
}

export function buildAlterTableDdl(
  dialect: SqlDialect,
  db: string,
  schema: string,
  table: string,
  diff: TableStructureDiff,
): string[] {
  const stmts: string[] = [];
  let currentTable = table;
  const qCurrent = () => qualifiedTableName(db, schema, currentTable, dialect);

  if (diff.renameTableTo && diff.renameTableTo !== table) {
    if (dialect === 'mysql') {
      stmts.push(`RENAME TABLE ${qCurrent()} TO ${qualifiedTableName(db, schema, diff.renameTableTo, dialect)};`);
    } else {
      stmts.push(`ALTER TABLE ${qCurrent()} RENAME TO ${quoteIdent(diff.renameTableTo, dialect)};`);
    }
    currentTable = diff.renameTableTo;
  }

  for (const col of diff.addColumns ?? []) {
    stmts.push(`ALTER TABLE ${qCurrent()} ADD COLUMN ${formatColumnDef(col, dialect, false)};`);
    if (col.comment && dialect === 'postgres') {
      stmts.push(
        `COMMENT ON COLUMN ${qCurrent()}.${quoteIdent(col.name, dialect)} IS ${quoteString(col.comment, dialect)};`,
      );
    }
  }

  for (const ren of diff.renameColumns ?? []) {
    stmts.push(
      `ALTER TABLE ${qCurrent()} RENAME COLUMN ${quoteIdent(ren.from, dialect)} TO ${quoteIdent(ren.to, dialect)};`,
    );
  }

  for (const alt of diff.alterColumns ?? []) {
    const qCol = quoteIdent(alt.name, dialect);
    if (dialect === 'postgres') {
      if (alt.dataType) {
        stmts.push(`ALTER TABLE ${qCurrent()} ALTER COLUMN ${qCol} TYPE ${alt.dataType};`);
      }
      if (alt.nullable === false) {
        stmts.push(`ALTER TABLE ${qCurrent()} ALTER COLUMN ${qCol} SET NOT NULL;`);
      } else if (alt.nullable === true) {
        stmts.push(`ALTER TABLE ${qCurrent()} ALTER COLUMN ${qCol} DROP NOT NULL;`);
      }
      if (alt.defaultValue !== undefined) {
        if (alt.defaultValue === null || alt.defaultValue === '') {
          stmts.push(`ALTER TABLE ${qCurrent()} ALTER COLUMN ${qCol} DROP DEFAULT;`);
        } else {
          stmts.push(`ALTER TABLE ${qCurrent()} ALTER COLUMN ${qCol} SET DEFAULT ${alt.defaultValue};`);
        }
      }
      if (alt.unique === true) {
        const uqName = quoteIdent(`uq_${currentTable}_${alt.name}`, dialect);
        stmts.push(`ALTER TABLE ${qCurrent()} ADD CONSTRAINT ${uqName} UNIQUE (${qCol});`);
      }
      if (alt.comment !== undefined) {
        stmts.push(`COMMENT ON COLUMN ${qCurrent()}.${qCol} IS ${quoteString(alt.comment, dialect)};`);
      }
    } else if (dialect === 'mysql') {
      const colDef = formatColumnDef(
        {
          name: alt.name,
          dataType: alt.dataType ?? 'VARCHAR(255)',
          nullable: alt.nullable,
          defaultValue: alt.defaultValue,
          unique: alt.unique,
          isAutoIncrement: alt.isAutoIncrement,
          comment: alt.comment,
        },
        dialect,
        false,
      );
      stmts.push(`ALTER TABLE ${qCurrent()} MODIFY COLUMN ${colDef};`);
    } else if (dialect === 'clickhouse') {
      if (alt.dataType) {
        stmts.push(`ALTER TABLE ${qCurrent()} MODIFY COLUMN ${qCol} ${alt.dataType};`);
      }
      if (alt.comment !== undefined) {
        stmts.push(`ALTER TABLE ${qCurrent()} COMMENT COLUMN ${qCol} ${quoteString(alt.comment, dialect)};`);
      }
    }
  }

  for (const colName of diff.dropColumns ?? []) {
    stmts.push(`ALTER TABLE ${qCurrent()} DROP COLUMN ${quoteIdent(colName, dialect)};`);
  }

  for (const fkName of diff.dropForeignKeys ?? []) {
    if (dialect === 'mysql') {
      stmts.push(`ALTER TABLE ${qCurrent()} DROP FOREIGN KEY ${quoteIdent(fkName, dialect)};`);
    } else if (dialect === 'postgres') {
      stmts.push(`ALTER TABLE ${qCurrent()} DROP CONSTRAINT IF EXISTS ${quoteIdent(fkName, dialect)};`);
    }
  }

  for (const fk of diff.addForeignKeys ?? []) {
    if (dialect === 'postgres' || dialect === 'mysql') {
      const constraintName =
        fk.name || `fk_${currentTable}_${fk.columns.join('_')}_${fk.referencedTable}`;
      const srcCols = fk.columns.map((c) => quoteIdent(c, dialect)).join(', ');
      const refTbl = qualifiedTableName(
        db,
        fk.referencedSchema ?? schema,
        fk.referencedTable,
        dialect,
      );
      const refCols = fk.referencedColumns.map((c) => quoteIdent(c, dialect)).join(', ');
      let stmt = `ALTER TABLE ${qCurrent()} ADD CONSTRAINT ${quoteIdent(constraintName, dialect)} FOREIGN KEY (${srcCols}) REFERENCES ${refTbl} (${refCols})`;
      if (fk.onDelete && fk.onDelete !== 'NO ACTION') stmt += ` ON DELETE ${fk.onDelete}`;
      if (fk.onUpdate && fk.onUpdate !== 'NO ACTION') stmt += ` ON UPDATE ${fk.onUpdate}`;
      stmts.push(`${stmt};`);
    }
  }

  for (const chkName of diff.dropCheckConstraints ?? []) {
    if (dialect === 'mysql') {
      stmts.push(`ALTER TABLE ${qCurrent()} DROP CHECK ${quoteIdent(chkName, dialect)};`);
    } else if (dialect === 'postgres') {
      stmts.push(`ALTER TABLE ${qCurrent()} DROP CONSTRAINT IF EXISTS ${quoteIdent(chkName, dialect)};`);
    }
  }

  for (const chk of diff.addCheckConstraints ?? []) {
    if (dialect === 'postgres' || dialect === 'mysql') {
      const name = chk.name || `chk_${currentTable}_${stmts.length + 1}`;
      const expr = /^\s*CHECK\s*\(/i.test(chk.expression)
        ? chk.expression.trim()
        : `CHECK (${chk.expression.trim()})`;
      stmts.push(
        `ALTER TABLE ${qCurrent()} ADD CONSTRAINT ${quoteIdent(name, dialect)} ${expr};`,
      );
    }
  }

  for (const idx of diff.addIndexes ?? []) {
    const uniqueKw = idx.unique ? 'UNIQUE ' : '';
    const cols = idx.columns.map((c) => quoteIdent(c, dialect)).join(', ');
    stmts.push(`CREATE ${uniqueKw}INDEX ${quoteIdent(idx.name, dialect)} ON ${qCurrent()} (${cols});`);
  }

  for (const idxName of diff.dropIndexes ?? []) {
    if (dialect === 'mysql') {
      stmts.push(`DROP INDEX ${quoteIdent(idxName, dialect)} ON ${qCurrent()};`);
    } else {
      const qIdx =
        dialect === 'postgres' && schema
          ? `${quoteIdent(schema, dialect)}.${quoteIdent(idxName, dialect)}`
          : quoteIdent(idxName, dialect);
      stmts.push(`DROP INDEX IF EXISTS ${qIdx};`);
    }
  }

  // Table physical options (full workbench parity: comment, storage engine, charset, collation, auto_increment)
  if (dialect === 'mysql') {
    const opts: string[] = [];
    if (diff.tableEngine) opts.push(`ENGINE = ${diff.tableEngine.replace(/[^a-zA-Z0-9_]/g, '')}`);
    if (diff.tableCharset) opts.push(`DEFAULT CHARACTER SET = ${diff.tableCharset.replace(/[^a-zA-Z0-9_]/g, '')}`);
    if (diff.tableCollation) opts.push(`COLLATE = ${diff.tableCollation.replace(/[^a-zA-Z0-9_]/g, '')}`);
    if (typeof diff.tableAutoIncrement === 'number' && Number.isFinite(diff.tableAutoIncrement)) {
      opts.push(`AUTO_INCREMENT = ${Math.max(1, Math.floor(diff.tableAutoIncrement))}`);
    }
    if (diff.tableComment !== undefined) {
      opts.push(`COMMENT = ${quoteString(diff.tableComment ?? '', dialect)}`);
    }
    if (opts.length > 0) {
      stmts.push(`ALTER TABLE ${qCurrent()} ${opts.join(' ')};`);
    }
  } else if (dialect === 'postgres') {
    if (diff.tableComment !== undefined) {
      const val = diff.tableComment === null ? 'NULL' : quoteString(diff.tableComment, dialect);
      stmts.push(`COMMENT ON TABLE ${qCurrent()} IS ${val};`);
    }
  } else if (dialect === 'clickhouse') {
    if (diff.tableComment !== undefined) {
      stmts.push(`ALTER TABLE ${qCurrent()} MODIFY COMMENT ${quoteString(diff.tableComment ?? '', dialect)};`);
    }
  }

  return stmts;
}

export function buildDropObjectSql(
  dialect: SqlDialect,
  db: string,
  schema: string,
  name: string,
  kind: DropObjectKind,
  cascade = false,
  tableName?: string,
): string {
  const qName = qualifiedTableName(db, schema, name, dialect);
  const qSimple = quoteIdent(name, dialect);
  const cascadeSql = cascade && dialect === 'postgres' ? ' CASCADE' : '';
  switch (kind) {
    case 'table':
      return `DROP TABLE IF EXISTS ${qName}${cascadeSql};`;
    case 'view':
      return `DROP VIEW IF EXISTS ${qName}${cascadeSql};`;
    case 'materialized_view':
      return dialect === 'postgres'
        ? `DROP MATERIALIZED VIEW IF EXISTS ${qName}${cascadeSql};`
        : `DROP VIEW IF EXISTS ${qName}${cascadeSql};`;
    case 'index':
      return `DROP INDEX IF EXISTS ${qName}${cascadeSql};`;
    case 'trigger':
      if (dialect === 'postgres' && tableName) {
        const qTable = qualifiedTableName(db, schema, tableName, 'postgres');
        return `DROP TRIGGER IF EXISTS ${quoteIdent(name, 'postgres')} ON ${qTable}${cascadeSql};`;
      }
      return `DROP TRIGGER IF EXISTS ${qName}${cascadeSql};`;
    case 'procedure':
      return `DROP PROCEDURE IF EXISTS ${qName}${cascadeSql};`;
    case 'function':
    case 'routine':
      return `DROP FUNCTION IF EXISTS ${qName}${cascadeSql};`;
    case 'sequence':
      return `DROP SEQUENCE IF EXISTS ${qName}${cascadeSql};`;
    case 'event':
      return `DROP EVENT IF EXISTS ${qName};`;
    case 'extension':
      return `DROP EXTENSION IF EXISTS ${qSimple}${cascadeSql};`;
    case 'synonym':
      return `DROP SYNONYM IF EXISTS ${qName};`;
    case 'custom_type':
      return `DROP TYPE IF EXISTS ${qName}${cascadeSql};`;
    case 'database':
      return `DROP DATABASE IF EXISTS ${qSimple};`;
    case 'schema':
      return `DROP SCHEMA IF EXISTS ${qSimple}${cascadeSql};`;
  }
}

export function buildTruncateTableSql(
  dialect: SqlDialect,
  db: string,
  schema: string,
  table: string,
  cascade = false,
): string {
  const qName = qualifiedTableName(db, schema, table, dialect);
  if (dialect === 'sqlite') {
    return `DELETE FROM ${qName};`;
  }
  const cascadeSql = cascade && dialect === 'postgres' ? ' CASCADE' : '';
  return `TRUNCATE TABLE ${qName}${cascadeSql};`;
}

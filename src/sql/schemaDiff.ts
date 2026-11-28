/**
 * Schema diff engine (with FK diffing & structured diff tree items) & SQL dump generator
 * across PostgreSQL, MySQL, SQLite, and ClickHouse.
 */

import type {
  CellValue,
  ForeignKeyStructure,
  SchemaDiffItem,
  SchemaDiffResult,
  SchemaSnapshot,
  SchemaTableDiff,
  SqlDialect,
  TableStructure,
} from '../drivers/types';
import {
  buildAlterTableDdl,
  buildCreateTableDdl,
  buildDropObjectSql,
  qualifiedTableName,
  quoteIdent,
  quoteSqlLiteral,
} from '../drivers/sqlDialect';

function fkSignature(fk: ForeignKeyStructure): string {
  return `${fk.columns.join(',')}->${fk.referencedTable}(${fk.referencedColumns.join(',')})`;
}

export function diffSchemas(
  leftSchema: SchemaSnapshot,
  rightSchema: SchemaSnapshot,
): SchemaDiffResult {
  const dialect = rightSchema.dialect ?? leftSchema.dialect;
  const leftMap = new Map(leftSchema.tables.map((t) => [t.table, t]));
  const rightMap = new Map(rightSchema.tables.map((t) => [t.table, t]));

  const addedTables: string[] = [];
  const droppedTables: string[] = [];
  const modifiedTables: SchemaTableDiff[] = [];
  const items: SchemaDiffItem[] = [];
  const migrationStatements: string[] = [];

  // Tables in right but not in left -> CREATE TABLE
  for (const [name, rightTable] of rightMap) {
    if (!leftMap.has(name)) {
      addedTables.push(name);
      const ddl =
        rightTable.createDdl && rightTable.createDdl.trim().length > 0
          ? rightTable.createDdl.trim().endsWith(';')
            ? rightTable.createDdl.trim()
            : `${rightTable.createDdl.trim()};`
          : buildCreateTableDdl(dialect, rightTable.database, rightTable.schema, {
              name: rightTable.table,
              columns: rightTable.columns.map((c) => ({
                name: c.name,
                dataType: c.dataType,
                nullable: c.nullable,
                defaultValue: c.defaultValue,
                isPrimaryKey: c.isPrimaryKey,
                isAutoIncrement: c.isAutoIncrement,
                comment: c.comment ?? undefined,
              })),
              foreignKeys: rightTable.foreignKeys.map((fk) => ({
                name: fk.name,
                columns: fk.columns,
                referencedSchema: fk.referencedSchema,
                referencedTable: fk.referencedTable,
                referencedColumns: fk.referencedColumns,
                onDelete: fk.onDelete,
                onUpdate: fk.onUpdate,
              })),
            });
      migrationStatements.push(ddl);
      items.push({
        id: `table:add:${name}`,
        kind: 'table',
        action: 'add',
        table: name,
        name,
        summary: `Create table ${name} (${rightTable.columns.length} columns)`,
        sql: [ddl],
      });
    }
  }

  // Tables in left but not in right -> DROP TABLE
  for (const [name, leftTable] of leftMap) {
    if (!rightMap.has(name)) {
      droppedTables.push(name);
      const stmt = buildDropObjectSql(dialect, leftTable.database, leftTable.schema, name, 'table', false);
      migrationStatements.push(stmt);
      items.push({
        id: `table:drop:${name}`,
        kind: 'table',
        action: 'drop',
        table: name,
        name,
        summary: `Drop table ${name}`,
        sql: [stmt],
      });
    }
  }

  // Tables in both -> compare columns, indexes, and foreign keys
  for (const [name, rightTable] of rightMap) {
    const leftTable = leftMap.get(name);
    if (!leftTable) continue;

    const leftCols = new Map(leftTable.columns.map((c) => [c.name, c]));
    const rightCols = new Map(rightTable.columns.map((c) => [c.name, c]));

    const addedColumns = rightTable.columns.filter((c) => !leftCols.has(c.name));
    const droppedColumns = leftTable.columns.filter((c) => !rightCols.has(c.name));
    const modifiedColumns: SchemaTableDiff['modifiedColumns'] = [];

    for (const rc of rightTable.columns) {
      const lc = leftCols.get(rc.name);
      if (!lc) continue;
      if (
        lc.dataType.toLowerCase() !== rc.dataType.toLowerCase() ||
        lc.nullable !== rc.nullable ||
        (lc.defaultValue ?? '') !== (rc.defaultValue ?? '')
      ) {
        modifiedColumns.push({ name: rc.name, before: lc, after: rc });
      }
    }

    const leftIdx = new Map(leftTable.indexes.filter((i) => !i.primary).map((i) => [i.name, i]));
    const rightIdx = new Map(rightTable.indexes.filter((i) => !i.primary).map((i) => [i.name, i]));

    const addedIndexes = rightTable.indexes.filter((i) => !i.primary && !leftIdx.has(i.name));
    const droppedIndexes = leftTable.indexes.filter((i) => !i.primary && !rightIdx.has(i.name));

    const leftFkBySig = new Map(leftTable.foreignKeys.map((fk) => [fkSignature(fk), fk]));
    const rightFkBySig = new Map(rightTable.foreignKeys.map((fk) => [fkSignature(fk), fk]));

    const addedForeignKeys = rightTable.foreignKeys.filter((fk) => !leftFkBySig.has(fkSignature(fk)));
    const droppedForeignKeys = leftTable.foreignKeys.filter((fk) => !rightFkBySig.has(fkSignature(fk)));

    const leftChk = new Map((leftTable.checkConstraints ?? []).map((c) => [c.name, c]));
    const rightChk = new Map((rightTable.checkConstraints ?? []).map((c) => [c.name, c]));
    const addedCheckConstraints = (rightTable.checkConstraints ?? []).filter((c) => !leftChk.has(c.name));
    const droppedCheckConstraints = (leftTable.checkConstraints ?? []).filter((c) => !rightChk.has(c.name));

    if (
      addedColumns.length > 0 ||
      droppedColumns.length > 0 ||
      modifiedColumns.length > 0 ||
      addedIndexes.length > 0 ||
      droppedIndexes.length > 0 ||
      addedForeignKeys.length > 0 ||
      droppedForeignKeys.length > 0 ||
      addedCheckConstraints.length > 0 ||
      droppedCheckConstraints.length > 0
    ) {
      modifiedTables.push({
        table: name,
        status: 'modified',
        addedColumns,
        droppedColumns,
        modifiedColumns,
        addedIndexes,
        droppedIndexes,
        addedForeignKeys,
        droppedForeignKeys,
        addedCheckConstraints,
        droppedCheckConstraints,
      });

      for (const c of addedColumns) {
        const sql = buildAlterTableDdl(dialect, rightTable.database, rightTable.schema, name, {
          addColumns: [{ name: c.name, dataType: c.dataType, nullable: c.nullable, defaultValue: c.defaultValue }],
        });
        migrationStatements.push(...sql);
        items.push({
          id: `col:add:${name}.${c.name}`,
          kind: 'column',
          action: 'add',
          table: name,
          name: c.name,
          summary: `Add column ${c.name} ${c.dataType}`,
          sql,
        });
      }

      for (const c of droppedColumns) {
        const sql = buildAlterTableDdl(dialect, rightTable.database, rightTable.schema, name, {
          dropColumns: [c.name],
        });
        migrationStatements.push(...sql);
        items.push({
          id: `col:drop:${name}.${c.name}`,
          kind: 'column',
          action: 'drop',
          table: name,
          name: c.name,
          summary: `Drop column ${c.name}`,
          sql,
        });
      }

      for (const m of modifiedColumns) {
        const sql = buildAlterTableDdl(dialect, rightTable.database, rightTable.schema, name, {
          alterColumns: [{
            name: m.name,
            dataType: m.after.dataType,
            nullable: m.after.nullable,
            defaultValue: m.after.defaultValue,
          }],
        });
        migrationStatements.push(...sql);
        items.push({
          id: `col:modify:${name}.${m.name}`,
          kind: 'column',
          action: 'modify',
          table: name,
          name: m.name,
          summary: `Alter column ${m.name}: ${m.before.dataType} -> ${m.after.dataType}`,
          sql,
        });
      }

      for (const idx of droppedIndexes) {
        const sql = buildAlterTableDdl(dialect, rightTable.database, rightTable.schema, name, {
          dropIndexes: [idx.name],
        });
        migrationStatements.push(...sql);
        items.push({
          id: `idx:drop:${name}.${idx.name}`,
          kind: 'index',
          action: 'drop',
          table: name,
          name: idx.name,
          summary: `Drop index ${idx.name}`,
          sql,
        });
      }

      for (const idx of addedIndexes) {
        const sql = buildAlterTableDdl(dialect, rightTable.database, rightTable.schema, name, {
          addIndexes: [{ name: idx.name, columns: idx.columns, unique: idx.unique }],
        });
        migrationStatements.push(...sql);
        items.push({
          id: `idx:add:${name}.${idx.name}`,
          kind: 'index',
          action: 'add',
          table: name,
          name: idx.name,
          summary: `Create ${idx.unique ? 'unique ' : ''}index ${idx.name} (${idx.columns.join(', ')})`,
          sql,
        });
      }

      for (const fk of droppedForeignKeys) {
        const sql = buildAlterTableDdl(dialect, rightTable.database, rightTable.schema, name, {
          dropForeignKeys: [fk.name],
        });
        migrationStatements.push(...sql);
        items.push({
          id: `fk:drop:${name}.${fk.name}`,
          kind: 'foreign_key',
          action: 'drop',
          table: name,
          name: fk.name,
          summary: `Drop FK ${fk.name} (${fkSignature(fk)})`,
          sql,
        });
      }

      for (const fk of addedForeignKeys) {
        const sql = buildAlterTableDdl(dialect, rightTable.database, rightTable.schema, name, {
          addForeignKeys: [{
            name: fk.name,
            columns: fk.columns,
            referencedSchema: fk.referencedSchema,
            referencedTable: fk.referencedTable,
            referencedColumns: fk.referencedColumns,
            onDelete: fk.onDelete,
            onUpdate: fk.onUpdate,
          }],
        });
        migrationStatements.push(...sql);
        items.push({
          id: `fk:add:${name}.${fk.name}`,
          kind: 'foreign_key',
          action: 'add',
          table: name,
          name: fk.name,
          summary: `Add FK ${fk.name} (${fkSignature(fk)})`,
          sql,
        });
      }

      for (const chk of droppedCheckConstraints) {
        const sql = buildAlterTableDdl(dialect, rightTable.database, rightTable.schema, name, {
          dropCheckConstraints: [chk.name],
        });
        migrationStatements.push(...sql);
        items.push({
          id: `chk:drop:${name}.${chk.name}`,
          kind: 'check_constraint',
          action: 'drop',
          table: name,
          name: chk.name,
          summary: `Drop CHECK ${chk.name}`,
          sql,
        });
      }

      for (const chk of addedCheckConstraints) {
        const sql = buildAlterTableDdl(dialect, rightTable.database, rightTable.schema, name, {
          addCheckConstraints: [{ name: chk.name, expression: chk.expression }],
        });
        migrationStatements.push(...sql);
        items.push({
          id: `chk:add:${name}.${chk.name}`,
          kind: 'check_constraint',
          action: 'add',
          table: name,
          name: chk.name,
          summary: `Add CHECK ${chk.name} (${chk.expression})`,
          sql,
        });
      }
    }
  }

  // Diff Views & Materialized Views
  const normDef = (s?: string) => (s ?? '').replace(/\s+/g, ' ').trim();
  const leftViews = new Map((leftSchema.views ?? []).map((v) => [v.name, v]));
  const rightViews = new Map((rightSchema.views ?? []).map((v) => [v.name, v]));
  for (const [vName, rv] of rightViews) {
    const lv = leftViews.get(vName);
    const kind = rv.isMaterialized ? 'materialized_view' : 'view';
    const qView = qualifiedTableName(rightSchema.database, rightSchema.schema, vName, dialect);
    const createStmt = rv.definition?.trim()
      ? /^\s*CREATE\s+/i.test(rv.definition)
        ? (rv.definition.trim().endsWith(';') ? rv.definition.trim() : `${rv.definition.trim()};`)
        : rv.isMaterialized
          ? `CREATE MATERIALIZED VIEW ${qView} AS\n${rv.definition.trim().replace(/;+\s*$/, '')};`
          : `CREATE OR REPLACE VIEW ${qView} AS\n${rv.definition.trim().replace(/;+\s*$/, '')};`
      : `-- Missing definition for ${kind} ${vName}`;
    if (!lv) {
      migrationStatements.push(createStmt);
      items.push({ id: `${kind}:add:${vName}`, kind, action: 'add', table: vName, name: vName, summary: `Create ${rv.isMaterialized ? 'materialized view' : 'view'} ${vName}`, sql: [createStmt] });
    } else if (normDef(lv.definition) !== normDef(rv.definition)) {
      const stmts = rv.isMaterialized
        ? [buildDropObjectSql(dialect, rightSchema.database, rightSchema.schema, vName, 'materialized_view', false), createStmt]
        : [createStmt];
      migrationStatements.push(...stmts);
      items.push({ id: `${kind}:modify:${vName}`, kind, action: 'modify', table: vName, name: vName, summary: `Update ${rv.isMaterialized ? 'materialized view' : 'view'} ${vName}`, sql: stmts });
    }
  }
  for (const [vName, lv] of leftViews) {
    if (!rightViews.has(vName)) {
      const kind = lv.isMaterialized ? 'materialized_view' : 'view';
      const stmt = buildDropObjectSql(dialect, leftSchema.database, leftSchema.schema, vName, kind, false);
      migrationStatements.push(stmt);
      items.push({ id: `${kind}:drop:${vName}`, kind, action: 'drop', table: vName, name: vName, summary: `Drop ${lv.isMaterialized ? 'materialized view' : 'view'} ${vName}`, sql: [stmt] });
    }
  }

  // Diff Routines (Functions & Procedures)
  const leftRoutines = new Map((leftSchema.routines ?? []).map((r) => [`${r.kind}:${r.name}`, r]));
  const rightRoutines = new Map((rightSchema.routines ?? []).map((r) => [`${r.kind}:${r.name}`, r]));
  for (const [key, rr] of rightRoutines) {
    const lr = leftRoutines.get(key);
    const stmt = rr.definition?.trim()
      ? (rr.definition.trim().endsWith(';') ? rr.definition.trim() : `${rr.definition.trim()};`)
      : `-- Definition unavailable for ${rr.kind} ${rr.name}`;
    if (!lr) {
      migrationStatements.push(stmt);
      items.push({ id: `routine:add:${key}`, kind: 'routine', action: 'add', table: rr.name, name: rr.name, summary: `Create ${rr.kind} ${rr.name}`, sql: [stmt] });
    } else if (normDef(lr.definition) !== normDef(rr.definition)) {
      migrationStatements.push(stmt);
      items.push({ id: `routine:modify:${key}`, kind: 'routine', action: 'modify', table: rr.name, name: rr.name, summary: `Update ${rr.kind} ${rr.name}`, sql: [stmt] });
    }
  }
  for (const [key, lr] of leftRoutines) {
    if (!rightRoutines.has(key)) {
      const qName = qualifiedTableName(leftSchema.database, leftSchema.schema, lr.name, dialect);
      const stmt = lr.kind === 'procedure' ? `DROP PROCEDURE IF EXISTS ${qName};` : `DROP FUNCTION IF EXISTS ${qName};`;
      migrationStatements.push(stmt);
      items.push({ id: `routine:drop:${key}`, kind: 'routine', action: 'drop', table: lr.name, name: lr.name, summary: `Drop ${lr.kind} ${lr.name}`, sql: [stmt] });
    }
  }

  // Diff Triggers
  const leftTriggers = new Map((leftSchema.triggers ?? []).map((t) => [`${t.tableName}.${t.name}`, t]));
  const rightTriggers = new Map((rightSchema.triggers ?? []).map((t) => [`${t.tableName}.${t.name}`, t]));
  for (const [key, rt] of rightTriggers) {
    const lt = leftTriggers.get(key);
    const stmt = rt.definition?.trim()
      ? (rt.definition.trim().endsWith(';') ? rt.definition.trim() : `${rt.definition.trim()};`)
      : `-- Definition unavailable for trigger ${rt.name}`;
    if (!lt) {
      migrationStatements.push(stmt);
      items.push({ id: `trigger:add:${key}`, kind: 'trigger', action: 'add', table: rt.tableName, name: rt.name, summary: `Create trigger ${rt.name} on ${rt.tableName}`, sql: [stmt] });
    } else if (normDef(lt.definition) !== normDef(rt.definition)) {
      const dropStmt = buildDropObjectSql(dialect, rightSchema.database, rightSchema.schema, rt.name, 'trigger', false);
      migrationStatements.push(dropStmt, stmt);
      items.push({ id: `trigger:modify:${key}`, kind: 'trigger', action: 'modify', table: rt.tableName, name: rt.name, summary: `Update trigger ${rt.name} on ${rt.tableName}`, sql: [dropStmt, stmt] });
    }
  }
  for (const [key, lt] of leftTriggers) {
    if (!rightTriggers.has(key)) {
      const stmt = buildDropObjectSql(dialect, leftSchema.database, leftSchema.schema, lt.name, 'trigger', false);
      migrationStatements.push(stmt);
      items.push({ id: `trigger:drop:${key}`, kind: 'trigger', action: 'drop', table: lt.tableName, name: lt.name, summary: `Drop trigger ${lt.name}`, sql: [stmt] });
    }
  }

  // Diff Sequences
  const leftSeqs = new Map((leftSchema.sequences ?? []).map((s) => [s.name, s]));
  const rightSeqs = new Map((rightSchema.sequences ?? []).map((s) => [s.name, s]));
  for (const [sName, rs] of rightSeqs) {
    const ls = leftSeqs.get(sName);
    const qSeq = qualifiedTableName(rightSchema.database, rightSchema.schema, sName, dialect);
    const createStmt = rs.definition?.trim()
      ? (rs.definition.trim().endsWith(';') ? rs.definition.trim() : `${rs.definition.trim()};`)
      : `CREATE SEQUENCE ${qSeq}${rs.increment ? ` INCREMENT BY ${rs.increment}` : ''}${rs.startValue ? ` START WITH ${rs.startValue}` : ''};`;
    if (!ls) {
      migrationStatements.push(createStmt);
      items.push({ id: `sequence:add:${sName}`, kind: 'sequence', action: 'add', table: sName, name: sName, summary: `Create sequence ${sName}`, sql: [createStmt] });
    } else if (ls.increment !== rs.increment || ls.maxValue !== rs.maxValue || ls.minValue !== rs.minValue || ls.cycle !== rs.cycle) {
      const alterStmt = `ALTER SEQUENCE ${qSeq}${rs.increment ? ` INCREMENT BY ${rs.increment}` : ''}${rs.cycle ? ' CYCLE' : ' NO CYCLE'};`;
      migrationStatements.push(alterStmt);
      items.push({ id: `sequence:modify:${sName}`, kind: 'sequence', action: 'modify', table: sName, name: sName, summary: `Alter sequence ${sName}`, sql: [alterStmt] });
    }
  }
  for (const [sName] of leftSeqs) {
    if (!rightSeqs.has(sName)) {
      const stmt = buildDropObjectSql(dialect, leftSchema.database, leftSchema.schema, sName, 'sequence', false);
      migrationStatements.push(stmt);
      items.push({ id: `sequence:drop:${sName}`, kind: 'sequence', action: 'drop', table: sName, name: sName, summary: `Drop sequence ${sName}`, sql: [stmt] });
    }
  }

  return {
    dialect,
    addedTables,
    droppedTables,
    modifiedTables,
    items,
    migrationStatements,
    migrationSql: migrationStatements.join('\n'),
  };
}

export interface TableDumpData {
  structure: TableStructure;
  columns: string[];
  rows: CellValue[][];
}

export function generateSqlDump(
  dialect: SqlDialect,
  database: string,
  schema: string,
  tables: TableDumpData[],
  includeData = true,
): string {
  const lines: string[] = [
    `-- Netcatty Database SQL Dump`,
    `-- Dialect: ${dialect}`,
    `-- Database: ${database}${schema ? ` / Schema: ${schema}` : ''}`,
    `-- Generated: ${new Date().toISOString()}`,
    '',
  ];

  for (const item of tables) {
    const { structure, columns, rows } = item;
    lines.push(`-- Table: ${structure.table}`);
    if (structure.createDdl && structure.createDdl.trim()) {
      const ddl = structure.createDdl.trim();
      lines.push(ddl.endsWith(';') ? ddl : `${ddl};`);
    } else {
      lines.push(
        buildCreateTableDdl(dialect, structure.database, structure.schema, {
          name: structure.table,
          columns: structure.columns.map((c) => ({
            name: c.name,
            dataType: c.dataType,
            nullable: c.nullable,
            defaultValue: c.defaultValue,
            isPrimaryKey: c.isPrimaryKey,
            isAutoIncrement: c.isAutoIncrement,
          })),
        }),
      );
    }
    lines.push('');

    if (includeData && rows.length > 0) {
      const qTable = qualifiedTableName(structure.database, structure.schema, structure.table, dialect);
      const qCols = columns.map((c) => quoteIdent(c, dialect)).join(', ');
      for (const row of rows) {
        const vals = row.map((v) => quoteSqlLiteral(v, dialect)).join(', ');
        lines.push(`INSERT INTO ${qTable} (${qCols}) VALUES (${vals});`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

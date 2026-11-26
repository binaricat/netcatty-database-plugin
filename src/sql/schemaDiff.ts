/**
 * Schema diff engine & SQL dump generator across PostgreSQL, MySQL, SQLite, and ClickHouse.
 */

import type {
  CellValue,
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
  const migrationStatements: string[] = [];

  // Tables in right but not in left -> CREATE TABLE
  for (const [name, rightTable] of rightMap) {
    if (!leftMap.has(name)) {
      addedTables.push(name);
      if (rightTable.createDdl && rightTable.createDdl.trim().length > 0) {
        const ddl = rightTable.createDdl.trim();
        migrationStatements.push(ddl.endsWith(';') ? ddl : `${ddl};`);
      } else {
        migrationStatements.push(
          buildCreateTableDdl(dialect, rightTable.database, rightTable.schema, {
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
          }),
        );
      }
    }
  }

  // Tables in left but not in right -> DROP TABLE
  for (const [name, leftTable] of leftMap) {
    if (!rightMap.has(name)) {
      droppedTables.push(name);
      migrationStatements.push(
        buildDropObjectSql(dialect, leftTable.database, leftTable.schema, name, 'table', false),
      );
    }
  }

  // Tables in both -> compare columns & indexes
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

    if (
      addedColumns.length > 0 ||
      droppedColumns.length > 0 ||
      modifiedColumns.length > 0 ||
      addedIndexes.length > 0 ||
      droppedIndexes.length > 0
    ) {
      modifiedTables.push({
        table: name,
        status: 'modified',
        addedColumns,
        droppedColumns,
        modifiedColumns,
        addedIndexes,
        droppedIndexes,
      });

      const alterStmts = buildAlterTableDdl(dialect, rightTable.database, rightTable.schema, name, {
        addColumns: addedColumns.map((c) => ({
          name: c.name,
          dataType: c.dataType,
          nullable: c.nullable,
          defaultValue: c.defaultValue,
        })),
        dropColumns: droppedColumns.map((c) => c.name),
        alterColumns: modifiedColumns.map((m) => ({
          name: m.name,
          dataType: m.after.dataType,
          nullable: m.after.nullable,
          defaultValue: m.after.defaultValue,
        })),
        addIndexes: addedIndexes.map((i) => ({
          name: i.name,
          columns: i.columns,
          unique: i.unique,
        })),
        dropIndexes: droppedIndexes.map((i) => i.name),
      });
      migrationStatements.push(...alterStmts);
    }
  }

  return {
    dialect,
    addedTables,
    droppedTables,
    modifiedTables,
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

/**
 * Full DBX-Parity SQLite Driver wrapping sql.js (asm.js, 100% browser-sandbox compatible).
 * Supports BOTH in-memory / demo DBs AND real local .db / .sqlite files loaded from Uint8Array
 * and exported back to Uint8Array via exportBytes().
 */

import initSqlJs from 'sql.js/dist/sql-asm.js';
import type { Database, SqlJsStatic } from 'sql.js';
import {
  buildAlterTableDdl,
  buildBatchMutations,
  buildCreateTableDdl,
  buildDropObjectSql,
  buildTruncateTableSql,
  qualifiedTableName,
  quoteIdent,
} from './sqlDialect';
import type {
  BatchMutationApplyResult,
  BatchMutationChanges,
  BatchMutationPreview,
  BrowseTableOptions,
  BrowseTableResult,
  ByteStreamTransport,
  CellValue,
  ColumnMeta,
  ColumnStructure,
  ConnectionConfig,
  ConnectionInfo,
  CreateTableSpec,
  DatabaseInfo,
  DropObjectKind,
  ExplainResult,
  ForeignKeyStructure,
  IndexStructure,
  MultiQueryResult,
  QueryOptions,
  QueryResultSet,
  RelationalDriver,
  RoutineSummary,
  SchemaDiffResult,
  SchemaErEdge,
  SchemaErGraph,
  SchemaErTable,
  SchemaInfo,
  SchemaSnapshot,
  TableStructure,
  TableStructureDiff,
  TableSummary,
  TestConnectionResult,
  TriggerSummary,
  ViewSummary,
} from './types';
import { parseSqliteExplainQueryPlan } from '../sql/explainParser';
import { diffSchemas as runSchemaDiff, generateSqlDump } from '../sql/schemaDiff';
import { splitSqlStatements } from '../sql/splitter';

let cachedSqlJs: Promise<SqlJsStatic> | null = null;
function getSqlJs(): Promise<SqlJsStatic> {
  if (!cachedSqlJs) cachedSqlJs = initSqlJs();
  return cachedSqlJs;
}

const DEMO_SEED_SQL = `
CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  tier TEXT NOT NULL DEFAULT 'standard',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  total_amount REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE VIEW customer_order_summary AS
  SELECT c.id, c.name, COUNT(o.id) AS order_count, COALESCE(SUM(o.total_amount), 0) AS total_spent
  FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id;
INSERT INTO customers (name, email, tier) VALUES
  ('Ada Lovelace', 'ada@example.com', 'enterprise'),
  ('林徽因', 'lin@example.com', 'pro'),
  ('Grace Hopper', 'grace@example.com', 'enterprise');
INSERT INTO products (sku, name, price, stock) VALUES
  ('SKU-001', 'Mechanical Keyboard', 149.99, 42),
  ('SKU-002', 'USB-C Dock', 89.50, 100);
INSERT INTO orders (customer_id, status, total_amount) VALUES
  (1, 'paid', 149.99),
  (2, 'shipped', 239.49),
  (1, 'pending', 89.50);
`;

export class SqliteDriver implements RelationalDriver {
  readonly engine = 'sqlite' as const;
  readonly family = 'sqlite' as const;

  private db: Database | null = null;
  private _connected = false;
  private _inTransaction = false;
  private _serverVersion = 'SQLite 3';
  private dbLabel = 'main';

  get connected(): boolean {
    return this._connected;
  }
  get inTransaction(): boolean {
    return this._inTransaction;
  }
  get serverVersion(): string {
    return this._serverVersion;
  }

  async connect(config: ConnectionConfig, _transport?: ByteStreamTransport): Promise<ConnectionInfo> {
    const started = performance.now();
    const SQL = await getSqlJs();
    if (this.db) {
      this.db.close();
      this.db = null;
    }

    if (config.sqliteBytes && config.sqliteBytes.length > 0) {
      this.db = new SQL.Database(config.sqliteBytes);
    } else {
      this.db = new SQL.Database();
      if (config.sqliteSeedDemo) {
        this.db.run(DEMO_SEED_SQL);
      }
    }
    this.db.run('PRAGMA foreign_keys = ON;');
    this.dbLabel = config.sqliteFileName || config.database || 'main';

    const verRows = this.db.exec('SELECT sqlite_version()');
    const ver = verRows[0]?.values[0]?.[0];
    this._serverVersion = ver ? `SQLite ${ver}` : 'SQLite 3';
    this._connected = true;
    this._inTransaction = false;

    return {
      engine: 'sqlite',
      family: 'sqlite',
      serverVersion: this._serverVersion,
      database: this.dbLabel,
      tlsActive: false,
      latencyMs: Math.round(performance.now() - started),
    };
  }

  /** Export the entire SQLite database as a raw .sqlite/.db Uint8Array (for ui.saveFile). */
  exportBytes(): Uint8Array {
    if (!this.db) throw new Error('SQLite database is not open');
    return this.db.export();
  }

  async testConnection(): Promise<TestConnectionResult> {
    const started = performance.now();
    try {
      const res = await this.query('SELECT sqlite_version()');
      const v = String(res.results[0]?.rows[0]?.[0] ?? '');
      return {
        ok: true,
        serverVersion: `SQLite ${v}`,
        latencyMs: Math.round(performance.now() - started),
        tlsActive: false,
      };
    } catch (err) {
      return {
        ok: false,
        serverVersion: this._serverVersion,
        latencyMs: Math.round(performance.now() - started),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async close(): Promise<void> {
    this._connected = false;
    this._inTransaction = false;
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async cancelQuery(): Promise<void> {
    // sql.js runs synchronously on main thread; no async cancellation primitive
  }

  private assertOpen(): Database {
    if (!this._connected || !this.db) throw new Error('SQLite database is not connected');
    return this.db;
  }

  async query(sql: string, options?: QueryOptions): Promise<MultiQueryResult> {
    const db = this.assertOpen();
    const maxRows = options?.maxRows ?? 10000;
    const totalStart = performance.now();
    const stmts = splitSqlStatements(sql, 'sqlite');
    const statements = stmts.length > 0 ? stmts.map((s) => s.sql) : [sql];
    const results: QueryResultSet[] = [];

    for (let i = 0; i < statements.length; i++) {
      const stSql = statements[i];
      const stStart = performance.now();
      const stmt = db.prepare(stSql);
      try {
        if (options?.params && options.params.length > 0 && statements.length === 1) {
          stmt.bind(options.params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p)));
        }
        const colNames = stmt.getColumnNames();
        const columns: ColumnMeta[] = colNames.map((name) => ({ name, dataType: 'ANY' }));
        const rows: CellValue[][] = [];
        let truncated = false;
        while (stmt.step()) {
          if (rows.length >= maxRows) {
            truncated = true;
            break;
          }
          const raw = stmt.get();
          rows.push(
            raw.map((v) =>
              v === undefined || v === null
                ? null
                : v instanceof Uint8Array
                  ? v
                  : (v as CellValue),
            ),
          );
        }
        const upper = stSql.trim().toUpperCase();
        if (/^BEGIN\b/.test(upper)) this._inTransaction = true;
        else if (/^(?:COMMIT|END|ROLLBACK)\b/.test(upper) && !/\bTO\b/.test(upper)) {
          this._inTransaction = false;
        }
        const affectedRows = colNames.length === 0 ? db.getRowsModified() : 0;
        results.push({
          sql: stSql,
          columns,
          rows,
          rowCount: rows.length,
          affectedRows,
          executionMs: Math.round(performance.now() - stStart),
          truncated,
          commandTag: upper.split(/\s+/)[0] || 'OK',
        });
      } finally {
        stmt.free();
      }
    }

    return {
      results,
      totalExecutionMs: Math.round(performance.now() - totalStart),
    };
  }

  async beginTransaction(): Promise<void> {
    await this.query('BEGIN TRANSACTION');
    this._inTransaction = true;
  }
  async commitTransaction(): Promise<void> {
    await this.query('COMMIT');
    this._inTransaction = false;
  }
  async rollbackTransaction(): Promise<void> {
    await this.query('ROLLBACK');
    this._inTransaction = false;
  }

  async listDatabases(): Promise<DatabaseInfo[]> {
    const res = await this.query('PRAGMA database_list');
    return (res.results[0]?.rows ?? []).map((r) => ({
      name: String(r[1] ?? 'main'),
    }));
  }

  async listSchemas(): Promise<SchemaInfo[]> {
    const dbs = await this.listDatabases();
    return dbs.map((d) => ({ name: d.name, isSystem: d.name === 'temp' }));
  }

  async listTables(db?: string, schema = 'main'): Promise<TableSummary[]> {
    const targetSchema = schema || 'main';
    const res = await this.query(
      `SELECT name FROM ${quoteIdent(targetSchema, 'sqlite')}.sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    );
    const tables: TableSummary[] = [];
    for (const r of res.results[0]?.rows ?? []) {
      const name = String(r[0]);
      let rowCountEstimate: number | undefined;
      try {
        const cnt = await this.query(
          `SELECT COUNT(*) FROM ${qualifiedTableName(db ?? '', targetSchema, name, 'sqlite')}`,
        );
        rowCountEstimate = Number(cnt.results[0]?.rows[0]?.[0] ?? 0);
      } catch {
        // ignore
      }
      tables.push({
        name,
        schema: targetSchema,
        database: db || this.dbLabel,
        kind: 'table',
        rowCountEstimate,
      });
    }
    return tables;
  }

  async listViews(db?: string, schema = 'main'): Promise<ViewSummary[]> {
    const targetSchema = schema || 'main';
    const res = await this.query(
      `SELECT name, sql FROM ${quoteIdent(targetSchema, 'sqlite')}.sqlite_master
       WHERE type = 'view' ORDER BY name`,
    );
    return (res.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      schema: targetSchema,
      database: db || this.dbLabel,
      definition: r[1] ? String(r[1]) : undefined,
    }));
  }

  async listRoutines(): Promise<RoutineSummary[]> {
    return [];
  }

  async listTriggers(db?: string, schema = 'main'): Promise<TriggerSummary[]> {
    const targetSchema = schema || 'main';
    const res = await this.query(
      `SELECT name, tbl_name, sql FROM ${quoteIdent(targetSchema, 'sqlite')}.sqlite_master
       WHERE type = 'trigger' ORDER BY tbl_name, name`,
    );
    return (res.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      schema: targetSchema,
      database: db || this.dbLabel,
      tableName: String(r[1]),
      definition: r[2] ? String(r[2]) : undefined,
    }));
  }

  async getTableStructure(db: string, schema: string, table: string): Promise<TableStructure> {
    const targetSchema = schema || 'main';
    const qSchema = quoteIdent(targetSchema, 'sqlite');
    const qTable = quoteIdent(table, 'sqlite');

    const ddlRes = await this.query(
      `SELECT sql FROM ${qSchema}.sqlite_master WHERE type IN ('table', 'view') AND name = ?`,
      { params: [table] },
    );
    const createSql = ddlRes.results[0]?.rows[0]?.[0]
      ? String(ddlRes.results[0].rows[0][0]) + ';'
      : '';
    const hasAutoInc = /AUTOINCREMENT/i.test(createSql);

    const colsRes = await this.query(`PRAGMA ${qSchema}.table_xinfo(${qTable})`);
    const columns: ColumnStructure[] = (colsRes.results[0]?.rows ?? [])
      .filter((r) => Number(r[6] ?? 0) === 0) // exclude hidden columns
      .map((r) => {
        const pkOrd = Number(r[5] ?? 0);
        const typeStr = String(r[2] ?? 'TEXT');
        return {
          name: String(r[1]),
          dataType: typeStr || 'ANY',
          nullable: Number(r[3]) === 0 && pkOrd === 0,
          defaultValue: r[4] !== null ? String(r[4]) : null,
          isPrimaryKey: pkOrd > 0,
          primaryKeyOrdinal: pkOrd > 0 ? pkOrd : undefined,
          isAutoIncrement: pkOrd > 0 && hasAutoInc && /^INTEGER$/i.test(typeStr),
        };
      });

    const idxListRes = await this.query(`PRAGMA ${qSchema}.index_list(${qTable})`);
    const indexes: IndexStructure[] = [];
    for (const r of idxListRes.results[0]?.rows ?? []) {
      const idxName = String(r[1]);
      const unique = Number(r[2]) === 1;
      const origin = String(r[3] ?? '');
      const idxInfoRes = await this.query(`PRAGMA ${qSchema}.index_info(${quoteIdent(idxName, 'sqlite')})`);
      const idxCols = (idxInfoRes.results[0]?.rows ?? [])
        .map((c) => (c[2] !== null ? String(c[2]) : null))
        .filter((c): c is string => c !== null);
      const idxDdlRes = await this.query(
        `SELECT sql FROM ${qSchema}.sqlite_master WHERE type = 'index' AND name = ?`,
        { params: [idxName] },
      );
      indexes.push({
        name: idxName,
        columns: idxCols,
        unique,
        primary: origin === 'pk',
        definition: idxDdlRes.results[0]?.rows[0]?.[0]
          ? String(idxDdlRes.results[0].rows[0][0])
          : null,
      });
    }

    const fkRes = await this.query(`PRAGMA ${qSchema}.foreign_key_list(${qTable})`);
    const fkMap = new Map<number, ForeignKeyStructure>();
    for (const r of fkRes.results[0]?.rows ?? []) {
      const id = Number(r[0]);
      let fk = fkMap.get(id);
      if (!fk) {
        fk = {
          name: `fk_${table}_${id}`,
          columns: [],
          referencedSchema: targetSchema,
          referencedTable: String(r[2]),
          referencedColumns: [],
          onUpdate: r[5] ? String(r[5]) : undefined,
          onDelete: r[6] ? String(r[6]) : undefined,
        };
        fkMap.set(id, fk);
      }
      fk.columns.push(String(r[3]));
      fk.referencedColumns.push(r[4] !== null ? String(r[4]) : '');
    }

    return {
      database: db || this.dbLabel,
      schema: targetSchema,
      table,
      columns,
      indexes,
      foreignKeys: Array.from(fkMap.values()),
      checkConstraints: [],
      createDdl: createSql,
    };
  }

  async getSchemaErGraph(db: string, schema = 'main'): Promise<SchemaErGraph> {
    const targetSchema = schema || 'main';
    const tables = await this.listTables(db, targetSchema);
    const erTables: SchemaErTable[] = [];
    const edges: SchemaErEdge[] = [];
    for (const t of tables) {
      const struct = await this.getTableStructure(db, targetSchema, t.name);
      erTables.push({ name: t.name, schema: targetSchema, columns: struct.columns });
      for (const fk of struct.foreignKeys) {
        edges.push({
          id: `${t.name}.${fk.name}`,
          name: fk.name,
          sourceTable: t.name,
          sourceColumns: fk.columns,
          targetTable: fk.referencedTable,
          targetColumns: fk.referencedColumns,
          onDelete: fk.onDelete,
          onUpdate: fk.onUpdate,
        });
      }
    }
    return { database: db || this.dbLabel, schema: targetSchema, tables: erTables, edges };
  }

  async browseTable(
    db: string,
    schema: string,
    table: string,
    options?: BrowseTableOptions,
  ): Promise<BrowseTableResult> {
    const targetSchema = schema || 'main';
    const page = Math.max(1, options?.page ?? 1);
    const pageSize = Math.min(1000, Math.max(1, options?.pageSize ?? 50));
    const offset = (page - 1) * pageSize;
    const qTable = qualifiedTableName(db, targetSchema, table, 'sqlite');

    const where = options?.whereClause?.trim() ? ` WHERE ${options.whereClause.trim()}` : '';
    const order = options?.sortBy
      ? ` ORDER BY ${quoteIdent(options.sortBy, 'sqlite')} ${options.sortDir === 'desc' ? 'DESC' : 'ASC'}`
      : '';
    const dataSql = `SELECT * FROM ${qTable}${where}${order} LIMIT ${pageSize} OFFSET ${offset}`;
    const countSql = `SELECT COUNT(*) FROM ${qTable}${where}`;

    const started = performance.now();
    const dataRes = await this.query(dataSql, { maxRows: pageSize });
    const countRes = await this.query(countSql, { maxRows: 1 });
    const rs = dataRes.results[0];
    const totalRows = Number(countRes.results[0]?.rows[0]?.[0] ?? rs?.rowCount ?? 0);

    return {
      database: db || this.dbLabel,
      schema: targetSchema,
      table,
      columns: rs?.columns ?? [],
      rows: rs?.rows ?? [],
      page,
      pageSize,
      totalRows,
      totalEstimated: false,
      executionMs: Math.round(performance.now() - started),
      sql: dataSql,
    };
  }

  generateBatchMutations(
    db: string,
    schema: string,
    table: string,
    structure: TableStructure,
    changes: BatchMutationChanges,
  ): BatchMutationPreview {
    return buildBatchMutations('sqlite', db, schema || 'main', table, structure, changes);
  }

  async applyBatchMutations(sqlStatements: readonly string[]): Promise<BatchMutationApplyResult> {
    const started = performance.now();
    let affectedRows = 0;
    const wasInTx = this._inTransaction;
    if (!wasInTx) await this.beginTransaction();
    try {
      for (const stmt of sqlStatements) {
        const res = await this.query(stmt);
        for (const r of res.results) affectedRows += r.affectedRows;
      }
      if (!wasInTx) await this.commitTransaction();
      return {
        applied: sqlStatements.length,
        affectedRows,
        executionMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      if (!wasInTx) await this.rollbackTransaction().catch(() => {});
      throw err;
    }
  }

  async explain(sql: string, _analyze = false): Promise<ExplainResult> {
    const res = await this.query(`EXPLAIN QUERY PLAN ${sql}`);
    const rows = (res.results[0]?.rows ?? []).map((r) => ({
      id: Number(r[0] ?? 0),
      parent: Number(r[1] ?? 0),
      detail: String(r[3] ?? r[2] ?? ''),
    }));
    return parseSqliteExplainQueryPlan(rows);
  }

  /**
   * SQLite ALTER TABLE generator: uses native ALTER TABLE for simple operations,
   * and automatically generates a full transactional table-rebuild script when
   * altering column types/nullability/defaults (which SQLite does not natively support).
   */
  generateAlterTableDdl(
    db: string,
    schema: string,
    table: string,
    diff: TableStructureDiff,
    currentStructure?: TableStructure,
  ): string[] {
    if (diff.alterColumns && diff.alterColumns.length > 0 && currentStructure) {
      return buildSqliteTableRebuildDdl(db, schema || 'main', table, currentStructure, diff);
    }
    return buildAlterTableDdl('sqlite', db, schema || 'main', table, diff);
  }

  generateCreateTableDdl(db: string, schema: string, spec: CreateTableSpec): string {
    return buildCreateTableDdl('sqlite', db, schema || 'main', spec);
  }

  async dropObject(
    db: string,
    schema: string,
    name: string,
    kind: DropObjectKind,
    cascade = false,
  ): Promise<void> {
    await this.query(buildDropObjectSql('sqlite', db, schema || 'main', name, kind, cascade));
  }

  async truncateTable(db: string, schema: string, table: string, cascade = false): Promise<void> {
    await this.query(buildTruncateTableSql('sqlite', db, schema || 'main', table, cascade));
  }

  async dumpDatabaseSql(
    db: string,
    schema = 'main',
    tables?: string[],
    includeData = true,
  ): Promise<string> {
    const targetSchema = schema || 'main';
    const list = tables ?? (await this.listTables(db, targetSchema)).map((t) => t.name);
    const dumpTables = [];
    for (const table of list) {
      const structure = await this.getTableStructure(db, targetSchema, table);
      let columns = structure.columns.map((c) => c.name);
      let rows: CellValue[][] = [];
      if (includeData) {
        const qTable = qualifiedTableName(db, targetSchema, table, 'sqlite');
        const res = await this.query(`SELECT * FROM ${qTable}`, { maxRows: 50000 });
        columns = res.results[0]?.columns.map((c) => c.name) ?? columns;
        rows = res.results[0]?.rows ?? [];
      }
      dumpTables.push({ structure, columns, rows });
    }
    return generateSqlDump('sqlite', db || this.dbLabel, targetSchema, dumpTables, includeData);
  }

  diffSchemas(leftSchema: SchemaSnapshot, rightSchema: SchemaSnapshot): SchemaDiffResult {
    return runSchemaDiff(leftSchema, rightSchema);
  }
}

export function buildSqliteTableRebuildDdl(
  db: string,
  schema: string,
  table: string,
  current: TableStructure,
  diff: TableStructureDiff,
): string[] {
  const dropSet = new Set(diff.dropColumns ?? []);
  const renameMap = new Map((diff.renameColumns ?? []).map((r) => [r.from, r.to]));
  const alterMap = new Map((diff.alterColumns ?? []).map((a) => [a.name, a]));

  const nextCols = current.columns
    .filter((c) => !dropSet.has(c.name))
    .map((c) => {
      const alt = alterMap.get(c.name);
      const nextName = renameMap.get(c.name) ?? c.name;
      return {
        oldName: c.name,
        spec: {
          name: nextName,
          dataType: alt?.dataType ?? c.dataType,
          nullable: alt?.nullable ?? c.nullable,
          defaultValue: alt?.defaultValue !== undefined ? alt.defaultValue : c.defaultValue,
          isPrimaryKey: c.isPrimaryKey,
          isAutoIncrement: c.isAutoIncrement,
        },
      };
    });

  const addedCols = (diff.addColumns ?? []).map((c) => ({ oldName: null as string | null, spec: c }));
  const allCols = [...nextCols, ...addedCols];
  const tempTable = `__netcatty_rebuild_${table}`;
  const finalName = diff.renameTableTo || table;

  const createTemp = buildCreateTableDdl('sqlite', db, schema, {
    name: tempTable,
    columns: allCols.map((c) => c.spec),
    foreignKeys: current.foreignKeys.map((fk) => ({
      name: fk.name,
      columns: fk.columns.map((c) => renameMap.get(c) ?? c),
      referencedTable: fk.referencedTable,
      referencedColumns: fk.referencedColumns,
      onDelete: fk.onDelete,
      onUpdate: fk.onUpdate,
    })),
  });

  const copyPairs = nextCols;
  const targetColList = copyPairs.map((c) => quoteIdent(c.spec.name, 'sqlite')).join(', ');
  const sourceColList = copyPairs.map((c) => quoteIdent(c.oldName, 'sqlite')).join(', ');
  const qOrig = qualifiedTableName(db, schema, table, 'sqlite');
  const qTemp = qualifiedTableName(db, schema, tempTable, 'sqlite');

  const stmts: string[] = [
    'PRAGMA foreign_keys = OFF;',
    'BEGIN TRANSACTION;',
    createTemp,
    `INSERT INTO ${qTemp} (${targetColList}) SELECT ${sourceColList} FROM ${qOrig};`,
    `DROP TABLE ${qOrig};`,
    `ALTER TABLE ${qTemp} RENAME TO ${quoteIdent(finalName, 'sqlite')};`,
  ];

  // Re-create explicit user indexes (skip SQLite internal sqlite_autoindex_* entries)
  const droppedIdx = new Set(diff.dropIndexes ?? []);
  for (const idx of current.indexes) {
    if (idx.primary || idx.name.startsWith('sqlite_autoindex_') || droppedIdx.has(idx.name)) {
      continue;
    }
    const cols = idx.columns
      .filter((c) => !dropSet.has(c))
      .map((c) => quoteIdent(renameMap.get(c) ?? c, 'sqlite'));
    if (cols.length > 0) {
      stmts.push(
        `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(idx.name, 'sqlite')} ON ${quoteIdent(finalName, 'sqlite')} (${cols.join(', ')});`,
      );
    }
  }
  for (const idx of diff.addIndexes ?? []) {
    const cols = idx.columns.map((c) => quoteIdent(c, 'sqlite')).join(', ');
    stmts.push(
      `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(idx.name, 'sqlite')} ON ${quoteIdent(finalName, 'sqlite')} (${cols});`,
    );
  }

  stmts.push('COMMIT;', 'PRAGMA foreign_keys = ON;');
  return stmts;
}

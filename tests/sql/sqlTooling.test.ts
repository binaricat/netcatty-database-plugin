import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autoMapImportColumns,
  buildMonacoCompletionSchema,
  diffSchemas,
  exportCsv,
  exportJson,
  exportMarkdown,
  exportSqlInserts,
  exportXlsx,
  extractTableAliases,
  formatSql,
  getSqlCompletions,
  importCsv,
  importJson,
  importSqlScript,
  importXlsx,
  inferColumnTypes,
  parseClickHouseExplainText,
  parseMysqlExplainJson,
  parsePostgresExplainJson,
  parseSqliteExplainQueryPlan,
  splitSqlStatements,
  statementAtOffset,
} from '../../src/sql/index';
import type { SchemaSnapshot } from '../../src/drivers/types';

test('splitSqlStatements handles strings, comments, dollar-quotes, and dialects', () => {
  const pgSql = `
    -- leading comment; not a split
    SELECT 'hello; world', $$body; with; semicolons$$ AS fn_body;
    /* nested /* comment; */ still comment */
    CREATE FUNCTION foo() RETURNS void AS $tag$ BEGIN PERFORM 1; END; $tag$ LANGUAGE plpgsql;
    SELECT 42;
  `;
  const stmts = splitSqlStatements(pgSql, 'postgres');
  assert.equal(stmts.length, 3);
  assert.match(stmts[0].sql, /\$\$body; with; semicolons\$\$/);
  assert.match(stmts[1].sql, /\$tag\$ BEGIN PERFORM 1; END; \$tag\$/);
  assert.equal(stmts[2].sql, 'SELECT 42');

  const mysqlSql = `
    # mysql hash comment; ignored
    SELECT 'it\\'s; fine', \`col;name\` FROM t;
    SELECT 2;
  `;
  const mStmts = splitSqlStatements(mysqlSql, 'mysql');
  assert.equal(mStmts.length, 2);
  assert.match(mStmts[0].sql, /it\\'s; fine/);
});

test('statementAtOffset resolves the statement under cursor', () => {
  const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3;';
  const s1 = statementAtOffset(sql, 4, 'postgres');
  const s2 = statementAtOffset(sql, 14, 'postgres');
  const s3 = statementAtOffset(sql, 25, 'postgres');
  assert.equal(s1?.sql, 'SELECT 1');
  assert.equal(s2?.sql, 'SELECT 2');
  assert.equal(s3?.sql, 'SELECT 3');
});

test('formatSql uppercases keywords and indents clauses cleanly', () => {
  const formatted = formatSql(
    "select u.id, u.name from users u left join orders o on o.user_id = u.id where u.active = true and u.tier = 'pro' order by u.id desc limit 20",
    { dialect: 'postgres' },
  );
  assert.match(formatted, /^SELECT u\.id,\n  u\.name\nFROM users u\nLEFT JOIN orders o ON o\.user_id = u\.id\nWHERE u\.active = TRUE\n  AND u\.tier = 'pro'\nORDER BY u\.id DESC\nLIMIT 20;$/);
});

test('schema-aware SQL completions resolve aliases and Monaco payload', () => {
  const schema = {
    dialect: 'postgres' as const,
    tables: [
      {
        name: 'customers',
        schema: 'public',
        columns: [
          { name: 'id', dataType: 'integer', isPrimaryKey: true },
          { name: 'email', dataType: 'text' },
          { name: 'full_name', dataType: 'text' },
        ],
      },
      {
        name: 'orders',
        schema: 'public',
        columns: [
          { name: 'id', dataType: 'integer', isPrimaryKey: true },
          { name: 'customer_id', dataType: 'integer' },
          { name: 'total', dataType: 'numeric' },
        ],
      },
    ],
  };

  const sql = 'SELECT c.em FROM customers c JOIN orders o ON o.customer_id = c.id';
  const aliases = extractTableAliases(sql);
  assert.equal(aliases.get('c'), 'customers');
  assert.equal(aliases.get('o'), 'orders');

  const items = getSqlCompletions(sql, 11, schema);
  assert.equal(items.length, 1);
  assert.equal(items[0].label, 'email');
  assert.equal(items[0].kind, 'column');

  const monaco = buildMonacoCompletionSchema(schema);
  assert.equal(monaco.tables.length, 2);
  assert.ok(monaco.keywords.includes('ILIKE'));
  assert.ok(monaco.functions.includes('JSONB_BUILD_OBJECT'));
});

test('EXPLAIN parsers produce normalized trees for PG, MySQL, SQLite, ClickHouse', () => {
  const pg = parsePostgresExplainJson(
    [
      {
        Plan: {
          'Node Type': 'Hash Join',
          'Total Cost': 125.5,
          'Plan Rows': 50,
          'Actual Rows': 48,
          'Actual Total Time': 1.23,
          Plans: [
            { 'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Plan Rows': 2000, 'Total Cost': 60 },
            { 'Node Type': 'Index Scan', 'Relation Name': 'customers', 'Index Name': 'customers_pkey', 'Plan Rows': 50, 'Total Cost': 20 },
          ],
        },
        'Execution Time': 1.45,
      },
    ],
    true,
  );
  assert.equal(pg.root.nodeType, 'Hash Join');
  assert.equal(pg.root.children.length, 2);
  assert.equal(pg.actualTimeMs, 1.45);
  assert.ok(pg.root.children[0].warnings?.[0].includes('Sequential scan'));

  const my = parseMysqlExplainJson({
    query_block: {
      cost_info: { query_cost: '12.5' },
      table: { table_name: 'users', access_type: 'ALL', rows_examined_per_scan: 100 },
    },
  });
  assert.equal(my.root.relation, 'users');
  assert.ok(my.root.warnings?.[0].includes('Full table scan'));

  const sq = parseSqliteExplainQueryPlan([
    { id: 3, parent: 0, detail: 'SCAN orders' },
    { id: 5, parent: 0, detail: 'SEARCH customers USING INTEGER PRIMARY KEY (rowid=?)' },
  ]);
  assert.equal(sq.root.children.length, 2);
  assert.equal(sq.root.children[0].relation, 'orders');

  const ch = parseClickHouseExplainText([
    'Expression ((Projection + Before ORDER BY))',
    '  ReadFromMergeTree (analytics_demo.page_views)',
  ]);
  assert.equal(ch.root.nodeType, 'Expression');
  assert.equal(ch.root.children.length, 1);
});

test('Export & Import engines round-trip CSV, JSON, Markdown, SQL INSERT, and XLSX', async () => {
  const columns = ['id', 'name', 'price', 'active', 'note'];
  const rows = [
    [1, 'Ada, "Engineer"', 19.95, true, 'Line1\nLine2'],
    [2, '林徽因 🚀', 42, false, null],
  ];

  // CSV round-trip
  const csv = exportCsv(columns, rows);
  const parsedCsv = importCsv(csv);
  assert.deepEqual(parsedCsv.columns, columns);
  assert.equal(parsedCsv.rows.length, 2);
  assert.equal(parsedCsv.rows[0][1], 'Ada, "Engineer"');
  assert.equal(parsedCsv.rows[0][4], 'Line1\nLine2');
  assert.equal(parsedCsv.rows[1][1], '林徽因 🚀');
  assert.equal(parsedCsv.rows[1][4], null);
  assert.equal(parsedCsv.inferredTypes.id, 'BIGINT');
  assert.equal(parsedCsv.inferredTypes.price, 'DOUBLE PRECISION');
  assert.equal(parsedCsv.inferredTypes.active, 'BOOLEAN');

  // JSON round-trip
  const json = exportJson(columns, rows);
  const parsedJson = importJson(json);
  assert.deepEqual(parsedJson.columns, columns);
  assert.equal(parsedJson.rows[1][2], 42);

  // Markdown
  const md = exportMarkdown(columns, rows);
  assert.match(md, /\| id \| name \| price \| active \| note \|/);
  assert.match(md, /林徽因 🚀/);

  // SQL INSERT + script import
  const sqlIns = exportSqlInserts('products', columns, rows, 'postgres', { batchSize: 2, schema: 'public' });
  assert.match(sqlIns, /INSERT INTO "public"\."products"/);
  const script = importSqlScript(sqlIns, 'postgres');
  assert.equal(script.statements.length, 1);

  // XLSX round-trip (pure-TS ZIP + OOXML!)
  const xlsxBytes = exportXlsx('Products', columns, rows);
  assert.equal(xlsxBytes[0], 0x50); // 'P'
  assert.equal(xlsxBytes[1], 0x4b); // 'K'
  const parsedXlsx = await importXlsx(xlsxBytes);
  assert.equal(parsedXlsx.sheetName, 'Products');
  assert.deepEqual(parsedXlsx.columns, columns);
  assert.equal(parsedXlsx.rows.length, 2);
  assert.equal(parsedXlsx.rows[0][0], 1);
  assert.equal(parsedXlsx.rows[0][2], 19.95);
  assert.equal(parsedXlsx.rows[0][3], true);
  assert.equal(parsedXlsx.rows[1][1], '林徽因 🚀');
  assert.equal(parsedXlsx.rows[1][4], null);

  // Auto-column mapping & type inference
  const mapped = autoMapImportColumns(['User Name', 'email_addr', 'unknown_col'], ['user_name', 'email_addr']);
  assert.equal(mapped['User Name'], 'user_name');
  assert.equal(mapped['email_addr'], 'email_addr');
  assert.equal(mapped['unknown_col'], null);

  const types = inferColumnTypes(['dt'], [['2026-11-26T10:00:00Z']], 'clickhouse');
  assert.equal(types.dt, 'DateTime64(3)');
});

test('diffSchemas detects added, dropped, and modified tables/columns/indexes', () => {
  const left: SchemaSnapshot = {
    dialect: 'postgres',
    database: 'shop',
    schema: 'public',
    tables: [
      {
        database: 'shop',
        schema: 'public',
        table: 'users',
        columns: [
          { name: 'id', dataType: 'integer', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true },
          { name: 'old_col', dataType: 'text', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
        ],
        indexes: [],
        foreignKeys: [],
        checkConstraints: [],
        createDdl: '',
      },
      {
        database: 'shop',
        schema: 'public',
        table: 'legacy_logs',
        columns: [],
        indexes: [],
        foreignKeys: [],
        checkConstraints: [],
        createDdl: '',
      },
    ],
  };
  const right: SchemaSnapshot = {
    dialect: 'postgres',
    database: 'shop',
    schema: 'public',
    tables: [
      {
        database: 'shop',
        schema: 'public',
        table: 'users',
        columns: [
          { name: 'id', dataType: 'bigint', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true },
          { name: 'email', dataType: 'varchar(255)', nullable: false, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
        ],
        indexes: [{ name: 'idx_users_email', columns: ['email'], unique: true, primary: false }],
        foreignKeys: [],
        checkConstraints: [],
        createDdl: '',
      },
      {
        database: 'shop',
        schema: 'public',
        table: 'orders',
        columns: [
          { name: 'id', dataType: 'integer', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true },
        ],
        indexes: [],
        foreignKeys: [],
        checkConstraints: [],
        createDdl: 'CREATE TABLE "public"."orders" ("id" SERIAL PRIMARY KEY);',
      },
    ],
  };

  const diff = diffSchemas(left, right);
  assert.deepEqual(diff.addedTables, ['orders']);
  assert.deepEqual(diff.droppedTables, ['legacy_logs']);
  assert.equal(diff.modifiedTables.length, 1);
  assert.equal(diff.modifiedTables[0].addedColumns[0].name, 'email');
  assert.equal(diff.modifiedTables[0].droppedColumns[0].name, 'old_col');
  assert.equal(diff.modifiedTables[0].modifiedColumns[0].name, 'id');
  assert.match(diff.migrationSql, /CREATE TABLE "public"\."orders"/);
  assert.match(diff.migrationSql, /DROP TABLE IF EXISTS "public"\."legacy_logs"/);
  assert.match(diff.migrationSql, /ADD COLUMN "email"/);
  assert.match(diff.migrationSql, /CREATE UNIQUE INDEX "idx_users_email"/);
});

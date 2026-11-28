import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildCancelQuerySql,
  buildServerStatusSnapshot,
  buildTerminateSessionSql,
  clampRefreshInterval,
  computeClickHouseMarkCacheHitRatio,
  computeInnodbBufferHitRatio,
  computeMssqlBufferHitRatio,
  computePgCacheHitRatio,
  computeRate,
  computeServerDeltaMetrics,
  formatBytes,
  formatUptime,
  isPgLegacyProcessListError,
  isPgLegacyStatusError,
  parseKeyValueStatusResult,
  parseProcessListResult,
  parseServerVariablesResult,
  parseSingleRowStatusResult,
  resolveMonitorProfile,
} from '../src/sql/serverMonitor.ts';

import {
  buildAlterUserSql,
  buildCreateUserSql,
  buildDropUserSql,
  buildGrantSql,
  buildListUsersSql,
  buildRevokeSql,
  buildShowGrantsSql,
  parseDatabaseUsers,
  parseMySqlGrantStatement,
  parseMySqlGrantee,
  parseUserGrants,
  resolveUserAdminProfile,
} from '../src/sql/userAdmin.ts';

import {
  cellsEqual,
  compareTableData,
  formatSqlLiteral,
  generateDataSyncSql,
} from '../src/sql/dataCompare.ts';

import {
  buildMockInsertStatements,
  createSeededRng,
  generateFromRegexLite,
  generateLuhnCreditCard,
  generateMockRows,
  inferColumnMockRule,
} from '../src/sql/mockGenerator.ts';

import {
  MODEL_CODE_FORMATS,
  exportDataDictionaryDbml,
  exportDataDictionaryHtml,
  exportDataDictionaryMarkdown,
  generateModelCode,
} from '../src/sql/dataDictionary.ts';

import {
  aggregateDataSearchMatches,
  buildGlobalObjectSearchSql,
  buildJumpToRowWhereClause,
  buildTableDataSearchSql,
  findMatchedColumnsInRow,
  isNumericSearchColumn,
  isTextSearchColumn,
  parseGlobalObjectSearchRows,
  parseNumericTerm,
  searchCachedSchemaObjects,
} from '../src/sql/databaseSearch.ts';

/* ============================================================================
 * 1. serverMonitor.ts
 * ============================================================================ */

test('serverMonitor: profile resolution & MySQL/PG/MSSQL/ClickHouse metrics', () => {
  assert.equal(resolveMonitorProfile('mysql')?.dialect, 'mysql');
  assert.equal(resolveMonitorProfile('mariadb')?.dialect, 'mysql');
  assert.equal(resolveMonitorProfile('postgres')?.dialect, 'postgres');
  assert.equal(resolveMonitorProfile('kingbase')?.dialect, 'postgres');
  assert.equal(resolveMonitorProfile('sqlserver')?.dialect, 'mssql');
  assert.equal(resolveMonitorProfile('clickhouse')?.dialect, 'clickhouse');
  assert.equal(resolveMonitorProfile('sqlite'), null);

  // MySQL status parsing + delta QPS + InnoDB buffer hit ratio
  const mysqlRes = {
    sql: 'SHOW GLOBAL STATUS',
    columns: [
      { name: 'Variable_name', dataType: 'varchar' },
      { name: 'Value', dataType: 'varchar' },
    ],
    rows: [
      ['Uptime', '90061'],
      ['Queries', '12000'],
      ['Threads_connected', '24'],
      ['Threads_running', '5'],
      ['Slow_queries', '3'],
      ['Bytes_received', '1048576'],
      ['Bytes_sent', '4194304'],
      ['Innodb_buffer_pool_read_requests', '10000'],
      ['Innodb_buffer_pool_reads', '125'],
      ['Com_select', '8000'],
      ['Com_insert', '1500'],
    ],
    rowCount: 11,
    affectedRows: 0,
    executionMs: 4,
    truncated: false,
  };
  const s1 = parseKeyValueStatusResult(mysqlRes);
  const hit = computeInnodbBufferHitRatio(s1);
  assert.ok(hit !== null && Math.abs(hit - 98.75) < 0.01);
  assert.equal(formatUptime(90061), '1d 1h 1m');
  assert.equal(formatBytes(1048576), '1.0 MB');

  const s2 = { ...s1, Queries: '12500', Bytes_received: '2097152', Com_select: '8300' };
  const delta = computeServerDeltaMetrics('mysql', { at: 1000, status: s1 }, { at: 6000, status: s2 });
  assert.equal(delta.qpsOrTps, 100);
  assert.equal(delta.selectPerSec, 60);

  // Counter reset safety
  assert.equal(
    computeRate({ at: 1000, status: { Queries: '500' } }, { at: 6000, status: { Queries: '100' } }, 'Queries'),
    0,
  );

  const snap = buildServerStatusSnapshot({ engine: 'mysql', dialect: 'mysql', status: s2, delta });
  assert.equal(snap.activeConnections, 5);
  assert.equal(snap.totalConnections, 24);
  assert.equal(snap.idleConnections, 19);
  assert.equal(snap.slowQueries, 3);
  assert.ok(snap.metrics.length >= 10);

  // PG single-row parsing + cache ratio + TPS
  const pgRowRes = {
    sql: 'PG_STATUS',
    columns: [
      { name: 'xact_commit', dataType: 'bigint' },
      { name: 'xact_rollback', dataType: 'bigint' },
      { name: 'blks_hit', dataType: 'bigint' },
      { name: 'blks_read', dataType: 'bigint' },
      { name: 'connections', dataType: 'bigint' },
      { name: 'active_connections', dataType: 'bigint' },
      { name: 'idle_connections', dataType: 'bigint' },
      { name: 'uptime_seconds', dataType: 'bigint' },
    ],
    rows: [[1000, 50, 9900, 100, 12, 3, 9, 3660]],
    rowCount: 1,
    affectedRows: 0,
    executionMs: 2,
    truncated: false,
  };
  const pg1 = parseSingleRowStatusResult(pgRowRes);
  assert.equal(computePgCacheHitRatio(pg1), 99);
  const pg2 = { ...pg1, xact_commit: '1200', xact_rollback: '55' };
  const pgDelta = computeServerDeltaMetrics('postgres', { at: 0, status: pg1 }, { at: 5000, status: pg2 });
  assert.equal(pgDelta.qpsOrTps, 41);

  assert.equal(computeMssqlBufferHitRatio({ buffer_hit_ratio_num: '95', buffer_hit_ratio_base: '100' }), 95);
  assert.equal(computeClickHouseMarkCacheHitRatio({ MarkCacheHits: '80', MarkCacheMisses: '20' }), 80);
});

test('serverMonitor: processlist parsing, kill SQL validation & legacy error detection', () => {
  const procRes = {
    sql: 'SHOW FULL PROCESSLIST',
    columns: [
      { name: 'Id', dataType: 'bigint' },
      { name: 'User', dataType: 'varchar' },
      { name: 'Host', dataType: 'varchar' },
      { name: 'db', dataType: 'varchar' },
      { name: 'Command', dataType: 'varchar' },
      { name: 'Time', dataType: 'int' },
      { name: 'State', dataType: 'varchar' },
      { name: 'Info', dataType: 'text' },
    ],
    rows: [
      [42, 'root', '127.0.0.1:5000', 'app', 'Query', 12, 'Sending data', 'SELECT * FROM orders'],
      [99, 'root', '127.0.0.1:5001', 'app', 'Sleep', 120, '', null],
    ],
    rowCount: 2,
    affectedRows: 0,
    executionMs: 1,
    truncated: false,
  };
  const entries = parseProcessListResult('mysql', procRes, 99);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, '42');
  assert.equal(entries[0].isCurrentSession, false);
  assert.equal(entries[1].isCurrentSession, true);

  assert.equal(buildCancelQuerySql('mysql', 42), 'KILL QUERY 42');
  assert.equal(buildTerminateSessionSql('mysql', 42), 'KILL 42');
  assert.equal(buildCancelQuerySql('postgres', 1234), 'SELECT pg_cancel_backend(1234)');
  assert.equal(buildTerminateSessionSql('postgres', 1234), 'SELECT pg_terminate_backend(1234)');
  assert.equal(buildTerminateSessionSql('mssql', 55), 'KILL 55');
  assert.equal(
    buildCancelQuerySql('clickhouse', "q-'abc"),
    "KILL QUERY WHERE query_id = 'q-''abc' SYNC",
  );

  // Injection guard
  assert.throws(() => buildCancelQuerySql('mysql', '42; DROP TABLE users'));
  assert.throws(() => buildTerminateSessionSql('postgres', -1));
  assert.throws(() => buildCancelQuerySql('clickhouse', 'bad\nquery'));

  assert.equal(clampRefreshInterval(0), 1);
  assert.equal(clampRefreshInterval(99999), 3600);
  assert.equal(isPgLegacyStatusError(new Error('function pg_current_wal_lsn() does not exist')), true);
  assert.equal(isPgLegacyProcessListError(new Error('column "wait_event_type" does not exist')), true);

  const vars = parseServerVariablesResult({
    sql: 'SHOW GLOBAL VARIABLES',
    columns: [{ name: 'Variable_name', dataType: 'text' }, { name: 'Value', dataType: 'text' }],
    rows: [['max_connections', '151'], ['innodb_buffer_pool_size', '134217728']],
    rowCount: 2,
    affectedRows: 0,
    executionMs: 1,
    truncated: false,
  });
  assert.equal(vars[0].name, 'innodb_buffer_pool_size');
});

/* ============================================================================
 * 2. userAdmin.ts
 * ============================================================================ */

test('userAdmin: SQL builders and parsers across PostgreSQL, MySQL, MSSQL', () => {
  assert.equal(resolveUserAdminProfile('postgres')?.dialect, 'postgres');
  assert.equal(resolveUserAdminProfile('mysql')?.dialect, 'mysql');
  assert.equal(resolveUserAdminProfile('sqlserver')?.dialect, 'mssql');
  assert.equal(resolveUserAdminProfile('sqlite'), null);

  assert.match(buildListUsersSql('postgres'), /pg_catalog\.pg_roles/);
  assert.match(buildListUsersSql('mysql'), /mysql\.user/);
  assert.match(buildListUsersSql('mssql'), /sys\.database_principals/);

  // Create
  assert.equal(
    buildCreateUserSql('postgres', { name: 'app_rw', password: "p'w", canLogin: true, canCreateDb: true }),
    `CREATE ROLE "app_rw" WITH LOGIN CREATEDB PASSWORD 'p''w';`,
  );
  assert.equal(
    buildCreateUserSql('mysql', { name: 'app', host: '10.%', password: "a'b" }),
    `CREATE USER 'app'@'10.%' IDENTIFIED BY 'a''b';`,
  );
  assert.match(
    buildCreateUserSql('mssql', { name: 'reporter', password: 'Secret123!', defaultDatabase: 'sales' }),
    /CREATE LOGIN \[reporter\] WITH PASSWORD = 'Secret123!', DEFAULT_DATABASE = \[sales\];/,
  );

  // Alter / Lock / Rename / Drop
  const mysqlAlters = buildAlterUserSql('mysql', {
    name: 'dev',
    host: 'localhost',
    newHost: '%',
    password: 'newpw',
    locked: true,
  });
  assert.equal(mysqlAlters.length, 3);
  assert.equal(mysqlAlters[0], `RENAME USER 'dev'@'localhost' TO 'dev'@'%';`);
  assert.equal(mysqlAlters[1], `ALTER USER 'dev'@'%' IDENTIFIED BY 'newpw';`);
  assert.equal(mysqlAlters[2], `ALTER USER 'dev'@'%' ACCOUNT LOCK;`);

  assert.equal(buildDropUserSql('postgres', 'old_role'), 'DROP ROLE IF EXISTS "old_role";');
  assert.equal(buildDropUserSql('mysql', 'old_user', '%'), "DROP USER IF EXISTS 'old_user'@'%';");
  assert.equal(buildDropUserSql('mssql', 'old_user'), 'DROP USER IF EXISTS [old_user];');

  // GRANT / REVOKE
  assert.equal(
    buildGrantSql('postgres', {
      userName: 'analyst',
      scope: 'table',
      schema: 'public',
      table: 'orders',
      privileges: ['select', 'insert'],
      withGrantOption: true,
    }),
    'GRANT SELECT, INSERT ON TABLE "public"."orders" TO "analyst" WITH GRANT OPTION;',
  );
  assert.equal(
    buildRevokeSql('postgres', { userName: 'analyst', scope: 'role', roleName: 'readonly', privileges: [] }),
    'REVOKE "readonly" FROM "analyst";',
  );
  assert.equal(
    buildGrantSql('mysql', { userName: 'bi', userHost: '%', scope: 'database', database: 'analytics', privileges: ['SELECT'] }),
    "GRANT SELECT ON `analytics`.* TO 'bi'@'%';",
  );
  assert.equal(
    buildRevokeSql('mssql', { userName: 'bi', scope: 'table', schema: 'dbo', table: 'sales', privileges: ['SELECT'] }),
    'REVOKE SELECT ON OBJECT::[dbo].[sales] FROM [bi];',
  );

  assert.match(buildShowGrantsSql('mysql', 'root', 'localhost'), /SHOW GRANTS FOR 'root'@'localhost'/);
  assert.match(buildShowGrantsSql('postgres', 'postgres'), /has_database_privilege/);
  assert.match(buildShowGrantsSql('mssql', 'dbo'), /sys\.database_permissions/);

  // Parsers
  assert.deepEqual(parseMySqlGrantee("'app'@'%'"), { name: 'app', host: '%' });
  const parsedGrant = parseMySqlGrantStatement("GRANT SELECT, INSERT ON `shop`.`orders` TO 'app'@'%' WITH GRANT OPTION");
  assert.deepEqual(parsedGrant, {
    privileges: ['SELECT', 'INSERT'],
    database: 'shop',
    table: 'orders',
    allPrivileges: false,
    grantOption: true,
  });

  const pgUsers = parseDatabaseUsers('postgres', {
    sql: '',
    columns: [
      { name: 'name', dataType: 'text' },
      { name: 'is_superuser', dataType: 'bool' },
      { name: 'can_login', dataType: 'bool' },
      { name: 'member_of', dataType: 'text' },
    ],
    rows: [['admin', true, true, 'pg_monitor,ops']],
    rowCount: 1,
    affectedRows: 0,
    executionMs: 1,
    truncated: false,
  });
  assert.equal(pgUsers[0].name, 'admin');
  assert.deepEqual(pgUsers[0].roles, ['pg_monitor', 'ops']);

  assert.deepEqual(
    parseUserGrants({
      sql: '',
      columns: [{ name: 'line', dataType: 'text' }],
      rows: [['GRANT SELECT ON *.* TO root'], ['']],
      rowCount: 2,
      affectedRows: 0,
      executionMs: 1,
      truncated: false,
    }),
    ['GRANT SELECT ON *.* TO root'],
  );
});

/* ============================================================================
 * 3. dataCompare.ts
 * ============================================================================ */

test('dataCompare: row-by-row diff engine & dialect-aware sync SQL', () => {
  assert.equal(cellsEqual(42, '42', true), true);
  assert.equal(cellsEqual(42, '42', false), false);
  assert.equal(cellsEqual(null, null), true);

  const diff = compareTableData({
    columns: ['id', 'name', 'price', 'updated_at'],
    keyColumns: ['id'],
    ignoredColumns: ['updated_at'],
    sourceRows: [
      [1, 'Widget', 10.5, '2026-01-02'],
      [2, 'Gadget Pro', 29.99, '2026-01-02'],
      [3, 'New Item', 15, '2026-01-02'],
    ],
    targetRows: [
      [1, 'Widget', '10.5', '2026-01-01'], // identical except ignored updated_at + loose numeric
      [2, 'Gadget', 19.99, '2026-01-01'], // modified
      [4, 'Legacy', 5, '2026-01-01'], // removed
    ],
  });

  assert.equal(diff.unchangedCount, 1);
  assert.equal(diff.ignoredOnlyCount, 1);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.modified.length, 1);
  assert.equal(diff.modified[0].changes.length, 2);

  // Postgres sync SQL
  const pgPlan = generateDataSyncSql({
    dialect: 'postgres',
    schema: 'public',
    tableName: 'products',
    diff,
  });
  assert.equal(pgPlan.insertCount, 1);
  assert.equal(pgPlan.updateCount, 1);
  assert.equal(pgPlan.deleteCount, 1);
  assert.match(pgPlan.sql, /INSERT INTO "public"\."products"/);
  assert.match(pgPlan.sql, /UPDATE "public"\."products" SET "name" = 'Gadget Pro', "price" = 29\.99 WHERE "id" = 2;/);
  assert.match(pgPlan.sql, /DELETE FROM "public"\."products" WHERE "id" = 4;/);

  // ClickHouse mutation syntax
  const chPlan = generateDataSyncSql({
    dialect: 'clickhouse',
    schema: 'analytics',
    tableName: 'products',
    diff,
  });
  assert.match(chPlan.sql, /ALTER TABLE `analytics`\.`products` UPDATE/);
  assert.match(chPlan.sql, /ALTER TABLE `analytics`\.`products` DELETE WHERE/);

  // Selective keys + reverse direction
  const revPlan = generateDataSyncSql({
    dialect: 'mysql',
    tableName: 'products',
    diff,
    direction: 'targetToSource',
    selectedKeys: [diff.removed[0].key],
  });
  assert.equal(revPlan.insertCount, 1);
  assert.equal(revPlan.deleteCount, 0);
  assert.match(revPlan.sql, /INSERT INTO `products`/);
  assert.equal(formatSqlLiteral('postgres', new Uint8Array([0xde, 0xad])), "'\\xdead'::bytea");
});

/* ============================================================================
 * 4. mockGenerator.ts
 * ============================================================================ */

test('mockGenerator: presets, Luhn credit card, regex-lite, inference, and batched INSERTs', () => {
  const rng = createSeededRng(42);
  const cc = generateLuhnCreditCard(rng);
  assert.equal(cc.length, 16);
  // Verify Luhn checksum
  let sum = 0;
  for (let i = 0; i < 16; i += 1) {
    let d = Number(cc[15 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  assert.equal(sum % 10, 0);

  const rx = generateFromRegexLite('[A-Z]{2}-[0-9]{4}-(US|EU)', createSeededRng(7));
  assert.match(rx, /^[A-Z]{2}-[0-9]{4}-(US|EU)$/);

  const inferredEmail = inferColumnMockRule({
    name: 'user_email',
    dataType: 'varchar(255)',
    nullable: false,
    defaultValue: null,
    isPrimaryKey: false,
    isAutoIncrement: false,
  });
  assert.equal(inferredEmail.preset, 'email');

  const inferredSkip = inferColumnMockRule({
    name: 'id',
    dataType: 'serial',
    nullable: false,
    defaultValue: null,
    isPrimaryKey: true,
    isAutoIncrement: true,
  });
  assert.equal(inferredSkip.preset, 'skip');

  const rules = [
    { columnName: 'id', dataType: 'int', preset: 'sequence', seqStart: 10, seqStep: 5 },
    { columnName: 'uid', dataType: 'uuid', preset: 'uuid', unique: true },
    { columnName: 'email', dataType: 'text', preset: 'email' },
    { columnName: 'status', dataType: 'text', preset: 'enum', enumValues: 'active:80,paused:20' },
    { columnName: 'org_id', dataType: 'int', preset: 'foreign_key', foreignKeyValues: [101, 202] },
    { columnName: 'ip', dataType: 'text', preset: 'ipv4' },
    { columnName: 'note', dataType: 'text', preset: 'text', nullPercent: 100 },
  ];

  const data = generateMockRows(rules, 12, 999);
  assert.equal(data.columns.length, 7);
  assert.equal(data.rows.length, 12);
  assert.equal(data.rows[0][0], 10);
  assert.equal(data.rows[1][0], 15);
  assert.match(String(data.rows[0][1]), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok([101, 202].includes(data.rows[0][4]));
  assert.equal(data.rows[0][6], null);

  const stmts = buildMockInsertStatements({
    dialect: 'postgres',
    schema: 'public',
    tableName: 'users',
    columns: data.columns,
    rows: data.rows,
    batchSize: 5,
  });
  assert.equal(stmts.length, 3); // 5 + 5 + 2
  assert.match(stmts[0], /^INSERT INTO "public"\."users"/);
});

/* ============================================================================
 * 5. dataDictionary.ts
 * ============================================================================ */

test('dataDictionary: Markdown, HTML (XSS-safe), DBML & 7-language Model Code Generator', () => {
  const sampleTable = {
    database: 'shop',
    schema: 'public',
    table: 'order_items',
    comment: "Customer's <script>alert(1)</script> line items",
    columns: [
      { name: 'id', dataType: 'bigint', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true },
      { name: 'order_id', dataType: 'uuid', nullable: false, defaultValue: null, isPrimaryKey: false, isForeignKey: true, isAutoIncrement: false },
      { name: 'unit_price', dataType: 'numeric(10,2)', nullable: false, defaultValue: '0.00', isPrimaryKey: false, isAutoIncrement: false },
      { name: 'notes', dataType: 'text', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false, comment: "Buyer's note'" },
      { name: 'created_at', dataType: 'timestamptz', nullable: false, defaultValue: 'now()', isPrimaryKey: false, isAutoIncrement: false },
    ],
    indexes: [
      { name: 'idx_order_items_order_id', columns: ['order_id'], unique: false, primary: false, type: 'btree' },
    ],
    foreignKeys: [
      {
        name: 'fk_order_items_order',
        columns: ['order_id'],
        referencedSchema: 'public',
        referencedTable: 'orders',
        referencedColumns: ['id'],
        onDelete: 'CASCADE',
      },
    ],
    checkConstraints: [{ name: 'chk_price', expression: 'unit_price >= 0' }],
    createDdl: 'CREATE TABLE order_items (...)',
  };

  const md = exportDataDictionaryMarkdown({
    projectName: 'ShopDB',
    engine: 'postgres',
    database: 'shop',
    schema: 'public',
    tables: [sampleTable],
  });
  assert.match(md, /# Data Dictionary: ShopDB/);
  assert.match(md, /\| `unit_price` \| `numeric\(10,2\)`/);
  assert.match(md, /fk_order_items_order/);

  const html = exportDataDictionaryHtml({
    projectName: 'ShopDB',
    engine: 'postgres',
    database: 'shop',
    schema: 'public',
    tables: [sampleTable],
  });
  assert.match(html, /<!doctype html>/i);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'Must escape script tags in comments');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));

  const dbml = exportDataDictionaryDbml({
    projectName: 'ShopDB',
    engine: 'postgres',
    database: 'shop',
    schema: 'public',
    tables: [sampleTable],
  });
  assert.match(dbml, /Table order_items \{/);
  assert.match(dbml, /id bigint \[pk, increment\]/);
  assert.match(dbml, /created_at timestamptz \[not null, default: `now\(\)`\]/);
  assert.match(dbml, /Ref fk_order_items_order: order_items\.order_id > orders\.id \[delete: cascade\]/);
  // Trailing single-quote escaped in DBML note
  assert.ok(dbml.includes("'''Buyer's note\\''''"));

  // Generate all 8 model targets covering 7 languages
  assert.equal(MODEL_CODE_FORMATS.length, 8);
  for (const fmt of MODEL_CODE_FORMATS) {
    const out = generateModelCode(sampleTable, fmt.id, { includeComments: true });
    assert.ok(out.code.length > 40, `Expected non-empty code for ${fmt.id}`);
    assert.equal(out.extension, fmt.extension);
  }

  assert.match(generateModelCode(sampleTable, 'typescript').code, /export interface OrderItems/);
  assert.match(generateModelCode(sampleTable, 'zod').code, /z\.string\(\)\.uuid\(\)/);
  assert.match(generateModelCode(sampleTable, 'prisma').code, /model OrderItems/);
  assert.match(generateModelCode(sampleTable, 'go').code, /type OrderItems struct/);
  assert.match(generateModelCode(sampleTable, 'rust').code, /pub struct OrderItems/);
  assert.match(generateModelCode(sampleTable, 'python-dataclass').code, /@dataclass/);
  assert.match(generateModelCode(sampleTable, 'python-sqlalchemy').code, /Mapped\[/);
  assert.match(generateModelCode(sampleTable, 'java').code, /public class OrderItems/);
});

/* ============================================================================
 * 6. databaseSearch.ts
 * ============================================================================ */

test('databaseSearch: global object search & cross-table data search', () => {
  assert.equal(isTextSearchColumn({ dataType: 'varchar(100)' }), true);
  assert.equal(isTextSearchColumn({ dataType: 'bytea' }), false);
  assert.equal(isNumericSearchColumn({ dataType: 'integer' }), true);
  assert.equal(parseNumericTerm(' 42.5 '), '42.5');
  assert.equal(parseNumericTerm('abc'), null);

  const pgObjSql = buildGlobalObjectSearchSql({ dialect: 'postgres', database: 'app', term: 'order' });
  assert.ok(pgObjSql && pgObjSql.includes('pg_catalog.pg_class') && pgObjSql.includes('pg_catalog.pg_proc'));
  const mysqlObjSql = buildGlobalObjectSearchSql({ dialect: 'mysql', database: 'app', term: 'order' });
  assert.ok(mysqlObjSql && mysqlObjSql.includes('information_schema.TABLES'));
  const mssqlObjSql = buildGlobalObjectSearchSql({ dialect: 'mssql', database: 'app', term: 'order' });
  assert.ok(mssqlObjSql && mssqlObjSql.includes('sys.extended_properties'));
  const chObjSql = buildGlobalObjectSearchSql({ dialect: 'clickhouse', database: 'app', term: 'order' });
  assert.ok(chObjSql && chObjSql.includes('system.tables'));

  const parsedHits = parseGlobalObjectSearchRows(
    {
      sql: '',
      columns: [
        { name: 'object_schema', dataType: 'text' },
        { name: 'object_kind', dataType: 'text' },
        { name: 'object_name', dataType: 'text' },
        { name: 'column_name', dataType: 'text' },
        { name: 'data_type', dataType: 'text' },
        { name: 'comment', dataType: 'text' },
      ],
      rows: [['public', 'column', 'orders', 'order_code', 'varchar', 'Primary order identifier']],
      rowCount: 1,
      affectedRows: 0,
      executionMs: 2,
      truncated: false,
    },
    'order',
  );
  assert.equal(parsedHits.length, 1);
  assert.deepEqual(parsedHits[0].matchedIn, ['name', 'column', 'comment']);

  const cachedHits = searchCachedSchemaObjects(
    [
      {
        schema: 'public',
        tables: [{ name: 'invoices', schema: 'public', database: 'app', kind: 'table', comment: 'Billing records' }],
        views: [{ name: 'v_billing', schema: 'public', database: 'app' }],
        routines: [{ name: 'recalc_billing', schema: 'public', database: 'app', kind: 'function' }],
        structures: {},
      },
    ],
    'billing',
  );
  assert.equal(cachedHits.length, 3);

  // Cross-table data search
  const cols = [
    { name: 'id', dataType: 'integer', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true },
    { name: 'email', dataType: 'varchar(255)', nullable: false, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
    { name: 'avatar', dataType: 'bytea', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
  ];
  const dataSql = buildTableDataSearchSql({
    dialect: 'postgres',
    schema: 'public',
    tableName: 'users',
    columns: cols,
    term: '42',
    limit: 25,
  });
  assert.ok(dataSql);
  assert.deepEqual(dataSql.searchableColumns, ['id', 'email']);
  assert.match(dataSql.sql, /"id" = 42/);
  assert.match(dataSql.sql, /ILIKE '%42%'/);

  const matched = findMatchedColumnsInRow(['id', 'email', 'avatar'], [42, 'bob@example.com', null], cols, '42');
  assert.deepEqual(matched, ['id']);

  const summary = aggregateDataSearchMatches({
    dialect: 'postgres',
    schema: 'public',
    tableName: 'users',
    schemaColumns: cols,
    term: 'bob',
    result: {
      sql: dataSql.sql,
      columns: [
        { name: 'id', dataType: 'integer' },
        { name: 'email', dataType: 'varchar' },
      ],
      rows: [[42, 'bob@example.com']],
      rowCount: 1,
      affectedRows: 0,
      executionMs: 1,
      truncated: false,
    },
  });
  assert.equal(summary.matches.length, 1);
  assert.equal(summary.matches[0].whereClause, '"id" = 42');
  assert.equal(
    buildJumpToRowWhereClause({
      dialect: 'mysql',
      columns: cols,
      rowValues: { id: 42, email: 'bob@example.com' },
    }),
    '`id` = 42',
  );
});

/* ============================================================================
 * 7. Sandbox & Host UI Policy Hygiene Check on all Wave B files
 * ============================================================================ */

test('Wave B files have zero inline <svg>/<canvas> and zero node:* imports', async () => {
  const files = [
    'src/sql/serverMonitor.ts',
    'src/sql/userAdmin.ts',
    'src/sql/dataCompare.ts',
    'src/sql/mockGenerator.ts',
    'src/sql/dataDictionary.ts',
    'src/sql/databaseSearch.ts',
    'src/ui/components/ServerMonitorTab.tsx',
    'src/ui/components/UserAdminTab.tsx',
    'src/ui/components/DataCompareTab.tsx',
    'src/ui/components/MockDataDrawer.tsx',
    'src/ui/components/DocsAndModelDrawer.tsx',
    'src/ui/components/GlobalSearchDrawer.tsx',
    'src/ui/components/DoltVersionTab.tsx',
  ];
  for (const rel of files) {
    const content = await readFile(new URL(`../${rel}`, import.meta.url), 'utf8');
    assert.ok(!/from\s+['"]node:/.test(content), `${rel} must not import node:*`);
    if (rel.endsWith('.tsx')) {
      assert.ok(!/<svg[\s>]/i.test(content), `${rel} must not contain inline <svg>`);
      assert.ok(!/<canvas[\s>]/i.test(content), `${rel} must not contain inline <canvas>`);
    }
  }
});

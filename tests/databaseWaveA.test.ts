/**
 * Wave A Netcatty Database Full-Parity Unit & SSR Tests:
 * - Routine parameter parser & PG/MySQL/MSSQL execution SQL (IN/OUT/INOUT)
 * - Sequence Alter/Restart, MySQL Event toggle, Trigger toggle, Refresh MV, Create DB/Schema SQL
 * - Table physical options ALTER DDL (MySQL Engine/Charset/Collation/AutoInc/Comment, PG Comment, CH Comment)
 * - Expanded Schema Diff (Views, Materialized Views, Routines, Triggers, Sequences, CHECK constraints)
 * - TSV export & SQL IN (...) formatter
 * - Live SQLite driver new methods (getObjectDefinition, listObjectDependencies, getServerStatus)
 * - SSR rendering of upgraded ObjectDefTab (editable source + routine exec + sequence alter) & StructureDesignerTab (partitions + physical options)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildCreateDatabaseSql,
  buildCreateSchemaSql,
  buildMysqlEventToggleSql,
  buildRefreshMaterializedViewSql,
  buildRoutineExecutionSql,
  buildSequenceAlterSql,
  buildTriggerToggleSql,
  parseRoutineParameters,
} from '../src/sql/routineSql';
import { buildAlterTableDdl, buildDropObjectSql } from '../src/drivers/sqlDialect';
import { diffSchemas } from '../src/sql/schemaDiff';
import { exportSqlInList, exportTsv } from '../src/sql/exportImport';
import { SqliteDriver } from '../src/drivers/sqliteDriver';
import type { ActiveSession, ObjectDefTabState, StructureDesignerTabState } from '../src/ui/types';

function ensureDomShims(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.HTMLElement === 'undefined') {
    g.HTMLElement = class {};
  }
  if (typeof g.MutationObserver === 'undefined') {
    g.MutationObserver = class {
      observe() {}
      disconnect() {}
      takeRecords() { return []; }
    };
  }
  if (typeof g.customElements === 'undefined') {
    const reg = new Map<string, unknown>();
    g.customElements = {
      define(name: string, ctor: unknown) { reg.set(name, ctor); },
      get(name: string) { return reg.get(name); },
    };
  }
}

test('parseRoutineParameters & buildRoutineExecutionSql generate PG/MySQL/MSSQL IN/OUT/INOUT calls', () => {
  const pgParams = parseRoutineParameters('IN p_id integer, OUT p_total numeric, INOUT p_tag text DEFAULT \'vip\'', 'postgres');
  assert.equal(pgParams.length, 3);
  assert.equal(pgParams[0].mode, 'IN');
  assert.equal(pgParams[1].mode, 'OUT');
  assert.equal(pgParams[2].mode, 'INOUT');

  const pgCall = buildRoutineExecutionSql({
    dialect: 'postgres',
    db: 'app',
    schema: 'public',
    name: 'recalc_order',
    kind: 'procedure',
    params: pgParams,
    values: { p_id: '42', p_tag: 'gold' },
  });
  assert.match(pgCall, /CALL "public"\."recalc_order"\(42, NULL, 'gold'\);/);

  const mysqlCall = buildRoutineExecutionSql({
    dialect: 'mysql',
    db: 'shop',
    schema: 'shop',
    name: 'calc_bonus',
    kind: 'procedure',
    params: pgParams,
    values: { p_id: '7', p_tag: 'pro' },
  });
  assert.match(mysqlCall, /SET @ndb_output_1 = NULL;/);
  assert.match(mysqlCall, /SET @ndb_output_2 = 'pro';/);
  assert.match(mysqlCall, /CALL `shop`\.`calc_bonus`\(7, @ndb_output_1, @ndb_output_2\);/);
  assert.match(mysqlCall, /SELECT @ndb_output_1 AS `p_total`, @ndb_output_2 AS `p_tag`;/);

  const mssqlParams = parseRoutineParameters('@id INT, @total DECIMAL(10,2) OUTPUT', 'mssql');
  assert.equal(mssqlParams.length, 2);
  assert.equal(mssqlParams[1].mode, 'OUT');
  const mssqlCall = buildRoutineExecutionSql({
    dialect: 'mssql',
    db: 'Sales',
    schema: 'dbo',
    name: 'sp_get_total',
    kind: 'procedure',
    params: mssqlParams,
    values: { '@id': '99' },
  });
  assert.match(mssqlCall, /DECLARE @ndb_output_1 DECIMAL\(10,2\);/);
  assert.match(mssqlCall, /EXEC \[Sales\]\.\[dbo\]\.\[sp_get_total\] @id = 99, @total = @ndb_output_1 OUTPUT;/);
});

test('Sequence, Event, Trigger, MV, DB/Schema & Physical Option SQL builders work across dialects', () => {
  assert.equal(
    buildSequenceAlterSql({ dialect: 'postgres', db: 'app', schema: 'public', name: 'orders_seq', restartWith: '500', increment: '2', cycle: true }),
    'ALTER SEQUENCE "public"."orders_seq" INCREMENT BY 2 RESTART WITH 500 CYCLE;',
  );
  assert.equal(buildMysqlEventToggleSql('shop', 'nightly_cleanup', false), 'ALTER EVENT `shop`.`nightly_cleanup` DISABLE;');
  assert.equal(
    buildTriggerToggleSql({ dialect: 'postgres', db: 'app', schema: 'public', tableName: 'orders', triggerName: 'trg_audit', enable: false }),
    'ALTER TABLE "public"."orders" DISABLE TRIGGER "trg_audit";',
  );
  assert.equal(
    buildTriggerToggleSql({ dialect: 'mssql', db: 'Sales', schema: 'dbo', tableName: 'Orders', triggerName: 'trg_audit', enable: true }),
    'ENABLE TRIGGER [trg_audit] ON [Sales].[dbo].[Orders];',
  );
  assert.equal(
    buildRefreshMaterializedViewSql({ dialect: 'postgres', db: 'app', schema: 'public', name: 'mv_sales', concurrently: true }),
    'REFRESH MATERIALIZED VIEW CONCURRENTLY "public"."mv_sales";',
  );
  assert.equal(
    buildCreateDatabaseSql({ dialect: 'mysql', name: 'analytics', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' }),
    'CREATE DATABASE `analytics` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;',
  );
  assert.equal(buildCreateSchemaSql({ dialect: 'postgres', name: 'reporting', owner: 'bi_admin' }), 'CREATE SCHEMA "reporting" AUTHORIZATION "bi_admin";');

  const mysqlOpts = buildAlterTableDdl('mysql', 'shop', 'shop', 'orders', {
    tableEngine: 'InnoDB',
    tableCharset: 'utf8mb4',
    tableAutoIncrement: 1000,
    tableComment: 'Customer orders',
  });
  assert.equal(mysqlOpts.length, 1);
  assert.match(mysqlOpts[0], /ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 AUTO_INCREMENT = 1000 COMMENT = 'Customer orders'/);

  assert.equal(buildDropObjectSql('postgres', 'app', 'public', 'mv_sales', 'materialized_view', true), 'DROP MATERIALIZED VIEW IF EXISTS "public"."mv_sales" CASCADE;');
  assert.equal(buildDropObjectSql('postgres', 'app', 'public', 'orders_seq', 'sequence'), 'DROP SEQUENCE IF EXISTS "public"."orders_seq";');
  assert.equal(buildDropObjectSql('mysql', 'shop', 'shop', 'ev_clean', 'event'), 'DROP EVENT IF EXISTS `shop`.`ev_clean`;');
});

test('diffSchemas covers Views, Materialized Views, Routines, Triggers, Sequences, and CHECK Constraints', () => {
  const res = diffSchemas(
    {
      dialect: 'postgres',
      database: 'app',
      schema: 'public',
      tables: [
        {
          database: 'app',
          schema: 'public',
          table: 'orders',
          columns: [{ name: 'id', dataType: 'integer', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true }],
          indexes: [],
          foreignKeys: [],
          checkConstraints: [{ name: 'chk_old', expression: 'CHECK (id > 0)' }],
          createDdl: '',
        },
      ],
      views: [{ name: 'v_legacy', schema: 'public', database: 'app', definition: 'SELECT 1' }],
      routines: [],
      triggers: [],
      sequences: [],
    },
    {
      dialect: 'postgres',
      database: 'app',
      schema: 'public',
      tables: [
        {
          database: 'app',
          schema: 'public',
          table: 'orders',
          columns: [{ name: 'id', dataType: 'integer', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true }],
          indexes: [],
          foreignKeys: [],
          checkConstraints: [{ name: 'chk_amount', expression: 'CHECK (id >= 1)' }],
          createDdl: '',
        },
      ],
      views: [
        { name: 'mv_sales', schema: 'public', database: 'app', isMaterialized: true, definition: 'SELECT count(*) FROM orders' },
      ],
      routines: [{ name: 'fn_tax', schema: 'public', database: 'app', kind: 'function', definition: 'CREATE FUNCTION public.fn_tax() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql' }],
      triggers: [{ name: 'trg_ord', schema: 'public', database: 'app', tableName: 'orders', definition: 'CREATE TRIGGER trg_ord AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.fn_tax()' }],
      sequences: [{ name: 'orders_seq', schema: 'public', database: 'app', increment: '1', startValue: '100' }],
    },
  );
  const kinds = new Set(res.items.map((i) => i.kind));
  assert.ok(kinds.has('check_constraint'));
  assert.ok(kinds.has('view'));
  assert.ok(kinds.has('materialized_view'));
  assert.ok(kinds.has('routine'));
  assert.ok(kinds.has('trigger'));
  assert.ok(kinds.has('sequence'));
  assert.match(res.migrationSql, /CREATE MATERIALIZED VIEW/);
  assert.match(res.migrationSql, /CREATE SEQUENCE/);
});

test('exportTsv & exportSqlInList format tabular data cleanly', () => {
  const tsv = exportTsv(['id', 'name'], [[1, 'Alice'], [2, 'Bob']]);
  assert.equal(tsv, 'id\tname\r\n1\tAlice\r\n2\tBob');
  const inClause = exportSqlInList([10, 20, 10, null, 30], 'postgres', 'order_id');
  assert.equal(inClause, '"order_id" IN (10, 20, 30)');
});

test('Live SQLite driver supports getObjectDefinition, listObjectDependencies, and getServerStatus', async () => {
  const drv = new SqliteDriver();
  await drv.connect({ engine: 'sqlite', sqliteSeedDemo: true });
  try {
    await drv.query('CREATE VIEW v_orders_summary AS SELECT status, COUNT(*) AS cnt FROM orders GROUP BY status;');
    const def = await drv.getObjectDefinition('main', 'main', 'v_orders_summary');
    assert.match(def, /CREATE VIEW v_orders_summary/);
    const deps = await drv.listObjectDependencies('main', 'main', 'orders');
    assert.ok(deps.some((d) => d.name === 'v_orders_summary'));
    const status = await drv.getServerStatus();
    assert.equal(status.engine, 'sqlite');
    assert.ok(status.variables.some((v) => v.name === 'PRAGMA page_size'));
  } finally {
    await drv.close();
  }
});

test('ObjectDefTab & StructureDesignerTab render editable source, routine exec, partitions, and zero inline svg/canvas', async () => {
  ensureDomShims();
  const [{ ObjectDefTab }, { StructureDesignerTab }] = await Promise.all([
    import('../src/ui/components/ObjectDefTab'),
    import('../src/ui/components/StructureDesignerTab'),
  ]);
  const session = {
    connectionId: 'c1',
    connection: { id: 'c1', name: 'PG', engine: 'postgres', readOnly: false } as ActiveSession['connection'],
    family: 'postgres',
  } as ActiveSession;
  const objTab: ObjectDefTabState = {
    id: 'def-1',
    connectionId: 'c1',
    kind: 'objectDef',
    title: 'fn_calc (function)',
    objectKind: 'function',
    database: 'app',
    schema: 'public',
    name: 'fn_calc',
    arguments: 'IN p_id integer',
    returnType: 'numeric',
    definition: 'CREATE OR REPLACE FUNCTION public.fn_calc(p_id integer) RETURNS numeric AS $$ SELECT 1 $$ LANGUAGE sql;',
    dependencies: [{ direction: 'referenced_by', kind: 'view', schema: 'public', name: 'v_sales' }],
  };
  const html1 = renderToStaticMarkup(
    React.createElement(ObjectDefTab, {
      tab: objTab,
      session,
      t: (k) => k,
      onOpenInQuery: () => {},
      onCopyDdl: () => {},
    }),
  );
  assert.match(html1, /Edit Source/);
  assert.match(html1, /Execute/);
  assert.match(html1, /Dependencies \(1\)/);
  assert.equal(/<svg\b|<canvas\b/i.test(html1), false);

  const structTab: StructureDesignerTabState = {
    id: 'st-1',
    connectionId: 'c1',
    kind: 'structure',
    title: 'orders (Structure)',
    database: 'app',
    schema: 'public',
    table: 'orders',
    structure: {
      database: 'app',
      schema: 'public',
      table: 'orders',
      columns: [{ name: 'id', dataType: 'bigint', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true }],
      indexes: [],
      foreignKeys: [],
      checkConstraints: [],
      createDdl: 'CREATE TABLE orders (id bigint);',
      engine: 'InnoDB',
      rowCountEstimate: 1200,
    },
    triggers: [],
    partitions: [{ name: 'p2026', method: 'RANGE', bound: 'VALUES LESS THAN (2027)', rowCountEstimate: 600, sizeBytes: 65536 }],
    activeSubTab: 'partitions',
    pendingDiff: {},
    loading: false,
    applying: false,
  };
  const html2 = renderToStaticMarkup(
    React.createElement(StructureDesignerTab, {
      tab: structTab,
      session,
      t: (k) => k,
      onUpdateTab: () => {},
      onReload: () => {},
      onPreviewAlter: () => {},
      onApplyAlter: () => {},
      onOpenData: () => {},
    }),
  );
  assert.match(html2, /Partitions \(1\)/);
  assert.match(html2, /p2026/);
  assert.equal(/<svg\b|<canvas\b/i.test(html2), false);
});

test('Iteration 2: buildDropObjectSql distinguishes procedure/function and PG trigger ON table', async () => {
  const { buildDropObjectSql } = await import('../src/drivers/sqlDialect');
  assert.equal(
    buildDropObjectSql('postgres', 'app', 'public', 'recalc_orders', 'procedure', false),
    'DROP PROCEDURE IF EXISTS "public"."recalc_orders";',
  );
  assert.equal(
    buildDropObjectSql('postgres', 'app', 'public', 'calc_tax', 'function', true),
    'DROP FUNCTION IF EXISTS "public"."calc_tax" CASCADE;',
  );
  assert.equal(
    buildDropObjectSql('mysql', 'shop', 'shop', 'sp_sync', 'procedure', false),
    'DROP PROCEDURE IF EXISTS `shop`.`sp_sync`;',
  );
  assert.equal(
    buildDropObjectSql('mssql', 'app', 'dbo', 'fn_total', 'function', false),
    'DROP FUNCTION IF EXISTS [app].[dbo].[fn_total];',
  );
  assert.equal(
    buildDropObjectSql('postgres', 'app', 'public', 'trg_audit', 'trigger', false, 'orders'),
    'DROP TRIGGER IF EXISTS "trg_audit" ON "public"."orders";',
  );
  assert.equal(
    buildDropObjectSql('postgres', 'app', 'public', 'trg_audit', 'trigger', true, 'orders'),
    'DROP TRIGGER IF EXISTS "trg_audit" ON "public"."orders" CASCADE;',
  );
});

test('Iteration 2: mq routes to Pulsar and gbase8c routes to PostgreSQL wire driver', async () => {
  const { createDriver } = await import('../src/drivers/index');
  const { createDriverAsync } = await import('../src/drivers/lazyFactory');
  const { makeDefaultConnection, buildDriverConfig } = await import('../src/ui/sessionManager');

  const mqSync = createDriver('mq');
  const mqAsync = await createDriverAsync('mq');
  assert.equal(mqSync.family, 'mq');
  assert.equal(mqSync.engine, 'pulsar');
  assert.equal(mqAsync.family, 'mq');
  assert.equal(mqAsync.engine, 'pulsar');

  const gbaseSync = createDriver('gbase8c');
  const gbaseAsync = await createDriverAsync('gbase8c');
  assert.equal(gbaseSync.family, 'postgres');
  assert.equal(gbaseSync.engine, 'gbase8c');
  assert.equal(gbaseAsync.family, 'postgres');

  const gbConn = makeDefaultConnection('gbase8c');
  assert.equal(gbConn.variant, 'gbase-8c-pg');
  const gbCfg = buildDriverConfig(gbConn, 'pw');
  assert.equal(gbCfg.variant, 'gbase-8c-pg');
  assert.throws(() => buildDriverConfig({ ...gbConn, variant: 'gbase-8c' }, 'pw'), /not packaged yet/i);

  assert.equal(makeDefaultConnection('cloudflare-d1').tlsMode, 'require');
  assert.equal(makeDefaultConnection('databricks').tlsMode, 'require');
  assert.equal(makeDefaultConnection('dynamodb').tlsMode, 'require');
});

test('Iteration 2: OceanBase Oracle metadata queries & specialized object introspection', async () => {
  const { MysqlDriver } = await import('../src/drivers/mysqlDriver');
  const { PostgresDriver } = await import('../src/drivers/postgresDriver');
  const { ClickHouseDriver } = await import('../src/drivers/clickhouseDriver');
  const { MssqlDriver } = await import('../src/drivers/mssqlDriver');
  const { SqliteDriver } = await import('../src/drivers/sqliteDriver');

  // 1. OceanBase Oracle branches in MysqlDriver
  const ob = new MysqlDriver('oceanbase-oracle');
  const obQueries: string[] = [];
  (ob as unknown as { query: (sql: string) => Promise<unknown> }).query = async (sql: string) => {
    obQueries.push(sql);
    if (sql.includes('ALL_USERS')) return { results: [{ rows: [['HR'], ['SALES']] }], totalExecutionMs: 1 };
    if (sql.includes('ALL_TRIGGERS')) {
      return { results: [{ rows: [['TRG_EMP', 'EMPLOYEES', 'BEFORE EACH ROW', 'INSERT', 'BEGIN NULL; END;', 'ENABLED']] }], totalExecutionMs: 1 };
    }
    if (sql.includes('ALL_TAB_COLUMNS')) {
      return { results: [{ rows: [['ID', 'NUMBER', 'N', null, 22, 10, 0, 1], ['NAME', 'VARCHAR2', 'Y', null, 128, null, null, 0]] }], totalExecutionMs: 1 };
    }
    if (sql.includes('DBMS_METADATA.GET_DDL')) {
      return { results: [{ rows: [['CREATE TABLE "HR"."EMPLOYEES" ("ID" NUMBER(10));']] }], totalExecutionMs: 1 };
    }
    return { results: [{ rows: [] }], totalExecutionMs: 1 };
  };
  const obDbs = await ob.listDatabases();
  assert.deepEqual(obDbs.map((d) => d.name), ['HR', 'SALES']);
  const obTrgs = await ob.listTriggers('hr');
  assert.equal(obTrgs[0]?.name, 'TRG_EMP');
  assert.equal(obTrgs[0]?.timing, 'BEFORE');
  const obStruct = await ob.getTableStructure('hr', 'hr', 'employees');
  assert.equal(obStruct.columns[0]?.dataType, 'NUMBER(10)');
  assert.equal(obStruct.columns[1]?.dataType, 'VARCHAR2(128)');
  const obDdl = await ob.getObjectDefinition('hr', 'hr', 'employees', 'table');
  assert.match(obDdl, /CREATE TABLE "HR"\."EMPLOYEES"/);
  assert.equal(obQueries.some((q) => q.includes('ALL_USERS')), true);
  assert.equal(obQueries.some((q) => q.includes('ALL_TRIGGERS')), true);
  assert.equal(obQueries.some((q) => q.includes('ALL_TAB_COLUMNS')), true);
  assert.equal(obQueries.some((q) => q.includes('DBMS_METADATA.GET_DDL')), true);

  // 2. PG Event Triggers & Rules
  const pg = new PostgresDriver('postgres');
  (pg as unknown as { query: (sql: string) => Promise<unknown> }).query = async (sql: string) => {
    if (sql.includes('pg_event_trigger')) {
      return { results: [{ rows: [['audit_ddl', 'ddl_command_end', 'fn_audit_ddl', 'O', ['CREATE TABLE']]] }], totalExecutionMs: 1 };
    }
    if (sql.includes('pg_rules')) {
      return { results: [{ rows: [['protect_delete', 'orders', 'CREATE RULE protect_delete AS ON DELETE TO orders DO INSTEAD NOTHING;']] }], totalExecutionMs: 1 };
    }
    return { results: [{ rows: [] }], totalExecutionMs: 1 };
  };
  const evtTrgs = await pg.listEventTriggers();
  assert.equal(evtTrgs.length, 1);
  assert.equal(evtTrgs[0]?.name, 'audit_ddl');
  assert.match(evtTrgs[0]?.definition ?? '', /CREATE EVENT TRIGGER/);
  const rules = await pg.listRules('app', 'public');
  assert.equal(rules.length, 1);
  assert.equal(rules[0]?.name, 'protect_delete');

  // 3. ClickHouse Dictionaries
  const ch = new ClickHouseDriver();
  (ch as unknown as { query: (sql: string) => Promise<unknown> }).query = async () => ({
    results: [{ rows: [['country_dict', 'default', 'Hashed', 'LOADED', 'HTTP', 249]] }],
    totalExecutionMs: 1,
  });
  const dicts = await ch.listDictionaries('default');
  assert.equal(dicts[0]?.name, 'country_dict');
  assert.equal(dicts[0]?.elementCount, 249);

  // 4. MSSQL Linked Servers
  const mssql = new MssqlDriver();
  (mssql as unknown as { query: (sql: string) => Promise<unknown> }).query = async () => ({
    results: [{ rows: [['ERP_PROD', 'SQL Server', 'MSOLEDBSQL', 'erp.internal', 'erp_db']] }],
    totalExecutionMs: 1,
  });
  const linked = await mssql.listLinkedServers();
  assert.equal(linked[0]?.name, 'ERP_PROD');
  assert.equal(linked[0]?.dataSource, 'erp.internal');

  // 5. Live SQLite schema-level indexes
  const sq = new SqliteDriver();
  await sq.connect({ id: 'sq-idx', name: 'sq', engine: 'sqlite', sqliteSeedDemo: false });
  await sq.query('CREATE TABLE t_items (id INTEGER PRIMARY KEY, code TEXT, price REAL); CREATE UNIQUE INDEX idx_items_code ON t_items(code);');
  const sqIndexes = await sq.listSchemaIndexes('memory', 'main');
  assert.equal(sqIndexes.some((ix) => ix.name === 'idx_items_code' && ix.unique && ix.tableName === 't_items'), true);
  await sq.close();
});

test('Iteration 2: ConnectionDrawer exposes messaging category, cloud/MQ fields, and variant selector', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ConnectionDrawer } = await import('../src/ui/components/ConnectionDrawer');
  const { makeDefaultConnection } = await import('../src/ui/sessionManager');
  const dummyContext = {} as unknown as import('@netcatty/plugin-sdk').PluginContext;

  const pickerHtml = renderToStaticMarkup(
    React.createElement(ConnectionDrawer, {
      context: dummyContext,
      theme: 'dark',
      t: (k) => k,
      editingConnection: null,
      onClose: () => {},
      onSave: async () => {},
    }),
  );
  assert.match(pickerHtml, /Messaging \/ MQ/);
  const renderedTiles = (pickerHtml.match(/class="ndb-engine-tile(?:\s|")/g) ?? []).length;
  assert.equal(renderedTiles > 0 && renderedTiles <= 24, true, `expected <= 24 bounded tiles, got ${renderedTiles}`);
  assert.match(pickerHtml, /1–24 \/ 113/);
  assert.equal(Buffer.byteLength(pickerHtml, 'utf8') < 25000, true, 'picker markup must stay well below host-ui 128 KiB JSON budget');

  const renderFormFor = (engine: import('../src/driverRegistry').DriverId) =>
    renderToStaticMarkup(
      React.createElement(ConnectionDrawer, {
        context: dummyContext,
        theme: 'dark',
        t: (k) => k,
        editingConnection: makeDefaultConnection(engine),
        onClose: () => {},
        onSave: async () => {},
      }),
    );

  assert.match(renderFormFor('cloudflare-d1'), /Account \/ Project ID/);
  assert.match(renderFormFor('databricks'), /Warehouse ID/);
  assert.match(renderFormFor('dynamodb'), /Region/);
  assert.match(renderFormFor('rabbitmq'), /Virtual Host/);
  assert.match(renderFormFor('mongodb-legacy'), /Auth Source/);
  const gbaseHtml = renderFormFor('gbase8c');
  assert.match(gbaseHtml, /Protocol Variant/);
  assert.match(gbaseHtml, /GBase 8c \/ PG-compatible mode/);
  assert.equal(/<svg\b|<canvas\b/i.test(gbaseHtml), false);
});

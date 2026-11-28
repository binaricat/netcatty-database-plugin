/**
 * Unit & Live SQLite Integration Tests for all 7 Native Catty Agent Database Tools
 * (`db_list_connections`, `db_list_tables`, `db_describe_table`, `db_run_readonly_sql`,
 *  `db_create_bi_chart`, `db_pin_chart_to_dashboard`, `db_open_sql_tab`)
 * + `buildDatabaseAgentContext` + `registerDatabaseAgentSidebar`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  PluginAIToolDefinition,
  PluginAIToolExecutor,
  PluginBiChartToolArtifact,
  PluginContext,
  PluginSqlResultToolArtifact,
} from '@netcatty/plugin-sdk';
import {
  AI_SIDEBAR_TOOLS_FEATURE,
  buildDatabaseAgentContext,
  DATABASE_AGENT_TOOLS,
  DATABASE_WORKBENCH_VIEW_ID,
  executeDatabaseAgentTool,
  registerDatabaseAgentSidebar,
  type DatabaseAgentHostBridge,
} from '../src/ai/databaseAgentTools';
import { SqliteDriver } from '../src/drivers/sqliteDriver';
import type { ActiveSession, SavedConnection } from '../src/ui/types';

function makeSavedConnection(): SavedConnection {
  return {
    id: 'conn-demo',
    name: 'Sample Shop SQLite',
    group: 'Local',
    color: 'emerald',
    engine: 'sqlite',
    host: '',
    port: 0,
    database: 'main',
    schema: 'main',
    username: '',
    hasPassword: false,
    apiKey: 'secret-should-never-leak',
    readOnly: false,
    tlsMode: 'disable',
    allowSelfSigned: false,
    redisDb: 0,
    authSource: '',
    httpPath: '',
    sqliteMode: 'demo',
    sqliteFileName: 'shop_demo.sqlite',
    sshTunnel: { enabled: false },
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };
}

test('DATABASE_AGENT_TOOLS defines all 7 bounded tools with valid JSON schemas', () => {
  const names = DATABASE_AGENT_TOOLS.map((t) => t.name);
  assert.deepEqual(names, [
    'db_list_connections',
    'db_list_tables',
    'db_describe_table',
    'db_run_readonly_sql',
    'db_create_bi_chart',
    'db_pin_chart_to_dashboard',
    'db_open_sql_tab',
  ]);
  for (const tool of DATABASE_AGENT_TOOLS) {
    assert.equal(tool.viewId, DATABASE_WORKBENCH_VIEW_ID);
    assert.equal(tool.risk, 'read');
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 20);
  }
});

test('all 7 Database Agent tools execute cleanly against live SQLite, enforce read-only, and emit official inline artifacts', async () => {
  const driver = new SqliteDriver();
  const info = await driver.connect({
    engine: 'sqlite',
    database: 'main',
    sqliteSeedDemo: true,
  });

  try {
    const conn = makeSavedConnection();
    const tables = await driver.listTables('main', 'main');
    const views = await driver.listViews('main', 'main');
    const structures: ActiveSession['objectsBySchema'][string]['structures'] = {};
    for (const tb of tables) {
      structures[tb.name] = await driver.getTableStructure('main', 'main', tb.name);
    }

    const session: ActiveSession = {
      connectionId: conn.id,
      connection: conn,
      driver,
      family: 'sqlite',
      info,
      databases: [{ name: 'main' }],
      activeDatabase: 'main',
      schemas: [{ name: 'main' }],
      activeSchema: 'main',
      objectsBySchema: {
        'main::main': {
          tables,
          views,
          routines: [],
          triggers: [],
          structures,
          loaded: true,
          loading: false,
        },
      },
      mongoCollectionsByDb: {},
    };

    const openedSqlTabs: Array<{ connectionId: string; sql: string; title?: string }> = [];
    const pinnedCharts: Array<{ connectionId: string; title: string; sql: string; chartType: string; rowCount: number }> = [];

    const bridge: DatabaseAgentHostBridge = {
      getConnections: () => [conn],
      getSessions: () => ({ [conn.id]: session }),
      getActiveConnectionId: () => conn.id,
      getActiveSql: () => 'SELECT * FROM orders LIMIT 10;',
      getLocale: () => 'en',
      openSqlTab: (connectionId, sql, title) => {
        openedSqlTabs.push({ connectionId, sql, title });
      },
      pinChartToDashboard: async (connectionId, payload) => {
        pinnedCharts.push({
          connectionId,
          title: payload.title,
          sql: payload.sql,
          chartType: payload.chartConfig.type,
          rowCount: payload.result.rowCount,
        });
      },
      ensureSchemaLoaded: async () => {},
    };

    // 1. db_list_connections (never leaks apiKey/secrets)
    const connList = await executeDatabaseAgentTool('db_list_connections', {}, bridge);
    assert.equal(connList.activeConnectionId, 'conn-demo');
    assert.equal(JSON.stringify(connList).includes('secret-should-never-leak'), false);
    assert.equal((connList.connections as Array<{ connected: boolean }>)[0].connected, true);

    // 2. db_list_tables
    const tableList = await executeDatabaseAgentTool('db_list_tables', {}, bridge);
    const listedNames = (tableList.tables as Array<{ name: string }>).map((t) => t.name);
    assert.ok(listedNames.includes('customers'));
    assert.ok(listedNames.includes('orders'));
    assert.ok(listedNames.includes('products'));

    // 3. db_describe_table
    const desc = await executeDatabaseAgentTool('db_describe_table', { table: 'orders' }, bridge);
    const colNames = (desc.columns as Array<{ name: string }>).map((c) => c.name);
    assert.ok(colNames.includes('total_amount'));
    assert.ok((desc.foreignKeys as Array<{ referencedTable: string }>).some((fk) => fk.referencedTable === 'customers'));

    // 4. db_run_readonly_sql (happy path + official sql-result artifact with openAction & chartAction)
    const queryRes = await executeDatabaseAgentTool(
      'db_run_readonly_sql',
      { sql: 'SELECT status, COUNT(*) AS cnt, SUM(total_amount) AS revenue FROM orders GROUP BY status', limit: 50 },
      bridge,
    );
    assert.match(String(queryRes.sql), /LIMIT 50$/);
    assert.equal(queryRes.rowCount, 3);
    const sqlArtifact = queryRes._netcattyArtifact as unknown as PluginSqlResultToolArtifact;
    assert.equal(sqlArtifact.kind, 'sql-result');
    assert.deepEqual(sqlArtifact.columns, ['status', 'cnt', 'revenue']);
    assert.equal(sqlArtifact.openAction?.toolName, 'db_open_sql_tab');
    assert.equal(sqlArtifact.chartAction?.toolName, 'db_create_bi_chart');

    // 4b. db_run_readonly_sql blocks writes/DDL
    await assert.rejects(
      () => executeDatabaseAgentTool('db_run_readonly_sql', { sql: 'DELETE FROM orders' }, bridge),
      /Read-only SQL guard blocked/i,
    );
    await assert.rejects(
      () => executeDatabaseAgentTool('db_run_readonly_sql', { sql: 'SELECT 1; DROP TABLE orders' }, bridge),
      /Read-only SQL guard blocked/i,
    );

    // 5. db_create_bi_chart (produces official inline bi-chart artifact + KPIs + pinAction + openAction)
    const chartRes = await executeDatabaseAgentTool(
      'db_create_bi_chart',
      {
        sql: 'SELECT c.tier, SUM(o.total_amount) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.id GROUP BY c.tier ORDER BY revenue DESC',
        title: 'Revenue by Tier',
        chartType: 'donut',
        valueFormat: 'currency',
      },
      bridge,
    );
    assert.equal(chartRes.chartType, 'donut');
    const chartArtifact = chartRes._netcattyArtifact as unknown as PluginBiChartToolArtifact;
    assert.equal(chartArtifact.kind, 'bi-chart');
    assert.equal(chartArtifact.title, 'Revenue by Tier');
    assert.equal(chartArtifact.chartSpec.type, 'donut');
    assert.ok(Array.isArray(chartArtifact.chartSpec.series) && chartArtifact.chartSpec.series.length === 1);
    assert.ok((chartArtifact.kpis?.length ?? 0) >= 3);
    assert.equal(typeof chartArtifact.kpis?.[0].value, 'string');
    assert.equal(chartArtifact.pinAction?.toolName, 'db_pin_chart_to_dashboard');
    assert.equal(chartArtifact.openAction?.toolName, 'db_open_sql_tab');

    // 6. db_pin_chart_to_dashboard (executes SQL & calls host pin callback)
    const pinRes = await executeDatabaseAgentTool(
      'db_pin_chart_to_dashboard',
      chartArtifact.pinAction!.args,
      bridge,
    );
    assert.equal(pinRes.pinned, true);
    assert.equal(pinnedCharts.length, 1);
    assert.equal(pinnedCharts[0].title, 'Revenue by Tier');
    assert.equal(pinnedCharts[0].chartType, 'donut');

    // 7. db_open_sql_tab (drafts write/DDL SQL safely without executing)
    const openRes = await executeDatabaseAgentTool(
      'db_open_sql_tab',
      { sql: "UPDATE orders SET status = 'paid' WHERE id = 3;", title: 'Mark Order 3 Paid' },
      bridge,
    );
    assert.equal(openRes.opened, true);
    assert.equal(openedSqlTabs.length, 1);
    assert.equal(openedSqlTabs[0].title, 'Mark Order 3 Paid');

    // Confirm orders table was never mutated!
    const countCheck = await driver.query("SELECT COUNT(*) FROM orders WHERE status = 'pending'");
    assert.equal(countCheck.results[0].rows[0][0], 1);

    // 8. buildDatabaseAgentContext (EN + zh-CN, official { label, prompt }[] starter chips, <= 10 KB)
    const ctxEn = buildDatabaseAgentContext({
      session,
      connectionsCount: 1,
      activeSql: 'SELECT * FROM orders LIMIT 10;',
      locale: 'en',
    });
    assert.equal(ctxEn.viewId, DATABASE_WORKBENCH_VIEW_ID);
    assert.equal(ctxEn.title, 'Sample Shop SQLite');
    assert.ok(ctxEn.summary?.includes('orders'));
    assert.ok(new TextEncoder().encode(ctxEn.summary ?? '').length <= 10_000);
    assert.ok((ctxEn.suggestedPrompts?.length ?? 0) >= 2);
    assert.equal(typeof ctxEn.suggestedPrompts?.[0].label, 'string');
    assert.equal(typeof ctxEn.suggestedPrompts?.[0].prompt, 'string');

    const ctxZh = buildDatabaseAgentContext({
      session,
      connectionsCount: 1,
      activeSql: '',
      locale: 'zh-CN',
    });
    assert.ok(ctxZh.suggestedPrompts?.some((p) => /[\u4e00-\u9fff]/.test(p.label)));

    // 9. registerDatabaseAgentSidebar wires context.ai.registerTools & disposes cleanly
    let registeredTools: readonly PluginAIToolDefinition[] = [];
    let registeredExecutor: PluginAIToolExecutor | null = null;
    let disposed = false;
    const mockCtx = {
      enabledFeatures: new Set([AI_SIDEBAR_TOOLS_FEATURE]),
      ai: {
        async registerTools(tools: readonly PluginAIToolDefinition[], executor: PluginAIToolExecutor) {
          registeredTools = tools;
          registeredExecutor = executor;
          return {
            dispose() {
              disposed = true;
            },
          };
        },
      },
    } as unknown as PluginContext;

    const reg = await registerDatabaseAgentSidebar(mockCtx, bridge);
    assert.equal(registeredTools.length, 7);
    assert.ok(registeredExecutor !== null);
    const viaExec = await (registeredExecutor as PluginAIToolExecutor)('db_list_connections', {}, {
      viewId: DATABASE_WORKBENCH_VIEW_ID,
      cancellationToken: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
    });
    assert.equal((viaExec as Record<string, unknown>).activeConnectionId, 'conn-demo');
    reg.dispose();
    assert.equal(disposed, true);
  } finally {
    await driver.close();
  }
});

test('Database Agent tools and context support native MongoDB aggregation BI and enforce read-only pipelines', async () => {
  const mongoConn: SavedConnection = {
    ...makeSavedConnection(),
    id: 'conn-mongo',
    name: 'Analytics MongoDB',
    engine: 'mongodb',
    host: '127.0.0.1',
    port: 27017,
    database: 'analytics',
    schema: '',
    authSource: 'admin',
  };

  const executedPipelines: Array<{ db: string; coll: string; pipeline: Record<string, unknown>[] }> = [];
  const mockMongoDriver = {
    family: 'mongodb' as const,
    async listCollections() {
      return [
        { name: 'orders', type: 'collection' },
        { name: 'customers', type: 'collection' },
      ];
    },
    async analyzeCollectionSchema(db: string, coll: string) {
      return {
        database: db,
        collection: coll,
        sampleCount: 50,
        totalDocuments: 1200,
        fields: [
          { path: '_id', count: 50, percentage: 100, types: [{ type: 'ObjectId', count: 50, percentage: 100 }], samples: ['65f1a2b3'] },
          { path: 'tier', count: 50, percentage: 100, types: [{ type: 'string', count: 50, percentage: 100 }], samples: ['enterprise', 'pro'] },
          { path: 'total', count: 50, percentage: 100, types: [{ type: 'double', count: 50, percentage: 100 }], samples: ['249.5', '99.0'] },
        ],
      };
    },
    async listIndexes() {
      return [{ name: '_id_', key: { _id: 1 }, unique: true }];
    },
    async aggregate(db: string, coll: string, pipeline: Record<string, unknown>[]) {
      executedPipelines.push({ db, coll, pipeline });
      return [
        { _id: 'enterprise', revenue: 4800.5, orders: 22 },
        { _id: 'pro', revenue: 2150.0, orders: 15 },
        { _id: 'starter', revenue: 640.0, orders: 12 },
      ];
    },
  };

  const mongoSession: ActiveSession = {
    connectionId: mongoConn.id,
    connection: mongoConn,
    driver: mockMongoDriver as unknown as ActiveSession['driver'],
    family: 'mongodb',
    info: {
      engine: 'mongodb',
      family: 'mongodb',
      serverVersion: 'MongoDB 7.0',
      database: 'analytics',
      tlsActive: false,
      latencyMs: 3,
    },
    databases: [{ name: 'analytics' }],
    activeDatabase: 'analytics',
    schemas: [],
    activeSchema: '',
    objectsBySchema: {},
    mongoCollectionsByDb: {
      analytics: [
        { name: 'orders', type: 'collection' },
        { name: 'customers', type: 'collection' },
      ],
    },
  };

  const pinnedCharts: Array<{ connectionId: string; title: string; sql: string; chartType: string; rowCount: number }> = [];
  const bridge: DatabaseAgentHostBridge = {
    getConnections: () => [mongoConn],
    getSessions: () => ({ [mongoConn.id]: mongoSession }),
    getActiveConnectionId: () => mongoConn.id,
    getActiveSql: () => '',
    getLocale: () => 'en',
    openSqlTab: () => {},
    pinChartToDashboard: async (connectionId, payload) => {
      pinnedCharts.push({
        connectionId,
        title: payload.title,
        sql: payload.sql,
        chartType: payload.chartConfig.type,
        rowCount: payload.result.rowCount,
      });
    },
    ensureSchemaLoaded: async () => {},
  };

  // Context mentions collections & JSON aggregation format (EN + zh-CN)
  const ctxEn = buildDatabaseAgentContext({
    session: mongoSession,
    connectionsCount: 1,
    activeSql: '',
    locale: 'en',
  });
  assert.ok(ctxEn.summary?.includes('orders'));
  assert.ok(ctxEn.summary?.includes('pipeline'));
  assert.ok((ctxEn.suggestedPrompts?.length ?? 0) >= 2);

  const ctxZh = buildDatabaseAgentContext({
    session: mongoSession,
    connectionsCount: 1,
    activeSql: '',
    locale: 'zh-CN',
  });
  assert.ok(ctxZh.suggestedPrompts?.some((p) => /[\u4e00-\u9fff]/.test(p.label)));

  // db_list_tables lists collections
  const listed = await executeDatabaseAgentTool('db_list_tables', {}, bridge);
  assert.equal(listed.family, 'mongodb');
  assert.deepEqual(
    (listed.tables as Array<{ name: string }>).map((t) => t.name),
    ['orders', 'customers'],
  );

  // db_describe_table returns sampled field schema + indexes
  const desc = await executeDatabaseAgentTool('db_describe_table', { table: 'orders' }, bridge);
  assert.equal(desc.collection, 'orders');
  assert.ok((desc.columns as Array<{ name: string }>).some((c) => c.name === 'total'));
  assert.equal((desc.indexes as Array<{ name: string }>)[0].name, '_id_');

  const aggQuery = JSON.stringify({
    collection: 'orders',
    pipeline: [{ $group: { _id: '$tier', revenue: { $sum: '$total' }, orders: { $sum: 1 } } }],
  });

  // db_run_readonly_sql executes read-only aggregation & emits sql-result artifact
  const runRes = await executeDatabaseAgentTool('db_run_readonly_sql', { sql: aggQuery, limit: 100 }, bridge);
  assert.equal(runRes.collection, 'orders');
  assert.equal(runRes.rowCount, 3);
  const sqlArtifact = runRes._netcattyArtifact as unknown as PluginSqlResultToolArtifact;
  assert.equal(sqlArtifact.kind, 'sql-result');
  assert.deepEqual(sqlArtifact.columns, ['_id', 'revenue', 'orders']);
  assert.equal(sqlArtifact.chartAction?.toolName, 'db_create_bi_chart');

  // Read-only guard rejects $out and $merge
  await assert.rejects(
    () =>
      executeDatabaseAgentTool(
        'db_run_readonly_sql',
        { sql: JSON.stringify({ collection: 'orders', pipeline: [{ $out: 'evil_copy' }] }) },
        bridge,
      ),
    /blocked write stage "\$out"/i,
  );
  await assert.rejects(
    () =>
      executeDatabaseAgentTool(
        'db_create_bi_chart',
        { sql: JSON.stringify({ collection: 'orders', pipeline: [{ $merge: { into: 'evil' } }] }) },
        bridge,
      ),
    /blocked write stage "\$merge"/i,
  );

  // db_create_bi_chart produces official inline bi-chart artifact + KPIs + pinAction
  const chartRes = await executeDatabaseAgentTool(
    'db_create_bi_chart',
    { sql: aggQuery, title: 'MongoDB Revenue by Tier', chartType: 'bar', valueFormat: 'currency' },
    bridge,
  );
  assert.equal(chartRes.collection, 'orders');
  assert.equal(chartRes.chartType, 'bar');
  const chartArtifact = chartRes._netcattyArtifact as unknown as PluginBiChartToolArtifact;
  assert.equal(chartArtifact.kind, 'bi-chart');
  assert.equal(chartArtifact.title, 'MongoDB Revenue by Tier');
  assert.equal(chartArtifact.chartSpec.type, 'bar');
  assert.ok((chartArtifact.kpis?.length ?? 0) >= 3);
  assert.equal(chartArtifact.pinAction?.toolName, 'db_pin_chart_to_dashboard');

  // db_pin_chart_to_dashboard pins MongoDB chart cleanly
  const pinRes = await executeDatabaseAgentTool('db_pin_chart_to_dashboard', chartArtifact.pinAction!.args, bridge);
  assert.equal(pinRes.pinned, true);
  assert.equal(pinnedCharts.length, 1);
  assert.equal(pinnedCharts[0].connectionId, 'conn-mongo');
  assert.equal(pinnedCharts[0].title, 'MongoDB Revenue by Tier');
  assert.equal(pinnedCharts[0].rowCount, 3);
  assert.ok(executedPipelines.length >= 3);
});

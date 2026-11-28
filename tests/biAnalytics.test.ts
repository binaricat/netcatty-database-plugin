/**
 * Comprehensive Unit & SSR UI Tests for the AI BI Analytics & Charting Studio.
 * Covers:
 * - Strict Read-Only SQL Guard (single-stmt, DML/DDL/tx/EXPLAIN ANALYZE rejection, auto-LIMIT/TOP)
 * - Zero-AI Column Profiler, Chart Recommender (10 types), Aggregator, Top-N Rollup, Cross-Filter, Quick X-Ray
 * - Schema-Grounded AI BI Pipeline (context budgeting, tolerant JSON parsing, live SQLite execution, 1-shot auto-repair, write-SQL blocking)
 * - Markdown & JSON Report Export + Dashboard Storage Persistence
 * - SSR UI Rendering of `BiAnalyticsTab` & `SqlQueryTab` Chart tab (verifying `data-plugin-widget="bi-chart"` & ZERO inline `<svg>`/`<canvas>`)
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PluginAIClient, PluginContext } from '@netcatty/plugin-sdk';
import {
  appendMongoSafeLimit,
  applyCrossFilter,
  assertReadOnlyMongoPipeline,
  buildBiChartProps,
  buildBiSchemaContext,
  buildTableStarterQueries,
  exportBiDashboardJson,
  exportBiReportMarkdown,
  flattenMongoDocsToResultSet,
  formatMongoBiQuery,
  parseBiAiResponse,
  parseMongoBiQuery,
  profileColumns,
  recommendChartConfig,
  runBiAiAnalysis,
  validateBiReadOnlySql,
  type BiAnalysisCard,
} from '../src/bi/index';
import type { QueryResultSet, TableStructure } from '../src/drivers/types';
import { SqliteDriver } from '../src/drivers/sqliteDriver';
import { createUiTranslator } from '../src/ui/i18n';
import { WorkbenchStorage } from '../src/ui/storage';
import type { ActiveSession, BiAnalyticsTabState, MongoWorkbenchTabState, SqlQueryTabState } from '../src/ui/types';

// @remote-dom/core / browser globals stub for Node SSR tests
const g = globalThis as Record<string, unknown>;
for (const name of ['HTMLElement', 'Element', 'Node', 'MutationObserver', 'DocumentFragment', 'Text', 'Comment']) {
  if (typeof g[name] === 'undefined') g[name] = class {};
}

const [{ BiAnalyticsTab }, { SqlQueryTab }, { MongoWorkbenchTab }] = await Promise.all([
  import('../src/ui/components/BiAnalyticsTab'),
  import('../src/ui/components/SqlQueryTab'),
  import('../src/ui/components/MongoWorkbenchTab'),
]);

function makeResult(columns: Array<{ name: string; dataType: string; isPrimaryKey?: boolean }>, rows: unknown[][]): QueryResultSet {
  return {
    columns: columns.map((c) => ({
      name: c.name,
      dataType: c.dataType,
      nullable: true,
      isPrimaryKey: Boolean(c.isPrimaryKey),
    })),
    rows: rows as QueryResultSet['rows'],
    rowCount: rows.length,
    affectedRows: 0,
    executionMs: 4,
    truncated: false,
    sql: 'SELECT 1',
  };
}

function makeMockAi(responses: string[]): PluginAIClient {
  let idx = 0;
  const turnText = new Map<string, { text: string; pos: number }>();
  return {
    async openChat() {
      return { chatHandle: `chat-${idx}`, model: 'test-bi-model', expiresAt: Date.now() + 60_000 };
    },
    async startTurn() {
      const text = responses[Math.min(idx++, responses.length - 1)] ?? '';
      const handle = `turn-${idx}`;
      turnText.set(handle, { text, pos: 0 });
      return { turnHandle: handle, maxOutputTokens: 2048 as const, reservedTokens: 256 };
    },
    async readTurn({ turnHandle }) {
      const st = turnText.get(turnHandle);
      if (!st || st.pos > 0) {
        return { sequence: 2, kind: 'end' };
      }
      st.pos = 1;
      return { sequence: 1, kind: 'text', text: st.text };
    },
    async stopTurn() {
      return { ok: true };
    },
    async closeChat() {
      return { ok: true };
    },
    async registerTools() {
      return { dispose() {} };
    },
    async setContext() {},
    async clearContext() {},
    async openSidebar() {},
    async closeSidebar() {},
  };
}

/* ============================================================================
 * 1. Read-Only SQL Guard
 * ============================================================================ */

test('validateBiReadOnlySql allows read queries and auto-appends safe row limit', () => {
  const sel = validateBiReadOnlySql('SELECT status, SUM(total_amount) FROM orders GROUP BY status;', 'postgres');
  assert.equal(sel.ok, true);
  if (sel.ok) {
    assert.equal(sel.limitApplied, true);
    assert.match(sel.safeSql, /\bLIMIT 500$/);
  }

  const withLimit = validateBiReadOnlySql('SELECT * FROM orders LIMIT 25', 'sqlite');
  assert.equal(withLimit.ok, true);
  if (withLimit.ok) {
    assert.equal(withLimit.limitApplied, false);
    assert.equal(withLimit.safeSql, 'SELECT * FROM orders LIMIT 25');
  }

  // Nested subquery LIMIT must still get an outer LIMIT
  const nested = validateBiReadOnlySql('SELECT * FROM (SELECT * FROM orders LIMIT 10) sub', 'postgres');
  assert.equal(nested.ok, true);
  if (nested.ok) {
    assert.equal(nested.limitApplied, true);
    assert.match(nested.safeSql, /\bLIMIT 500$/);
  }

  // SQL Server uses TOP
  const mssql = validateBiReadOnlySql('SELECT status, COUNT(*) AS cnt FROM orders GROUP BY status', 'mssql');
  assert.equal(mssql.ok, true);
  if (mssql.ok) {
    assert.equal(mssql.limitApplied, true);
    assert.match(mssql.safeSql, /^SELECT TOP 500 /i);
  }

  // Read-only CTE
  const cte = validateBiReadOnlySql('WITH agg AS (SELECT status, COUNT(*) c FROM orders GROUP BY status) SELECT * FROM agg', 'postgres');
  assert.equal(cte.ok, true);
});

test('validateBiReadOnlySql blocks writes, DDL, transactions, EXPLAIN ANALYZE, and multi-statement injection', () => {
  const blocked = [
    'DELETE FROM orders',
    'UPDATE orders SET status = "paid" WHERE id = 1',
    'INSERT INTO orders (customer_id, status, total_amount) VALUES (1, "paid", 10)',
    'DROP TABLE orders',
    'ALTER TABLE orders ADD COLUMN x INT',
    'TRUNCATE TABLE orders',
    'BEGIN',
    'COMMIT',
    'USE production',
    'PRAGMA journal_mode = WAL',
    'EXPLAIN ANALYZE SELECT * FROM orders',
    'SELECT * INTO backup_orders FROM orders',
    'WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d',
    'SELECT 1; DROP TABLE orders',
  ];

  for (const sql of blocked) {
    const res = validateBiReadOnlySql(sql, 'postgres');
    assert.equal(res.ok, false, `Expected "${sql}" to be blocked`);
  }
});

/* ============================================================================
 * 2. Deterministic Column Profiler, Chart Recommender & Aggregator
 * ============================================================================ */

test('recommendChartConfig picks optimal chart types across data shapes', () => {
  // Temporal + 1 numeric -> area
  const temporal1 = makeResult(
    [
      { name: 'day', dataType: 'DATE' },
      { name: 'revenue', dataType: 'REAL' },
    ],
    [
      ['2026-01-01', 1200],
      ['2026-01-02', 1450],
      ['2026-01-03', 1800],
    ],
  );
  assert.equal(recommendChartConfig(temporal1).type, 'area');

  // Temporal + 2 numerics -> line
  const temporal2 = makeResult(
    [
      { name: 'day', dataType: 'DATE' },
      { name: 'revenue', dataType: 'REAL' },
      { name: 'orders', dataType: 'INTEGER' },
    ],
    [
      ['2026-01-01', 1200, 14],
      ['2026-01-02', 1450, 18],
    ],
  );
  assert.equal(recommendChartConfig(temporal2).type, 'line');

  // Categorical <= 7 positive -> donut
  const smallCat = makeResult(
    [
      { name: 'region', dataType: 'TEXT' },
      { name: 'sales', dataType: 'REAL' },
    ],
    [
      ['APAC', 420],
      ['EMEA', 310],
      ['NA', 580],
    ],
  );
  assert.equal(recommendChartConfig(smallCat).type, 'donut');

  // Categorical 8..25 -> horizontal-bar
  const mediumCat = makeResult(
    [
      { name: 'country', dataType: 'TEXT' },
      { name: 'users', dataType: 'INTEGER' },
    ],
    Array.from({ length: 10 }, (_, i) => [`Country-${i + 1}`, (i + 1) * 100]),
  );
  assert.equal(recommendChartConfig(mediumCat).type, 'horizontal-bar');

  // Categorical + 2 numerics with >5x scale gap -> combo
  const comboData = makeResult(
    [
      { name: 'tier', dataType: 'TEXT' },
      { name: 'revenue', dataType: 'REAL' },
      { name: 'order_count', dataType: 'INTEGER' },
    ],
    [
      ['enterprise', 25000, 12],
      ['pro', 8400, 9],
      ['starter', 1200, 4],
    ],
  );
  assert.equal(recommendChartConfig(comboData).type, 'combo');

  // 2 categoricals + numeric -> stacked-bar
  const stackedData = makeResult(
    [
      { name: 'region', dataType: 'TEXT' },
      { name: 'tier', dataType: 'TEXT' },
      { name: 'revenue', dataType: 'REAL' },
    ],
    [
      ['APAC', 'pro', 100],
      ['APAC', 'enterprise', 300],
      ['EMEA', 'pro', 120],
      ['EMEA', 'enterprise', 240],
    ],
  );
  const stackedCfg = recommendChartConfig(stackedData);
  assert.equal(stackedCfg.type, 'stacked-bar');
  assert.equal(stackedCfg.groupByField, 'tier');

  // 2 numerics only -> scatter
  const scatterData = makeResult(
    [
      { name: 'price', dataType: 'REAL' },
      { name: 'stock', dataType: 'INTEGER' },
    ],
    [
      [149.99, 42],
      [89.5, 100],
      [29.0, 250],
    ],
  );
  assert.equal(recommendChartConfig(scatterData).type, 'scatter');

  // Monotonic stage column -> funnel
  const funnelData = makeResult(
    [
      { name: 'funnel_stage', dataType: 'TEXT' },
      { name: 'users', dataType: 'INTEGER' },
    ],
    [
      ['Visited', 1000],
      ['Signed Up', 420],
      ['Activated', 180],
      ['Paid', 65],
    ],
  );
  assert.equal(recommendChartConfig(funnelData).type, 'funnel');
});

test('buildBiChartProps aggregates SUM/AVG/COUNT/MIN/MAX, rolls up topN, and applies cross-filtering', () => {
  const result = makeResult(
    [
      { name: 'category', dataType: 'TEXT' },
      { name: 'amount', dataType: 'REAL' },
    ],
    [
      ['A', 100],
      ['A', 200],
      ['B', 50],
      ['C', 300],
      ['D', 40],
      ['E', 30],
      ['F', 20],
      ['G', 10],
      ['H', 5],
      ['I', 4],
      ['J', 3],
      ['K', 2],
    ],
  );

  const profiles = profileColumns(result.columns, result.rows);
  assert.equal(profiles[0].role, 'categorical');
  assert.equal(profiles[1].role, 'numeric');

  const baseCfg = recommendChartConfig(result);
  const sumBundle = buildBiChartProps(result, { ...baseCfg, type: 'bar', aggregation: 'sum', topN: 10, sort: 'value-desc' });
  assert.equal(sumBundle.props.categories?.length, 10);
  assert.equal(sumBundle.props.categories?.[0], 'A');
  assert.equal(sumBundle.props.series[0]?.data?.[0], 300);
  assert.equal(sumBundle.props.categories?.[9], 'Other (2)');
  assert.equal(sumBundle.props.series[0]?.data?.[9], 5); // J(3) + K(2)
  assert.ok(sumBundle.kpis.length >= 3);
  assert.ok(sumBundle.insights.length >= 1);

  const avgBundle = buildBiChartProps(result, { ...baseCfg, type: 'bar', aggregation: 'avg', topN: 0, sort: 'value-desc' });
  const idxA = avgBundle.props.categories?.indexOf('A') ?? -1;
  assert.equal(avgBundle.props.series[0]?.data?.[idxA], 150);

  const countBundle = buildBiChartProps(result, { ...baseCfg, type: 'bar', aggregation: 'count', topN: 0, sort: 'value-desc' });
  const idxACnt = countBundle.props.categories?.indexOf('A') ?? -1;
  assert.equal(countBundle.props.series[0]?.data?.[idxACnt], 2);

  // Cross-filtering
  const filtered = applyCrossFilter(result, { sourceCardId: 'c1', column: 'category', value: 'A' });
  assert.equal(filtered.rowCount, 2);
  assert.deepEqual(filtered.rows.map((r) => r[1]), [100, 200]);
});

/* ============================================================================
 * 3. AI BI Pipeline + Live SQLite Driver + 1-Shot Auto-Repair + X-Ray Starters
 * ============================================================================ */

test('runBiAiAnalysis executes on live SQLite, auto-repairs failed SQL once, and blocks writes', async () => {
  const driver = new SqliteDriver();
  await driver.connect({
    engine: 'sqlite',
    host: '',
    port: 0,
    database: 'main',
    username: '',
    sqliteSeedDemo: true,
  });

  try {
    const tables = await driver.listTables('main', 'main');
    const structures: Record<string, TableStructure> = {};
    for (const tb of tables) {
      structures[tb.name] = await driver.getTableStructure('main', 'main', tb.name);
    }

    const schemaContext = buildBiSchemaContext({
      engine: 'sqlite',
      dialect: 'sqlite',
      database: 'main',
      schema: 'main',
      tables,
      structures,
      question: 'Revenue by customer tier',
    });
    assert.ok(schemaContext.includes('customers'));
    assert.ok(schemaContext.includes('orders'));
    assert.ok(new TextEncoder().encode(schemaContext).length <= 9000);

    // Quick X-Ray starter queries execute cleanly on live SQLite
    const starters = buildTableStarterQueries('orders', structures.orders, 'sqlite', 'main');
    assert.ok(starters.length >= 2);
    for (const st of starters) {
      const check = validateBiReadOnlySql(st.sql, 'sqlite');
      assert.equal(check.ok, true);
      if (check.ok) {
        const res = await driver.query(check.safeSql);
        assert.ok(res.results[0].columns.length > 0);
      }
    }

    // AI Pipeline: 1st attempt uses wrong column `amount` -> triggers 1-shot auto-repair to `total_amount`!
    const stages: string[] = [];
    const repairAi = makeMockAi([
      '```json\n{"title":"Revenue by Tier","sql":"SELECT c.tier, SUM(o.amount) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.id GROUP BY c.tier","chartType":"donut","xField":"tier","yFields":["revenue"],"valueFormat":"currency","followUps":["Break down by order status"]}\n```',
      '```json\n{"title":"Revenue by Tier","sql":"SELECT c.tier, SUM(o.total_amount) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.id GROUP BY c.tier ORDER BY revenue DESC","chartType":"donut","xField":"tier","yFields":["revenue"],"valueFormat":"currency","insights":["Enterprise tier contributes strong repeat orders."],"followUps":["Break down by order status"]}\n```',
    ]);

    const outcome = await runBiAiAnalysis({
      ai: repairAi,
      driver,
      dialect: 'sqlite',
      schemaContext,
      question: 'Revenue by customer tier',
      onStage: (s) => stages.push(s),
    });

    assert.equal(outcome.repaired, true);
    assert.ok(stages.includes('repairing'));
    assert.equal(outcome.card.chartConfig.type, 'donut');
    assert.ok((outcome.card.result?.rowCount ?? 0) >= 2);
    assert.ok(outcome.card.kpis.length >= 3);
    assert.ok(outcome.card.followUps.length === 1);

    // AI returning destructive SQL must be blocked (both initial & repair)
    const evilAi = makeMockAi([
      '{"title":"Oops","sql":"DROP TABLE orders"}',
      '{"title":"Still Oops","sql":"DELETE FROM orders"}',
    ]);
    await assert.rejects(
      () =>
        runBiAiAnalysis({
          ai: evilAi,
          driver,
          dialect: 'sqlite',
          schemaContext,
          question: 'delete everything',
        }),
      /Read-only guard rejected SQL/i,
    );

    // Confirm orders table is untouched
    const verify = await driver.query('SELECT COUNT(*) FROM orders');
    assert.equal(verify.results[0].rows[0][0], 3);
  } finally {
    await driver.close();
  }
});

test('parseBiAiResponse handles fenced JSON, trailing commas, and rejects missing SQL', () => {
  const parsed = parseBiAiResponse('Here is your chart:\n```json\n{"title":"Test","sql":"SELECT 1 AS v","chartType":"bar",}\n```');
  assert.equal(parsed.title, 'Test');
  assert.equal(parsed.sql, 'SELECT 1 AS v');
  assert.equal(parsed.chartType, 'bar');

  assert.throws(() => parseBiAiResponse('{"title":"No SQL"}'), /SQL query/i);
});

/* ============================================================================
 * 4. Report Export & Storage Persistence
 * ============================================================================ */

test('Markdown/JSON export and WorkbenchStorage BI dashboard persistence round-trip', async () => {
  const sampleResult = makeResult(
    [
      { name: 'status', dataType: 'TEXT' },
      { name: 'total_amount', dataType: 'REAL' },
    ],
    [
      ['shipped', 239.49],
      ['paid', 149.99],
      ['pending', 89.5],
    ],
  );
  const cfg = recommendChartConfig(sampleResult);
  const built = buildBiChartProps(sampleResult, cfg, { title: 'Revenue by Status' });
  const card: BiAnalysisCard = {
    id: 'card-1',
    title: 'Revenue by Status',
    description: 'Order volume by payment status',
    sql: 'SELECT status, SUM(total_amount) AS total_amount FROM orders GROUP BY status',
    chartConfig: cfg,
    kpis: built.kpis,
    insights: built.insights,
    followUps: ['Compare monthly growth'],
    pinned: true,
    span: 1,
    updatedAt: 1700000000000,
    result: sampleResult,
  };

  const md = exportBiReportMarkdown({ connectionName: 'Demo Shop', database: 'main', cards: [card] });
  assert.ok(md.includes('# BI Analytics Report — Demo Shop'));
  assert.ok(md.includes('## 1. Revenue by Status'));
  assert.ok(md.includes('| status | total_amount |'));
  assert.ok(md.includes('```sql'));

  const jsonStr = exportBiDashboardJson({ connectionName: 'Demo Shop', database: 'main', cards: [card] });
  const parsedJson = JSON.parse(jsonStr);
  assert.equal(parsedJson.cards.length, 1);
  assert.equal(parsedJson.cards[0].rowCount, 3);
  assert.equal(parsedJson.cards[0].result, undefined);

  // Storage round-trip
  const mem = new Map<string, unknown>();
  const mockCtx = {
    storage: {
      async get(k: string) {
        return mem.get(k);
      },
      async set(k: string, v: unknown) {
        mem.set(k, v);
      },
      async delete(k: string) {
        mem.delete(k);
      },
      async keys() {
        return Array.from(mem.keys());
      },
    },
  } as unknown as PluginContext;
  const storage = new WorkbenchStorage(mockCtx);
  await storage.saveBiDashboard('conn-1', [card]);
  const loaded = await storage.loadBiDashboard('conn-1');
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'card-1');
  assert.equal(loaded[0].result, undefined); // ephemeral result stripped on persist
  await storage.deleteBiDashboard('conn-1');
  assert.deepEqual(await storage.loadBiDashboard('conn-1'), []);
});

/* ============================================================================
 * 5. SSR UI Tests — Verify `bi-chart` Widget & ZERO Inline `<svg>` / `<canvas>`
 * ============================================================================ */

test('BiAnalyticsTab and SqlQueryTab Chart tab render bi-chart widget with zero inline svg/canvas', () => {
  const sampleResult = makeResult(
    [
      { name: 'tier', dataType: 'TEXT' },
      { name: 'revenue', dataType: 'REAL' },
    ],
    [
      ['enterprise', 389.49],
      ['pro', 239.49],
    ],
  );
  const cfg = recommendChartConfig(sampleResult);
  const built = buildBiChartProps(sampleResult, cfg, { title: 'Revenue by Tier' });
  const card: BiAnalysisCard = {
    id: 'bi-ssr-1',
    title: 'Revenue by Tier',
    description: 'Enterprise vs Pro total spend',
    sql: 'SELECT tier, SUM(revenue) AS revenue FROM orders GROUP BY tier',
    chartConfig: cfg,
    kpis: built.kpis,
    insights: ['enterprise leads tier with $389.49 (61.9% of total).'],
    followUps: ['Show trend over time'],
    pinned: true,
    span: 2,
    updatedAt: Date.now(),
    result: sampleResult,
  };

  const session = {
    connectionId: 'conn-sqlite',
    connection: {
      id: 'conn-sqlite',
      name: 'Demo SQLite',
      group: '',
      color: 'none',
      engine: 'sqlite',
      host: '',
      port: 0,
      database: 'main',
      schema: 'main',
      username: '',
      hasPassword: false,
      tlsMode: 'off',
      allowSelfSigned: false,
      redisDb: 0,
      authSource: '',
      httpPath: '',
      sqliteMode: 'demo',
      sshTunnel: { enabled: false },
      createdAt: 0,
      updatedAt: 0,
    },
    driver: {} as ActiveSession['driver'],
    family: 'sqlite',
    info: { engine: 'sqlite', family: 'sqlite', serverVersion: 'SQLite 3', database: 'main', tlsActive: false, latencyMs: 1 },
    databases: [{ name: 'main' }],
    activeDatabase: 'main',
    schemas: [{ name: 'main' }],
    activeSchema: 'main',
    objectsBySchema: {
      'main::main': {
        tables: [{ name: 'orders', schema: 'main' }, { name: 'customers', schema: 'main' }],
        views: [],
        routines: [],
        triggers: [],
        structures: {},
        loaded: true,
        loading: false,
      },
    },
    mongoCollectionsByDb: {},
  } as unknown as ActiveSession;

  const mockContext = {
    enabledFeatures: new Set(['ai.model-invocation']),
    environment: { locale: 'en', theme: 'dark' },
    ai: makeMockAi([]),
  } as unknown as PluginContext;

  const biTab: BiAnalyticsTabState = {
    id: 'bi-tab-1',
    connectionId: 'conn-sqlite',
    kind: 'bi',
    title: 'BI Dashboard',
    database: 'main',
    schema: 'main',
    viewMode: 'dashboard',
    question: '',
    pipelineStage: 'idle',
    cards: [card],
    activeCardId: card.id,
    crossFilter: { sourceCardId: card.id, column: 'tier', value: 'enterprise', seriesIndex: 0, datumIndex: 0 },
  };

  const biHtml = renderToStaticMarkup(
    React.createElement(BiAnalyticsTab, {
      tab: biTab,
      session,
      context: mockContext,
      t: createUiTranslator('en'),
      onUpdateTab: () => {},
      onPersistCards: () => {},
      onOpenSqlInQuery: () => {},
      onOpenAiSidebar: () => {},
      onNewSqlQuery: () => {},
      onSaveExportFile: async () => {},
      onNotify: () => {},
    }),
  );

  assert.ok(biHtml.includes('BI Dashboard'), 'BiAnalyticsTab must render BI Dashboard header');
  assert.ok(biHtml.includes('assets/ui/bar-chart-2.svg'), 'BiAnalyticsTab header must use Lucide bar-chart-2 icon');
  assert.ok(biHtml.includes('assets/ui/sparkles.svg'), 'BiAnalyticsTab Ask Catty Agent CTA keeps sparkles icon');
  assert.ok(biHtml.includes('Refresh All'), 'BiAnalyticsTab must render Refresh All action');
  assert.ok(biHtml.includes('Export MD'), 'BiAnalyticsTab must render Export MD action');
  assert.ok(biHtml.includes('Export JSON'), 'BiAnalyticsTab must render Export JSON action');
  assert.ok(biHtml.includes('Ask Catty Agent'), 'BiAnalyticsTab must render Ask Catty Agent action');
  assert.equal(biHtml.includes('ndb-bi-ask-bar'), false, 'BiAnalyticsTab must NOT render duplicate AI prompt input');
  assert.ok(biHtml.includes('data-plugin-widget="bi-chart"'), 'BiAnalyticsTab must render host bi-chart widget');
  assert.ok(biHtml.includes('data-plugin-widget="data-grid"'), 'BiAnalyticsTab must render underlying data-grid widget');
  assert.ok(biHtml.includes('Filtered: tier = &quot;enterprise&quot;'), 'BiAnalyticsTab must render active cross-filter chip');
  assert.ok(biHtml.includes('Revenue by Tier'));
  assert.equal(/<svg[\s>]/i.test(biHtml), false, 'BiAnalyticsTab must have ZERO inline <svg>');
  assert.equal(/<canvas[\s>]/i.test(biHtml), false, 'BiAnalyticsTab must have ZERO inline <canvas>');

  // Verify clean empty state routes users to Catty Agent or New SQL Query
  const emptyHtml = renderToStaticMarkup(
    React.createElement(BiAnalyticsTab, {
      tab: { ...biTab, cards: [], activeCardId: null, crossFilter: null },
      session,
      context: mockContext,
      t: createUiTranslator('en'),
      onUpdateTab: () => {},
      onPersistCards: () => {},
      onOpenSqlInQuery: () => {},
      onOpenAiSidebar: () => {},
      onNewSqlQuery: () => {},
      onSaveExportFile: async () => {},
      onNotify: () => {},
    }),
  );
  assert.ok(emptyHtml.includes('Ask Catty Agent'));
  assert.ok(emptyHtml.includes('New SQL Query'));
  assert.equal(emptyHtml.includes('ndb-bi-ask-bar'), false);

  // Verify zh-CN localization
  const biHtmlZh = renderToStaticMarkup(
    React.createElement(BiAnalyticsTab, {
      tab: biTab,
      session,
      context: { ...mockContext, environment: { locale: 'zh-CN', theme: 'light' } } as unknown as PluginContext,
      t: createUiTranslator('zh-CN'),
      onUpdateTab: () => {},
      onPersistCards: () => {},
      onOpenSqlInQuery: () => {},
      onOpenAiSidebar: () => {},
      onNewSqlQuery: () => {},
      onSaveExportFile: async () => {},
      onNotify: () => {},
    }),
  );
  assert.ok(biHtmlZh.includes('BI 看板'));
  assert.ok(biHtmlZh.includes('分析洞察'));
  assert.ok(biHtmlZh.includes('已联动筛选'));

  // Verify SqlQueryTab inline Chart tab
  const sqlTab: SqlQueryTabState = {
    id: 'sql-1',
    connectionId: 'conn-sqlite',
    kind: 'sql',
    title: 'Query 1',
    dialect: 'sqlite',
    database: 'main',
    schema: 'main',
    sql: 'SELECT tier, SUM(revenue) AS revenue FROM orders GROUP BY tier',
    selectedText: '',
    txMode: 'auto',
    inTransaction: false,
    running: false,
    results: [sampleResult],
    activeResultTab: 'chart',
    resultFilter: '',
    resultSort: null,
    explainViewMode: 'tree',
    messages: [],
    explainResult: null,
    diagnostics: [],
    serverDiagnostics: [],
    lastParamValues: {},
  };

  const sqlHtml = renderToStaticMarkup(
    React.createElement(SqlQueryTab, {
      tab: sqlTab,
      session,
      t: createUiTranslator('en'),
      onUpdateTab: () => {},
      onExecute: () => {},
      onCancel: () => {},
      onFormat: () => {},
      onExplain: () => {},
      onToggleTxMode: () => {},
      onBeginTx: () => {},
      onCommitTx: () => {},
      onRollbackTx: () => {},
      onOpenSqlFile: () => {},
      onSaveSqlFile: () => {},
      onOpenHistory: () => {},
      onExportResult: () => {},
      onPinChartToBi: () => {},
      onInspectCell: () => {},
    }),
  );

  assert.ok(sqlHtml.includes('data-plugin-widget="bi-chart"'), 'SqlQueryTab Chart tab must render host bi-chart widget');
  assert.ok(sqlHtml.includes('assets/ui/bar-chart-2.svg'), 'SqlQueryTab Chart subtab must use Lucide bar-chart-2 icon');
  assert.equal(sqlHtml.includes('assets/ui/sparkles.svg'), false, 'SqlQueryTab Chart subtab must not use sparkles icon');
  assert.ok(sqlHtml.includes('Pin to BI Dashboard'), 'SqlQueryTab Chart tab must expose Pin to BI Dashboard CTA');
  assert.equal(/<svg[\s>]/i.test(sqlHtml), false, 'SqlQueryTab Chart tab must have ZERO inline <svg>');
  assert.equal(/<canvas[\s>]/i.test(sqlHtml), false, 'SqlQueryTab Chart tab must have ZERO inline <canvas>');
});

/* ============================================================================
 * 6. Native MongoDB Aggregation BI Helpers & SSR Rendering
 * ============================================================================ */

test('mongoTabular parses JSON pipelines, blocks $out/$merge at any nesting depth, enforces $limit, and flattens documents into chartable QueryResultSet', () => {
  const parsed = parseMongoBiQuery(
    '```json\n{"collection":"orders","pipeline":[{"$group":{"_id":{"tier":"$tier","region":"$region"},"revenue":{"$sum":"$total"},"orders":{"$sum":1}}}]};\n```',
  );
  assert.equal(parsed.collection, 'orders');
  assert.equal(parsed.pipeline.length, 1);

  const formatted = formatMongoBiQuery(parsed);
  assert.equal(JSON.parse(formatted).collection, 'orders');

  // Invalid / missing collection
  assert.throws(() => parseMongoBiQuery(''), /empty/i);
  assert.throws(() => parseMongoBiQuery('{"pipeline":[]}'), /collection/i);
  assert.throws(() => parseMongoBiQuery('{not-json'), /Invalid MongoDB BI query JSON/i);

  // Read-only pipeline guard: top-level and nested write stages must be rejected
  assert.throws(() => assertReadOnlyMongoPipeline([{ $match: {} }, { $out: 'backup' }]), /blocked write stage "\$out"/i);
  assert.throws(() => assertReadOnlyMongoPipeline([{ $merge: { into: 'target' } }]), /blocked write stage "\$merge"/i);
  assert.throws(
    () =>
      assertReadOnlyMongoPipeline([
        { $lookup: { from: 'items', as: 'items', pipeline: [{ $out: 'evil' }] } },
      ]),
    /blocked write stage "\$out"/i,
  );
  assert.throws(
    () =>
      assertReadOnlyMongoPipeline([
        { $unionWith: { coll: 'items', pipeline: [{ $merge: 'evil' }] } },
      ]),
    /blocked write stage "\$merge"/i,
  );
  assert.throws(
    () =>
      assertReadOnlyMongoPipeline([
        { $facet: { a: [{ $match: {} }], b: [{ $out: 'evil' }] } },
      ]),
    /blocked write stage "\$out"/i,
  );

  // Safe $limit enforcement
  const limited = appendMongoSafeLimit([{ $match: { status: 'paid' } }], 200);
  assert.deepEqual(limited[limited.length - 1], { $limit: 200 });
  const preserved = appendMongoSafeLimit([{ $match: {} }, { $limit: 25 }], 200);
  assert.equal(preserved.length, 2);
  const capped = appendMongoSafeLimit([{ $match: {} }, { $limit: 5000 }], 200);
  assert.equal(capped.length, 3);
  assert.deepEqual(capped[2], { $limit: 200 });

  // Document flattening: compound _id expansion, EJSON scalar unwrapping, nested object flattening, column typing
  const docs = [
    {
      _id: { tier: 'enterprise', day: { $date: '2026-01-01T00:00:00Z' } },
      revenue: { $numberDecimal: '1250.50' },
      orders: { $numberLong: '14' },
      active: true,
      meta: { region: 'APAC' },
      oid: { $oid: '65f1a2b3c4d5e6f7a8b9c0d1' },
    },
    {
      _id: { tier: 'pro', day: { $date: '2026-01-02T00:00:00Z' } },
      revenue: { $numberDecimal: '640.25' },
      orders: { $numberLong: '9' },
      active: true,
      meta: { region: 'EMEA' },
      oid: { $oid: '65f1a2b3c4d5e6f7a8b9c0d2' },
    },
  ];
  const res = flattenMongoDocsToResultSet(docs, 12, formatted);
  assert.equal(res.rowCount, 2);
  assert.equal(res.commandTag, 'AGGREGATE');
  const colMap = new Map(res.columns.map((c) => [c.name, c.dataType]));
  assert.equal(colMap.get('tier'), 'TEXT');
  assert.equal(colMap.get('day'), 'TIMESTAMP');
  assert.equal(colMap.get('revenue'), 'DOUBLE');
  assert.equal(colMap.get('orders'), 'INTEGER');
  assert.equal(colMap.get('active'), 'BOOLEAN');
  assert.equal(colMap.get('meta.region'), 'TEXT');
  assert.equal(colMap.get('oid'), 'TEXT');
  assert.equal(res.rows[0][res.columns.findIndex((c) => c.name === 'revenue')], 1250.5);
  assert.equal(res.rows[0][res.columns.findIndex((c) => c.name === 'orders')], 14);
  assert.equal(res.rows[0][res.columns.findIndex((c) => c.name === 'oid')], '65f1a2b3c4d5e6f7a8b9c0d1');

  // Flows cleanly into chart recommendation & buildBiChartProps
  const cfg = recommendChartConfig(res);
  const built = buildBiChartProps(res, cfg, { title: 'MongoDB Revenue' });
  assert.ok(built.props.series.length >= 1);
  assert.ok(built.kpis.length >= 3);
});

test('BiAnalyticsTab and MongoWorkbenchTab render MongoDB Aggregation BI controls with bar-chart-2 icon and zero inline svg/canvas', () => {
  const mongoResult = flattenMongoDocsToResultSet(
    [
      { _id: 'enterprise', revenue: 3200 },
      { _id: 'pro', revenue: 1850 },
    ],
    6,
    formatMongoBiQuery({ collection: 'orders', pipeline: [{ $group: { _id: '$tier', revenue: { $sum: '$total' } } }] }),
  );
  const cfg = recommendChartConfig(mongoResult);
  const built = buildBiChartProps(mongoResult, cfg, { title: 'Orders by Tier' });

  const mongoSession = {
    connectionId: 'conn-mongo',
    connection: {
      id: 'conn-mongo',
      name: 'Analytics MongoDB',
      group: '',
      color: 'none',
      engine: 'mongodb',
      host: '127.0.0.1',
      port: 27017,
      database: 'analytics',
      schema: '',
      username: '',
      hasPassword: false,
      tlsMode: 'off',
      allowSelfSigned: false,
      redisDb: 0,
      authSource: 'admin',
      httpPath: '',
      sshTunnel: { enabled: false },
      createdAt: 0,
      updatedAt: 0,
    },
    driver: { family: 'mongodb' } as unknown as ActiveSession['driver'],
    family: 'mongodb',
    info: { engine: 'mongodb', family: 'mongodb', serverVersion: 'MongoDB 7.0', database: 'analytics', tlsActive: false, latencyMs: 2 },
    databases: [{ name: 'analytics' }],
    activeDatabase: 'analytics',
    schemas: [],
    activeSchema: '',
    objectsBySchema: {},
    mongoCollectionsByDb: { analytics: [{ name: 'orders', type: 'collection' }] },
  } as unknown as ActiveSession;

  const mockContext = {
    enabledFeatures: new Set(['ai.model-invocation']),
    environment: { locale: 'en', theme: 'dark' },
    ai: makeMockAi([]),
  } as unknown as PluginContext;

  const mongoBiCard: BiAnalysisCard = {
    id: 'mongo-bi-1',
    title: 'Orders by Tier',
    sql: mongoResult.sql,
    chartConfig: cfg,
    kpis: built.kpis,
    insights: built.insights,
    followUps: [],
    pinned: true,
    span: 2,
    updatedAt: Date.now(),
    result: mongoResult,
  };

  const mongoBiHtml = renderToStaticMarkup(
    React.createElement(BiAnalyticsTab, {
      tab: {
        id: 'bi-mongo-1',
        connectionId: 'conn-mongo',
        kind: 'bi',
        title: 'BI Dashboard',
        database: 'analytics',
        schema: '',
        viewMode: 'dashboard',
        question: '',
        pipelineStage: 'idle',
        cards: [mongoBiCard],
        activeCardId: mongoBiCard.id,
        crossFilter: null,
      },
      session: mongoSession,
      context: mockContext,
      t: createUiTranslator('en'),
      onUpdateTab: () => {},
      onPersistCards: () => {},
      onOpenSqlInQuery: () => {},
      onOpenAiSidebar: () => {},
      onNewSqlQuery: () => {},
      onSaveExportFile: async () => {},
      onNotify: () => {},
    }),
  );

  assert.ok(mongoBiHtml.includes('data-plugin-widget="bi-chart"'), 'MongoDB BiAnalyticsTab must render bi-chart widget');
  assert.ok(mongoBiHtml.includes('assets/ui/bar-chart-2.svg'), 'MongoDB BiAnalyticsTab must use bar-chart-2 icon');
  assert.ok(mongoBiHtml.includes('Pipeline'), 'MongoDB BiAnalyticsTab must label query inspector as Pipeline');
  assert.equal(mongoBiHtml.includes('Open in SQL Editor'), false, 'MongoDB BiAnalyticsTab must hide Open in SQL Editor');
  assert.equal(/<svg[\s>]/i.test(mongoBiHtml), false, 'MongoDB BiAnalyticsTab must have ZERO inline <svg>');

  const mongoTab: MongoWorkbenchTabState = {
    id: 'mongo-tab-1',
    connectionId: 'conn-mongo',
    kind: 'mongo',
    title: 'orders',
    database: 'analytics',
    collection: 'orders',
    mode: 'aggregate',
    filterJson: '{}',
    sortJson: '{}',
    projectionJson: '{}',
    pipelineJson: '[{"$group":{"_id":"$tier","revenue":{"$sum":"$total"}}}]',
    limit: 50,
    skip: 0,
    viewMode: 'table',
    activeSubTab: 'documents',
    totalCount: 2,
    documents: [
      { _id: 'enterprise', revenue: 3200 },
      { _id: 'pro', revenue: 1850 },
    ],
    loading: false,
    indexes: [],
    stats: null,
    schemaAnalysis: null,
    schemaLoading: false,
    selectedDocIndex: null,
    executionMs: 6,
  };

  const mongoTabHtml = renderToStaticMarkup(
    React.createElement(MongoWorkbenchTab, {
      tab: mongoTab,
      driver: mongoSession.driver as unknown as import('../src/drivers/types').MongoDriver,
      t: createUiTranslator('en'),
      onUpdateTab: () => {},
      onRun: async () => {},
      onReloadIndexes: async () => {},
      onAnalyzeSchema: async () => {},
      onPinToBi: () => {},
      onCopyText: () => {},
      onNotify: () => {},
    }),
  );

  assert.ok(mongoTabHtml.includes('Pin to BI'), 'MongoWorkbenchTab aggregate mode must show Pin to BI CTA');
  assert.ok(mongoTabHtml.includes('assets/ui/bar-chart-2.svg'), 'MongoWorkbenchTab Pin to BI button must use bar-chart-2 icon');
  assert.equal(/<svg[\s>]/i.test(mongoTabHtml), false, 'MongoWorkbenchTab must have ZERO inline <svg>');
});

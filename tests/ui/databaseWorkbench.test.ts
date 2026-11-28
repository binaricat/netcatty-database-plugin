/**
 * Database Workbench UI unit & React render tests (v0.3.0).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PluginContext } from '@netcatty/plugin-sdk';
import { drivers } from '../../src/driverRegistry';
import { ZH_TRANSLATIONS, createUiTranslator, formatBytes, formatTtl } from '../../src/ui/i18n';
import { exportConnectionUri, parseConnectionUri } from '../../src/ui/uriParser';
import { exportConnectionsJson, importConnectionsJson } from '../../src/ui/connectionTransfer';
import { pushGridUndo, redoGridEdit, undoGridEdit } from '../../src/ui/gridHistory';
import {
  coerceCellInput,
  createModalBridge,
  formatCellForClipboard,
  makeDefaultConnection,
} from '../../src/ui/sessionManager';
import { WorkbenchStorage } from '../../src/ui/storage';
import { createWorkbenchTransport } from '../../src/ui/transport';
import { PureRedisDriver, PureMongoDriver, SqliteDriver, Neo4jDriver, SearchVectorDriver, KvHttpDriver } from '../../src/drivers/index';
import type {
  ActiveSession,
  ErDiagramTabState,
  GraphWorkbenchTabState,
  KvWorkbenchTabState,
  MongoWorkbenchTabState,
  ObjectDefTabState,
  RedisWorkbenchTabState,
  SchemaDiffTabState,
  SearchWorkbenchTabState,
  SqlQueryTabState,
  StructureDesignerTabState,
  TableDataTabState,
} from '../../src/ui/types';

// @remote-dom/core references browser DOM base classes at module load time in Node SSR tests.
const g = globalThis as Record<string, unknown>;
for (const name of ['HTMLElement', 'Element', 'Node', 'MutationObserver', 'DocumentFragment', 'Text', 'Comment']) {
  if (typeof g[name] === 'undefined') g[name] = class {};
}

const [
  { DatabaseWorkbench },
  { ConnectionModalView },
  { ConnectionDrawer },
  { SqlQueryTab },
  { TableDataTab },
  { StructureDesignerTab },
  { ObjectDefTab },
  { ErDiagramTab },
  { RedisWorkbenchTab },
  { MongoWorkbenchTab },
  { GraphWorkbenchTab },
  { SearchWorkbenchTab },
  { KvWorkbenchTab },
  { SchemaDiffTab },
  { CommandPalette, fuzzyScore, filterPaletteItems },
  { ConfirmSqlDrawer, SqlParameterDrawer },
] = await Promise.all([
  import('../../src/ui/DatabaseWorkbench'),
  import('../../src/ui/ConnectionModalView'),
  import('../../src/ui/components/ConnectionDrawer'),
  import('../../src/ui/components/SqlQueryTab'),
  import('../../src/ui/components/TableDataTab'),
  import('../../src/ui/components/StructureDesignerTab'),
  import('../../src/ui/components/ObjectDefTab'),
  import('../../src/ui/components/ErDiagramTab'),
  import('../../src/ui/components/RedisWorkbenchTab'),
  import('../../src/ui/components/MongoWorkbenchTab'),
  import('../../src/ui/components/GraphWorkbenchTab'),
  import('../../src/ui/components/SearchWorkbenchTab'),
  import('../../src/ui/components/KvWorkbenchTab'),
  import('../../src/ui/components/SchemaDiffTab'),
  import('../../src/ui/components/CommandPalette'),
  import('../../src/ui/components/AuxDrawers'),
]);

function createMockContext(): {
  context: PluginContext;
  kv: Map<string, unknown>;
  secrets: Map<string, string>;
  connectCalls: unknown[];
  connectViaHostCalls: unknown[];
} {
  const kv = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const connectCalls: unknown[] = [];
  const connectViaHostCalls: unknown[] = [];

  const context = {
    pluginId: 'com.binaricat.netcatty-database',
    environment: {
      locale: 'en',
      theme: 'dark',
      reducedMotion: false,
      highContrast: false,
      themeTokens: {},
      onDidChange: () => ({ dispose() {} }),
    },
    storage: {
      async get(key: string) {
        return kv.get(key);
      },
      async set(key: string, val: unknown) {
        kv.set(key, val);
      },
      async delete(key: string) {
        kv.delete(key);
      },
      async keys(opts?: { prefix?: string }) {
        const all = Array.from(kv.keys());
        return opts?.prefix ? all.filter((k) => k.startsWith(opts.prefix!)) : all;
      },
    },
    secrets: {
      async get(key: string) {
        return secrets.has(key) ? { kind: 'secret-ref', id: key } : undefined;
      },
      async getPlaintext(key: string) {
        return secrets.get(key);
      },
      async readOwn(key: string) {
        return secrets.get(key);
      },
      async set(key: string, val: string) {
        secrets.set(key, val);
        return { kind: 'secret-ref', id: key };
      },
      async delete(key: string) {
        secrets.delete(key);
      },
    },
    network: {
      async connect(req: unknown) {
        connectCalls.push(req);
        return {
          endpoint: 'tcp://127.0.0.1:5432',
          readable: { id: 'r1', read: async () => null, cancel() {}, dispose() {} },
          writable: { id: 'w1', write: async () => {}, end: async () => {}, fail() {}, cancel() {}, dispose() {} },
          upgradeTls: async () => ({ upgraded: true, authorized: true }),
          close: async () => {},
          dispose() {},
        };
      },
      async connectViaHost(req: unknown) {
        connectViaHostCalls.push(req);
        return {
          endpoint: 'tcp://postgres:5432',
          hostBindingToken: 'bind-tok-xyz',
          readable: { id: 'r2', read: async () => null, cancel() {}, dispose() {} },
          writable: { id: 'w2', write: async () => {}, end: async () => {}, fail() {}, cancel() {}, dispose() {} },
          upgradeTls: async () => ({ upgraded: true, authorized: true }),
          close: async () => {},
          dispose() {},
        };
      },
      async request() {
        return { status: 200, headers: {}, body: { encoding: 'utf8', data: 'ok' } };
      },
    },
    ui: {
      openFile: async () => ({ cancelled: true }),
      saveFile: async () => ({ cancelled: true }),
      quickPick: async () => undefined,
      input: async () => undefined,
    },
    clipboard: {
      readText: async () => '',
      writeText: async () => true,
    },
    vault: {
      selectHosts: async () => ({ hosts: [] }),
      revokeHostBinding: async () => ({ revoked: true }),
    },
    views: {
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage() {},
      getState: async () => undefined,
      setState: async () => {},
    },
    enabledFeatures: new Set(['views.host-drawn', 'network.byte-streams', 'network.host-byte-streams']),
  } as unknown as PluginContext;

  return { context, kv, secrets, connectCalls, connectViaHostCalls };
}

test('URI parser & exporter round-trip PostgreSQL, MySQL, Redis, MongoDB, ClickHouse, SQLite', () => {
  const pg = parseConnectionUri('postgres://netcatty:s3cr%40t@127.0.0.1:5432/shop_demo?sslmode=require');
  assert.equal(pg.engine, 'postgres');
  assert.equal(pg.host, '127.0.0.1');
  assert.equal(pg.port, 5432);
  assert.equal(pg.database, 'shop_demo');
  assert.equal(pg.username, 'netcatty');
  assert.equal(pg.password, 's3cr@t');
  assert.equal(pg.tlsMode, 'require');

  const red = parseConnectionUri('rediss://:pass@cache.local:6380/3');
  assert.equal(red.engine, 'redis');
  assert.equal(red.port, 6380);
  assert.equal(red.redisDb, 3);
  assert.equal(red.tlsMode, 'require');

  const mongo = parseConnectionUri('mongodb://admin:pw@127.0.0.1:27017/shop_demo?authSource=admin');
  assert.equal(mongo.engine, 'mongodb');
  assert.equal(mongo.database, 'shop_demo');
  assert.equal(mongo.authSource, 'admin');

  const ch = parseConnectionUri('clickhouse://netcatty:ch@127.0.0.1:8123/analytics_demo');
  assert.equal(ch.engine, 'clickhouse');
  assert.equal(ch.database, 'analytics_demo');

  const conn = makeDefaultConnection('postgres');
  conn.host = 'db.internal';
  conn.port = 5432;
  conn.database = 'prod';
  conn.username = 'reader';
  conn.tlsMode = 'require';
  assert.equal(exportConnectionUri(conn), 'postgres://reader@db.internal:5432/prod?sslmode=require');

  assert.throws(() => parseConnectionUri('not-a-uri'), /scheme/);
});

test('i18n translator & formatters handle EN/ZH locales, bytes, and TTL cleanly', () => {
  const en = createUiTranslator('en-US');
  const zh = createUiTranslator('zh-CN');
  assert.equal(en('New Connection'), 'New Connection');
  assert.equal(zh('New Connection'), '新建连接');
  assert.equal(zh('Command Palette'), '命令面板');
  assert.equal(zh('Read-Only Mode'), '只读安全模式');
  assert.equal(zh('Filter Builder'), '筛选构建器');
  assert.equal(zh('Data Transfer'), '跨库数据传输');
  assert.ok(Object.keys(ZH_TRANSLATIONS).length >= 120, 'ZH dictionary should cover full Round 2 UI chrome');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatTtl(-1), '∞');
  assert.equal(formatTtl(95_000), '1m 35s');
});

test('coerceCellInput & formatCellForClipboard preserve scalar & JSON types', () => {
  assert.equal(coerceCellInput('42', false, { name: 'id', dataType: 'INTEGER', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true }), 42);
  assert.equal(coerceCellInput('true', false, { name: 'active', dataType: 'BOOLEAN', nullable: false, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false }), true);
  assert.equal(coerceCellInput('anything', true), null);
  assert.deepEqual(
    coerceCellInput('{"ok":true}', false, { name: 'meta', dataType: 'jsonb', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false }),
    { ok: true },
  );
  assert.equal(formatCellForClipboard(new Uint8Array([0xde, 0xad])), '0xdead');
});

test('gridHistory supports multi-step Undo and Redo across cell edits, inserts, and deletes', () => {
  let current = { dirtyCells: {} as Record<string, string | null>, insertedRows: [] as Record<string, string | null>[], deletedRowIndices: [] as number[] };
  let undoStack: typeof current[] = [];
  let redoStack: typeof current[] = [];

  // Edit 1: modify cell
  const step1 = pushGridUndo(current, { ...current, dirtyCells: { '0:name': 'Alice' } }, undoStack);
  current = step1.current as typeof current;
  undoStack = step1.undoStack as typeof current[];
  redoStack = step1.redoStack as typeof current[];

  // Edit 2: insert row
  const step2 = pushGridUndo(current, { ...current, insertedRows: [{ name: 'Bob' }] }, undoStack);
  current = step2.current as typeof current;
  undoStack = step2.undoStack as typeof current[];
  redoStack = step2.redoStack as typeof current[];
  assert.equal(undoStack.length, 2);

  // Undo 2 -> removes insert
  const u1 = undoGridEdit(current, undoStack, redoStack)!;
  current = u1.current as typeof current;
  undoStack = u1.undoStack as typeof current[];
  redoStack = u1.redoStack as typeof current[];
  assert.equal(current.insertedRows.length, 0);
  assert.equal(current.dirtyCells['0:name'], 'Alice');
  assert.equal(redoStack.length, 1);

  // Undo 1 -> removes cell edit
  const u2 = undoGridEdit(current, undoStack, redoStack)!;
  current = u2.current as typeof current;
  undoStack = u2.undoStack as typeof current[];
  redoStack = u2.redoStack as typeof current[];
  assert.deepEqual(current.dirtyCells, {});
  assert.equal(u2.dirty, false);

  // Redo 1 -> restores cell edit
  const r1 = redoGridEdit(current, undoStack, redoStack)!;
  current = r1.current as typeof current;
  assert.equal(current.dirtyCells['0:name'], 'Alice');
  assert.equal(r1.dirty, true);
});

test('connectionTransfer round-trips Netcatty JSON bundle (stripping secrets) & imports DBeaver data-sources.json', () => {
  const pg = makeDefaultConnection('postgres');
  pg.name = 'Prod PG';
  pg.host = 'pg.internal';
  pg.hasPassword = true;
  pg.readOnly = true;
  pg.sshTunnel = { enabled: true, hostLabel: 'bastion', hostBindingToken: 'secret-token-123' };

  const json = exportConnectionsJson([pg]);
  assert.equal(json.includes('secret-token-123'), false);

  const imported = importConnectionsJson(json);
  assert.equal(imported.length, 1);
  assert.equal(imported[0].name, 'Prod PG');
  assert.equal(imported[0].readOnly, true);
  assert.equal(imported[0].hasPassword, false);

  const dbeaverJson = JSON.stringify({
    connections: {
      'pg-1': {
        provider: 'postgresql',
        name: 'Analytics PG',
        folder: 'Production',
        'read-only': true,
        configuration: { host: '10.0.0.5', port: '5432', database: 'metrics', user: 'ro_user' },
      },
      'mysql-1': {
        provider: 'mysql',
        name: 'Orders MySQL',
        configuration: { host: '10.0.0.6', port: '3306', database: 'shop', user: 'admin' },
      },
    },
  });
  const dbeaver = importConnectionsJson(dbeaverJson);
  assert.equal(dbeaver.length, 2);
  assert.equal(dbeaver[0].engine, 'postgres');
  assert.equal(dbeaver[0].readOnly, true);
  assert.equal(dbeaver[0].group, 'Production');
  assert.equal(dbeaver[1].engine, 'mysql');
});

test('CommandPalette fuzzyScore & filterPaletteItems rank exact/prefix matches above subsequences', () => {
  assert.ok(fuzzyScore('cust', 'customers') > fuzzyScore('cust', 'my_customer_orders'));
  assert.ok(fuzzyScore('co', 'customers_orders') > 0);
  assert.equal(fuzzyScore('zzz', 'customers'), 0);

  const items = [
    { id: '1', group: 'object' as const, title: 'order_items', icon: 'table' as const, onSelect() {} },
    { id: '2', group: 'object' as const, title: 'orders', icon: 'table' as const, onSelect() {} },
    { id: '3', group: 'action' as const, title: 'New Query', icon: 'file-code' as const, onSelect() {} },
  ];
  const matched = filterPaletteItems(items, 'ord');
  assert.equal(matched.length, 2);
  assert.equal(matched[0].title, 'orders');

  const html = renderToStaticMarkup(
    React.createElement(CommandPalette, {
      open: true,
      items,
      t: createUiTranslator('en'),
      onClose() {},
    }),
  );
  assert.match(html, /Command Palette/);
  assert.match(html, /order_items/);
});

test('WorkbenchStorage persists connections (incl. readOnly) without passwords and stores secrets in encrypted store', async () => {
  const { context, kv, secrets } = createMockContext();
  const storage = new WorkbenchStorage(context);
  const conn = makeDefaultConnection('postgres');
  conn.name = 'Staging PG';
  conn.readOnly = true;
  conn.hasPassword = await storage.savePassword(conn.id, 'super-secret-pw');
  await storage.saveConnections([conn]);

  assert.equal(secrets.get(`netcatty.database.password.v1.${conn.id}`), 'super-secret-pw');
  assert.equal(JSON.stringify(kv.get('netcatty.database.connections.v1')).includes('super-secret-pw'), false);

  const loaded = await storage.loadConnections();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, 'Staging PG');
  assert.equal(loaded[0].readOnly, true);
  assert.equal(await storage.readPassword(conn.id), 'super-secret-pw');

  await storage.deletePassword(conn.id);
  assert.equal(await storage.readPassword(conn.id), undefined);
});

function assertNoUndefinedProperties(value: unknown, path = 'root'): void {
  if (value === null || value === undefined || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      assert.notEqual(item, undefined, `Found undefined at ${path}[${i}]`);
      assertNoUndefinedProperties(item, `${path}[${i}]`);
    });
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    assert.notEqual(v, undefined, `Found undefined wire key at ${path}.${k}`);
    assertNoUndefinedProperties(v, `${path}.${k}`);
  }
}

test('Wire JSON boundary: zero undefined keys in storage.set, network.connect, connectViaHost, request, and upgradeTls', async () => {
  const upgradeCalls: unknown[] = [];
  const requestCalls: unknown[] = [];
  const { context, kv, connectCalls, connectViaHostCalls } = createMockContext();
  const origConnect = context.network.connect;
  context.network.connect = async (req) => {
    const conn = await origConnect(req);
    conn.upgradeTls = async (opts) => {
      upgradeCalls.push(opts);
      return { upgraded: true, authorized: true };
    };
    return conn;
  };
  context.network.request = async (req) => {
    requestCalls.push(req);
    return { status: 200, statusText: 'OK', url: req.url, headers: {}, body: { encoding: 'base64' as const, data: btoa('ok') } };
  };

  const storage = new WorkbenchStorage(context);
  const conn = makeDefaultConnection('postgres');
  conn.sqliteFileName = undefined;
  conn.sqliteFileHandleId = 'ephemeral-h1';
  conn.sshTunnel = { enabled: false, hostLabel: undefined, hostBindingToken: undefined };
  await storage.saveConnections([conn]);
  assertNoUndefinedProperties(kv.get('netcatty.database.connections.v1'), 'connections');

  await storage.saveTabDrafts(conn.id, [{ id: 't1', kind: 'sql', title: 'Q1', sql: 'SELECT 1', table: undefined }]);
  assertNoUndefinedProperties(kv.get(`netcatty.database.tabs.v1.${conn.id}`), 'tabDrafts');

  const transport = createWorkbenchTransport(context.network);
  const stream = await transport.connect({
    host: '127.0.0.1',
    port: 5432,
    tls: false,
    allowSelfSigned: undefined,
    caPem: undefined,
  });
  assertNoUndefinedProperties(connectCalls[0], 'network.connect');

  await stream.upgradeTls?.({ servername: '127.0.0.1', allowSelfSigned: true, caPem: undefined });
  assertNoUndefinedProperties(upgradeCalls[0], 'upgradeTls');

  await transport.httpRequest?.({ url: 'http://127.0.0.1:8123/', method: 'GET' });
  assertNoUndefinedProperties(requestCalls[0], 'network.request');

  const tunneled = createWorkbenchTransport(context.network, {
    sshTunnel: { target: { hostId: 'h1', extra: undefined } as never, expectedRevision: 'r1' },
  });
  await tunneled.connect({ host: 'postgres', port: 5432, tls: false });
  assertNoUndefinedProperties(connectViaHostCalls[0], 'network.connectViaHost');
});

test('createWorkbenchTransport enables allowLocal and captures durable hostBindingToken', async () => {
  const { context, connectCalls, connectViaHostCalls } = createMockContext();
  const direct = createWorkbenchTransport(context.network);
  await direct.connect({ host: '127.0.0.1', port: 5432, tls: false });
  assert.equal((connectCalls[0] as { allowLocal?: boolean }).allowLocal, true);

  let capturedToken = '';
  const tunneled = createWorkbenchTransport(context.network, {
    sshTunnel: {
      target: { hostId: 'h1' } as never,
      expectedRevision: 'rev-1',
    },
    onBindingToken: (tok) => {
      capturedToken = tok;
    },
  });
  await tunneled.connect({ host: 'postgres', port: 5432, tls: false });
  assert.equal((connectViaHostCalls[0] as { durable?: boolean }).durable, true);
  assert.equal(capturedToken, 'bind-tok-xyz');
});

test('DatabaseWorkbench & ConnectionModalView render full-bleed chrome, ⌘K trigger, and all 22 engine brand icons', () => {
  const { context } = createMockContext();
  const bridge = createModalBridge();

  const wbHtml = renderToStaticMarkup(React.createElement(DatabaseWorkbench, { context, modalBridge: bridge }));
  assert.match(wbHtml, /data-plugin-chrome="full-bleed"/);
  assert.match(wbHtml, /data-plugin-widget="split-pane"/);
  assert.match(wbHtml, /Open Local SQLite File/);
  assert.match(wbHtml, /Launch Sample SQLite/);
  assert.match(wbHtml, /⌘K/);

  const modalHtml = renderToStaticMarkup(
    React.createElement(ConnectionModalView, { context, modalBridge: bridge }),
  );
  assert.match(modalHtml, /Select Database Engine/);
  assert.match(modalHtml, new RegExp(`1–24 / ${drivers.length}`));
  for (const d of drivers.slice(0, 24)) {
    assert.match(modalHtml, new RegExp(`assets/icons/${d.icon}-dark\\.png`), `Missing icon for ${d.id}`);
  }
  const tileCount = (modalHtml.match(/class="ndb-engine-tile(?:\s|")/g) ?? []).length;
  assert.equal(tileCount, 24, `expected bounded 24 tiles on page 1, got ${tileCount}`);

  const lightDrawerHtml = renderToStaticMarkup(
    React.createElement(ConnectionDrawer, {
      context,
      theme: 'light',
      t: createUiTranslator('en'),
      editingConnection: null,
      onClose() {},
      onSave: async () => {},
    }),
  );
  assert.match(lightDrawerHtml, /assets\/icons\/postgresql-light\.png/);

  // Option A: when host supports ai.sidebar-tools + openSidebar, .ndb-topbar omits duplicate AI and BI Studio buttons
  const sidebarContext = {
    ...context,
    enabledFeatures: new Set([...context.enabledFeatures, 'ai.sidebar-tools']),
    ai: {
      ...(context.ai ?? {}),
      registerTools: async () => ({ dispose() {} }),
      openSidebar: async () => {},
      setContext: async () => {},
      clearContext: async () => {},
    },
  } as unknown as PluginContext;
  const sidebarWbHtml = renderToStaticMarkup(
    React.createElement(DatabaseWorkbench, { context: sidebarContext, modalBridge: bridge }),
  );
  assert.equal(sidebarWbHtml.includes('ndb-topbar-ai-btn'), false, 'topbar must omit duplicate AI button when host sidebar is available');
  assert.equal(sidebarWbHtml.includes('>BI Studio<'), false, 'topbar must omit standalone BI Studio button');
  assert.match(sidebarWbHtml, /⌘K/);
  assert.match(sidebarWbHtml, />Tools</);

  // Fallback: when host does NOT support ai.sidebar-tools, fallback AI button renders
  assert.equal(wbHtml.includes('ndb-topbar-ai-btn'), true, 'fallback AI button renders when host sidebar is unavailable');
});

test('All Netcatty Database v0.3.0 tabs & drawers render cleanly (SQL, Table, Structure, ObjectDef, ER, Redis, Mongo, Diff, ConfirmSql, Params)', () => {
  const t = createUiTranslator('en');
  const conn = makeDefaultConnection('sqlite');
  const sqliteDriver = new SqliteDriver();
  const session: ActiveSession = {
    connectionId: conn.id,
    connection: conn,
    driver: sqliteDriver,
    family: 'sqlite',
    info: { engine: 'sqlite', family: 'sqlite', serverVersion: 'SQLite 3.46', database: 'main', tlsActive: false, latencyMs: 1 },
    databases: [{ name: 'main' }],
    activeDatabase: 'main',
    schemas: [{ name: 'main' }],
    activeSchema: 'main',
    objectsBySchema: {},
    mongoCollectionsByDb: {},
  };

  // 1. SQL Query Tab (with error message + Fix with AI button)
  const sqlTab: SqlQueryTabState = {
    id: 't-sql',
    connectionId: conn.id,
    kind: 'sql',
    title: 'Query 1',
    dialect: 'sqlite',
    database: 'main',
    schema: 'main',
    sql: 'SELECT * FROM customers;',
    selectedText: '',
    txMode: 'manual',
    inTransaction: true,
    running: false,
    results: [
      {
        sql: 'SELECT * FROM customers;',
        columns: [{ name: 'id', dataType: 'INTEGER', isPrimaryKey: true }, { name: 'name', dataType: 'TEXT' }],
        rows: [[1, 'Ada Lovelace']],
        rowCount: 1,
        affectedRows: 0,
        executionMs: 3,
        truncated: false,
      },
    ],
    activeResultTab: 'messages',
    resultFilter: '',
    resultSort: null,
    explainViewMode: 'tree',
    messages: [{ time: Date.now(), level: 'error', text: 'no such table: missing_tbl', line: 1, column: 15, sql: 'SELECT * FROM missing_tbl' }],
    explainResult: null,
    diagnostics: [],
    serverDiagnostics: [],
    lastParamValues: {},
  };
  const sqlHtml = renderToStaticMarkup(
    React.createElement(SqlQueryTab, {
      tab: sqlTab,
      session,
      t,
      onUpdateTab() {},
      onExecute() {},
      onCancel() {},
      onFormat() {},
      onExplain() {},
      onToggleTxMode() {},
      onBeginTx() {},
      onCommitTx() {},
      onRollbackTx() {},
      onOpenSqlFile() {},
      onSaveSqlFile() {},
      onOpenHistory() {},
      onOpenAi() {},
      onFixWithAi() {},
      onExportResult() {},
      onInspectCell() {},
    }),
  );
  assert.match(sqlHtml, /data-plugin-widget="code-editor"/);
  assert.match(sqlHtml, /Fix with AI/);
  assert.match(sqlHtml, /L1:C15/);

  // 2. Table Data Tab with Visual Filter Builder, Column Picker & Undo/Redo Pending Bar
  const tableTab: TableDataTabState = {
    id: 't-tbl',
    connectionId: conn.id,
    kind: 'table',
    title: 'customers',
    database: 'main',
    schema: 'main',
    table: 'customers',
    structure: null,
    whereClause: 'id > 0',
    appliedWhere: 'id > 0',
    filterRules: [{ id: 'r1', column: 'id', operator: '>', value: '0', combinator: 'AND', enabled: true }],
    showFilterBuilder: true,
    hiddenColumns: [],
    sort: { column: 'id', direction: 'asc' },
    page: 1,
    pageSize: 50,
    totalRows: 25,
    totalEstimated: false,
    columns: [{ name: 'id', dataType: 'INTEGER', isPrimaryKey: true }, { name: 'name', dataType: 'TEXT' }],
    rows: [[1, 'Ada']],
    loading: false,
    executionMs: 2,
    sql: 'SELECT * FROM customers',
    dirtyCells: { '0:name': 'Ada L.' },
    insertedRows: [],
    deletedRowIndices: [],
    selectedRowIndices: [],
    undoStack: [{ dirtyCells: {}, insertedRows: [], deletedRowIndices: [] }],
    redoStack: [],
  };
  const tableHtml = renderToStaticMarkup(
    React.createElement(TableDataTab, {
      tab: tableTab,
      session,
      t,
      onUpdateTab() {},
      onReload() {},
      onOpenStructure() {},
      onOpenImport() {},
      onExportData() {},
      onPreviewChanges() {},
      onCommitChanges() {},
      onDiscardChanges() {},
      onInspectCell() {},
      onCopyText() {},
      onCopyRowAsSql() {},
      onOpenContextMenu() {},
    }),
  );
  assert.match(tableHtml, /data-plugin-widget="data-grid"/);
  assert.match(tableHtml, /Filter Builder/);
  assert.match(tableHtml, /Apply Rules/);
  assert.match(tableHtml, /Pending changes/);
  assert.match(tableHtml, /Undo/);

  // 3. Structure Designer Tab (with Checks sub-tab)
  const structTab: StructureDesignerTabState = {
    id: 't-struct',
    connectionId: conn.id,
    kind: 'structure',
    title: 'customers',
    database: 'main',
    schema: 'main',
    table: 'customers',
    structure: {
      database: 'main',
      schema: 'main',
      table: 'customers',
      columns: [{ name: 'id', dataType: 'INTEGER', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true }],
      indexes: [],
      foreignKeys: [],
      checkConstraints: [{ name: 'chk_id', expression: 'id > 0' }],
      createDdl: 'CREATE TABLE customers (id INTEGER PRIMARY KEY);',
    },
    triggers: [],
    activeSubTab: 'checks',
    pendingDiff: { addColumns: [{ name: 'notes', dataType: 'TEXT', nullable: true }] },
    loading: false,
    applying: false,
  };
  const structHtml = renderToStaticMarkup(
    React.createElement(StructureDesignerTab, {
      tab: structTab,
      session,
      t,
      onUpdateTab() {},
      onReload() {},
      onPreviewAlter() {},
      onApplyAlter() {},
      onOpenData() {},
    }),
  );
  assert.match(structHtml, /chk_id/);
  assert.match(structHtml, /Preview ALTER DDL/);

  // 4. Object Definition Viewer Tab
  const objDefTab: ObjectDefTabState = {
    id: 't-def',
    connectionId: conn.id,
    kind: 'objectDef',
    title: 'v_orders (view)',
    objectKind: 'view',
    database: 'main',
    schema: 'main',
    name: 'v_orders',
    definition: 'CREATE VIEW v_orders AS SELECT * FROM orders;',
  };
  const objDefHtml = renderToStaticMarkup(
    React.createElement(ObjectDefTab, {
      tab: objDefTab,
      session,
      t,
      onOpenInQuery() {},
      onCopyDdl() {},
      onOpenViewData() {},
    }),
  );
  assert.match(objDefHtml, /VIEW/);
  assert.match(objDefHtml, /v_orders/);
  assert.match(objDefHtml, /Open Data/);

  // 5. ER Diagram Tab
  const erTab: ErDiagramTabState = {
    id: 't-er',
    connectionId: conn.id,
    kind: 'er',
    title: 'ER: main',
    database: 'main',
    schema: 'main',
    graph: {
      database: 'main',
      schema: 'main',
      tables: [
        { name: 'customers', schema: 'main', columns: [{ name: 'id', dataType: 'INTEGER', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true }] },
        { name: 'orders', schema: 'main', columns: [{ name: 'id', dataType: 'INTEGER', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true }, { name: 'customer_id', dataType: 'INTEGER', nullable: false, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false }] },
      ],
      edges: [{ id: 'e1', name: 'fk_orders_cust', sourceTable: 'orders', sourceColumns: ['customer_id'], targetTable: 'customers', targetColumns: ['id'], onDelete: 'CASCADE' }],
    },
    filter: '',
    selectedTable: 'orders',
    loading: false,
  };
  const erHtml = renderToStaticMarkup(
    React.createElement(ErDiagramTab, {
      tab: erTab,
      t,
      onUpdateTab() {},
      onReload() {},
      onDumpSql() {},
      onOpenSchemaDiff() {},
      onOpenTableData() {},
      onOpenTableStructure() {},
      onExportSvg() {},
    }),
  );
  assert.match(erHtml, /data-plugin-widget="er-canvas"/);

  // 6. Redis Specialist Tab (with Load More cursor & Pub/Sub sub-tab)
  const redisDriver = new PureRedisDriver();
  const redisTab: RedisWorkbenchTabState = {
    id: 't-redis',
    connectionId: 'r1',
    kind: 'redis',
    title: 'Redis',
    db: 0,
    matchPattern: '*',
    viewMode: 'tree',
    activeSubTab: 'keys',
    keys: [{ key: 'user:1:profile', type: 'hash', ttlMs: 60_000 }],
    cursor: '42',
    selectedKey: 'user:1:profile',
    keyDetail: { key: 'user:1:profile', type: 'hash', ttlMs: 60_000, size: 128, value: { name: 'Ada' } },
    info: null,
    infoFilter: '',
    showCli: true,
    cliInput: '',
    cliHistory: [{ command: 'PING', args: [], output: 'PONG', formatted: 'PONG', executionMs: 1, isError: false }],
    cliCommandHistory: ['PING'],
    pubsubChannel: 'events',
    pubsubMessage: '',
    pubsubSubscribed: [],
    pubsubLog: [],
    loading: false,
  };
  const redisHtml = renderToStaticMarkup(
    React.createElement(RedisWorkbenchTab, {
      tab: redisTab,
      driver: redisDriver,
      t,
      onUpdateTab() {},
      onScan: async () => {},
      onSelectKey: async () => {},
      onNotify() {},
    }),
  );
  assert.match(redisHtml, /HASH/);
  assert.match(redisHtml, /PONG/);
  assert.match(redisHtml, /Load More/);
  assert.match(redisHtml, /Pub\/Sub/);

  // 7. MongoDB Specialist Tab (Schema Analyzer sub-tab)
  const mongoDriver = new PureMongoDriver();
  const mongoTab: MongoWorkbenchTabState = {
    id: 't-mongo',
    connectionId: 'm1',
    kind: 'mongo',
    title: 'users',
    database: 'shop_demo',
    collection: 'users',
    mode: 'find',
    filterJson: '{}',
    sortJson: '',
    projectionJson: '',
    pipelineJson: '[]',
    limit: 50,
    skip: 0,
    viewMode: 'tree',
    activeSubTab: 'schema',
    documents: [{ _id: 'u1', name: 'Ada', tags: ['admin'] }],
    totalCount: 1,
    indexes: [{ name: '_id_', key: { _id: 1 } }],
    stats: { ns: 'shop_demo.users', count: 1, size: 256, avgObjSize: 256, storageSize: 4096, nindexes: 1, totalIndexSize: 4096 },
    schemaAnalysis: {
      database: 'shop_demo',
      collection: 'users',
      sampleCount: 1,
      totalDocuments: 1,
      fields: [{ path: 'name', count: 1, percentage: 100, types: [{ type: 'string', count: 1, percentage: 100 }], samples: ['Ada'] }],
    },
    schemaLoading: false,
    selectedDocIndex: null,
    executionMs: 4,
    loading: false,
  };
  const mongoHtml = renderToStaticMarkup(
    React.createElement(MongoWorkbenchTab, {
      tab: mongoTab,
      driver: mongoDriver,
      t,
      onUpdateTab() {},
      onRun: async () => {},
      onReloadIndexes: async () => {},
      onAnalyzeSchema: async () => {},
      onNotify() {},
    }),
  );
  assert.match(mongoHtml, /shop_demo\.users/);
  assert.match(mongoHtml, /Sampled 1 of 1 docs/);

  // 8. Schema Diff / Dump / Restore / Transfer Tab
  const diffTab: SchemaDiffTabState = {
    id: 't-diff',
    connectionId: conn.id,
    kind: 'diff',
    title: 'Schema Diff',
    mode: 'diff',
    leftConnectionId: conn.id,
    leftDatabase: 'main',
    leftSchema: 'main',
    rightConnectionId: conn.id,
    rightDatabase: 'main',
    rightSchema: 'main',
    diffResult: {
      dialect: 'sqlite',
      addedTables: ['audit_log'],
      droppedTables: [],
      modifiedTables: [],
      items: [{ id: 'table:add:audit_log', kind: 'table', action: 'add', table: 'audit_log', name: 'audit_log', summary: 'Create table audit_log', sql: ['CREATE TABLE audit_log (id INTEGER);'] }],
      migrationStatements: ['CREATE TABLE audit_log (id INTEGER);'],
      migrationSql: 'CREATE TABLE audit_log (id INTEGER);',
    },
    selectedItemIds: ['table:add:audit_log'],
    dumpSql: '',
    dumpTables: [],
    includeData: true,
    restoreFileName: '',
    restoreSql: '',
    restoreContinueOnError: false,
    restoreProgress: null,
    restoreResult: null,
    transferTables: [],
    transferCreateTables: true,
    transferDropIfExists: false,
    transferIncludeData: true,
    transferProgress: null,
    transferResult: null,
    loading: false,
  };
  const diffHtml = renderToStaticMarkup(
    React.createElement(SchemaDiffTab, {
      tab: diffTab,
      session,
      sessions: { [conn.id]: session },
      t,
      onUpdateTab() {},
      onRunDiff() {},
      onApplySelectedDiff() {},
      onRunDump() {},
      onPickRestoreFile() {},
      onRunRestore() {},
      onRunTransfer() {},
      onSaveSql() {},
      onOpenInQuery() {},
    }),
  );
  assert.match(diffHtml, /SQL Restore/);
  assert.match(diffHtml, /Data Transfer/);
  assert.match(diffHtml, /Create table audit_log/);

  // 9. Destructive SQL Confirmation Drawer & SQL Parameter Prompt Drawer
  const confirmHtml = renderToStaticMarkup(
    React.createElement(ConfirmSqlDrawer, {
      target: {
        title: 'shop_demo',
        sql: 'DELETE FROM orders;',
        dialect: 'postgres',
        assessment: { isReadOnly: false, isWrite: true, level: 'destructive', destructiveReasons: ['DELETE without WHERE clause'], statements: [] },
        onConfirm: async () => {},
      },
      t,
      onClose() {},
    }),
  );
  assert.match(confirmHtml, /Destructive SQL Warning/);
  assert.match(confirmHtml, /DELETE without WHERE clause/);

  const paramHtml = renderToStaticMarkup(
    React.createElement(SqlParameterDrawer, {
      target: {
        tabId: 't-sql',
        sql: 'SELECT * FROM orders WHERE customer_id = :cid',
        dialect: 'postgres',
        parameters: [{ name: 'cid', raw: ':cid', kind: 'named', index: 1, occurrences: 1 }],
        initialValues: { cid: '42' },
        onExecute: async () => {},
      },
      t,
      onClose() {},
    }),
  );
  assert.match(paramHtml, /Bind SQL Parameters/);
  assert.match(paramHtml, /:cid/);

  // 10. Neo4j Graph Workbench Tab (host-rendered PluginErCanvas + label chips + node inspector)
  const graphTab: GraphWorkbenchTabState = {
    id: 't-graph',
    connectionId: conn.id,
    kind: 'graph',
    title: 'Neo4j Local · Graph',
    database: 'neo4j',
    cypher: 'MATCH (a:Person)-[r:KNOWS]->(b:Person) RETURN a, r, b LIMIT 25',
    viewMode: 'graph',
    result: {
      cypher: 'MATCH (a:Person)-[r:KNOWS]->(b:Person) RETURN a, r, b LIMIT 25',
      columns: ['a', 'r', 'b'],
      rows: [['Alice', 'KNOWS', 'Bob']],
      nodes: [
        { id: '1', labels: ['Person'], properties: { name: 'Alice', role: 'Architect' } },
        { id: '2', labels: ['Person'], properties: { name: 'Bob', role: 'Engineer' } },
      ],
      relationships: [
        { id: '10', type: 'KNOWS', startNodeId: '1', endNodeId: '2', properties: { since: 2024 } },
      ],
      rowCount: 1,
      executionMs: 4,
      truncated: false,
    },
    schema: {
      database: 'neo4j',
      labels: [{ label: 'Person', count: 42 }, { label: 'Company', count: 5 }],
      relationshipTypes: ['KNOWS', 'WORKS_AT'],
      propertyKeys: ['name', 'role', 'since'],
      indexes: [],
      constraints: [],
    },
    selectedNodeId: '1',
    running: false,
  };
  const graphHtml = renderToStaticMarkup(
    React.createElement(GraphWorkbenchTab, {
      tab: graphTab,
      driver: new Neo4jDriver(),
      t,
      onUpdateTab() {},
      onRunCypher: async () => {},
      onRefreshSchema: async () => {},
    }),
  );
  assert.match(graphHtml, /Run Cypher/);
  assert.match(graphHtml, /:Person \(42\)/);
  assert.match(graphHtml, /-\[:KNOWS\]-&gt;/);
  assert.match(graphHtml, /Expand Neighbors/);

  // 11. Search & Vector Workbench Tab (Elasticsearch / Qdrant)
  const searchTab: SearchWorkbenchTabState = {
    id: 't-search',
    connectionId: conn.id,
    kind: 'search',
    title: 'products',
    index: 'products',
    queryText: '{"match_all":{}}',
    viewMode: 'json',
    activeSubTab: 'documents',
    documents: [{ id: 'doc-1', score: 1.5, source: { title: 'Widget', price: 29 } }],
    totalCount: 1,
    mapping: { properties: { title: { type: 'text' } } },
    from: 0,
    size: 50,
    executionMs: 6,
    loading: false,
  };
  const searchHtml = renderToStaticMarkup(
    React.createElement(SearchWorkbenchTab, {
      tab: searchTab,
      driver: new SearchVectorDriver('elasticsearch'),
      t,
      onUpdateTab() {},
      onRunSearch: async () => {},
      onLoadMapping: async () => {},
      onNotify() {},
    }),
  );
  assert.match(searchHtml, /Mapping \/ Schema/);
  assert.match(searchHtml, /REST Console/);
  assert.match(searchHtml, /Widget/);

  // 12. Registry / Config KV Workbench Tab (etcd / Consul / Nacos)
  const kvTab: KvWorkbenchTabState = {
    id: 't-kv',
    connectionId: conn.id,
    kind: 'kv',
    title: 'etcd Local · KV',
    namespace: 'default',
    prefix: '/app/',
    entries: [{ key: '/app/db/url', value: 'postgres://localhost:5432/app', revision: 7 }],
    selectedKey: '/app/db/url',
    selectedEntry: { key: '/app/db/url', value: 'postgres://localhost:5432/app', revision: 7 },
    loading: false,
  };
  const kvHtml = renderToStaticMarkup(
    React.createElement(KvWorkbenchTab, {
      tab: kvTab,
      driver: new KvHttpDriver('etcd'),
      t,
      onUpdateTab() {},
      onReload: async () => {},
      onSelectKey: async () => {},
      onNotify() {},
    }),
  );
  assert.match(kvHtml, /\/app\/db\/url/);
  assert.match(kvHtml, /rev 7/);

  // 13. Expanded URI schemes (Neo4j Bolt, MSSQL, Elasticsearch, Qdrant, etcd)
  const bolt = parseConnectionUri('bolt+s://neo4j:secret@graph.internal:7687/movies');
  assert.equal(bolt.engine, 'neo4j');
  assert.equal(bolt.port, 7687);
  assert.equal(bolt.database, 'movies');
  assert.equal(bolt.tlsMode, 'verify-full');

  const mssql = parseConnectionUri('mssql://sa:P@ss@10.0.0.2:1433/sales');
  assert.equal(mssql.engine, 'sqlserver');
  assert.equal(mssql.port, 1433);
  assert.equal(mssql.database, 'sales');

  const es = parseConnectionUri('elasticsearch://elastic:pw@10.0.0.3:9200');
  assert.equal(es.engine, 'elasticsearch');
  assert.equal(es.port, 9200);

  const etcd = parseConnectionUri('etcd://10.0.0.4:2379');
  assert.equal(etcd.engine, 'etcd');
  assert.equal(etcd.port, 2379);
});

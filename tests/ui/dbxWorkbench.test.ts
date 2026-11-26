/**
 * DBX Workbench UI unit & React render tests.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PluginContext } from '@netcatty/plugin-sdk';
import { drivers } from '../../src/driverRegistry';
import { createUiTranslator, formatBytes, formatTtl } from '../../src/ui/i18n';
import { exportConnectionUri, parseConnectionUri } from '../../src/ui/uriParser';
import {
  coerceCellInput,
  createModalBridge,
  formatCellForClipboard,
  makeDefaultConnection,
} from '../../src/ui/sessionManager';
import { WorkbenchStorage } from '../../src/ui/storage';
import { createWorkbenchTransport } from '../../src/ui/transport';
import { PureRedisDriver, PureMongoDriver, SqliteDriver } from '../../src/drivers/index';
import type {
  ActiveSession,
  ErDiagramTabState,
  MongoWorkbenchTabState,
  RedisWorkbenchTabState,
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
  { DbxWorkbench },
  { ConnectionModalView },
  { ConnectionDrawer },
  { SqlQueryTab },
  { TableDataTab },
  { StructureDesignerTab },
  { ErDiagramTab },
  { RedisWorkbenchTab },
  { MongoWorkbenchTab },
] = await Promise.all([
  import('../../src/ui/DbxWorkbench'),
  import('../../src/ui/ConnectionModalView'),
  import('../../src/ui/components/ConnectionDrawer'),
  import('../../src/ui/components/SqlQueryTab'),
  import('../../src/ui/components/TableDataTab'),
  import('../../src/ui/components/StructureDesignerTab'),
  import('../../src/ui/components/ErDiagramTab'),
  import('../../src/ui/components/RedisWorkbenchTab'),
  import('../../src/ui/components/MongoWorkbenchTab'),
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

test('WorkbenchStorage persists connections without passwords and stores secrets in encrypted store', async () => {
  const { context, kv, secrets } = createMockContext();
  const storage = new WorkbenchStorage(context);
  const conn = makeDefaultConnection('postgres');
  conn.name = 'Staging PG';
  conn.hasPassword = await storage.savePassword(conn.id, 'super-secret-pw');
  await storage.saveConnections([conn]);

  assert.equal(secrets.get(`dbx.password.v1.${conn.id}`), 'super-secret-pw');
  assert.equal(JSON.stringify(kv.get('dbx.connections.v1')).includes('super-secret-pw'), false);

  const loaded = await storage.loadConnections();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, 'Staging PG');
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
  assertNoUndefinedProperties(kv.get('dbx.connections.v1'), 'connections');

  await storage.saveTabDrafts(conn.id, [{ id: 't1', kind: 'sql', title: 'Q1', sql: 'SELECT 1', table: undefined }]);
  assertNoUndefinedProperties(kv.get(`dbx.tabs.v1.${conn.id}`), 'tabDrafts');

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

test('DbxWorkbench & ConnectionModalView render full-bleed chrome and all 22 engine brand icons', () => {
  const { context } = createMockContext();
  const bridge = createModalBridge();

  const wbHtml = renderToStaticMarkup(React.createElement(DbxWorkbench, { context, modalBridge: bridge }));
  assert.match(wbHtml, /data-plugin-chrome="full-bleed"/);
  assert.match(wbHtml, /data-plugin-widget="split-pane"/);
  assert.match(wbHtml, /Open Local SQLite File/);
  assert.match(wbHtml, /Launch Sample SQLite/);

  const modalHtml = renderToStaticMarkup(
    React.createElement(ConnectionModalView, { context, modalBridge: bridge }),
  );
  assert.match(modalHtml, /Select Database Engine/);
  for (const d of drivers) {
    assert.match(modalHtml, new RegExp(`assets/icons/${d.icon}-dark\\.png`), `Missing icon for ${d.id}`);
  }

  // Also test light-theme icon selection
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
});

test('All DBX workbench tabs (SQL, Table Data, Structure, ER, Redis, MongoDB) render host-native primitives cleanly', () => {
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

  // 1. SQL Query Tab
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
    activeResultTab: 0,
    messages: [],
    explainResult: null,
    diagnostics: [],
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
      onExportResult() {},
      onInspectCell() {},
    }),
  );
  assert.match(sqlHtml, /data-plugin-widget="code-editor"/);
  assert.match(sqlHtml, /data-plugin-widget="data-grid"/);
  assert.match(sqlHtml, /Commit/);
  assert.match(sqlHtml, /Rollback/);

  // 2. Table Data Tab with Pending Changes Bar
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
  assert.match(tableHtml, /Pending changes/);
  assert.match(tableHtml, /Preview SQL/);

  // 3. Structure Designer Tab
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
      checkConstraints: [],
      createDdl: 'CREATE TABLE customers (id INTEGER PRIMARY KEY);',
    },
    triggers: [],
    activeSubTab: 'columns',
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
  assert.match(structHtml, /Preview ALTER DDL/);
  assert.match(structHtml, /notes/);

  // 4. ER Diagram Tab
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
      edges: [{ id: 'e1', name: 'fk_orders_cust', sourceTable: 'orders', sourceColumns: ['customer_id'], targetTable: 'customers', targetColumns: ['id'] }],
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
    }),
  );
  assert.match(erHtml, /data-plugin-widget="er-canvas"/);

  // 5. Redis Specialist Tab
  const redisDriver = new PureRedisDriver();
  const redisTab: RedisWorkbenchTabState = {
    id: 't-redis',
    connectionId: 'r1',
    kind: 'redis',
    title: 'Redis',
    db: 0,
    matchPattern: '*',
    viewMode: 'tree',
    keys: [{ key: 'user:1:profile', type: 'hash', ttlMs: 60_000 }],
    cursor: '0',
    selectedKey: 'user:1:profile',
    keyDetail: { key: 'user:1:profile', type: 'hash', ttlMs: 60_000, value: { name: 'Ada' } },
    info: null,
    showInfo: false,
    showCli: true,
    cliInput: '',
    cliHistory: [{ command: 'PING', args: [], output: 'PONG', formatted: 'PONG', executionMs: 1, isError: false }],
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

  // 6. MongoDB Specialist Tab
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
    activeSubTab: 'documents',
    documents: [{ _id: 'u1', name: 'Ada', tags: ['admin'] }],
    totalCount: 1,
    indexes: [{ name: '_id_', key: { _id: 1 } }],
    stats: { ns: 'shop_demo.users', count: 1, size: 256, avgObjSize: 256, storageSize: 4096, nindexes: 1, totalIndexSize: 4096 },
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
      onNotify() {},
    }),
  );
  assert.match(mongoHtml, /shop_demo\.users/);
  assert.match(mongoHtml, /Ada/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HttpSqlDriver,
  parseFluxAnnotatedCsv,
} from '../../src/drivers/httpSqlDriver';
import { SearchVectorDriver } from '../../src/drivers/searchVectorDriver';
import {
  computeEtcdPrefixRangeEnd,
  KvHttpDriver,
} from '../../src/drivers/kvHttpDriver';
import {
  bytesToBase64,
  type ByteStream,
  type ByteStreamEndpoint,
  type ByteStreamTransport,
  type HttpRequestOptions,
  type HttpResponseData,
} from '../../src/drivers/types';

const te = new TextEncoder();
const td = new TextDecoder('utf-8');

interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

type MockRouteResult = {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
  chunked?: boolean;
};

type MockRouteHandler = (req: RecordedRequest) => MockRouteResult | Promise<MockRouteResult>;

function normalizeHeaders(headers?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

/**
 * Mock transport using `httpRequest` (direct Netcatty host HTTP path).
 */
function createMockHttpTransport(handler: MockRouteHandler): {
  transport: ByteStreamTransport;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const transport: ByteStreamTransport = {
    async connect(): Promise<ByteStream> {
      throw new Error('Unexpected raw ByteStream connect in direct HTTP mock');
    },
    async httpRequest(request: HttpRequestOptions): Promise<HttpResponseData> {
      const parsed = new URL(request.url);
      const bodyStr =
        request.body === undefined
          ? ''
          : typeof request.body === 'string'
            ? request.body
            : td.decode(request.body);
      const rec: RecordedRequest = {
        method: request.method,
        url: request.url,
        path: `${parsed.pathname}${parsed.search}`,
        headers: normalizeHeaders(request.headers),
        body: bodyStr,
      };
      requests.push(rec);
      const res = await handler(rec);
      const status = res.status ?? 200;
      const respHeaders = normalizeHeaders(res.headers);
      let respText = '';
      if (res.json !== undefined) {
        respText = JSON.stringify(res.json);
        if (!respHeaders['content-type']) respHeaders['content-type'] = 'application/json';
      } else if (res.text !== undefined) {
        respText = res.text;
      }
      return {
        status,
        headers: respHeaders,
        body: te.encode(respText),
      };
    },
  };
  return { transport, requests };
}

/**
 * Mock transport using ONLY raw ByteStream (`connect()` without `httpRequest`),
 * speaking real HTTP/1.1 (Content-Length or Transfer-Encoding: chunked).
 */
function createMockByteStreamHttpTransport(handler: MockRouteHandler): {
  transport: ByteStreamTransport;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const transport: ByteStreamTransport = {
    async connect(endpoint: ByteStreamEndpoint): Promise<ByteStream> {
      const incomingChunks: Uint8Array[] = [];
      let responseQueue: Uint8Array[] | null = null;
      let readIdx = 0;

      const buildResponseChunks = async (): Promise<Uint8Array[]> => {
        const totalLen = incomingChunks.reduce((sum, c) => sum + c.length, 0);
        const full = new Uint8Array(totalLen);
        let offset = 0;
        for (const c of incomingChunks) {
          full.set(c, offset);
          offset += c.length;
        }
        const rawText = td.decode(full);
        const sep = rawText.indexOf('\r\n\r\n');
        const headPart = sep >= 0 ? rawText.slice(0, sep) : rawText;
        const bodyPart = sep >= 0 ? rawText.slice(sep + 4) : '';
        const lines = headPart.split('\r\n');
        const [method, path] = lines[0].split(' ');
        const headers: Record<string, string> = {};
        for (let i = 1; i < lines.length; i++) {
          const colon = lines[i].indexOf(':');
          if (colon > 0) {
            headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i].slice(colon + 1).trim();
          }
        }
        const scheme = endpoint.tls ? 'https' : 'http';
        const rec: RecordedRequest = {
          method,
          url: `${scheme}://${endpoint.host}:${endpoint.port}${path}`,
          path,
          headers,
          body: bodyPart,
        };
        requests.push(rec);
        const res = await handler(rec);
        const status = res.status ?? 200;
        const respHeaders = normalizeHeaders(res.headers);
        let respText = '';
        if (res.json !== undefined) {
          respText = JSON.stringify(res.json);
          if (!respHeaders['content-type']) respHeaders['content-type'] = 'application/json';
        } else if (res.text !== undefined) {
          respText = res.text;
        }
        const bodyBytes = te.encode(respText);
        const outLines = [`HTTP/1.1 ${status} OK`];
        for (const [k, v] of Object.entries(respHeaders)) {
          outLines.push(`${k}: ${v}`);
        }
        if (res.chunked) {
          outLines.push('transfer-encoding: chunked', '', '');
          const headBytes = te.encode(outLines.join('\r\n'));
          const mid = Math.max(1, Math.floor(bodyBytes.length / 2));
          const part1 = bodyBytes.subarray(0, mid);
          const part2 = bodyBytes.subarray(mid);
          const chunks: Uint8Array[] = [headBytes];
          if (part1.length > 0) {
            chunks.push(te.encode(`${part1.length.toString(16)}\r\n`), part1, te.encode('\r\n'));
          }
          if (part2.length > 0) {
            chunks.push(te.encode(`${part2.length.toString(16)}\r\n`), part2, te.encode('\r\n'));
          }
          chunks.push(te.encode('0\r\n\r\n'));
          return chunks;
        }
        outLines.push(`content-length: ${bodyBytes.length}`, '', '');
        const headBytes = te.encode(outLines.join('\r\n'));
        return [headBytes, bodyBytes];
      };

      return {
        isTls: Boolean(endpoint.tls),
        async write(data: Uint8Array): Promise<void> {
          incomingChunks.push(data);
        },
        async read(): Promise<Uint8Array | null> {
          if (!responseQueue) {
            responseQueue = await buildResponseChunks();
          }
          if (readIdx >= responseQueue.length) return null;
          return responseQueue[readIdx++];
        },
        async close(): Promise<void> {},
      };
    },
  };
  return { transport, requests };
}

/* ============================================================================
 * 1. HttpSqlDriver Tests (9 engines)
 * ============================================================================ */

test('HttpSqlDriver: Trino polling, headers, metadata, cancel, browse, DDL, dump, diff', async () => {
  let deletedUri = '';
  const { transport, requests } = createMockHttpTransport((req) => {
    if (req.method === 'GET' && req.path === '/v1/info') {
      return { json: { nodeVersion: { version: '449' } } };
    }
    if (req.method === 'DELETE') {
      deletedUri = req.path;
      return { status: 204 };
    }
    if (req.method === 'POST' && req.path === '/v1/statement') {
      const sql = req.body.trim();
      if (sql === 'SHOW CATALOGS') {
        return { json: { columns: [{ name: 'Catalog', type: 'varchar' }], data: [['hive'], ['memory']] } };
      }
      if (sql.startsWith('SHOW SCHEMAS')) {
        return { json: { columns: [{ name: 'Schema', type: 'varchar' }], data: [['default'], ['information_schema']] } };
      }
      if (sql.startsWith('SHOW TABLES')) {
        return { json: { columns: [{ name: 'Table', type: 'varchar' }], data: [['events']] } };
      }
      if (sql.startsWith('DESCRIBE')) {
        return {
          json: {
            columns: [
              { name: 'Column', type: 'varchar' },
              { name: 'Type', type: 'varchar' },
              { name: 'Extra', type: 'varchar' },
              { name: 'Comment', type: 'varchar' },
            ],
            data: [
              ['id', 'bigint', '', 'primary id'],
              ['name', 'varchar', '', 'event name'],
            ],
          },
        };
      }
      if (sql.startsWith('EXPLAIN')) {
        return { json: { columns: [{ name: 'Query Plan', type: 'varchar' }], data: [['Output[id]\n  TableScan[events]']] } };
      }
      if (sql.startsWith('SELECT COUNT(*)')) {
        return { json: { columns: [{ name: '_col0', type: 'bigint' }], data: [[10]] } };
      }
      if (sql.startsWith('SELECT * FROM')) {
        return {
          json: {
            id: 'q1',
            nextUri: 'http://trino.local:8080/v1/statement/q1/2',
            columns: [
              { name: 'id', type: 'bigint' },
              { name: 'name', type: 'varchar' },
            ],
            data: [[1, 'click']],
          },
        };
      }
      return { json: { columns: [], data: [], updateType: 'OK', updateCount: 1 } };
    }
    if (req.method === 'GET' && req.path === '/v1/statement/q1/2') {
      return {
        json: {
          id: 'q1',
          nextUri: 'http://trino.local:8080/v1/statement/q1/3',
          data: [[2, 'view']],
        },
      };
    }
    if (req.method === 'GET' && req.path === '/v1/statement/q1/3') {
      return {
        json: {
          id: 'q1',
          data: [[3, 'purchase']],
        },
      };
    }
    return { status: 404, text: `Unhandled ${req.method} ${req.path}` };
  });

  const driver = new HttpSqlDriver('trino');
  const info = await driver.connect(
    {
      engine: 'trino',
      host: 'trino.local',
      port: 8080,
      username: 'analyst',
      database: 'hive',
      schema: 'default',
    },
    transport,
  );
  assert.equal(info.family, 'http_sql');
  assert.equal(info.serverVersion, 'Trino 449');

  const catalogs = await driver.listDatabases();
  assert.deepEqual(catalogs.map((c) => c.name), ['hive', 'memory']);

  const schemas = await driver.listSchemas('hive');
  assert.equal(schemas.find((s) => s.name === 'information_schema')?.isSystem, true);

  const tables = await driver.listTables('hive', 'default');
  assert.deepEqual(tables.map((t) => t.name), ['events']);

  const struct = await driver.getTableStructure('hive', 'default', 'events');
  assert.equal(struct.columns.length, 2);
  assert.equal(struct.columns[0].name, 'id');

  // Full multi-page poll
  const multi = await driver.query('SELECT * FROM "hive"."default"."events";');
  assert.equal(multi.results[0].rows.length, 3);
  assert.equal(multi.results[0].truncated, false);
  const submitReq = requests.find((r) => r.method === 'POST' && r.body.includes('SELECT * FROM'));
  assert.equal(submitReq?.headers['x-trino-user'], 'analyst');
  assert.equal(submitReq?.headers['x-trino-catalog'], 'hive');
  assert.equal(submitReq?.headers['x-trino-schema'], 'default');

  // Truncation triggers DELETE cancel once extra rows exceed maxRows
  const limited = await driver.query('SELECT * FROM "hive"."default"."events"', { maxRows: 1 });
  assert.equal(limited.results[0].rows.length, 1);
  assert.equal(limited.results[0].truncated, true);
  assert.equal(deletedUri, '/v1/statement/q1/3');

  // AbortSignal triggers DELETE cancel on current nextUri
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => driver.query('SELECT * FROM "hive"."default"."events"', { signal: ac.signal }),
    /cancelled/i,
  );
  assert.equal(deletedUri, '/v1/statement/q1/2');

  const browse = await driver.browseTable('hive', 'default', 'events', { page: 1, pageSize: 10 });
  assert.equal(browse.totalRows, 10);
  assert.equal(browse.rows.length, 3);

  const plan = await driver.explain('SELECT * FROM events', true);
  assert.equal(plan.dialect, 'trino');
  assert.match(plan.rawText, /TableScan/);

  const preview = driver.generateBatchMutations('hive', 'default', 'events', struct, {
    inserts: [{ values: { id: 9, name: 'signup' } }],
  });
  assert.match(preview.statements[0], /INSERT INTO "hive"\."default"\."events"/);

  const dump = await driver.dumpDatabaseSql('hive', 'default', ['events'], true);
  assert.match(dump, /CREATE TABLE/);
  assert.match(dump, /INSERT INTO/);

  const diff = driver.diffSchemas(
    { dialect: 'trino', database: 'hive', schema: 'default', tables: [] },
    { dialect: 'trino', database: 'hive', schema: 'default', tables: [struct] },
  );
  assert.deepEqual(diff.addedTables, ['events']);

  await driver.close();
});

test('HttpSqlDriver: PrestoSQL uses X-Presto-* headers and polling', async () => {
  const { transport, requests } = createMockHttpTransport((req) => {
    if (req.path === '/v1/info') {
      return { json: { nodeVersion: { version: '0.286' } } };
    }
    if (req.method === 'POST' && req.path === '/v1/statement') {
      return {
        json: {
          columns: [{ name: 'n', type: 'integer' }],
          data: [[42]],
        },
      };
    }
    return { status: 404 };
  });

  const driver = new HttpSqlDriver('prestosql');
  const info = await driver.connect(
    { engine: 'prestosql', host: 'presto.local', username: 'presto_user', database: 'tpch', schema: 'sf1' },
    transport,
  );
  assert.equal(info.serverVersion, 'Presto 0.286');

  const res = await driver.query('SELECT 42 AS n');
  assert.equal(res.results[0].rows[0][0], 42);
  const postReq = requests.find((r) => r.method === 'POST');
  assert.equal(postReq?.headers['x-presto-user'], 'presto_user');
  assert.equal(postReq?.headers['x-presto-catalog'], 'tpch');
  assert.equal(postReq?.headers['x-presto-schema'], 'sf1');
});

test('HttpSqlDriver: TDengine supports Basic Auth, v2 head/data & v3 column_meta/data, metadata', async () => {
  let useV2 = false;
  const { transport, requests } = createMockHttpTransport((req) => {
    assert.ok(req.headers['authorization']?.startsWith('Basic '));
    const sql = req.body.trim().toUpperCase();
    if (sql === 'SELECT SERVER_VERSION()') {
      return { json: { code: 0, column_meta: [['server_version()', 'VARCHAR', 16]], data: [['3.2.3.0']], rows: 1 } };
    }
    if (sql === 'SHOW DATABASES') {
      return { json: { code: 0, column_meta: [['name', 'VARCHAR', 64]], data: [['power'], ['metrics']], rows: 2 } };
    }
    if (sql === 'SHOW STABLES') {
      return { json: { code: 0, column_meta: [['stable_name', 'VARCHAR', 64]], data: [['meters']], rows: 1 } };
    }
    if (sql === 'SHOW TABLES') {
      return { json: { code: 0, column_meta: [['table_name', 'VARCHAR', 64]], data: [['d1001']], rows: 1 } };
    }
    if (sql.startsWith('DESCRIBE')) {
      return {
        json: {
          code: 0,
          column_meta: [
            ['field', 'VARCHAR', 64],
            ['type', 'VARCHAR', 32],
            ['length', 'INT', 4],
            ['note', 'VARCHAR', 32],
          ],
          data: [
            ['ts', 'TIMESTAMP', 8, ''],
            ['current', 'FLOAT', 4, ''],
            ['location', 'BINARY', 64, 'TAG'],
          ],
          rows: 3,
        },
      };
    }
    if (useV2) {
      return {
        json: {
          status: 'succ',
          head: ['ts', 'val'],
          data: [['2026-01-01T00:00:00Z', 12.5]],
          rows: 1,
        },
      };
    }
    return {
      json: {
        code: 0,
        column_meta: [
          ['ts', 9, 8],
          ['val', 6, 4],
        ],
        data: [['2026-01-01T00:00:00Z', 99.5]],
        rows: 1,
      },
    };
  });

  const driver = new HttpSqlDriver('tdengine');
  const info = await driver.connect(
    { engine: 'tdengine', host: 'td.local', username: 'root', password: 'secret', database: 'power' },
    transport,
  );
  assert.equal(info.serverVersion, 'TDengine 3.2.3.0');
  assert.ok(requests[0].path.endsWith('/rest/sql/power'));

  const dbs = await driver.listDatabases();
  assert.deepEqual(dbs.map((d) => d.name), ['power', 'metrics']);

  const tables = await driver.listTables('power');
  assert.deepEqual(
    tables.map((t) => ({ name: t.name, engine: t.engine })),
    [
      { name: 'meters', engine: 'STABLE' },
      { name: 'd1001', engine: 'TABLE' },
    ],
  );

  const struct = await driver.getTableStructure('power', 'power', 'meters');
  assert.equal(struct.columns[0].isPrimaryKey, true);
  assert.equal(struct.columns[2].extra, 'TAG');

  // v3 numeric type codes
  const v3Res = await driver.query('SELECT ts, val FROM d1001');
  assert.equal(v3Res.results[0].columns[0].dataType, 'TIMESTAMP');
  assert.equal(v3Res.results[0].columns[1].dataType, 'FLOAT');
  assert.equal(v3Res.results[0].rows[0][1], 99.5);

  // v2 head/data format
  useV2 = true;
  const v2Res = await driver.query('SELECT ts, val FROM d1001');
  assert.deepEqual(v2Res.results[0].columns.map((c) => c.name), ['ts', 'val']);
  assert.equal(v2Res.results[0].rows[0][1], 12.5);
});

test('HttpSqlDriver: Databend /v1/query polling with Basic Auth and X-DATABEND-DATABASE', async () => {
  const { transport, requests } = createMockHttpTransport((req) => {
    assert.ok(req.headers['authorization']?.startsWith('Basic '));
    if (req.method === 'POST' && req.path === '/v1/query') {
      const parsed = JSON.parse(req.body) as { sql: string };
      if (parsed.sql === 'SELECT version()') {
        return { json: { state: 'Succeeded', schema: [{ name: 'version()', type: 'String' }], data: [['1.2.400']] } };
      }
      if (parsed.sql === 'SHOW DATABASES') {
        return { json: { state: 'Succeeded', schema: [{ name: 'Database', type: 'String' }], data: [['analytics']] } };
      }
      return {
        json: {
          state: 'Running',
          schema: [{ name: 'id', type: 'UInt64' }],
          data: [[1]],
          next_uri: '/v1/query/q42/page/1',
          kill_uri: '/v1/query/q42/kill',
        },
      };
    }
    if (req.method === 'GET' && req.path === '/v1/query/q42/page/1') {
      return {
        json: {
          state: 'Succeeded',
          data: [[2], [3]],
          next_uri: null,
        },
      };
    }
    return { status: 404 };
  });

  const driver = new HttpSqlDriver('databend');
  const info = await driver.connect(
    { engine: 'databend', host: 'db.local', username: 'root', password: 'pw', database: 'analytics' },
    transport,
  );
  assert.equal(info.serverVersion, 'Databend 1.2.400');

  const res = await driver.query('SELECT id FROM events');
  assert.deepEqual(res.results[0].rows, [[1], [2], [3]]);
  assert.equal(requests[0].headers['x-databend-database'], 'analytics');
});

test('HttpSqlDriver: rqlite routes reads to /db/query and writes to /db/execute with SQLite metadata', async () => {
  const { transport, requests } = createMockHttpTransport((req) => {
    const body = JSON.parse(req.body) as unknown[];
    const sql = String(Array.isArray(body[0]) ? body[0][0] : body[0]);
    if (req.path === '/db/query') {
      if (sql.includes('sqlite_version')) {
        return { json: { results: [{ columns: ['sqlite_version()'], types: ['text'], values: [['3.45.1']] }] } };
      }
      if (sql.includes("type = 'table'") && sql.includes('sqlite_master') && !sql.includes('name =')) {
        return { json: { results: [{ columns: ['name'], types: ['text'], values: [['users']] }] } };
      }
      if (sql.startsWith('PRAGMA table_info')) {
        return {
          json: {
            results: [{
              columns: ['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk'],
              values: [
                [0, 'id', 'INTEGER', 1, null, 1],
                [1, 'email', 'TEXT', 1, null, 0],
              ],
            }],
          },
        };
      }
      if (sql.startsWith('PRAGMA foreign_key_list')) {
        return { json: { results: [{ columns: ['id', 'seq', 'table', 'from', 'to'], values: [] }] } };
      }
      if (sql.startsWith('PRAGMA index_list')) {
        return { json: { results: [{ columns: ['seq', 'name', 'unique', 'origin'], values: [] }] } };
      }
      if (sql.startsWith('EXPLAIN QUERY PLAN')) {
        return {
          json: {
            results: [{
              columns: ['id', 'parent', 'notused', 'detail'],
              values: [[2, 0, 0, 'SCAN TABLE users']],
            }],
          },
        };
      }
      return { json: { results: [{ columns: ['sql'], values: [['CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL)']] }] } };
    }
    if (req.path === '/db/execute') {
      return { json: { results: [{ last_insert_id: 7, rows_affected: 1 }] } };
    }
    return { status: 404 };
  });

  const driver = new HttpSqlDriver('rqlite');
  const info = await driver.connect({ engine: 'rqlite', host: 'rq.local' }, transport);
  assert.match(info.serverVersion, /3\.45\.1/);

  const tables = await driver.listTables();
  assert.deepEqual(tables.map((t) => t.name), ['users']);

  const struct = await driver.getTableStructure('main', 'main', 'users');
  assert.equal(struct.columns[0].isPrimaryKey, true);
  assert.equal(struct.columns[1].nullable, false);

  const insertRes = await driver.query("INSERT INTO users (email) VALUES ('a@b.com')");
  assert.equal(insertRes.results[0].affectedRows, 1);
  assert.equal(insertRes.results[0].insertId, 7);
  assert.ok(requests.some((r) => r.path === '/db/execute'));

  const plan = await driver.explain('SELECT * FROM users');
  assert.equal(plan.dialect, 'sqlite');
  assert.match(plan.rawText, /SCAN TABLE users/);
});

test('HttpSqlDriver: Turso (libSQL) Hrana /v2/pipeline with Bearer auth and typed values', async () => {
  const { transport, requests } = createMockHttpTransport((req) => {
    assert.equal(req.path, '/v2/pipeline');
    assert.equal(req.headers['authorization'], 'Bearer turso-jwt-token');
    const body = JSON.parse(req.body) as { requests: Array<{ stmt?: { sql: string } }> };
    const sql = body.requests[0]?.stmt?.sql ?? '';
    if (sql.includes('sqlite_version')) {
      return {
        json: {
          results: [{
            type: 'ok',
            response: {
              type: 'execute',
              result: {
                cols: [{ name: 'sqlite_version()', decltype: 'TEXT' }],
                rows: [[{ type: 'text', value: '3.45.3' }]],
              },
            },
          }],
        },
      };
    }
    return {
      json: {
        results: [{
          type: 'ok',
          response: {
            type: 'execute',
            result: {
              cols: [
                { name: 'id', decltype: 'INTEGER' },
                { name: 'score', decltype: 'REAL' },
                { name: 'tag', decltype: 'TEXT' },
                { name: 'raw', decltype: 'BLOB' },
                { name: 'opt', decltype: 'TEXT' },
              ],
              rows: [[
                { type: 'integer', value: '42' },
                { type: 'float', value: 3.5 },
                { type: 'text', value: 'alpha' },
                { type: 'blob', base64: bytesToBase64(new Uint8Array([1, 2, 3])) },
                { type: 'null' },
              ]],
              affected_row_count: 0,
            },
          },
        }],
      },
    };
  });

  const driver = new HttpSqlDriver('turso');
  const info = await driver.connect(
    { engine: 'turso', host: 'my-db.turso.io', port: 443, apiKey: 'turso-jwt-token' },
    transport,
  );
  assert.match(info.serverVersion, /3\.45\.3/);
  assert.equal(info.tlsActive, true);

  const res = await driver.query('SELECT id, score, tag, raw, opt FROM items');
  const row = res.results[0].rows[0];
  assert.equal(row[0], 42);
  assert.equal(row[1], 3.5);
  assert.equal(row[2], 'alpha');
  assert.deepEqual(row[3], new Uint8Array([1, 2, 3]));
  assert.equal(row[4], null);
  assert.equal(requests.length, 2);
});

test('HttpSqlDriver: InfluxDB v1 InfluxQL & v2 Flux Annotated CSV', async () => {
  // InfluxDB v1
  const v1Mock = createMockHttpTransport((req) => {
    if (req.path === '/ping') {
      return { status: 204, headers: { 'x-influxdb-version': '1.8.10' } };
    }
    if (req.path.startsWith('/query')) {
      const q = decodeURIComponent(req.body.replace(/^q=/, ''));
      if (q === 'SHOW DATABASES') {
        return { json: { results: [{ series: [{ name: 'databases', columns: ['name'], values: [['telegraf']] }] }] } };
      }
      if (q === 'SHOW MEASUREMENTS') {
        return { json: { results: [{ series: [{ name: 'measurements', columns: ['name'], values: [['cpu']] }] }] } };
      }
      return {
        json: {
          results: [{
            series: [{
              name: 'cpu',
              tags: { host: 'srv-1' },
              columns: ['time', 'usage_idle'],
              values: [['2026-01-01T00:00:00Z', 92.4]],
            }],
          }],
        },
      };
    }
    return { status: 404 };
  });

  const v1Driver = new HttpSqlDriver('influxdb');
  const v1Info = await v1Driver.connect(
    { engine: 'influxdb', host: 'influx1.local', database: 'telegraf' },
    v1Mock.transport,
  );
  assert.equal(v1Info.serverVersion, 'InfluxDB 1.8.10');
  assert.deepEqual((await v1Driver.listDatabases()).map((d) => d.name), ['telegraf']);
  assert.deepEqual((await v1Driver.listTables('telegraf')).map((t) => t.name), ['cpu']);
  const v1Query = await v1Driver.query('SELECT usage_idle FROM cpu LIMIT 1');
  assert.deepEqual(v1Query.results[0].columns.map((c) => c.name), ['host', 'time', 'usage_idle']);
  assert.deepEqual(v1Query.results[0].rows[0], ['srv-1', '2026-01-01T00:00:00Z', 92.4]);

  // InfluxDB v2 Flux CSV
  const fluxCsv = [
    '#group,false,false,true,true,false,false,true',
    '#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,dateTime:RFC3339,double,string',
    '#default,_result,,,,,,',
    ',result,table,_start,_stop,_time,_value,_measurement',
    ',,0,2026-01-01T00:00:00Z,2026-01-01T01:00:00Z,2026-01-01T00:05:00Z,42.5,mem',
    ',,0,2026-01-01T00:00:00Z,2026-01-01T01:00:00Z,2026-01-01T00:10:00Z,43.0,mem',
    '',
  ].join('\r\n');

  const v2Mock = createMockHttpTransport((req) => {
    assert.equal(req.headers['authorization'], 'Token influx-v2-tok');
    if (req.path === '/health') {
      return { json: { name: 'influxdb', version: '2.7.5', status: 'pass' } };
    }
    if (req.path.startsWith('/api/v2/buckets')) {
      return { json: { buckets: [{ id: 'b1', name: 'prod-metrics' }] } };
    }
    if (req.path.startsWith('/api/v2/query')) {
      return { headers: { 'content-type': 'text/csv' }, text: fluxCsv };
    }
    return { status: 404 };
  });

  const v2Driver = new HttpSqlDriver('influxdb');
  const v2Info = await v2Driver.connect(
    { engine: 'influxdb', host: 'influx2.local', org: 'acme', apiKey: 'influx-v2-tok' },
    v2Mock.transport,
  );
  assert.equal(v2Info.serverVersion, 'InfluxDB 2.7.5');
  assert.deepEqual((await v2Driver.listDatabases()).map((d) => d.name), ['prod-metrics']);

  const fluxRes = await v2Driver.query('from(bucket: "prod-metrics") |> range(start: -1h)');
  assert.equal(fluxRes.results[0].rows.length, 2);
  const valColIdx = fluxRes.results[0].columns.findIndex((c) => c.name === '_value');
  assert.equal(fluxRes.results[0].rows[0][valColIdx], 42.5);

  const parsedDirect = parseFluxAnnotatedCsv(fluxCsv, 1);
  assert.equal(parsedDirect.rows.length, 1);
  assert.equal(parsedDirect.truncated, true);
});

test('HttpSqlDriver: InfluxDB 3 /api/v3/query_sql JSON and Bearer auth', async () => {
  const { transport } = createMockHttpTransport((req) => {
    assert.equal(req.headers['authorization'], 'Bearer v3-token');
    if (req.path === '/health') {
      return { json: { version: '3.0.1' } };
    }
    if (req.method === 'POST' && req.path === '/api/v3/query_sql') {
      const body = JSON.parse(req.body) as { db: string; q: string; format: string };
      assert.equal(body.format, 'json');
      if (body.q.includes('information_schema.tables')) {
        return { json: [{ table_name: 'sensors', table_schema: 'iox' }] };
      }
      if (body.q.includes('information_schema.columns')) {
        return {
          json: [
            { column_name: 'time', data_type: 'Timestamp', is_nullable: 'NO' },
            { column_name: 'temp', data_type: 'Float64', is_nullable: 'YES' },
          ],
        };
      }
      return { json: [{ time: '2026-01-01T00:00:00Z', temp: 21.5 }] };
    }
    return { status: 404 };
  });

  const driver = new HttpSqlDriver('influxdb3');
  const info = await driver.connect(
    { engine: 'influxdb3', host: 'i3.local', database: 'iot', apiKey: 'v3-token' },
    transport,
  );
  assert.equal(info.serverVersion, 'InfluxDB 3 3.0.1');
  assert.deepEqual((await driver.listTables('iot')).map((t) => t.name), ['sensors']);
  const struct = await driver.getTableStructure('iot', 'iox', 'sensors');
  assert.equal(struct.columns[0].isPrimaryKey, true);
  const res = await driver.query('SELECT time, temp FROM sensors LIMIT 1');
  assert.deepEqual(res.results[0].rows[0], ['2026-01-01T00:00:00Z', 21.5]);
});

test('HttpSqlDriver: VictoriaMetrics PromQL normalized to tabular QueryResultSet', async () => {
  const { transport } = createMockHttpTransport((req) => {
    if (req.path === '/api/v1/status/buildinfo') {
      return { json: { status: 'success', data: { version: '1.102.0' } } };
    }
    if (req.path === '/api/v1/label/__name__/values') {
      return { json: { status: 'success', data: ['up', 'http_requests_total'] } };
    }
    if (req.path === '/api/v1/query') {
      const q = decodeURIComponent(req.body.replace(/^query=/, ''));
      if (q === 'scalar(1)') {
        return { json: { status: 'success', data: { resultType: 'scalar', result: [1700000000, '1'] } } };
      }
      return {
        json: {
          status: 'success',
          data: {
            resultType: 'vector',
            result: [
              {
                metric: { __name__: 'up', instance: '10.0.0.1:9100', job: 'node' },
                value: [1700000000, '1'],
              },
            ],
          },
        },
      };
    }
    return { status: 404 };
  });

  const driver = new HttpSqlDriver('victoriametrics');
  const info = await driver.connect({ engine: 'victoriametrics', host: 'vm.local' }, transport);
  assert.equal(info.serverVersion, 'VictoriaMetrics 1.102.0');

  const metrics = await driver.listTables();
  assert.deepEqual(metrics.map((m) => m.name), ['up', 'http_requests_total']);

  const vec = await driver.query('up');
  assert.deepEqual(vec.results[0].columns.map((c) => c.name), ['metric', 'labels', 'timestamp', 'value']);
  assert.equal(vec.results[0].rows[0][0], 'up');
  assert.deepEqual(vec.results[0].rows[0][1], { instance: '10.0.0.1:9100', job: 'node' });
  assert.equal(vec.results[0].rows[0][3], 1);

  const scalar = await driver.query('scalar(1)');
  assert.equal(scalar.results[0].rows[0][0], 'scalar');
  assert.equal(scalar.results[0].rows[0][3], 1);

  const browse = await driver.browseTable('metrics', 'promql', 'up', { page: 1, pageSize: 10 });
  assert.equal(browse.totalRows, 1);
});

/* ============================================================================
 * 2. SearchVectorDriver Tests (7 engines)
 * ============================================================================ */

test('SearchVectorDriver: Elasticsearch & Easysearch full operations and auth headers', async () => {
  for (const eng of ['elasticsearch', 'easysearch'] as const) {
    const { transport, requests } = createMockHttpTransport((req) => {
      if (req.method === 'GET' && req.path === '/') {
        return {
          json: {
            version: {
              number: eng === 'easysearch' ? '1.8.0' : '8.14.1',
              distribution: eng === 'easysearch' ? 'easysearch' : 'elasticsearch',
            },
          },
        };
      }
      if (req.method === 'GET' && req.path === '/_cat/indices?format=json&bytes=b') {
        return { json: [{ index: 'logs', 'docs.count': '120', 'store.size': '4096', health: 'green', status: 'open' }] };
      }
      if (req.method === 'GET' && req.path === '/logs/_mapping') {
        return { json: { logs: { mappings: { properties: { message: { type: 'text' } } } } } };
      }
      if (req.method === 'POST' && req.path === '/logs/_search') {
        return {
          json: {
            hits: {
              total: { value: 1 },
              hits: [{ _id: 'doc-1', _index: 'logs', _score: 1.5, _source: { message: 'hello' } }],
            },
          },
        };
      }
      if (req.method === 'PUT' && req.path.startsWith('/logs/_doc/doc-2')) {
        return { json: { _id: 'doc-2', result: 'created' } };
      }
      if (req.method === 'DELETE' && req.path.startsWith('/logs/_doc/doc-2')) {
        return { json: { result: 'deleted' } };
      }
      if (req.method === 'PUT' && req.path === '/new_idx') {
        return { json: { acknowledged: true } };
      }
      if (req.method === 'DELETE' && req.path === '/new_idx') {
        return { json: { acknowledged: true } };
      }
      return { status: 404 };
    });

    const driver = new SearchVectorDriver(eng);
    const info = await driver.connect(
      eng === 'elasticsearch'
        ? { engine: eng, host: 'es.local', apiKey: 'es-api-key' }
        : { engine: eng, host: 'es.local', username: 'admin', password: 'pw' },
      transport,
    );
    assert.equal(info.family, 'search');
    assert.match(info.serverVersion, eng === 'easysearch' ? /easysearch 1\.8\.0/i : /8\.14\.1/);

    if (eng === 'elasticsearch') {
      assert.equal(requests[0].headers['authorization'], 'ApiKey es-api-key');
    } else {
      assert.ok(requests[0].headers['authorization']?.startsWith('Basic '));
    }

    const indices = await driver.listIndices();
    assert.equal(indices[0].name, 'logs');
    assert.equal(indices[0].docCount, 120);
    assert.equal(indices[0].sizeBytes, 4096);

    const mapping = await driver.getIndexSchema('logs');
    assert.ok('logs' in mapping);

    const search = await driver.search('logs', 'hello', { from: 0, size: 10 });
    assert.equal(search.totalCount, 1);
    assert.equal(search.documents[0].id, 'doc-1');

    const upserted = await driver.upsertDocument('logs', { message: 'world' }, 'doc-2');
    assert.equal(upserted.id, 'doc-2');
    await driver.deleteDocument('logs', 'doc-2');
    await driver.createIndex('new_idx');
    await driver.deleteIndex('new_idx');
  }
});

test('SearchVectorDriver: Meilisearch Bearer auth, indexes, search, CRUD', async () => {
  const { transport, requests } = createMockHttpTransport((req) => {
    assert.equal(req.headers['authorization'], 'Bearer meili-master-key');
    if (req.method === 'GET' && req.path === '/version') {
      return { json: { pkgVersion: '1.9.0' } };
    }
    if (req.method === 'GET' && req.path === '/indexes') {
      return { json: { results: [{ uid: 'movies', primaryKey: 'id' }] } };
    }
    if (req.method === 'GET' && req.path === '/indexes/movies/settings') {
      return { json: { searchableAttributes: ['title'] } };
    }
    if (req.method === 'POST' && req.path === '/indexes/movies/search') {
      return { json: { hits: [{ id: 'm1', title: 'Matrix' }], estimatedTotalHits: 1 } };
    }
    if (req.method === 'POST' && req.path === '/indexes/movies/documents') {
      return { json: { taskUid: 1 } };
    }
    if (req.method === 'DELETE' && req.path === '/indexes/movies/documents/m1') {
      return { json: { taskUid: 2 } };
    }
    return { status: 404 };
  });

  const driver = new SearchVectorDriver('meilisearch');
  const info = await driver.connect(
    { engine: 'meilisearch', host: 'meili.local', apiKey: 'meili-master-key' },
    transport,
  );
  assert.equal(info.serverVersion, 'Meilisearch 1.9.0');
  assert.deepEqual((await driver.listIndices()).map((i) => i.name), ['movies']);
  const res = await driver.search('movies', 'matrix');
  assert.equal(res.documents[0].id, 'm1');
  const up = await driver.upsertDocument('movies', { title: 'Inception' }, 'm2');
  assert.equal(up.id, 'm2');
  await driver.deleteDocument('movies', 'm1');
  assert.ok(requests.length >= 5);
});

test('SearchVectorDriver: CouchDB _all_dbs, _all_docs, _find, and _rev-aware CRUD', async () => {
  let putAttempt = 0;
  const { transport, requests } = createMockHttpTransport((req) => {
    assert.ok(req.headers['authorization']?.startsWith('Basic '));
    if (req.method === 'GET' && req.path === '/') {
      return { json: { couchdb: 'Welcome', version: '3.3.3' } };
    }
    if (req.method === 'GET' && req.path === '/_all_dbs') {
      return { json: ['_users', 'notes'] };
    }
    if (req.method === 'GET' && req.path.startsWith('/notes/_all_docs')) {
      return { json: { total_rows: 1, rows: [{ id: 'n1', doc: { _id: 'n1', _rev: '1-abc', body: 'hi' } }] } };
    }
    if (req.method === 'POST' && req.path === '/notes/_find') {
      return { json: { docs: [{ _id: 'n1', _rev: '1-abc', body: 'hi' }] } };
    }
    if (req.method === 'PUT' && req.path === '/notes/n1') {
      putAttempt++;
      if (putAttempt === 1) return { status: 409, json: { error: 'conflict' } };
      const parsed = JSON.parse(req.body) as { _rev?: string };
      assert.equal(parsed._rev, '1-abc');
      return { json: { ok: true, id: 'n1', rev: '2-def' } };
    }
    if (req.method === 'GET' && req.path === '/notes/n1') {
      return { json: { _id: 'n1', _rev: '1-abc', body: 'hi' } };
    }
    if (req.method === 'DELETE' && req.path === '/notes/n1?rev=1-abc') {
      return { json: { ok: true, id: 'n1', rev: '3-ghi' } };
    }
    return { status: 404 };
  });

  const driver = new SearchVectorDriver('couchdb');
  const info = await driver.connect(
    { engine: 'couchdb', host: 'couch.local', username: 'admin', password: 'secret' },
    transport,
  );
  assert.equal(info.serverVersion, 'CouchDB 3.3.3');
  assert.deepEqual((await driver.listIndices()).map((i) => i.name), ['_users', 'notes']);

  const allDocs = await driver.search('notes', '*');
  assert.equal(allDocs.documents[0].id, 'n1');

  const found = await driver.search('notes', { selector: { body: 'hi' } });
  assert.equal(found.documents[0].id, 'n1');

  // Triggers 409 -> GET _rev -> retry PUT
  const up = await driver.upsertDocument('notes', { body: 'updated' }, 'n1');
  assert.equal(up.id, 'n1');
  assert.equal(putAttempt, 2);

  await driver.deleteDocument('notes', 'n1');
  assert.ok(requests.some((r) => r.method === 'DELETE' && r.path === '/notes/n1?rev=1-abc'));
});

test('SearchVectorDriver: Qdrant api-key, collections, scroll, vector search, upsert/delete', async () => {
  const { transport } = createMockHttpTransport((req) => {
    assert.equal(req.headers['api-key'], 'qdrant-secret');
    if (req.method === 'GET' && req.path === '/') {
      return { json: { title: 'qdrant - vector search engine', version: '1.10.1' } };
    }
    if (req.method === 'GET' && req.path === '/collections') {
      return { json: { result: { collections: [{ name: 'embeddings' }] } } };
    }
    if (req.method === 'GET' && req.path === '/collections/embeddings') {
      return { json: { result: { status: 'green', points_count: 10 } } };
    }
    if (req.method === 'POST' && req.path === '/collections/embeddings/points/scroll') {
      return { json: { result: { points: [{ id: 1, payload: { title: 'doc1' }, vector: [0.1, 0.2] }] } } };
    }
    if (req.method === 'POST' && req.path === '/collections/embeddings/points/search') {
      return { json: { result: [{ id: 1, score: 0.99, payload: { title: 'doc1' }, vector: [0.1, 0.2] }] } };
    }
    if (req.method === 'PUT' && req.path.startsWith('/collections/embeddings/points')) {
      return { json: { result: { status: 'completed' } } };
    }
    if (req.method === 'POST' && req.path.startsWith('/collections/embeddings/points/delete')) {
      return { json: { result: { status: 'completed' } } };
    }
    return { status: 404 };
  });

  const driver = new SearchVectorDriver('qdrant');
  const info = await driver.connect(
    { engine: 'qdrant', host: 'qdrant.local', apiKey: 'qdrant-secret' },
    transport,
  );
  assert.equal(info.serverVersion, 'Qdrant 1.10.1');
  assert.deepEqual((await driver.listIndices()).map((i) => i.name), ['embeddings']);

  const scrolled = await driver.search('embeddings', '');
  assert.equal(scrolled.documents[0].id, '1');
  assert.deepEqual(scrolled.documents[0].vector, [0.1, 0.2]);

  const vecSearch = await driver.search('embeddings', { vector: [0.1, 0.2] });
  assert.equal(vecSearch.documents[0].score, 0.99);

  const up = await driver.upsertDocument('embeddings', { vector: [0.3, 0.4], title: 'doc2' }, '2');
  assert.equal(up.id, '2');
  await driver.deleteDocument('embeddings', '2');
});

test('SearchVectorDriver: ChromaDB v2 & v1 fallback, collections CRUD, get/query/add/delete', async () => {
  // v2 path
  const v2Mock = createMockHttpTransport((req) => {
    if (req.path === '/api/v2/version') return { text: '"0.5.5"' };
    if (req.method === 'GET' && req.path === '/api/v2/tenants/t1/databases/d1/collections') {
      return { json: [{ id: 'col-uuid-1', name: 'kb', metadata: { space: 'cosine' } }] };
    }
    if (req.method === 'POST' && req.path === '/api/v2/tenants/t1/databases/d1/collections/col-uuid-1/get') {
      return { json: { ids: ['r1'], documents: ['hello chroma'], metadatas: [{ tag: 'a' }], embeddings: [[0.5, 0.5]] } };
    }
    if (req.method === 'POST' && req.path === '/api/v2/tenants/t1/databases/d1/collections/col-uuid-1/query') {
      return { json: { ids: [['r1']], documents: [['hello chroma']], metadatas: [[{ tag: 'a' }]], distances: [[0.12]] } };
    }
    if (req.method === 'POST' && req.path === '/api/v2/tenants/t1/databases/d1/collections/col-uuid-1/add') {
      return { json: true };
    }
    if (req.method === 'POST' && req.path === '/api/v2/tenants/t1/databases/d1/collections/col-uuid-1/delete') {
      return { json: ['r2'] };
    }
    if (req.method === 'POST' && req.path === '/api/v2/tenants/t1/databases/d1/collections') {
      return { json: { id: 'col-uuid-2', name: 'new_col' } };
    }
    if (req.method === 'DELETE' && req.path === '/api/v2/tenants/t1/databases/d1/collections/new_col') {
      return { status: 200, json: {} };
    }
    return { status: 404 };
  });

  const v2Driver = new SearchVectorDriver('chromadb');
  const v2Info = await v2Driver.connect(
    { engine: 'chromadb', host: 'chroma.local', org: 't1', namespace: 'd1' },
    v2Mock.transport,
  );
  assert.equal(v2Info.serverVersion, 'ChromaDB 0.5.5');
  assert.deepEqual((await v2Driver.listIndices()).map((i) => i.name), ['kb']);
  const got = await v2Driver.search('kb', '');
  assert.equal(got.documents[0].id, 'r1');
  const queried = await v2Driver.search('kb', 'hello');
  assert.equal(queried.documents[0].score, 0.12);
  await v2Driver.upsertDocument('kb', { document: 'new doc', vector: [0.1, 0.9], tag: 'b' }, 'r2');
  await v2Driver.deleteDocument('kb', 'r2');
  await v2Driver.createIndex('new_col');
  await v2Driver.deleteIndex('new_col');

  // v1 fallback when /api/v2/version returns 404
  const v1Mock = createMockHttpTransport((req) => {
    if (req.path === '/api/v2/version') return { status: 404 };
    if (req.path === '/api/v1/version') return { text: '"0.4.24"' };
    if (req.path === '/api/v1/collections') return { json: [{ id: 'c1', name: 'legacy' }] };
    return { status: 404 };
  });
  const v1Driver = new SearchVectorDriver('chromadb');
  const v1Info = await v1Driver.connect({ engine: 'chromadb', host: 'chroma1.local' }, v1Mock.transport);
  assert.equal(v1Info.serverVersion, 'ChromaDB 0.4.24');
  assert.deepEqual((await v1Driver.listIndices()).map((i) => i.name), ['legacy']);
});

test('SearchVectorDriver: Weaviate Bearer auth, /v1/meta, /v1/schema, /v1/graphql, /v1/objects CRUD', async () => {
  const { transport } = createMockHttpTransport((req) => {
    assert.equal(req.headers['authorization'], 'Bearer weaviate-key');
    if (req.method === 'GET' && req.path === '/v1/meta') {
      return { json: { version: '1.25.4' } };
    }
    if (req.method === 'GET' && req.path === '/v1/schema') {
      return { json: { classes: [{ class: 'Article', properties: [{ name: 'title' }] }] } };
    }
    if (req.method === 'POST' && req.path === '/v1/graphql') {
      return {
        json: {
          data: {
            Get: {
              Article: [{ title: 'Vector DBs', _additional: { id: 'uuid-1', certainty: 0.91 } }],
            },
          },
        },
      };
    }
    if (req.method === 'POST' && req.path === '/v1/objects') {
      return { json: { id: 'uuid-2' } };
    }
    if (req.method === 'DELETE' && req.path === '/v1/objects/Article/uuid-2') {
      return { status: 204 };
    }
    return { status: 404 };
  });

  const driver = new SearchVectorDriver('weaviate');
  const info = await driver.connect(
    { engine: 'weaviate', host: 'weav.local', apiKey: 'weaviate-key' },
    transport,
  );
  assert.equal(info.serverVersion, 'Weaviate 1.25.4');
  assert.deepEqual((await driver.listIndices()).map((i) => i.name), ['Article']);

  const search = await driver.search('Article', 'vectors');
  assert.equal(search.documents[0].id, 'uuid-1');
  assert.equal(search.documents[0].score, 0.91);
  assert.equal(search.documents[0].source.title, 'Vector DBs');

  const up = await driver.upsertDocument('Article', { title: 'New Post' }, 'uuid-2');
  assert.equal(up.id, 'uuid-2');
  await driver.deleteDocument('Article', 'uuid-2');
});

/* ============================================================================
 * 3. KvHttpDriver Tests (3 engines)
 * ============================================================================ */

test('KvHttpDriver: etcd v3 base64 range/put/deleterange and prefix range_end', async () => {
  // Verify prefix range_end computation: '/app/' -> '/app0' ('/' = 0x2f, '0' = 0x30)
  assert.equal(computeEtcdPrefixRangeEnd('/app/'), bytesToBase64(te.encode('/app0')));
  assert.equal(computeEtcdPrefixRangeEnd(''), bytesToBase64(new Uint8Array([0])));

  const store = new Map<string, string>([
    ['/app/env', 'production'],
    ['/app/region', 'us-east'],
  ]);

  const { transport } = createMockHttpTransport((req) => {
    if (req.method === 'GET' && req.path === '/version') {
      return { json: { etcdserver: '3.5.14', etcdcluster: '3.5.0' } };
    }
    if (req.method === 'POST' && req.path === '/v3/kv/range') {
      const body = JSON.parse(req.body) as { key: string; range_end?: string };
      if (!body.range_end) {
        const k = td.decode(Uint8Array.from(atob(body.key), (c) => c.charCodeAt(0)));
        const v = store.get(k);
        return {
          json: v !== undefined
            ? { kvs: [{ key: body.key, value: bytesToBase64(te.encode(v)), version: '2', mod_revision: '15' }] }
            : {},
        };
      }
      return {
        json: {
          kvs: Array.from(store.entries()).map(([k, v]) => ({
            key: bytesToBase64(te.encode(k)),
            value: bytesToBase64(te.encode(v)),
            version: '1',
            mod_revision: '10',
          })),
        },
      };
    }
    if (req.method === 'POST' && req.path === '/v3/kv/put') {
      const body = JSON.parse(req.body) as { key: string; value: string };
      const k = td.decode(Uint8Array.from(atob(body.key), (c) => c.charCodeAt(0)));
      const v = td.decode(Uint8Array.from(atob(body.value), (c) => c.charCodeAt(0)));
      store.set(k, v);
      return { json: { header: { revision: '16' } } };
    }
    if (req.method === 'POST' && req.path === '/v3/kv/deleterange') {
      const body = JSON.parse(req.body) as { key: string };
      const k = td.decode(Uint8Array.from(atob(body.key), (c) => c.charCodeAt(0)));
      store.delete(k);
      return { json: { deleted: '1' } };
    }
    return { status: 404 };
  });

  const driver = new KvHttpDriver('etcd');
  const info = await driver.connect({ engine: 'etcd', host: 'etcd.local' }, transport);
  assert.equal(info.family, 'kv');
  assert.equal(info.serverVersion, 'etcd 3.5.14');

  const keys = await driver.listKeys('/app/');
  assert.equal(keys.length, 2);
  assert.equal(keys[0].key, '/app/env');
  assert.equal(keys[0].value, 'production');

  await driver.putKey('/app/mode', 'strict');
  const got = await driver.getKey('/app/mode');
  assert.equal(got?.value, 'strict');
  assert.equal(got?.revision, 15);

  await driver.deleteKey('/app/mode');
  assert.equal(await driver.getKey('/app/mode'), null);
});

test('KvHttpDriver: Consul X-Consul-Token, leader fallback, /v1/kv/?keys & CRUD', async () => {
  const { transport, requests } = createMockHttpTransport((req) => {
    assert.equal(req.headers['x-consul-token'], 'consul-acl-token');
    if (req.path === '/v1/agent/self') return { status: 403, text: 'Permission denied' };
    if (req.path === '/v1/status/leader') return { json: '127.0.0.1:8300' };
    if (req.path === '/v1/namespaces') return { status: 404 };
    if (req.method === 'GET' && req.path === '/v1/kv/?keys') {
      return { json: ['service/web/port', 'service/db/host'] };
    }
    if (req.method === 'GET' && req.path === '/v1/kv/service/web/port') {
      return {
        json: [{
          Key: 'service/web/port',
          Value: bytesToBase64(te.encode('8080')),
          ModifyIndex: 42,
          Flags: 0,
        }],
      };
    }
    if (req.method === 'PUT' && req.path === '/v1/kv/service/web/port') {
      assert.equal(req.body, '9090');
      return { text: 'true' };
    }
    if (req.method === 'DELETE' && req.path === '/v1/kv/service/web/port') {
      return { text: 'true' };
    }
    return { status: 404 };
  });

  const driver = new KvHttpDriver('consul');
  const info = await driver.connect(
    { engine: 'consul', host: 'consul.local', apiKey: 'consul-acl-token' },
    transport,
  );
  assert.equal(info.serverVersion, 'Consul');

  const keys = await driver.listKeys('');
  assert.deepEqual(keys.map((k) => k.key), ['service/web/port', 'service/db/host']);

  const entry = await driver.getKey('service/web/port');
  assert.equal(entry?.value, '8080');
  assert.equal(entry?.revision, 42);

  await driver.putKey('service/web/port', '9090');
  await driver.deleteKey('service/web/port');
  assert.ok(requests.some((r) => r.method === 'DELETE' && r.path === '/v1/kv/service/web/port'));
});

test('KvHttpDriver: Nacos login, namespaces, and /nacos/v1/cs/configs CRUD', async () => {
  const { transport, requests } = createMockHttpTransport((req) => {
    if (req.method === 'POST' && req.path === '/nacos/v1/auth/login') {
      return { json: { accessToken: 'nacos-jwt-123', tokenTtl: 18000 } };
    }
    if (req.path.startsWith('/nacos/v1/console/server/state')) {
      return { json: { version: '2.3.2', standalone_mode: 'standalone' } };
    }
    if (req.path.startsWith('/nacos/v1/console/namespaces')) {
      assert.ok(req.path.includes('accessToken=nacos-jwt-123'));
      return {
        json: {
          code: 200,
          data: [
            { namespace: '', namespaceShowName: 'public', configCount: 3 },
            { namespace: 'prod-ns', namespaceShowName: 'Production', configCount: 12 },
          ],
        },
      };
    }
    if (req.method === 'GET' && req.path.startsWith('/nacos/v1/cs/configs') && req.path.includes('search=blur')) {
      return {
        json: {
          totalCount: 1,
          pageItems: [{ dataId: 'app.yaml', group: 'DEFAULT_GROUP', content: 'port: 8080', type: 'yaml' }],
        },
      };
    }
    if (req.method === 'GET' && req.path.startsWith('/nacos/v1/cs/configs')) {
      return { headers: { 'config-type': 'yaml' }, text: 'port: 8080' };
    }
    if (req.method === 'POST' && req.path === '/nacos/v1/cs/configs') {
      assert.ok(req.body.includes('accessToken=nacos-jwt-123'));
      assert.ok(req.body.includes('dataId=app.yaml'));
      return { text: 'true' };
    }
    if (req.method === 'DELETE' && req.path.startsWith('/nacos/v1/cs/configs')) {
      assert.ok(req.path.includes('dataId=app.yaml'));
      return { text: 'true' };
    }
    return { status: 404 };
  });

  const driver = new KvHttpDriver('nacos');
  const info = await driver.connect(
    { engine: 'nacos', host: 'nacos.local', username: 'nacos', password: 'nacos-password' },
    transport,
  );
  assert.equal(info.serverVersion, 'Nacos 2.3.2');

  const namespaces = await driver.listNamespaces();
  assert.equal(namespaces.length, 2);
  assert.equal(namespaces[1].id, 'prod-ns');
  assert.equal(namespaces[1].count, 12);

  const list = await driver.listKeys('app', { namespace: 'prod-ns' });
  assert.equal(list[0].key, 'app.yaml');
  assert.equal(list[0].format, 'yaml');

  const cfg = await driver.getKey('app.yaml', { namespace: 'prod-ns', group: 'DEFAULT_GROUP' });
  assert.equal(cfg?.value, 'port: 8080');
  assert.equal(cfg?.format, 'yaml');

  await driver.putKey('app.yaml', 'port: 9000', { namespace: 'prod-ns', format: 'yaml' });
  await driver.deleteKey('app.yaml', { namespace: 'prod-ns' });
  assert.ok(requests.some((r) => r.method === 'POST' && r.path === '/nacos/v1/auth/login'));
});

/* ============================================================================
 * 4. Raw ByteStream HTTP/1.1 Transport Tests (SSH Tunnel / Chunked Fallback)
 * ============================================================================ */

test('Raw ByteStream HTTP/1.1 transport works across HttpSqlDriver, SearchVectorDriver, and KvHttpDriver (Content-Length & chunked)', async () => {
  // 1) HttpSqlDriver (rqlite) over ByteStream with chunked encoding
  const sqlMock = createMockByteStreamHttpTransport((req) => {
    if (req.path === '/db/query') {
      return {
        chunked: true,
        json: { results: [{ columns: ['v'], types: ['text'], values: [['3.46.0']] }] },
      };
    }
    return { status: 404 };
  });
  const sqlDriver = new HttpSqlDriver('rqlite');
  const sqlInfo = await sqlDriver.connect({ engine: 'rqlite', host: '10.0.0.5', port: 4001 }, sqlMock.transport);
  assert.match(sqlInfo.serverVersion, /3\.46\.0/);
  assert.equal(sqlMock.requests.length, 1);

  // 2) SearchVectorDriver (elasticsearch) over ByteStream with Content-Length
  const searchMock = createMockByteStreamHttpTransport((req) => {
    if (req.path === '/') {
      return { json: { version: { number: '8.15.0' } } };
    }
    if (req.path === '/docs/_search') {
      return {
        chunked: true,
        json: { hits: { total: 1, hits: [{ _id: 'bs-1', _source: { ok: true } }] } },
      };
    }
    return { status: 404 };
  });
  const searchDriver = new SearchVectorDriver('elasticsearch');
  const searchInfo = await searchDriver.connect(
    { engine: 'elasticsearch', host: '10.0.0.6', port: 9200 },
    searchMock.transport,
  );
  assert.equal(searchInfo.serverVersion, 'Elasticsearch 8.15.0');
  const searchRes = await searchDriver.search('docs', '*');
  assert.equal(searchRes.documents[0].id, 'bs-1');

  // 3) KvHttpDriver (etcd) over ByteStream with chunked encoding
  const kvMock = createMockByteStreamHttpTransport((req) => {
    if (req.path === '/version') {
      return { json: { etcdserver: '3.5.15' } };
    }
    if (req.path === '/v3/kv/range') {
      return {
        chunked: true,
        json: {
          kvs: [{ key: bytesToBase64(te.encode('/k')), value: bytesToBase64(te.encode('via-stream')) }],
        },
      };
    }
    return { status: 404 };
  });
  const kvDriver = new KvHttpDriver('etcd');
  const kvInfo = await kvDriver.connect({ engine: 'etcd', host: '10.0.0.7', port: 2379 }, kvMock.transport);
  assert.equal(kvInfo.serverVersion, 'etcd 3.5.15');
  const kvEntry = await kvDriver.getKey('/k');
  assert.equal(kvEntry?.value, 'via-stream');
});

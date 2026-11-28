import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Neo4jDriver,
  isPackStreamStruct,
  makePackStreamStruct,
  packStreamDecode,
  packStreamEncode,
  type PackStreamStruct,
} from '../../src/drivers/neo4jDriver';
import {
  MssqlDriver,
  TDS_ENCRYPT_NOT_SUP,
  TDS_ENCRYPT_ON,
  TDS_PKT_ATTENTION,
  TDS_PKT_LOGIN7,
  TDS_PKT_PRELOGIN,
  TDS_PKT_SQL_BATCH,
  TDS_PKT_TABULAR_RESULT,
  buildTdsLogin7Packet,
  buildTdsPreloginPacket,
  buildTdsSqlBatchPacket,
  encodeTdsPassword,
  wrapTdsPackets,
} from '../../src/drivers/mssqlDriver';
import { concatBytes } from '../../src/drivers/streamBuffer';
import {
  QueryError,
  type ByteStream,
  type ByteStreamEndpoint,
  type ByteStreamTransport,
  type HttpRequestOptions,
  type HttpResponseData,
  type TlsUpgradeOptions,
} from '../../src/drivers/types';

const te = new TextEncoder();
const tdUtf16Le = new TextDecoder('utf-16le');

/* ============================================================================
 * Mock ByteStream Harness
 * ============================================================================ */

class MockByteStream implements ByteStream {
  private readQueue: Uint8Array[] = [];
  private waiters: Array<(chunk: Uint8Array | null) => void> = [];
  private closed = false;
  private _isTls: boolean;
  readonly written: Uint8Array[] = [];
  tlsUpgrades: TlsUpgradeOptions[] = [];

  constructor(
    private readonly onWrite: (data: Uint8Array, stream: MockByteStream) => void,
    initialTls = false,
  ) {
    this._isTls = initialTls;
  }

  get isTls(): boolean {
    return this._isTls;
  }

  pushServerData(chunk: Uint8Array): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(chunk);
    } else {
      this.readQueue.push(chunk);
    }
  }

  async read(): Promise<Uint8Array | null> {
    if (this.readQueue.length > 0) {
      return this.readQueue.shift()!;
    }
    if (this.closed) return null;
    return new Promise<Uint8Array | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('Stream closed');
    const copy = new Uint8Array(data);
    this.written.push(copy);
    this.onWrite(copy, this);
  }

  async upgradeTls(options?: TlsUpgradeOptions): Promise<void> {
    this.tlsUpgrades.push(options ?? {});
    this._isTls = true;
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!(null);
    }
  }
}

/* ============================================================================
 * Bolt Mock Helpers
 * ============================================================================ */

function boltFrame(struct: PackStreamStruct): Uint8Array {
  const payload = packStreamEncode(struct);
  const hdr = new Uint8Array([(payload.length >> 8) & 0xff, payload.length & 0xff]);
  return concatBytes(hdr, payload, new Uint8Array([0x00, 0x00]));
}

function createMockBoltTransport(options: {
  serverMajor: number;
  serverMinor: number;
  serverBanner: string;
  onRun: (
    cypher: string,
    params: Record<string, unknown>,
    extra: Record<string, unknown>,
  ) =>
    | {
        fields: string[];
        records: unknown[][];
        stats?: Record<string, unknown>;
        hasMore?: boolean;
      }
    | { failure: { code: string; message: string } };
}) {
  const endpoints: ByteStreamEndpoint[] = [];
  const receivedTags: number[] = [];
  let helloPayload: Record<string, unknown> | null = null;
  let logonPayload: Record<string, unknown> | null = null;
  let resetCount = 0;
  let discardCount = 0;
  let goodbyeCount = 0;

  const transport: ByteStreamTransport = {
    async connect(endpoint: ByteStreamEndpoint): Promise<ByteStream> {
      endpoints.push(endpoint);
      let handshakeDone = false;
      let buf: Uint8Array = new Uint8Array(0);
      let pendingResult:
        | {
            fields: string[];
            records: unknown[][];
            stats?: Record<string, unknown>;
            hasMore?: boolean;
          }
        | null = null;

      return new MockByteStream((chunk, stream) => {
        buf = concatBytes(buf, chunk);
        if (!handshakeDone) {
          if (buf.length < 20) return;
          assert.deepEqual(buf.slice(0, 4), new Uint8Array([0x60, 0x60, 0xb0, 0x17]));
          buf = buf.slice(20);
          handshakeDone = true;
          stream.pushServerData(new Uint8Array([0x00, 0x00, options.serverMinor, options.serverMajor]));
        }

        // Parse complete chunked Bolt messages
        while (buf.length >= 2) {
          let pos = 0;
          const parts: Uint8Array[] = [];
          let complete = false;
          while (pos + 2 <= buf.length) {
            const len = (buf[pos] << 8) | buf[pos + 1];
            pos += 2;
            if (len === 0) {
              complete = true;
              break;
            }
            if (pos + len > buf.length) break;
            parts.push(buf.slice(pos, pos + len));
            pos += len;
          }
          if (!complete) break;
          buf = buf.slice(pos);
          if (parts.length === 0) continue;

          const decoded = packStreamDecode(concatBytes(...parts));
          assert.ok(isPackStreamStruct(decoded));
          receivedTags.push(decoded.tag);

          switch (decoded.tag) {
            case 0x01: {
              // HELLO
              helloPayload = (decoded.fields[0] ?? {}) as Record<string, unknown>;
              stream.pushServerData(
                boltFrame(
                  makePackStreamStruct(0x70, [
                    { server: options.serverBanner, connection_id: 'bolt-1' },
                  ]),
                ),
              );
              break;
            }
            case 0x6a: {
              // LOGON
              logonPayload = (decoded.fields[0] ?? {}) as Record<string, unknown>;
              stream.pushServerData(boltFrame(makePackStreamStruct(0x70, [{}])));
              break;
            }
            case 0x10: {
              // RUN
              const cypher = String(decoded.fields[0] ?? '');
              const params = (decoded.fields[1] ?? {}) as Record<string, unknown>;
              const extra = (decoded.fields[2] ?? {}) as Record<string, unknown>;
              const res = options.onRun(cypher, params, extra);
              if ('failure' in res) {
                pendingResult = null;
                stream.pushServerData(boltFrame(makePackStreamStruct(0x7f, [res.failure])));
              } else {
                pendingResult = res;
                stream.pushServerData(
                  boltFrame(makePackStreamStruct(0x70, [{ fields: res.fields, qid: 0 }])),
                );
              }
              break;
            }
            case 0x3f: {
              // PULL
              const pullOpts = (decoded.fields[0] ?? {}) as Record<string, unknown>;
              const n = typeof pullOpts.n === 'number' ? pullOpts.n : -1;
              if (!pendingResult) {
                stream.pushServerData(boltFrame(makePackStreamStruct(0x70, [{}])));
                break;
              }
              const limit = n > 0 ? Math.min(n, pendingResult.records.length) : pendingResult.records.length;
              const frames: Uint8Array[] = [];
              // Include a Bolt NOOP keepalive before records to verify driver ignores it
              frames.push(new Uint8Array([0x00, 0x00]));
              for (let i = 0; i < limit; i++) {
                frames.push(boltFrame(makePackStreamStruct(0x71, [pendingResult.records[i]])));
              }
              const hasMore = Boolean(pendingResult.hasMore) || (n > 0 && pendingResult.records.length > limit);
              const meta: Record<string, unknown> = {};
              if (pendingResult.stats) meta.stats = pendingResult.stats;
              if (hasMore) meta.has_more = true;
              frames.push(boltFrame(makePackStreamStruct(0x70, [meta])));
              stream.pushServerData(concatBytes(...frames));
              break;
            }
            case 0x2f: {
              // DISCARD
              discardCount += 1;
              pendingResult = null;
              stream.pushServerData(boltFrame(makePackStreamStruct(0x70, [{}])));
              break;
            }
            case 0x0f: {
              // RESET
              resetCount += 1;
              pendingResult = null;
              stream.pushServerData(boltFrame(makePackStreamStruct(0x70, [{}])));
              break;
            }
            case 0x02: {
              // GOODBYE
              goodbyeCount += 1;
              break;
            }
          }
        }
      }, Boolean(endpoint.tls));
    },
  };

  return {
    transport,
    endpoints,
    receivedTags,
    getHello: () => helloPayload,
    getLogon: () => logonPayload,
    getResetCount: () => resetCount,
    getDiscardCount: () => discardCount,
    getGoodbyeCount: () => goodbyeCount,
  };
}

/* ============================================================================
 * Neo4j Tests
 * ============================================================================ */

test('PackStream v1 round-trips primitives, integers, floats, bytes, strings, lists, maps, and structs', () => {
  const cases: unknown[] = [
    null,
    true,
    false,
    0,
    1,
    -1,
    -16,
    127,
    -17,
    -128,
    128,
    32767,
    -32768,
    100000,
    -100000,
    9007199254740991,
    3.141592653589793,
    '',
    'short',
    'a'.repeat(40),
    'b'.repeat(300),
    new Uint8Array([0x01, 0x02, 0xfe, 0xff]),
    [],
    [1, 'two', true, null, { nested: [3, 4] }],
    { empty: {}, count: 42, flag: false, list: ['x', 'y'] },
  ];

  for (const val of cases) {
    const encoded = packStreamEncode(val);
    const decoded = packStreamDecode(encoded);
    assert.deepEqual(decoded, val);
  }

  const nodeStruct = makePackStreamStruct(0x4e, [101, ['Person'], { name: 'Ada' }, '4:abc:101']);
  const decodedStruct = packStreamDecode(packStreamEncode(nodeStruct));
  assert.ok(isPackStreamStruct(decodedStruct));
  assert.equal(decodedStruct.tag, 0x4e);
  assert.deepEqual(decodedStruct.fields, [101, ['Person'], { name: 'Ada' }, '4:abc:101']);
});

test('Neo4jDriver Bolt v5.4 full lifecycle: TLS, HELLO+LOGON, Nodes/Rels/Paths/Temporals, schema, FAILURE+RESET, GOODBYE', async () => {
  const aliceNode = makePackStreamStruct(0x4e, [1, ['Person'], { name: 'Alice', born: 1990 }, '4:db:1']);
  const bobNode = makePackStreamStruct(0x4e, [2, ['Person'], { name: 'Bob' }, '4:db:2']);
  const knowsRel = makePackStreamStruct(0x52, [
    10,
    1,
    2,
    'KNOWS',
    { since: 2020 },
    '5:db:10',
    '4:db:1',
    '4:db:2',
  ]);
  const unboundFollows = makePackStreamStruct(0x72, [11, 'FOLLOWS', { weight: 2 }, '5:db:11']);
  // Path: bob <-[:FOLLOWS]- alice (negative index reverses direction: start=alice, end=bob)
  const pathStruct = makePackStreamStruct(0x50, [
    [bobNode, aliceNode],
    [unboundFollows],
    [-1, 1],
  ]);

  const mock = createMockBoltTransport({
    serverMajor: 5,
    serverMinor: 4,
    serverBanner: 'Neo4j/5.20.0',
    onRun(cypher, _params, extra) {
      if (cypher === 'RETURN 1 AS ok') {
        return { fields: ['ok'], records: [[1]] };
      }
      if (cypher === 'SHOW DATABASES') {
        assert.equal(extra.db, 'system');
        return {
          fields: ['name', 'currentStatus'],
          records: [
            ['neo4j', 'online'],
            ['analytics', 'online'],
            ['system', 'online'],
          ],
        };
      }
      if (cypher.startsWith('CALL db.labels()')) {
        return { fields: ['label'], records: [['Person'], ['Movie']] };
      }
      if (cypher.startsWith('CALL db.relationshipTypes()')) {
        return { fields: ['relationshipType'], records: [['KNOWS'], ['ACTED_IN']] };
      }
      if (cypher.startsWith('CALL db.propertyKeys()')) {
        return { fields: ['propertyKey'], records: [['name'], ['title']] };
      }
      if (cypher === 'SHOW INDEXES') {
        return {
          fields: ['name', 'type', 'entityType', 'labelsOrTypes', 'properties', 'state'],
          records: [['idx_person_name', 'RANGE', 'NODE', ['Person'], ['name'], 'ONLINE']],
        };
      }
      if (cypher === 'SHOW CONSTRAINTS') {
        return {
          fields: ['name', 'type', 'entityType', 'labelsOrTypes', 'properties'],
          records: [['uniq_person_name', 'UNIQUENESS', 'NODE', ['Person'], ['name']]],
        };
      }
      if (cypher === 'BAD CYPHER') {
        return {
          failure: {
            code: 'Neo.ClientError.Statement.SyntaxError',
            message: 'Invalid input BAD',
          },
        };
      }
      if (cypher.includes('MATCH p=')) {
        return {
          fields: ['a', 'r', 'p', 'd', 't', 'dt', 'dur', 'pt'],
          records: [
            [
              aliceNode,
              knowsRel,
              pathStruct,
              makePackStreamStruct(0x44, [19723]), // 2024-01-01
              makePackStreamStruct(0x54, [3661000000000, 3600]), // 01:01:01+01:00
              makePackStreamStruct(0x49, [1704067200, 500000000, 0]), // 2024-01-01T00:00:00.5Z
              makePackStreamStruct(0x45, [1, 2, 3, 0]), // P1M2DT3S
              makePackStreamStruct(0x58, [4326, 12.5, 55.6]),
            ],
            // Second row repeats aliceNode to verify deduplication
            [
              aliceNode,
              knowsRel,
              null,
              null,
              null,
              null,
              null,
              null,
            ],
          ],
          stats: { 'nodes-created': 2, 'relationships-created': 1, 'properties-set': 3 },
        };
      }
      return { fields: [], records: [] };
    },
  });

  const driver = new Neo4jDriver();
  const conn = await driver.connect(
    {
      engine: 'neo4j',
      host: 'neo4j.local',
      port: 7687,
      username: 'neo4j',
      password: 'secret',
      tlsMode: 'require',
    },
    mock.transport,
  );

  assert.equal(driver.connected, true);
  assert.equal(driver.transportProtocol, 'bolt');
  assert.equal(conn.serverVersion, 'Neo4j/5.20.0');
  assert.equal(conn.tlsActive, true);
  assert.equal(mock.endpoints[0].tls, true);
  // Bolt 5.4 separates HELLO and LOGON
  assert.equal(mock.getHello()?.scheme, undefined);
  assert.equal(mock.getLogon()?.scheme, 'basic');
  assert.equal(mock.getLogon()?.principal, 'neo4j');

  const dbs = await driver.listDatabases();
  assert.deepEqual(
    dbs.map((d) => d.name),
    ['neo4j', 'analytics', 'system'],
  );

  const switched = await driver.switchDatabase('analytics');
  assert.equal(switched.database, 'analytics');
  assert.equal(driver.activeDatabase, 'analytics');

  const schema = await driver.getSchemaSummary();
  assert.equal(schema.database, 'analytics');
  assert.deepEqual(
    schema.labels.map((l) => l.label),
    ['Person', 'Movie'],
  );
  assert.deepEqual(schema.relationshipTypes, ['KNOWS', 'ACTED_IN']);
  assert.deepEqual(schema.propertyKeys, ['name', 'title']);
  assert.equal(schema.indexes[0].name, 'idx_person_name');
  assert.equal(schema.constraints[0].name, 'uniq_person_name');

  const res = await driver.executeCypher('MATCH p=(a)-[r]->(b) RETURN a, r, p, d, t, dt, dur, pt');
  assert.equal(res.rowCount, 2);
  assert.equal(res.nodes.length, 2); // Deduplicated Alice & Bob
  assert.equal(res.relationships.length, 2); // KNOWS + FOLLOWS from Path
  const follows = res.relationships.find((r) => r.type === 'FOLLOWS')!;
  assert.equal(follows.startNodeId, '4:db:1'); // Reversed by -1 index in Path
  assert.equal(follows.endNodeId, '4:db:2');
  assert.equal(res.rows[0][3], '2024-01-01');
  assert.equal(res.rows[0][4], '01:01:01+01:00');
  assert.equal(res.rows[0][5], '2024-01-01T00:00:00.5Z');
  assert.equal(res.rows[0][6], 'P1M2DT3S');
  assert.deepEqual(res.rows[0][7], { srid: 4326, x: 12.5, y: 55.6 });
  assert.deepEqual(res.counters, { nodesCreated: 2, relationshipsCreated: 1, propertiesSet: 3 });

  // Truncation triggers DISCARD
  const limited = await driver.executeCypher('MATCH p=(a)-[r]->(b) RETURN a, r, p, d, t, dt, dur, pt', {
    maxRows: 1,
  });
  assert.equal(limited.rowCount, 1);
  assert.equal(limited.truncated, true);
  assert.equal(mock.getDiscardCount(), 1);

  // FAILURE triggers automatic RESET and throws QueryError
  await assert.rejects(
    () => driver.executeCypher('BAD CYPHER'),
    (err: unknown) => err instanceof QueryError && err.code === 'Neo.ClientError.Statement.SyntaxError',
  );
  assert.equal(mock.getResetCount(), 1);

  const ping = await driver.testConnection();
  assert.equal(ping.ok, true);

  await driver.close();
  assert.equal(driver.connected, false);
  assert.equal(mock.getGoodbyeCount(), 1);
});

test('Neo4jDriver Bolt v4.4 embeds auth in HELLO without LOGON', async () => {
  const mock = createMockBoltTransport({
    serverMajor: 4,
    serverMinor: 4,
    serverBanner: 'Neo4j/4.4.30',
    onRun() {
      return {
        fields: ['n'],
        records: [[makePackStreamStruct(0x4e, [7, ['City'], { name: 'Tokyo' }])]],
      };
    },
  });

  const driver = new Neo4jDriver();
  await driver.connect(
    { engine: 'neo4j', host: '127.0.0.1', port: 7687, username: 'neo4j', password: 'pw' },
    mock.transport,
  );
  assert.equal(mock.getHello()?.scheme, 'basic');
  assert.equal(mock.getLogon(), null);

  const res = await driver.executeCypher('MATCH (n:City) RETURN n');
  assert.equal(res.nodes.length, 1);
  assert.equal(res.nodes[0].id, '7');
  assert.deepEqual(res.nodes[0].labels, ['City']);
  await driver.close();
});

test('Neo4jDriver HTTP Cypher fallback supports /tx/commit and falls back to Neo4j 5 /query/v2', async () => {
  const calls: Array<{ method: string; url: string; auth?: string }> = [];
  let mode: 'tx' | 'v2' = 'tx';

  const transport: ByteStreamTransport = {
    async connect(): Promise<ByteStream> {
      throw new Error('Should not open raw Bolt socket for HTTP test');
    },
    async httpRequest(req: HttpRequestOptions): Promise<HttpResponseData> {
      calls.push({ method: req.method, url: req.url, auth: req.headers?.Authorization });
      const pathname = new URL(req.url).pathname;
      if (pathname === '/') {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: te.encode(JSON.stringify({ neo4j_version: '5.21.0' })),
        };
      }
      if (pathname === '/db/neo4j/tx/commit') {
        if (mode === 'v2') {
          return { status: 404, headers: {}, body: te.encode('Not Found') };
        }
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: te.encode(
            JSON.stringify({
              results: [
                {
                  columns: ['n', 'r'],
                  data: [
                    {
                      row: [{ name: 'Alice' }, { since: 2021 }],
                      graph: {
                        nodes: [
                          { id: '1', labels: ['Person'], properties: { name: 'Alice' } },
                          { id: '2', labels: ['Person'], properties: { name: 'Bob' } },
                        ],
                        relationships: [
                          { id: '9', type: 'KNOWS', startNode: '1', endNode: '2', properties: { since: 2021 } },
                        ],
                      },
                    },
                  ],
                  stats: { nodes_created: 1 },
                },
              ],
              errors: [],
            }),
          ),
        };
      }
      if (pathname === '/db/neo4j/query/v2') {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: te.encode(
            JSON.stringify({
              data: {
                fields: ['n'],
                values: [
                  [
                    {
                      elementId: '4:v2:42',
                      labels: ['Tool'],
                      properties: { title: 'Netcatty' },
                    },
                  ],
                ],
              },
              counters: { nodesCreated: 1, propertiesSet: 1 },
            }),
          ),
        };
      }
      return { status: 404, headers: {}, body: new Uint8Array(0) };
    },
  };

  // Port 7474 auto-selects HTTP
  const driver = new Neo4jDriver();
  const info = await driver.connect(
    { engine: 'neo4j', host: '127.0.0.1', port: 7474, username: 'neo4j', password: 'pw' },
    transport,
  );
  assert.equal(driver.transportProtocol, 'http');
  assert.equal(info.serverVersion, 'Neo4j/5.21.0');

  const txRes = await driver.executeCypher('MATCH (n)-[r]->(m) RETURN n, r');
  assert.equal(txRes.nodes.length, 2);
  assert.equal(txRes.relationships.length, 1);
  assert.equal(txRes.counters?.nodesCreated, 1);
  assert.ok(calls.some((c) => c.auth?.startsWith('Basic ')));

  // Switch server to Query API v2 only (/tx/commit returns 404 -> falls back to /query/v2)
  mode = 'v2';
  const v2Res = await driver.executeCypher('MATCH (n:Tool) RETURN n');
  assert.equal(v2Res.columns[0], 'n');
  assert.equal(v2Res.nodes.length, 1);
  assert.equal(v2Res.nodes[0].id, '4:v2:42');
  assert.equal(v2Res.counters?.propertiesSet, 1);
  assert.ok(calls.some((c) => c.url.endsWith('/db/neo4j/query/v2')));

  await driver.close();
});

/* ============================================================================
 * MSSQL TDS 7.4 Mock & Token Builders
 * ============================================================================ */

function u16le(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}
function i16le(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setInt16(0, n, true);
  return b;
}
function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
function i32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, true);
  return b;
}
function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}
function f64le(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, n, true);
  return b;
}
function utf16le(s: string): Uint8Array {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    b[i * 2] = c & 0xff;
    b[i * 2 + 1] = (c >> 8) & 0xff;
  }
  return b;
}
function bVarChar(s: string): Uint8Array {
  return concatBytes(new Uint8Array([s.length]), utf16le(s));
}
function usVarChar(s: string): Uint8Array {
  return concatBytes(u16le(s.length), utf16le(s));
}

function tokDone(status: number, rowCount: bigint): Uint8Array {
  return concatBytes(new Uint8Array([0xfd]), u16le(status), u16le(0), u64le(rowCount));
}

function tokLoginAck(progName: string, major: number, minor: number, build: number): Uint8Array {
  const body = concatBytes(
    new Uint8Array([0x01]), // SQL_DFLT
    new Uint8Array([0x74, 0x00, 0x00, 0x04]),
    bVarChar(progName),
    new Uint8Array([major, minor, (build >> 8) & 0xff, build & 0xff]),
  );
  return concatBytes(new Uint8Array([0xad]), u16le(body.length), body);
}

function tokEnvChangeStr(envType: number, newVal: string, oldVal = ''): Uint8Array {
  const body = concatBytes(new Uint8Array([envType]), bVarChar(newVal), bVarChar(oldVal));
  return concatBytes(new Uint8Array([0xe3]), u16le(body.length), body);
}

function tokEnvChangeBytes(envType: number, newBytes: Uint8Array, oldBytes = new Uint8Array(0)): Uint8Array {
  const body = concatBytes(
    new Uint8Array([envType]),
    new Uint8Array([newBytes.length]),
    newBytes,
    new Uint8Array([oldBytes.length]),
    oldBytes,
  );
  return concatBytes(new Uint8Array([0xe3]), u16le(body.length), body);
}

function tokError(number: number, message: string, lineNumber = 1): Uint8Array {
  const body = concatBytes(
    i32le(number),
    new Uint8Array([1, 16]), // state, severity
    usVarChar(message),
    bVarChar('SQLMOCK'),
    bVarChar(''),
    u32le(lineNumber),
  );
  return concatBytes(new Uint8Array([0xaa]), u16le(body.length), body);
}

function buildPreloginResp(encryption: number): Uint8Array {
  // VERSION (0x00, 6 bytes) + ENCRYPTION (0x01, 1 byte) + 0xFF
  const table = new Uint8Array([
    0x00, 0x00, 0x0b, 0x00, 0x06,
    0x01, 0x00, 0x11, 0x00, 0x01,
    0xff,
  ]);
  const data = new Uint8Array([16, 0, 0x04, 0x01, 0, 0, encryption]); // SQL Server 16.0.1025
  return wrapTdsPackets(TDS_PKT_TABULAR_RESULT, concatBytes(table, data));
}

function simpleResultSet(cols: string[], rows: Array<Array<string | number | boolean | null>>): Uint8Array {
  const colParts: Uint8Array[] = [new Uint8Array([0x81]), u16le(cols.length)];
  for (const c of cols) {
    // NVARCHAR(4000) with 5-byte collation
    colParts.push(
      u32le(0),
      u16le(0x01), // nullable
      new Uint8Array([0xe7]),
      u16le(8000),
      new Uint8Array([0x09, 0x04, 0xd0, 0x00, 0x34]),
      bVarChar(c),
    );
  }
  const rowParts: Uint8Array[] = [];
  for (const row of rows) {
    rowParts.push(new Uint8Array([0xd1]));
    for (const cell of row) {
      if (cell === null || cell === undefined) {
        rowParts.push(u16le(0xffff));
      } else {
        const str = typeof cell === 'boolean' ? (cell ? '1' : '0') : String(cell);
        const bytes = utf16le(str);
        rowParts.push(u16le(bytes.length), bytes);
      }
    }
  }
  return concatBytes(...colParts, ...rowParts, tokDone(0x0010, BigInt(rows.length)));
}

/* ============================================================================
 * MSSQL Tests
 * ============================================================================ */

test('MSSQL TDS wire encoders: password obfuscation, PRELOGIN, LOGIN7, and SQL_BATCH', () => {
  // 'a' -> UTF-16LE [0x61, 0x00] -> nibble swap [0x16, 0x00] -> XOR 0xA5 = [0xB3, 0xA5]
  const obfA = encodeTdsPassword('a');
  assert.deepEqual(obfA, new Uint8Array([0xb3, 0xa5]));

  // Verify reversibility for multi-char password
  const obfPass = encodeTdsPassword('P@ss123!');
  assert.equal(obfPass.length, 16);
  const recovered = new Uint8Array(obfPass.length);
  for (let i = 0; i < obfPass.length; i++) {
    const x = obfPass[i] ^ 0xa5;
    recovered[i] = ((x & 0x0f) << 4) | ((x & 0xf0) >> 4);
  }
  assert.equal(tdUtf16Le.decode(recovered), 'P@ss123!');

  // PRELOGIN packet
  const pre = buildTdsPreloginPacket({ encryption: TDS_ENCRYPT_ON, instanceName: 'SQLEXPRESS' });
  assert.equal(pre[0], TDS_PKT_PRELOGIN);
  assert.equal(pre[1], 0x01); // EOM
  assert.equal((pre[2] << 8) | pre[3], pre.length);
  assert.equal(pre[8], 0x00); // VERSION token first

  // LOGIN7 packet
  const login = buildTdsLogin7Packet({
    username: 'sa',
    password: 'Secret!',
    database: 'appdb',
    hostName: 'workstation',
    serverName: 'sql.local',
  });
  assert.equal(login[0], TDS_PKT_LOGIN7);
  assert.equal(login[1], 0x01);
  const lv = new DataView(login.buffer, login.byteOffset + 8);
  assert.equal(lv.getUint32(4, true), 0x74000004); // TDS 7.4
  const userOff = lv.getUint16(40, true);
  const userLen = lv.getUint16(42, true);
  assert.equal(userLen, 2);
  assert.equal(tdUtf16Le.decode(login.slice(8 + userOff, 8 + userOff + userLen * 2)), 'sa');
  const passOff = lv.getUint16(44, true);
  const passLen = lv.getUint16(46, true);
  assert.equal(passLen, 7);
  assert.deepEqual(login.slice(8 + passOff, 8 + passOff + passLen * 2), encodeTdsPassword('Secret!'));
  const dbOff = lv.getUint16(68, true);
  const dbLen = lv.getUint16(70, true);
  assert.equal(tdUtf16Le.decode(login.slice(8 + dbOff, 8 + dbOff + dbLen * 2)), 'appdb');

  // SQL_BATCH packet
  const txDesc = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const batch = buildTdsSqlBatchPacket('SELECT 1', txDesc);
  assert.equal(batch[0], TDS_PKT_SQL_BATCH);
  const bv = new DataView(batch.buffer, batch.byteOffset + 8);
  assert.equal(bv.getUint32(0, true), 22); // ALL_HEADERS total length
  assert.equal(bv.getUint16(8, true), 0x0002); // Transaction descriptor header type
  assert.deepEqual(batch.slice(8 + 10, 8 + 18), txDesc);
  assert.equal(tdUtf16Le.decode(batch.slice(8 + 22)), 'SELECT 1');
});

test('MssqlDriver full mock TDS 7.4 protocol: TLS upgrade, rich types, NBCROW, ERROR, transactions, metadata, explain, DDL', async () => {
  const seenSql: string[] = [];
  const seenTxDescs: Uint8Array[] = [];
  let attentionReceived = false;
  let mockStreamRef: MockByteStream | null = null;
  let connectEndpoint: ByteStreamEndpoint | null = null;

  const activeTx = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0x01, 0x02, 0x03, 0x04]);

  function buildRichTypesPayload(): Uint8Array {
    // 14 columns testing every major TDS 7.4 data type
    const colMeta = concatBytes(
      new Uint8Array([0x81]),
      u16le(14),
      // 0: INT4
      u32le(0), u16le(0x00), new Uint8Array([0x38]), bVarChar('c_int'),
      // 1: INTN(8)
      u32le(0), u16le(0x01), new Uint8Array([0x26, 8]), bVarChar('c_bigint'),
      // 2: BITN(1)
      u32le(0), u16le(0x01), new Uint8Array([0x68, 1]), bVarChar('c_bit'),
      // 3: FLTN(8)
      u32le(0), u16le(0x01), new Uint8Array([0x6d, 8]), bVarChar('c_float'),
      // 4: DECIMALN(9, 10, 2)
      u32le(0), u16le(0x01), new Uint8Array([0x6a, 9, 10, 2]), bVarChar('c_dec'),
      // 5: BIGVARCHAR(100)
      u32le(0), u16le(0x01), new Uint8Array([0xa7]), u16le(100), new Uint8Array(5), bVarChar('c_varchar'),
      // 6: NVARCHAR(MAX) PLP (0xFFFF)
      u32le(0), u16le(0x01), new Uint8Array([0xe7]), u16le(0xffff), new Uint8Array(5), bVarChar('c_nvarchar_max'),
      // 7: BIGVARBINARY(50)
      u32le(0), u16le(0x01), new Uint8Array([0xa5]), u16le(50), bVarChar('c_bin'),
      // 8: UNIQUEIDENTIFIER
      u32le(0), u16le(0x01), new Uint8Array([0x24, 16]), bVarChar('c_guid'),
      // 9: DATE
      u32le(0), u16le(0x01), new Uint8Array([0x28]), bVarChar('c_date'),
      // 10: TIME(3)
      u32le(0), u16le(0x01), new Uint8Array([0x29, 3]), bVarChar('c_time'),
      // 11: DATETIME
      u32le(0), u16le(0x00), new Uint8Array([0x3d]), bVarChar('c_dt'),
      // 12: DATETIME2(3)
      u32le(0), u16le(0x01), new Uint8Array([0x2a, 3]), bVarChar('c_dt2'),
      // 13: DATETIMEOFFSET(0)
      u32le(0), u16le(0x01), new Uint8Array([0x2b, 0]), bVarChar('c_dto'),
    );

    const nvChunk = utf16le('Hello PLP Max!');
    // GUID 01020304-0506-0708-090a-0b0c0d0e0f10 in MS mixed endian:
    const guidBytes = new Uint8Array([
      0x04, 0x03, 0x02, 0x01, 0x06, 0x05, 0x08, 0x07,
      0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
    ]);
    // 2024-01-01 is day 738885 from 0001-01-01 (0x0B4645)
    const date2024 = new Uint8Array([0x45, 0x46, 0x0b]);
    // 12:30:45.500 at scale 3 => 45045500 ticks = 0x02AF52FC (4 bytes LE)
    const timeTicks4 = u32le(45045500);
    // DATETIME: 2024-01-01 is 45290 days since 1900-01-01; 06:00:00 = 21600 * 300 = 6480000 ticks
    const dt8 = concatBytes(i32le(45290), u32le(6480000));
    // DATETIMEOFFSET(0): 2024-01-01 10:00:00 UTC + 120 mins (+02:00) => 2024-01-01 12:00:00+02:00
    // 36000 seconds = 0x008CA0 (3 bytes LE)
    const time10h = new Uint8Array([0xa0, 0x8c, 0x00]);
    const dtoVal = concatBytes(new Uint8Array([8]), time10h, date2024, i16le(120));

    const row1 = concatBytes(
      new Uint8Array([0xd1]), // ROW
      i32le(42),
      new Uint8Array([8]), u64le(9000000000n),
      new Uint8Array([1, 1]),
      new Uint8Array([8]), f64le(3.5),
      new Uint8Array([5, 0]), u32le(12345), // -123.45
      u16le(5), te.encode('hello'),
      // PLP: totalLen=nvChunk.length, chunkLen=nvChunk.length, data, terminator=0
      u64le(BigInt(nvChunk.length)), u32le(nvChunk.length), nvChunk, u32le(0),
      u16le(3), new Uint8Array([0xde, 0xad, 0xbe]),
      new Uint8Array([16]), guidBytes,
      new Uint8Array([3]), date2024,
      new Uint8Array([4]), timeTicks4,
      dt8,
      new Uint8Array([7]), timeTicks4, date2024,
      dtoVal,
    );

    // Row 2 uses NBCROW (0xD2) where columns 1..10, 12, 13 are NULL and only col 0 (INT4) and col 11 (DATETIME) are non-null
    // Bitmap (2 bytes for 14 cols): bits 1..7 set in byte 0 (0xFE), bits 8..10,12,13 set in byte 1 (0b0011_0111 = 0x37)
    const row2 = concatBytes(
      new Uint8Array([0xd2]),
      new Uint8Array([0xfe, 0x37]),
      i32le(99),
      dt8,
    );

    return concatBytes(colMeta, row1, row2, tokDone(0x0010, 2n));
  }

  const transport: ByteStreamTransport = {
    async connect(endpoint: ByteStreamEndpoint): Promise<ByteStream> {
      connectEndpoint = endpoint;
      let buf: Uint8Array = new Uint8Array(0);
      mockStreamRef = new MockByteStream((chunk, stream) => {
        buf = concatBytes(buf, chunk);
        while (buf.length >= 8) {
          const pktType = buf[0];
          const pktLen = (buf[2] << 8) | buf[3];
          if (buf.length < pktLen) break;
          const pktPayload = buf.slice(8, pktLen);
          buf = buf.slice(pktLen);

          if (pktType === TDS_PKT_PRELOGIN) {
            stream.pushServerData(buildPreloginResp(TDS_ENCRYPT_ON));
          } else if (pktType === TDS_PKT_LOGIN7) {
            const resp = concatBytes(
              tokEnvChangeStr(1, 'shopdb', 'master'),
              tokEnvChangeStr(4, '4096', '4096'),
              tokLoginAck('Microsoft SQL Server', 16, 0, 1025),
              tokDone(0x0000, 0n),
            );
            stream.pushServerData(wrapTdsPackets(TDS_PKT_TABULAR_RESULT, resp));
          } else if (pktType === TDS_PKT_ATTENTION) {
            attentionReceived = true;
          } else if (pktType === TDS_PKT_SQL_BATCH) {
            const totalHdrLen = new DataView(pktPayload.buffer, pktPayload.byteOffset).getUint32(0, true);
            seenTxDescs.push(pktPayload.slice(10, 18));
            const sql = tdUtf16Le.decode(pktPayload.slice(totalHdrLen));
            seenSql.push(sql);

            let respPayload: Uint8Array;
            if (sql === 'SELECT_RICH_TYPES') {
              respPayload = buildRichTypesPayload();
            } else if (sql === 'SELECT_ERROR') {
              respPayload = concatBytes(
                tokError(208, "Invalid object name 'missing_table'.", 3),
                tokDone(0x0002, 0n),
              );
            } else if (sql === 'BEGIN TRANSACTION') {
              respPayload = concatBytes(tokEnvChangeBytes(8, activeTx), tokDone(0x0000, 0n));
            } else if (sql === 'COMMIT TRANSACTION') {
              respPayload = concatBytes(tokEnvChangeBytes(9, new Uint8Array(0), activeTx), tokDone(0x0000, 0n));
            } else if (sql === 'ROLLBACK TRANSACTION') {
              respPayload = concatBytes(tokEnvChangeBytes(10, new Uint8Array(0), activeTx), tokDone(0x0000, 0n));
            } else if (sql.startsWith('USE ')) {
              respPayload = concatBytes(tokEnvChangeStr(1, 'analytics', 'shopdb'), tokDone(0x0000, 0n));
            } else if (sql.includes('@@VERSION')) {
              respPayload = simpleResultSet(['version'], [['Microsoft SQL Server 2022 (RTM) - 16.0.1025']]);
            } else if (sql.includes('FROM sys.databases')) {
              respPayload = simpleResultSet(['name', 'owner', 'collation_name'], [
                ['master', 'sa', 'SQL_Latin1_General_CP1_CI_AS'],
                ['shopdb', 'sa', 'SQL_Latin1_General_CP1_CI_AS'],
              ]);
            } else if (sql.includes('sys.schemas ORDER BY')) {
              respPayload = simpleResultSet(['name', 'owner'], [
                ['dbo', 'dbo'],
                ['sys', 'sys'],
              ]);
            } else if (sql.includes('sys.check_constraints cc')) {
              respPayload = simpleResultSet(['name', 'definition'], [['CK_orders_id', '([id]>(0))']]);
            } else if (sql.includes('sys.triggers tr')) {
              respPayload = simpleResultSet(['name', 'schema_name', 'table_name', 'timing', 'definition'], [
                ['tr_orders_audit', 'dbo', 'orders', 'AFTER', 'CREATE TRIGGER tr_orders_audit ON dbo.orders AFTER INSERT AS SELECT 1'],
              ]);
            } else if (sql.includes('sys.tables t')) {
              respPayload = simpleResultSet(['name', 'schema_name', 'row_count'], [
                ['orders', 'dbo', 120],
              ]);
            } else if (sql.includes('sys.views v')) {
              respPayload = simpleResultSet(['name', 'schema_name', 'definition'], [
                ['v_orders', 'dbo', 'CREATE VIEW dbo.v_orders AS SELECT * FROM dbo.orders'],
              ]);
            } else if (sql.includes('INFORMATION_SCHEMA.ROUTINES') || (sql.includes('sys.objects o') && sql.includes('sys.sql_modules m'))) {
              respPayload = simpleResultSet(
                ['name', 'schema_name', 'routine_type', 'definition'],
                [['sp_get_orders', 'dbo', 'PROCEDURE', 'CREATE PROCEDURE dbo.sp_get_orders AS SELECT 1']],
              );
            } else if (sql.includes('sys.columns c') && sql.includes('sys.types ty')) {
              respPayload = simpleResultSet(
                ['name', 'data_type', 'max_length', 'precision', 'scale', 'is_nullable', 'is_identity', 'default_value'],
                [
                  ['id', 'int', 4, 10, 0, false, true, null],
                  ['customer_id', 'int', 4, 10, 0, false, false, null],
                  ['note', 'nvarchar', 200, 0, 0, true, false, null],
                ],
              );
            } else if (sql.includes('sys.indexes i')) {
              respPayload = simpleResultSet(
                ['name', 'is_unique', 'is_primary_key', 'type_desc', 'col_name', 'key_ordinal'],
                [['PK_orders', true, true, 'CLUSTERED', 'id', 1]],
              );
            } else if (sql.includes('sys.foreign_keys fk')) {
              respPayload = simpleResultSet(
                ['name', 'col_name', 'ref_schema', 'ref_table', 'ref_col', 'delete_referential_action_desc', 'update_referential_action_desc'],
                [['FK_orders_customers', 'customer_id', 'dbo', 'customers', 'id', 'CASCADE', 'NO_ACTION']],
              );
            } else if (sql.startsWith('SELECT COUNT(*) AS total_rows')) {
              respPayload = simpleResultSet(['total_rows'], [[25]]);
            } else if (sql.includes('OFFSET') && sql.includes('FETCH NEXT')) {
              respPayload = simpleResultSet(['id', 'note'], [
                [1, 'first'],
                [2, 'second'],
              ]);
            } else if (sql.startsWith('SET SHOWPLAN_TEXT')) {
              respPayload = tokDone(0x0000, 0n);
            } else if (sql === 'SELECT * FROM dbo.orders') {
              respPayload = simpleResultSet(['StmtText'], [
                ['  |--Table Scan(OBJECT:([shopdb].[dbo].[orders]))'],
              ]);
            } else if (sql.startsWith('INSERT INTO') || sql.startsWith('UPDATE ') || sql.startsWith('DELETE ')) {
              respPayload = tokDone(0x0010, 1n);
            } else if (sql.startsWith('SELECT TOP (50000)')) {
              respPayload = simpleResultSet(['id', 'customer_id', 'note'], [[1, 10, 'hello']]);
            } else {
              respPayload = tokDone(0x0000, 0n);
            }
            stream.pushServerData(wrapTdsPackets(TDS_PKT_TABULAR_RESULT, respPayload));
          }
        }
      }, Boolean(endpoint.tls));
      return mockStreamRef;
    },
  };

  const driver = new MssqlDriver();
  const conn = await driver.connect(
    {
      engine: 'sqlserver',
      host: 'mssql.local',
      port: 1433,
      database: 'shopdb',
      username: 'sa',
      password: 'Password1!',
      tlsMode: 'require',
    },
    transport,
  );

  assert.equal(driver.family, 'mssql');
  assert.equal(driver.engine, 'sqlserver');
  assert.equal(driver.connected, true);
  assert.equal(connectEndpoint!.tls, false); // Started plain, upgraded after PRELOGIN
  assert.equal(mockStreamRef!.tlsUpgrades.length, 1);
  assert.equal(conn.tlsActive, true);
  assert.equal(conn.database, 'shopdb');
  assert.match(conn.serverVersion, /16\.0\.1025/);

  // Rich types + NBCROW test
  const rich = await driver.query('SELECT_RICH_TYPES');
  const rs = rich.results[0];
  assert.equal(rs.columns.length, 14);
  assert.equal(rs.rows.length, 2);
  const r0 = rs.rows[0];
  assert.equal(r0[0], 42);
  assert.equal(r0[1], 9000000000);
  assert.equal(r0[2], true);
  assert.equal(r0[3], 3.5);
  assert.equal(r0[4], -123.45);
  assert.equal(r0[5], 'hello');
  assert.equal(r0[6], 'Hello PLP Max!');
  assert.deepEqual(r0[7], new Uint8Array([0xde, 0xad, 0xbe]));
  assert.equal(r0[8], '01020304-0506-0708-090a-0b0c0d0e0f10');
  assert.equal(r0[9], '2024-01-01');
  assert.equal(r0[10], '12:30:45.5');
  assert.equal(r0[11], '2024-01-01 06:00:00');
  assert.equal(r0[12], '2024-01-01 12:30:45.5');
  assert.equal(r0[13], '2024-01-01 12:00:00+02:00');

  // Row 2 NBCROW null bitmap verification
  const r1 = rs.rows[1];
  assert.equal(r1[0], 99);
  assert.equal(r1[1], null);
  assert.equal(r1[6], null);
  assert.equal(r1[11], '2024-01-01 06:00:00');
  assert.equal(r1[13], null);

  // ERROR token handling
  await assert.rejects(
    () => driver.query('SELECT_ERROR'),
    (err: unknown) => err instanceof QueryError && err.code === '208' && err.line === 3,
  );

  // Catalog metadata
  const dbs = await driver.listDatabases();
  assert.deepEqual(dbs.map((d) => d.name), ['master', 'shopdb']);

  const schemas = await driver.listSchemas('shopdb');
  assert.equal(schemas.find((s) => s.name === 'sys')?.isSystem, true);
  assert.equal(schemas.find((s) => s.name === 'dbo')?.isSystem, false);

  const tables = await driver.listTables('shopdb', 'dbo');
  assert.equal(tables[0].name, 'orders');
  assert.equal(tables[0].rowCountEstimate, 120);

  const views = await driver.listViews('shopdb', 'dbo');
  assert.equal(views[0].name, 'v_orders');

  const routines = await driver.listRoutines('shopdb', 'dbo');
  assert.equal(routines[0].kind, 'procedure');

  const triggers = await driver.listTriggers('shopdb', 'dbo');
  assert.equal(triggers[0].timing, 'AFTER');

  const struct = await driver.getTableStructure('shopdb', 'dbo', 'orders');
  assert.equal(struct.columns.length, 3);
  assert.equal(struct.columns[0].isPrimaryKey, true);
  assert.equal(struct.columns[0].isAutoIncrement, true);
  assert.equal(struct.columns[2].dataType, 'nvarchar(100)');
  assert.equal(struct.foreignKeys[0].referencedTable, 'customers');
  assert.equal(struct.checkConstraints[0].name, 'CK_orders_id');
  assert.match(struct.createDdl, /CREATE TABLE \[shopdb\]\.\[dbo\]\.\[orders\]/);

  const er = await driver.getSchemaErGraph('shopdb', 'dbo');
  assert.equal(er.tables.length, 1);
  assert.equal(er.edges[0].targetTable, 'customers');

  // Browse table pagination (OFFSET ... FETCH NEXT)
  const page = await driver.browseTable('shopdb', 'dbo', 'orders', { page: 2, pageSize: 10, sortBy: 'id', sortDir: 'desc' });
  assert.match(page.sql, /ORDER BY \[id\] DESC OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY/);
  assert.equal(page.totalRows, 25);
  assert.equal(page.rows.length, 2);

  // Batch mutations + transaction descriptor propagation
  const preview = driver.generateBatchMutations('shopdb', 'dbo', 'orders', struct, {
    inserts: [{ values: { customer_id: 10, note: 'new' } }],
    updates: [{ keyValues: { id: 1 }, changes: { note: 'updated' } }],
  });
  assert.equal(preview.dialect, 'mssql');
  assert.equal(preview.statements.length, 2);
  seenTxDescs.length = 0;
  const applied = await driver.applyBatchMutations(preview.statements);
  assert.equal(applied.applied, 2);
  assert.equal(applied.affectedRows, 2);
  assert.equal(driver.inTransaction, false);
  // After BEGIN TRANSACTION, subsequent SQL_BATCH packets carry activeTx descriptor
  assert.deepEqual(seenTxDescs[1], activeTx);

  // EXPLAIN via SHOWPLAN_TEXT
  const plan = await driver.explain('SELECT * FROM dbo.orders');
  assert.equal(plan.dialect, 'mssql');
  assert.match(plan.rawText, /Table Scan/);
  assert.ok(plan.root.warnings?.includes('Full table scan'));

  // DDL builders & schema diff
  const createSql = driver.generateCreateTableDdl('shopdb', 'dbo', {
    name: 'items',
    columns: [
      { name: 'id', dataType: 'INT', isPrimaryKey: true, isAutoIncrement: true },
      { name: 'title', dataType: 'NVARCHAR(120)', nullable: false },
    ],
  });
  assert.match(createSql, /\[id\] INT PRIMARY KEY IDENTITY\(1,1\)/);

  const alterSql = driver.generateAlterTableDdl('shopdb', 'dbo', 'items', {
    addColumns: [{ name: 'price', dataType: 'DECIMAL(10,2)', nullable: false, defaultValue: '0' }],
    alterColumns: [{ name: 'title', dataType: 'NVARCHAR(255)', nullable: false }],
    dropIndexes: ['IX_items_old'],
  });
  assert.ok(alterSql.some((s) => s.includes('ADD [price] DECIMAL(10,2) NOT NULL DEFAULT 0;')));
  assert.ok(alterSql.some((s) => s.includes('ALTER COLUMN [title] NVARCHAR(255) NOT NULL;')));
  assert.ok(alterSql.some((s) => s.includes('DROP INDEX [IX_items_old] ON [shopdb].[dbo].[items];')));

  const dump = await driver.dumpDatabaseSql('shopdb', 'dbo', ['orders'], true);
  assert.match(dump, /CREATE TABLE \[shopdb\]\.\[dbo\]\.\[orders\]/);
  assert.match(dump, /INSERT INTO \[shopdb\]\.\[dbo\]\.\[orders\]/);

  const diff = driver.diffSchemas(
    { dialect: 'mssql', database: 'shopdb', schema: 'dbo', tables: [] },
    { dialect: 'mssql', database: 'shopdb', schema: 'dbo', tables: [struct] },
  );
  assert.deepEqual(diff.addedTables, ['orders']);

  // Drop, truncate, switchDatabase, cancelQuery, testConnection
  await driver.dropObject('shopdb', 'dbo', 'orders', 'table');
  await driver.truncateTable('shopdb', 'dbo', 'orders');
  const sw = await driver.switchDatabase('analytics');
  assert.equal(sw.database, 'analytics');
  await driver.cancelQuery();
  assert.equal(attentionReceived, true);

  const testRes = await driver.testConnection();
  assert.equal(testRes.ok, true);
  assert.match(testRes.serverVersion, /SQL Server 2022/);

  await driver.close();
  assert.equal(driver.connected, false);
  assert.ok(seenSql.some((s) => s.includes('TRUNCATE TABLE [shopdb].[dbo].[orders]')));
});

test('MssqlDriver uses direct TLS on tlsMode=verify-full without calling upgradeTls', async () => {
  let connectEndpoint: ByteStreamEndpoint | null = null;
  let streamRef: MockByteStream | null = null;
  const transport: ByteStreamTransport = {
    async connect(endpoint: ByteStreamEndpoint): Promise<ByteStream> {
      connectEndpoint = endpoint;
      let buf: Uint8Array = new Uint8Array(0);
      streamRef = new MockByteStream((chunk, stream) => {
        buf = concatBytes(buf, chunk);
        while (buf.length >= 8) {
          const pktType = buf[0];
          const pktLen = (buf[2] << 8) | buf[3];
          if (buf.length < pktLen) break;
          buf = buf.slice(pktLen);
          if (pktType === TDS_PKT_PRELOGIN) {
            stream.pushServerData(buildPreloginResp(TDS_ENCRYPT_NOT_SUP));
          } else if (pktType === TDS_PKT_LOGIN7) {
            stream.pushServerData(
              wrapTdsPackets(
                TDS_PKT_TABULAR_RESULT,
                concatBytes(tokLoginAck('SQL Server', 16, 0, 1000), tokDone(0, 0n)),
              ),
            );
          }
        }
      }, Boolean(endpoint.tls));
      return streamRef;
    },
  };

  const driver = new MssqlDriver();
  const info = await driver.connect(
    { engine: 'sqlserver', host: 'secure.sql.local', tlsMode: 'verify-full' },
    transport,
  );
  assert.equal(connectEndpoint!.tls, true);
  assert.equal(streamRef!.tlsUpgrades.length, 0);
  assert.equal(info.tlsActive, true);
  await driver.close();
});

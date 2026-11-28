import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { register } from 'tsx/esm/api';

register();

const { HttpSqlDriver } = await import('../src/drivers/httpSqlDriver.ts');
const {
  CassandraDriver,
  CQL_OPCODE,
  CQL_RESULT_KIND,
  CQL_TYPE,
  CQL_VERSION_REQUEST,
  CQL_VERSION_RESPONSE,
  decodeCqlFrameHeader,
  decodeCqlResult,
  decodeCqlValue,
  encodeCqlAuthResponseBody,
  encodeCqlFrame,
  encodeCqlQueryBody,
  encodeCqlStartupBody,
} = await import('../src/drivers/cassandraDriver.ts');
const { MqHttpDriver } = await import('../src/drivers/mqHttpDriver.ts');
const {
  MqttDriver,
  MQTT_PACKET_TYPE,
  decodeMqttConnack,
  decodeMqttPublish,
  decodeMqttRemainingLength,
  decodeMqttSuback,
  encodeMqttConnect,
  encodeMqttDisconnect,
  encodeMqttPingreq,
  encodeMqttPublish,
  encodeMqttRemainingLength,
  encodeMqttSubscribe,
} = await import('../src/drivers/mqttDriver.ts');
const {
  KafkaDriver,
  KAFKA_API_KEY,
  computeCrc32,
  decodeKafkaApiVersionsResponse,
  decodeKafkaFetchResponse,
  decodeKafkaListGroupsResponse,
  decodeKafkaListOffsetsResponse,
  decodeKafkaMetadataResponse,
  decodeKafkaProduceResponse,
  decodeKafkaSaslAuthenticateResponse,
  decodeKafkaSaslHandshakeResponse,
  encodeKafkaApiVersionsRequest,
  encodeKafkaFetchRequest,
  encodeKafkaListOffsetsRequest,
  encodeKafkaMessageSetV1,
  encodeKafkaMetadataRequest,
  encodeKafkaProduceRequest,
  encodeKafkaRequestFrame,
  encodeKafkaSaslAuthenticateRequest,
  encodeKafkaSaslHandshakeRequest,
} = await import('../src/drivers/kafkaDriver.ts');
const {
  ZookeeperDriver,
  ZK_ERR,
  ZK_OPCODE,
  decodeZkConnectResponse,
  decodeZkCreateResponse,
  decodeZkGetChildrenResponse,
  decodeZkGetDataResponse,
  decodeZkReplyHeader,
  encodeZkConnectRequest,
  encodeZkCreateBody,
  encodeZkDeleteBody,
  encodeZkGetChildrenBody,
  encodeZkGetDataBody,
  encodeZkRequest,
  encodeZkSetDataBody,
  frameJutePacket,
  parseZkMntrResponse,
  parseZkStatResponse,
} = await import('../src/drivers/zookeeperDriver.ts');
const {
  ENGINE_CATALOG_ADDITIONS,
  ENGINE_CATALOG_ONLY_ADDITIONS,
  ENGINE_LIVE_ALIAS_ADDITIONS,
  ENGINE_NEW_LIVE_ADDITIONS,
  GBASE8C_PG_COMPAT_VARIANT,
  VALID_ASSET_ICON_IDS,
  mergeEngineCatalogProfiles,
} = await import('../src/engineCatalogAdditions.ts');
const { drivers: baseDrivers } = await import('../src/driverRegistry.ts');

const te = new TextEncoder();
const td = new TextDecoder('utf-8');

/* ============================================================================
 * Mock Transports (HTTP + Scripted ByteStream)
 * ============================================================================ */

function jsonResponse(data, status = 200, headers = {}) {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: te.encode(typeof data === 'string' ? data : JSON.stringify(data)),
  };
}

function createMockHttpTransport(handler) {
  const calls = [];
  const transport = {
    async connect() {
      throw new Error('Unexpected raw TCP connect in HTTP mock');
    },
    async httpRequest(req) {
      calls.push(req);
      return handler(req, calls.length - 1);
    },
  };
  return { transport, calls };
}

function createScriptedByteTransport(onConnect) {
  const connections = [];
  return {
    connections,
    transport: {
      async connect(endpoint) {
        const sent = [];
        const inbox = [];
        let closed = false;
        const waiters = [];

        const push = (chunk) => {
          if (waiters.length > 0) {
            const resolve = waiters.shift();
            resolve(chunk);
          } else {
            inbox.push(chunk);
          }
        };

        const connIdx = connections.length;
        const connCtx = { endpoint, sent, push, close: () => { closed = true; push(null); } };
        connections.push(connCtx);

        const responder = onConnect(connCtx, connIdx);

        return {
          isTls: Boolean(endpoint.tls),
          async read() {
            if (inbox.length > 0) return inbox.shift();
            if (closed) return null;
            return new Promise((resolve) => {
              waiters.push(resolve);
            });
          },
          async write(data) {
            const copy = new Uint8Array(data);
            sent.push(copy);
            if (responder) {
              await responder(copy, connCtx);
            }
          },
          async close() {
            closed = true;
            while (waiters.length > 0) {
              waiters.shift()(null);
            }
          },
        };
      },
    },
  };
}

function concat(...parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function be16(v) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setInt16(0, v, false);
  return b;
}

function be32(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v, false);
  return b;
}

function be64(v) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(v), false);
  return b;
}

function cqlRespFrame(opcode, stream, body = new Uint8Array(0)) {
  const hdr = new Uint8Array(9);
  const view = new DataView(hdr.buffer);
  hdr[0] = CQL_VERSION_RESPONSE;
  hdr[1] = 0;
  view.setInt16(2, stream, false);
  hdr[4] = opcode;
  view.setInt32(5, body.length, false);
  return concat(hdr, body);
}

function cqlStr(s) {
  const raw = te.encode(s);
  const len = new Uint8Array(2);
  new DataView(len.buffer).setUint16(0, raw.length, false);
  return concat(len, raw);
}

function cqlBytes(b) {
  if (b === null) return be32(-1);
  return concat(be32(b.length), b);
}

function buildCqlRowsBody(ks, tbl, cols, rows) {
  // flags = 0x0001 (global tables spec)
  const parts = [be32(CQL_RESULT_KIND.ROWS), be32(0x0001), be32(cols.length), cqlStr(ks), cqlStr(tbl)];
  for (const col of cols) {
    parts.push(cqlStr(col.name), be16(col.typeId));
  }
  parts.push(be32(rows.length));
  for (const row of rows) {
    for (const cell of row) {
      parts.push(cqlBytes(cell));
    }
  }
  return concat(...parts);
}

/* ============================================================================
 * 1. CQL v4 Frame Codecs & CassandraDriver Tests
 * ============================================================================ */

test('CQL v4 frame encoding/decoding and value decoders cover core Cassandra types', () => {
  const startupBody = encodeCqlStartupBody('3.0.0');
  const frame = encodeCqlFrame(CQL_OPCODE.STARTUP, 7, startupBody);
  const hdr = decodeCqlFrameHeader(frame.subarray(0, 9));
  assert.equal(hdr.version, CQL_VERSION_REQUEST);
  assert.equal(hdr.stream, 7);
  assert.equal(hdr.opcode, CQL_OPCODE.STARTUP);
  assert.equal(hdr.length, startupBody.length);

  const authBody = encodeCqlAuthResponseBody('cassandra', 'secret');
  const authLen = new DataView(authBody.buffer).getInt32(0, false);
  assert.equal(authLen, 1 + 'cassandra'.length + 1 + 'secret'.length);
  assert.equal(authBody[4], 0);

  const queryBody = encodeCqlQueryBody('SELECT * FROM users', { pageSize: 50 });
  assert.ok(queryBody.length > 20);

  // Value decoders
  assert.equal(decodeCqlValue({ typeId: CQL_TYPE.INT }, be32(42)), 42);
  assert.equal(decodeCqlValue({ typeId: CQL_TYPE.BIGINT }, be64(900719925474n)), 900719925474);
  assert.equal(decodeCqlValue({ typeId: CQL_TYPE.TEXT }, te.encode('hello')), 'hello');
  assert.equal(decodeCqlValue({ typeId: CQL_TYPE.BOOLEAN }, new Uint8Array([1])), true);
  assert.equal(decodeCqlValue({ typeId: CQL_TYPE.BOOLEAN }, new Uint8Array([0])), false);

  const f64 = new Uint8Array(8);
  new DataView(f64.buffer).setFloat64(0, 3.14159, false);
  assert.equal(decodeCqlValue({ typeId: CQL_TYPE.DOUBLE }, f64), 3.14159);

  const f32 = new Uint8Array(4);
  new DataView(f32.buffer).setFloat32(0, 1.5, false);
  assert.equal(decodeCqlValue({ typeId: CQL_TYPE.FLOAT }, f32), 1.5);

  const uuidBytes = new Uint8Array([
    0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0,
    0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
  ]);
  assert.equal(
    decodeCqlValue({ typeId: CQL_TYPE.UUID }, uuidBytes),
    '12345678-9abc-def0-1122-334455667788',
  );

  const tsMs = Date.UTC(2026, 0, 2, 3, 4, 5);
  assert.equal(
    decodeCqlValue({ typeId: CQL_TYPE.TIMESTAMP }, be64(BigInt(tsMs))),
    '2026-01-02T03:04:05.000Z',
  );

  const blob = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  assert.deepEqual(decodeCqlValue({ typeId: CQL_TYPE.BLOB }, blob), blob);

  // Result kinds: Void, SetKeyspace, SchemaChange, Rows
  assert.deepEqual(decodeCqlResult(be32(CQL_RESULT_KIND.VOID)), { kind: 'void' });
  assert.deepEqual(
    decodeCqlResult(concat(be32(CQL_RESULT_KIND.SET_KEYSPACE), cqlStr('analytics'))),
    { kind: 'set_keyspace', keyspace: 'analytics' },
  );
  const sc = decodeCqlResult(
    concat(be32(CQL_RESULT_KIND.SCHEMA_CHANGE), cqlStr('CREATED'), cqlStr('TABLE'), cqlStr('ks'), cqlStr('t')),
  );
  assert.equal(sc.kind, 'schema_change');
  assert.equal(sc.changeType, 'CREATED');
});

test('CassandraDriver handles STARTUP -> AUTH -> QUERY -> system_schema metadata over ByteStream', async () => {
  const { transport } = createScriptedByteTransport(() => (chunk, ctx) => {
    const hdr = decodeCqlFrameHeader(chunk.subarray(0, 9));
    const body = chunk.subarray(9);
    if (hdr.opcode === CQL_OPCODE.STARTUP) {
      ctx.push(cqlRespFrame(CQL_OPCODE.AUTHENTICATE, hdr.stream, cqlStr('org.apache.cassandra.auth.PasswordAuthenticator')));
    } else if (hdr.opcode === CQL_OPCODE.AUTH_RESPONSE) {
      ctx.push(cqlRespFrame(CQL_OPCODE.AUTH_SUCCESS, hdr.stream, be32(0)));
    } else if (hdr.opcode === CQL_OPCODE.OPTIONS) {
      ctx.push(cqlRespFrame(CQL_OPCODE.SUPPORTED, hdr.stream, be16(0)));
    } else if (hdr.opcode === CQL_OPCODE.QUERY) {
      const qLen = new DataView(body.buffer, body.byteOffset, 4).getInt32(0, false);
      const sql = td.decode(body.subarray(4, 4 + qLen));
      if (sql.includes('system.local')) {
        ctx.push(
          cqlRespFrame(
            CQL_OPCODE.RESULT,
            hdr.stream,
            buildCqlRowsBody('system', 'local', [{ name: 'release_version', typeId: CQL_TYPE.TEXT }], [[te.encode('4.1.4')]]),
          ),
        );
      } else if (sql.includes('system_schema.keyspaces')) {
        ctx.push(
          cqlRespFrame(
            CQL_OPCODE.RESULT,
            hdr.stream,
            buildCqlRowsBody('system_schema', 'keyspaces', [{ name: 'keyspace_name', typeId: CQL_TYPE.TEXT }], [[te.encode('app')], [te.encode('system')]]),
          ),
        );
      } else if (sql.includes('system_schema.tables')) {
        ctx.push(
          cqlRespFrame(
            CQL_OPCODE.RESULT,
            hdr.stream,
            buildCqlRowsBody(
              'system_schema',
              'tables',
              [
                { name: 'table_name', typeId: CQL_TYPE.TEXT },
                { name: 'comment', typeId: CQL_TYPE.TEXT },
              ],
              [[te.encode('events'), te.encode('Event stream')]],
            ),
          ),
        );
      } else if (sql.includes('system_schema.columns')) {
        ctx.push(
          cqlRespFrame(
            CQL_OPCODE.RESULT,
            hdr.stream,
            buildCqlRowsBody(
              'system_schema',
              'columns',
              [
                { name: 'column_name', typeId: CQL_TYPE.TEXT },
                { name: 'kind', typeId: CQL_TYPE.TEXT },
                { name: 'position', typeId: CQL_TYPE.INT },
                { name: 'type', typeId: CQL_TYPE.TEXT },
              ],
              [
                [te.encode('id'), te.encode('partition_key'), be32(0), te.encode('uuid')],
                [te.encode('payload'), te.encode('regular'), be32(-1), te.encode('text')],
              ],
            ),
          ),
        );
      } else if (sql.includes('system_schema.indexes')) {
        ctx.push(
          cqlRespFrame(
            CQL_OPCODE.RESULT,
            hdr.stream,
            buildCqlRowsBody('system_schema', 'indexes', [{ name: 'index_name', typeId: CQL_TYPE.TEXT }], []),
          ),
        );
      } else {
        ctx.push(cqlRespFrame(CQL_OPCODE.RESULT, hdr.stream, be32(CQL_RESULT_KIND.VOID)));
      }
    }
  });

  const driver = new CassandraDriver('cassandra');
  const info = await driver.connect(
    { engine: 'cassandra', host: '127.0.0.1', port: 9042, username: 'cassandra', password: 'secret' },
    transport,
  );
  assert.equal(info.serverVersion, 'Cassandra 4.1.4');
  const dbs = await driver.listDatabases();
  assert.deepEqual(dbs.map((d) => d.name), ['app', 'system']);
  const tables = await driver.listTables('app');
  assert.equal(tables[0].name, 'events');
  const struct = await driver.getTableStructure('app', 'app', 'events');
  assert.equal(struct.columns.length, 2);
  assert.equal(struct.columns[0].isPrimaryKey, true);
  assert.match(struct.createDdl, /PRIMARY KEY \("id"\)/);
  const ping = await driver.testConnection();
  assert.equal(ping.ok, true);
  await driver.close();
});

/* ============================================================================
 * 2. MQTT v3.1.1 / v5.0 Binary Packet Codecs & MqttDriver Tests
 * ============================================================================ */

test('MQTT packet codecs encode and decode v3.1.1 and v5.0 packets cleanly', () => {
  for (const val of [0, 127, 128, 16383, 16384, 2097151]) {
    const enc = encodeMqttRemainingLength(val);
    const dec = decodeMqttRemainingLength(enc, 0);
    assert.equal(dec.value, val);
    assert.equal(dec.bytesRead, enc.length);
  }

  const connV3 = encodeMqttConnect({ clientId: 'c1', username: 'u', password: 'p', protocolVersion: 4 });
  assert.equal(connV3[0], MQTT_PACKET_TYPE.CONNECT << 4);
  const connV5 = encodeMqttConnect({ clientId: 'c5', protocolVersion: 5 });
  assert.equal(connV5[0], MQTT_PACKET_TYPE.CONNECT << 4);

  const ack = decodeMqttConnack(new Uint8Array([0x01, 0x00]), 4);
  assert.equal(ack.ok, true);
  assert.equal(ack.sessionPresent, true);

  const sub = encodeMqttSubscribe(9, [{ topic: 'sensors/temp', qos: 1 }], 4);
  assert.equal(sub[0], (MQTT_PACKET_TYPE.SUBSCRIBE << 4) | 0x02);
  const suback = decodeMqttSuback(new Uint8Array([0x00, 0x09, 0x01]), 4);
  assert.equal(suback.packetId, 9);
  assert.deepEqual(suback.returnCodes, [1]);

  const pub = encodeMqttPublish({ topic: 'sensors/temp', payload: '{"c":22.5}', qos: 1, retain: true, packetId: 5 }, 4);
  const flags = pub[0] & 0x0f;
  const rem = decodeMqttRemainingLength(pub, 1);
  const decodedPub = decodeMqttPublish(flags, pub.subarray(1 + rem.bytesRead), 4);
  assert.equal(decodedPub.topic, 'sensors/temp');
  assert.equal(decodedPub.payload, '{"c":22.5}');
  assert.equal(decodedPub.qos, 1);
  assert.equal(decodedPub.retain, true);
  assert.equal(decodedPub.packetId, 5);

  assert.deepEqual(encodeMqttPingreq(), new Uint8Array([0xc0, 0x00]));
  assert.deepEqual(encodeMqttDisconnect(4), new Uint8Array([0xe0, 0x00]));
});

test('MqttDriver connects, subscribes, publishes, peeks messages, and pings over ByteStream', async () => {
  const { transport } = createScriptedByteTransport(() => (chunk, ctx) => {
    const type = (chunk[0] >> 4) & 0x0f;
    if (type === MQTT_PACKET_TYPE.CONNECT) {
      ctx.push(new Uint8Array([MQTT_PACKET_TYPE.CONNACK << 4, 2, 0, 0]));
    } else if (type === MQTT_PACKET_TYPE.PINGREQ) {
      ctx.push(new Uint8Array([MQTT_PACKET_TYPE.PINGRESP << 4, 0]));
    } else if (type === MQTT_PACKET_TYPE.SUBSCRIBE) {
      const rem = decodeMqttRemainingLength(chunk, 1);
      const body = chunk.subarray(1 + rem.bytesRead);
      const pidHi = body[0];
      const pidLo = body[1];
      ctx.push(new Uint8Array([MQTT_PACKET_TYPE.SUBACK << 4, 3, pidHi, pidLo, 0]));
      // Deliver a retained message right after SUBACK
      ctx.push(encodeMqttPublish({ topic: 'sensors/temp', payload: '{"v":21}', qos: 0 }, 4));
    } else if (type === MQTT_PACKET_TYPE.PUBLISH) {
      const qos = (chunk[0] >> 1) & 0x03;
      if (qos === 1) {
        const rem = decodeMqttRemainingLength(chunk, 1);
        const body = chunk.subarray(1 + rem.bytesRead);
        const decoded = decodeMqttPublish(chunk[0] & 0x0f, body, 4);
        ctx.push(new Uint8Array([MQTT_PACKET_TYPE.PUBACK << 4, 2, (decoded.packetId >> 8) & 0xff, decoded.packetId & 0xff]));
      }
    }
  });

  const driver = new MqttDriver();
  const info = await driver.connect({ engine: 'mqtt', host: '127.0.0.1', port: 1883 }, transport);
  assert.equal(info.serverVersion, 'MQTT v3.1.1');
  assert.equal((await driver.testConnection()).ok, true);
  await driver.createQueue('sensors/temp');
  const pubRes = await driver.publishMessage('sensors/temp', '{"v":25}', { qos: 1 });
  assert.equal(pubRes.routed, true);
  const msgs = await driver.getMessages('sensors/temp', { count: 1, timeoutMs: 100 });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].payload, '{"v":21}');
  await driver.close();
});

/* ============================================================================
 * 3. ZooKeeper Jute Codecs, 4LW Parsers & ZookeeperDriver Tests
 * ============================================================================ */

test('ZooKeeper Jute codecs and 4LW mntr/stat parsers decode responses accurately', () => {
  const connReq = encodeZkConnectRequest({ timeoutMs: 30000 });
  const len = new DataView(connReq.buffer).getInt32(0, false);
  assert.equal(len, connReq.length - 4);

  const connRespBody = concat(be32(0), be32(30000), be64(0x123456n), be32(16), new Uint8Array(16), new Uint8Array([0]));
  const parsedConn = decodeZkConnectResponse(connRespBody);
  assert.equal(parsedConn.sessionId, 0x123456n);
  assert.equal(parsedConn.timeoutMs, 30000);

  const mntr = parseZkMntrResponse('zk_version\t3.9.2-abc\nzk_server_state\tleader\nzk_znode_count\t42\n');
  assert.equal(mntr.zk_version, '3.9.2-abc');
  assert.equal(mntr.zk_server_state, 'leader');
  assert.equal(mntr.zk_znode_count, '42');

  const stat = parseZkStatResponse(
    'Zookeeper version: 3.9.2-abc, built on 2024\nClients:\n /127.0.0.1:50000[1](queued=0)\nMode: standalone\nNode count: 15\n',
  );
  assert.equal(stat.version, '3.9.2-abc');
  assert.equal(stat.mode, 'standalone');
  assert.equal(stat.nodeCount, 15);
  assert.equal(stat.connections, 1);

  // Verify request encoders produce valid length-prefixed Jute packets
  assert.ok(encodeZkRequest(1, ZK_OPCODE.GET_CHILDREN, encodeZkGetChildrenBody('/')).length > 12);
  assert.ok(encodeZkRequest(2, ZK_OPCODE.GET_DATA, encodeZkGetDataBody('/app')).length > 12);
  assert.ok(encodeZkRequest(3, ZK_OPCODE.SET_DATA, encodeZkSetDataBody('/app', te.encode('ok'))).length > 16);
  assert.ok(encodeZkRequest(4, ZK_OPCODE.CREATE, encodeZkCreateBody('/app/k', te.encode('v'))).length > 24);
  assert.ok(encodeZkRequest(5, ZK_OPCODE.DELETE, encodeZkDeleteBody('/app/k')).length > 16);

  const createResp = concat(be32(4), be64(10n), be32(0), be32(6), te.encode('/app/k'));
  const hdr = decodeZkReplyHeader(createResp);
  assert.equal(hdr.err, ZK_ERR.OK);
  assert.equal(decodeZkCreateResponse(createResp, hdr.offset), '/app/k');
});

test('ZookeeperDriver executes Connect, 4LW mntr, GetChildren, GetData, SetData/Create, Delete over ByteStream', async () => {
  const store = new Map([
    ['/config', 'root-cfg'],
    ['/config/db', 'postgres://host'],
  ]);

  function zkStatBytes(len) {
    return concat(
      be64(1n), be64(2n), be64(1000n), be64(2000n),
      be32(3), be32(0), be32(0), be64(0n), be32(len), be32(0), be64(2n),
    );
  }

  function readJuteString(buf, off) {
    const l = new DataView(buf.buffer, buf.byteOffset + off, 4).getInt32(0, false);
    return { val: td.decode(buf.subarray(off + 4, off + 4 + l)), next: off + 4 + l };
  }

  const { transport } = createScriptedByteTransport((_ctx, connIdx) => (chunk, ctx) => {
    const asText = td.decode(chunk);
    if (asText === 'mntr') {
      ctx.push(te.encode('zk_version\t3.9.2-stable\nzk_server_state\tstandalone\nzk_znode_count\t2\n'));
      ctx.close();
      return;
    }
    if (connIdx === 0 && ctx.sent.length === 1) {
      // ConnectRequest
      const resp = concat(be32(0), be32(30000), be64(99n), be32(16), new Uint8Array(16), new Uint8Array([0]));
      ctx.push(frameJutePacket(resp));
      return;
    }
    const payload = chunk.subarray(4);
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const xid = view.getInt32(0, false);
    const opcode = view.getInt32(4, false);

    if (opcode === ZK_OPCODE.PING) {
      ctx.push(frameJutePacket(concat(be32(xid), be64(1n), be32(ZK_ERR.OK))));
    } else if (opcode === ZK_OPCODE.GET_CHILDREN) {
      const { val: path } = readJuteString(payload, 8);
      const kids = new Set();
      for (const k of store.keys()) {
        if (path === '/') {
          const seg = k.split('/').filter(Boolean)[0];
          if (seg) kids.add(seg);
        } else if (k.startsWith(`${path}/`)) {
          const rest = k.slice(path.length + 1);
          if (rest && !rest.includes('/')) kids.add(rest);
        }
      }
      const list = Array.from(kids);
      const parts = [be32(xid), be64(2n), be32(ZK_ERR.OK), be32(list.length)];
      for (const c of list) {
        const b = te.encode(c);
        parts.push(be32(b.length), b);
      }
      ctx.push(frameJutePacket(concat(...parts)));
    } else if (opcode === ZK_OPCODE.GET_DATA) {
      const { val: path } = readJuteString(payload, 8);
      if (!store.has(path)) {
        ctx.push(frameJutePacket(concat(be32(xid), be64(3n), be32(ZK_ERR.NO_NODE))));
        return;
      }
      const data = te.encode(store.get(path));
      ctx.push(frameJutePacket(concat(be32(xid), be64(3n), be32(ZK_ERR.OK), be32(data.length), data, zkStatBytes(data.length))));
    } else if (opcode === ZK_OPCODE.SET_DATA) {
      const { val: path, next } = readJuteString(payload, 8);
      const { val: dataStr } = readJuteString(payload, next);
      if (!store.has(path)) {
        ctx.push(frameJutePacket(concat(be32(xid), be64(4n), be32(ZK_ERR.NO_NODE))));
        return;
      }
      store.set(path, dataStr);
      ctx.push(frameJutePacket(concat(be32(xid), be64(4n), be32(ZK_ERR.OK), zkStatBytes(dataStr.length))));
    } else if (opcode === ZK_OPCODE.CREATE) {
      const { val: path, next } = readJuteString(payload, 8);
      const { val: dataStr } = readJuteString(payload, next);
      store.set(path, dataStr);
      const pBytes = te.encode(path);
      ctx.push(frameJutePacket(concat(be32(xid), be64(5n), be32(ZK_ERR.OK), be32(pBytes.length), pBytes)));
    } else if (opcode === ZK_OPCODE.DELETE) {
      const { val: path } = readJuteString(payload, 8);
      store.delete(path);
      ctx.push(frameJutePacket(concat(be32(xid), be64(6n), be32(ZK_ERR.OK))));
    }
  });

  const driver = new ZookeeperDriver();
  const info = await driver.connect({ engine: 'zookeeper', host: '127.0.0.1', port: 2181 }, transport);
  assert.equal(info.serverVersion, 'ZooKeeper 3.9.2-stable');
  assert.equal((await driver.testConnection()).ok, true);

  const ns = await driver.listNamespaces();
  assert.ok(ns.some((n) => n.id === '/config'));

  const keys = await driver.listKeys('/');
  assert.ok(keys.some((k) => k.key === '/config/db' && k.value === 'postgres://host'));

  await driver.putKey('/config/new', 'hello');
  const created = await driver.getKey('/config/new');
  assert.equal(created?.value, 'hello');

  await driver.deleteKey('/config/new');
  assert.equal(await driver.getKey('/config/new'), null);

  const status = await driver.getClusterStatus();
  assert.equal(status.zk_server_state, 'standalone');
  await driver.close();
});

/* ============================================================================
 * 4. Kafka Binary Wire Codecs & KafkaDriver Tests
 * ============================================================================ */

test('Kafka wire codecs encode/decode ApiVersions, Metadata, ListOffsets, Fetch, Produce, ListGroups, SASL', () => {
  // IEEE CRC32 standard test vector "123456789" === 0xcbf43926
  assert.equal(computeCrc32(te.encode('123456789')), 0xcbf43926);

  const req = encodeKafkaRequestFrame(KAFKA_API_KEY.API_VERSIONS, 0, 42, 'netcatty', encodeKafkaApiVersionsRequest(0));
  const reqView = new DataView(req.buffer);
  assert.equal(reqView.getInt32(0, false), req.length - 4);
  assert.equal(reqView.getInt16(4, false), KAFKA_API_KEY.API_VERSIONS);
  assert.equal(reqView.getInt32(8, false), 42);

  // ApiVersions response
  const apiResp = concat(be16(0), be32(1), be16(3), be16(0), be16(9));
  const parsedApi = decodeKafkaApiVersionsResponse(apiResp, 0);
  assert.equal(parsedApi.errorCode, 0);
  assert.equal(parsedApi.apiKeys[0].apiKey, 3);

  // SASL Handshake + Authenticate
  assert.ok(encodeKafkaSaslHandshakeRequest('PLAIN').length > 4);
  const hsResp = decodeKafkaSaslHandshakeResponse(concat(be16(0), be32(1), cqlStr('PLAIN')));
  assert.deepEqual(hsResp.mechanisms, ['PLAIN']);
  assert.ok(encodeKafkaSaslAuthenticateRequest('alice', 'pw').length > 10);
  const authResp = decodeKafkaSaslAuthenticateResponse(concat(be16(0), be16(-1)));
  assert.equal(authResp.errorCode, 0);

  // Metadata + ListOffsets + Produce + Fetch + ListGroups
  assert.ok(encodeKafkaMetadataRequest(null, 1).length >= 4);
  assert.ok(encodeKafkaListOffsetsRequest('orders', [0], -1n).length > 12);
  const loResp = decodeKafkaListOffsetsResponse(
    concat(be32(1), cqlStr('orders'), be32(1), be32(0), be16(0), be64(0n), be64(10n)),
  );
  assert.equal(loResp[0].offset, 10);

  const prodReq = encodeKafkaProduceRequest('orders', 0, [{ key: 'k1', value: 'v1' }], 2);
  assert.ok(prodReq.length > 30);
  const prodResp = decodeKafkaProduceResponse(
    concat(be32(1), cqlStr('orders'), be32(1), be32(0), be16(0), be64(10n), be64(0n)),
  );
  assert.equal(prodResp[0].baseOffset, 10);

  assert.ok(encodeKafkaFetchRequest('orders', 0, 0, 65536, 500, 2).length > 20);
  const msgSet = encodeKafkaMessageSetV1([{ key: 'k1', value: '{"ok":true}', timestamp: 1700000000000 }]);
  const fetchResp = decodeKafkaFetchResponse(
    concat(be32(0), be32(1), cqlStr('orders'), be32(1), be32(0), be16(0), be64(1n), be32(msgSet.length), msgSet),
    2,
  );
  assert.equal(fetchResp[0].records.length, 1);
  assert.equal(fetchResp[0].records[0].key, 'k1');
  assert.equal(fetchResp[0].records[0].value, '{"ok":true}');

  const lgResp = decodeKafkaListGroupsResponse(concat(be16(0), be32(1), cqlStr('billing-cg'), cqlStr('consumer')));
  assert.equal(lgResp.groups[0].groupId, 'billing-cg');
});

test('KafkaDriver performs SASL PLAIN, Metadata, ListPartitions, ListGroups, Produce and Fetch over ByteStream', async () => {
  function kafkaFrame(corrId, body) {
    const payload = concat(be32(corrId), body);
    return concat(be32(payload.length), payload);
  }

  const { transport } = createScriptedByteTransport(() => (chunk, ctx) => {
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const apiKey = view.getInt16(4, false);
    const corrId = view.getInt32(8, false);

    if (apiKey === KAFKA_API_KEY.SASL_HANDSHAKE) {
      ctx.push(kafkaFrame(corrId, concat(be16(0), be32(1), cqlStr('PLAIN'))));
    } else if (apiKey === KAFKA_API_KEY.SASL_AUTHENTICATE) {
      ctx.push(kafkaFrame(corrId, concat(be16(0), be16(-1))));
    } else if (apiKey === KAFKA_API_KEY.API_VERSIONS) {
      ctx.push(kafkaFrame(corrId, concat(be16(0), be32(1), be16(3), be16(0), be16(4))));
    } else if (apiKey === KAFKA_API_KEY.METADATA) {
      // Metadata v1: brokers[1], controllerId=1, topics[1]
      const body = concat(
        be32(1), be32(1), cqlStr('broker-1'), be32(9092), be16(-1),
        be32(1), // controllerId
        be32(1), // topics count
        be16(0), cqlStr('orders'), new Uint8Array([0]),
        be32(1), // partitions count
        be16(0), be32(0), be32(1), be32(1), be32(1), be32(1), be32(1),
      );
      ctx.push(kafkaFrame(corrId, body));
    } else if (apiKey === KAFKA_API_KEY.LIST_OFFSETS) {
      const body = concat(be32(1), cqlStr('orders'), be32(1), be32(0), be16(0), be64(0n), be64(5n));
      ctx.push(kafkaFrame(corrId, body));
    } else if (apiKey === KAFKA_API_KEY.FETCH) {
      const msgSet = encodeKafkaMessageSetV1([{ key: 'ord-1', value: '{"total":99}' }]);
      const body = concat(
        be32(0), be32(1), cqlStr('orders'), be32(1), be32(0), be16(0), be64(6n), be32(msgSet.length), msgSet,
      );
      ctx.push(kafkaFrame(corrId, body));
    } else if (apiKey === KAFKA_API_KEY.PRODUCE) {
      const body = concat(be32(1), cqlStr('orders'), be32(1), be32(0), be16(0), be64(6n), be64(0n));
      ctx.push(kafkaFrame(corrId, body));
    } else if (apiKey === KAFKA_API_KEY.LIST_GROUPS) {
      const body = concat(be16(0), be32(1), cqlStr('orders-workers'), cqlStr('consumer'));
      ctx.push(kafkaFrame(corrId, body));
    }
  });

  const driver = new KafkaDriver();
  const info = await driver.connect(
    { engine: 'kafka', host: '127.0.0.1', port: 9092, username: 'admin', password: 'secret' },
    transport,
  );
  assert.match(info.serverVersion, /Apache Kafka/);
  const queues = await driver.listQueues();
  assert.equal(queues[0].name, 'orders');
  const nodes = await driver.listNodes();
  assert.equal(nodes[0].isController, true);
  const parts = await driver.listPartitions('orders');
  assert.equal(parts[0].latestOffset, 5);
  const groups = await driver.listConsumerGroups();
  assert.equal(groups[0].groupId, 'orders-workers');
  assert.equal((await driver.publishMessage('orders', '{"total":100}')).routed, true);
  const msgs = await driver.getMessages('orders', { count: 5 });
  assert.equal(msgs[0].payload, '{"total":99}');
  await driver.close();
});

/* ============================================================================
 * 5. RabbitMQ & Apache Pulsar HTTP Flows (MqHttpDriver)
 * ============================================================================ */

test('MqHttpDriver handles RabbitMQ Management HTTP API and Pulsar Admin HTTP API', async () => {
  // RabbitMQ
  const rmq = createMockHttpTransport((req) => {
    const u = new URL(req.url);
    if (u.pathname === '/api/overview') {
      return jsonResponse({
        cluster_name: 'rabbit@prod',
        rabbitmq_version: '3.13.2',
        object_totals: { queues: 2, exchanges: 5, connections: 3 },
        queue_totals: { messages_ready: 12, messages_unacknowledged: 1 },
      });
    }
    if (u.pathname === '/api/vhosts') return jsonResponse([{ name: '/' }, { name: 'app' }]);
    if (u.pathname.startsWith('/api/queues') && req.method === 'GET') {
      return jsonResponse([{ name: 'jobs', vhost: '/', messages: 12, messages_ready: 12, consumers: 2, durable: true, state: 'running' }]);
    }
    if (u.pathname.startsWith('/api/exchanges') && req.method === 'GET') {
      return jsonResponse([{ name: 'amq.topic', vhost: '/', type: 'topic', durable: true }]);
    }
    if (u.pathname.startsWith('/api/bindings')) {
      return jsonResponse([{ source: 'amq.topic', destination: 'jobs', destination_type: 'queue', routing_key: 'job.*', vhost: '/' }]);
    }
    if (u.pathname === '/api/nodes') return jsonResponse([{ name: 'rabbit@node1', running: true, mem_used: 102400 }]);
    if (u.pathname === '/api/connections') return jsonResponse([{ name: '127.0.0.1:51234', user: 'guest', vhost: '/', state: 'running' }]);
    if (u.pathname === '/api/channels') return jsonResponse([{ name: 'ch-1', user: 'guest', consumer_count: 2, messages_unacknowledged: 1 }]);
    if (u.pathname === '/api/users') return jsonResponse([{ name: 'guest', tags: ['administrator'] }]);
    if (u.pathname === '/api/permissions') return jsonResponse([{ user: 'guest', vhost: '/', configure: '.*', write: '.*', read: '.*' }]);
    if (u.pathname.startsWith('/api/policies')) return jsonResponse([{ name: 'ha-all', vhost: '/', pattern: '^jobs', 'apply-to': 'queues' }]);
    if (u.pathname.endsWith('/publish')) return jsonResponse({ routed: true });
    if (u.pathname.endsWith('/get')) return jsonResponse([{ payload: '{"job":1}', routing_key: 'jobs', redelivered: false, properties: { message_id: 'm1' } }]);
    return jsonResponse({});
  });

  const rabbit = new MqHttpDriver('rabbitmq');
  const rInfo = await rabbit.connect({ engine: 'rabbitmq', host: '127.0.0.1', port: 15672, username: 'guest', password: 'guest' }, rmq.transport);
  assert.equal(rInfo.serverVersion, 'RabbitMQ 3.13.2');
  assert.deepEqual(await rabbit.listVhosts(), ['/', 'app']);
  assert.equal((await rabbit.listQueues('/'))[0].name, 'jobs');
  assert.equal((await rabbit.listExchanges('/'))[0].type, 'topic');
  assert.equal((await rabbit.listBindings('/'))[0].routingKey, 'job.*');
  assert.equal((await rabbit.listNodes())[0].name, 'rabbit@node1');
  assert.equal((await rabbit.listConnections()).length, 1);
  assert.equal((await rabbit.listChannels()).length, 1);
  assert.equal((await rabbit.listUsers())[0].permissions.length, 1);
  assert.equal((await rabbit.listPolicies('/'))[0].name, 'ha-all');
  assert.equal((await rabbit.publishMessage('jobs', '{"job":2}')).routed, true);
  assert.equal((await rabbit.getMessages('jobs'))[0].payload, '{"job":1}');
  await rabbit.close();

  // Pulsar
  const pul = createMockHttpTransport((req) => {
    const u = new URL(req.url);
    if (u.pathname === '/admin/v2/brokers/health') return jsonResponse('ok');
    if (u.pathname === '/admin/v2/tenants') return jsonResponse(['public']);
    if (u.pathname === '/admin/v2/brokers/active') return jsonResponse(['broker-0:8080']);
    if (u.pathname === '/admin/v2/namespaces/public') return jsonResponse(['public/default']);
    if (u.pathname === '/admin/v2/persistent/public/default') {
      return jsonResponse(['persistent://public/default/payments']);
    }
    if (u.pathname.endsWith('/subscriptions')) return jsonResponse(['sub-analytics']);
    if (u.pathname.includes('/examinemessage')) return jsonResponse('{"amount":50}', 200, { 'x-pulsar-message-id': '1:0' });
    return jsonResponse({});
  });

  const pulsar = new MqHttpDriver('pulsar');
  const pInfo = await pulsar.connect({ engine: 'pulsar', host: '127.0.0.1', port: 8080, apiKey: 'jwt-tok' }, pul.transport);
  assert.equal(pInfo.serverVersion, 'Apache Pulsar Admin v2');
  assert.deepEqual(await pulsar.listVhosts(), ['public/default']);
  assert.equal((await pulsar.listQueues('public/default'))[0].name, 'payments');
  assert.equal((await pulsar.listBindings('public/default'))[0].destination, 'sub-analytics');
  assert.equal((await pulsar.getMessages('payments', { count: 1 }))[0].payload, '{"amount":50}');
  await pulsar.close();
});

/* ============================================================================
 * 6. All 7 New Tier 1 HTTP SQL Engines (httpSqlDriver.ts)
 * ============================================================================ */

test('HttpSqlDriver supports all 7 Tier 1 HTTP SQL engines with mocked httpRequest', async () => {
  // 1) Cloudflare D1
  {
    const { transport, calls } = createMockHttpTransport((req) => {
      const body = JSON.parse(req.body);
      if (body.sql.includes('sqlite_version')) {
        return jsonResponse({ success: true, result: [{ success: true, results: [{ 'sqlite_version()': '3.45.0' }] }] });
      }
      if (body.sql.includes('sqlite_master')) {
        return jsonResponse({ success: true, result: [{ success: true, results: [{ name: 'users' }] }] });
      }
      return jsonResponse({ success: true, result: [{ success: true, results: [{ id: 1, name: 'Ada' }], meta: { changes: 0 } }] });
    });
    const d = new HttpSqlDriver('cloudflare-d1');
    const info = await d.connect({ engine: 'cloudflare-d1', accountId: 'acc123', database: 'db456', apiKey: 'cf-tok' }, transport);
    assert.equal(info.serverVersion, 'Cloudflare D1 (SQLite 3.45.0)');
    assert.match(calls[0].url, /\/client\/v4\/accounts\/acc123\/d1\/database\/db456\/query$/);
    assert.equal(calls[0].headers.Authorization, 'Bearer cf-tok');
    const tbls = await d.listTables();
    assert.equal(tbls[0].name, 'users');
    const q = await d.query('SELECT id, name FROM users');
    assert.deepEqual(q.results[0].rows, [[1, 'Ada']]);
    await d.close();
  }

  // 2) Apache IoTDB REST v2
  {
    const { transport, calls } = createMockHttpTransport((req) => {
      const u = new URL(req.url);
      if (u.pathname === '/rest/v2/nonQuery') return jsonResponse({ code: 200, message: 'EXECUTE_STATEMENT_SUCCESS' });
      const body = JSON.parse(req.body);
      if (body.sql === 'SHOW VERSION') return jsonResponse({ columnNames: ['Version'], values: [['1.3.2']] });
      return jsonResponse({
        expressions: ['root.sg.d1.temp'],
        timestamps: [1700000000000, 1700000001000],
        values: [[23.4, 24.1]],
      });
    });
    const d = new HttpSqlDriver('iotdb');
    const info = await d.connect({ engine: 'iotdb', host: '127.0.0.1', port: 18080, username: 'root', password: 'root' }, transport);
    assert.equal(info.serverVersion, 'Apache IoTDB 1.3.2');
    const sel = await d.query('SELECT temp FROM root.sg.d1');
    assert.deepEqual(sel.results[0].columns.map((c) => c.name), ['Time', 'root.sg.d1.temp']);
    assert.deepEqual(sel.results[0].rows[0], [1700000000000, 23.4]);
    await d.query('CREATE DATABASE root.sg2');
    assert.ok(calls.some((c) => c.url.endsWith('/rest/v2/nonQuery')));
    await d.close();
  }

  // 3) Apache Kylin REST
  {
    const { transport } = createMockHttpTransport((req) => {
      const u = new URL(req.url);
      if (u.pathname === '/kylin/api/projects') return jsonResponse([{ name: 'learn_kylin' }]);
      if (u.pathname === '/kylin/api/tables') {
        return jsonResponse([{ name: 'KYLIN_SALES', database: 'DEFAULT', columns: [{ name: 'PRICE', datatype: 'DECIMAL' }] }]);
      }
      if (u.pathname === '/kylin/api/query') {
        return jsonResponse({
          columnMetas: [{ label: 'TOTAL', columnTypeName: 'BIGINT' }],
          results: [['999']],
        });
      }
      return jsonResponse({});
    });
    const d = new HttpSqlDriver('kylin');
    const info = await d.connect({ engine: 'kylin', host: '127.0.0.1', port: 7070, database: 'learn_kylin' }, transport);
    assert.equal(info.serverVersion, 'Apache Kylin');
    assert.equal((await d.listDatabases())[0].name, 'learn_kylin');
    assert.equal((await d.listTables('learn_kylin', 'DEFAULT'))[0].name, 'KYLIN_SALES');
    const struct = await d.getTableStructure('learn_kylin', 'DEFAULT', 'KYLIN_SALES');
    assert.equal(struct.columns[0].name, 'PRICE');
    const q = await d.query('SELECT SUM(PRICE) AS TOTAL FROM KYLIN_SALES');
    assert.equal(q.results[0].rows[0][0], '999');
    await d.close();
  }

  // 4) Databricks SQL Statement Execution API (with PENDING -> SUCCEEDED polling)
  {
    let pollStep = 0;
    const { transport } = createMockHttpTransport((req) => {
      const u = new URL(req.url);
      if (u.pathname === '/api/2.0/sql/statements' && req.method === 'POST') {
        const body = JSON.parse(req.body);
        if (body.statement.includes('current_version')) {
          return jsonResponse({
            statement_id: 'st-ver',
            status: { state: 'SUCCEEDED' },
            manifest: { schema: { columns: [{ name: 'v', type_text: 'STRING' }] } },
            result: { data_array: [['2024.30']] },
          });
        }
        return jsonResponse({ statement_id: 'st-1', status: { state: 'PENDING' } });
      }
      if (u.pathname === '/api/2.0/sql/statements/st-1') {
        pollStep++;
        return jsonResponse({
          statement_id: 'st-1',
          status: { state: 'SUCCEEDED' },
          manifest: { schema: { columns: [{ name: 'cnt', type_name: 'LONG' }] } },
          result: { data_array: [[123]] },
        });
      }
      return jsonResponse({});
    });
    const d = new HttpSqlDriver('databricks');
    const info = await d.connect({ engine: 'databricks', host: 'adb.example.com', warehouseId: 'wh-1', apiKey: 'dapi-tok' }, transport);
    assert.equal(info.serverVersion, 'Databricks SQL 2024.30');
    const q = await d.query('SELECT COUNT(*) AS cnt FROM main.default.events');
    assert.equal(pollStep, 1);
    assert.equal(q.results[0].rows[0][0], 123);
    await d.close();
  }

  // 5) Snowflake SQL REST API v2 (with 202 -> 200 polling)
  {
    let sfPolled = false;
    const { transport } = createMockHttpTransport((req) => {
      const u = new URL(req.url);
      if (u.pathname === '/api/v2/statements' && req.method === 'POST') {
        const body = JSON.parse(req.body);
        if (body.statement.includes('CURRENT_VERSION')) {
          return jsonResponse({
            statementHandle: 'h-ver',
            resultSetMetaData: { rowType: [{ name: 'VER', type: 'text' }] },
            data: [['8.25.0']],
          });
        }
        return jsonResponse({ statementHandle: 'h-async', statementStatusUrl: '/api/v2/statements/h-async' }, 202);
      }
      if (u.pathname === '/api/v2/statements/h-async') {
        sfPolled = true;
        return jsonResponse({
          statementHandle: 'h-async',
          resultSetMetaData: { rowType: [{ name: 'AMOUNT', type: 'fixed' }, { name: 'ACTIVE', type: 'boolean' }] },
          data: [['42.5', 'true']],
        });
      }
      return jsonResponse({});
    });
    const d = new HttpSqlDriver('snowflake');
    const info = await d.connect({ engine: 'snowflake', accountId: 'xy12345', warehouseId: 'COMPUTE_WH', apiKey: 'sf-oauth' }, transport);
    assert.equal(info.serverVersion, 'Snowflake 8.25.0');
    const q = await d.query('SELECT amount, active FROM orders');
    assert.equal(sfPolled, true);
    assert.deepEqual(q.results[0].rows[0], [42.5, true]);
    await d.close();
  }

  // 6) Google BigQuery REST API v2 (with datasets + job polling)
  {
    let bqPolled = false;
    const { transport } = createMockHttpTransport((req) => {
      const u = new URL(req.url);
      if (u.pathname === '/bigquery/v2/projects/my-gcp/datasets') {
        return jsonResponse({ datasets: [{ datasetReference: { datasetId: 'analytics' } }] });
      }
      if (u.pathname === '/bigquery/v2/projects/my-gcp/datasets/analytics/tables') {
        return jsonResponse({ tables: [{ tableReference: { tableId: 'sessions' }, type: 'TABLE' }] });
      }
      if (u.pathname === '/bigquery/v2/projects/my-gcp/queries' && req.method === 'POST') {
        return jsonResponse({ jobComplete: false, jobReference: { projectId: 'my-gcp', jobId: 'job-99', location: 'US' } });
      }
      if (u.pathname === '/bigquery/v2/projects/my-gcp/queries/job-99') {
        bqPolled = true;
        return jsonResponse({
          jobComplete: true,
          schema: { fields: [{ name: 'users', type: 'INT64', mode: 'REQUIRED' }] },
          rows: [{ f: [{ v: '77' }] }],
        });
      }
      return jsonResponse({});
    });
    const d = new HttpSqlDriver('bigquery');
    const info = await d.connect({ engine: 'bigquery', accountId: 'my-gcp', apiKey: 'gcp-token' }, transport);
    assert.equal(info.serverVersion, 'Google BigQuery (my-gcp)');
    assert.equal((await d.listSchemas('my-gcp'))[0].name, 'analytics');
    assert.equal((await d.listTables('my-gcp', 'analytics'))[0].name, 'sessions');
    const q = await d.query('SELECT COUNT(*) AS users FROM analytics.sessions');
    assert.equal(bqPolled, true);
    assert.equal(q.results[0].rows[0][0], 77);
    await d.close();
  }

  // 7) Salesforce SOQL REST v61.0
  {
    const { transport } = createMockHttpTransport((req) => {
      const u = new URL(req.url);
      if (u.pathname === '/services/data/v61.0/sobjects') {
        return jsonResponse({ sobjects: [{ name: 'Account', label: 'Account', queryable: true, custom: false }] });
      }
      if (u.pathname === '/services/data/v61.0/sobjects/Account/describe') {
        return jsonResponse({
          label: 'Account',
          fields: [
            { name: 'Id', label: 'Account ID', type: 'id', nillable: false },
            { name: 'Name', label: 'Account Name', type: 'string', nillable: false, length: 255 },
          ],
        });
      }
      if (u.pathname === '/services/data/v61.0/query') {
        return jsonResponse({
          totalSize: 1,
          done: true,
          records: [{ attributes: { type: 'Account', url: '/...' }, Id: '001XX000003DGbY', Name: 'Acme Corp' }],
        });
      }
      return jsonResponse({});
    });
    const d = new HttpSqlDriver('salesforce');
    const info = await d.connect({ engine: 'salesforce', host: 'acme.my.salesforce.com', apiKey: 'sf-session' }, transport);
    assert.equal(info.serverVersion, 'Salesforce API v61.0');
    assert.equal((await d.listTables())[0].name, 'Account');
    const struct = await d.getTableStructure('', 'sobjects', 'Account');
    assert.equal(struct.columns[0].isPrimaryKey, true);
    const browse = await d.browseTable('', 'sobjects', 'Account', { page: 1, pageSize: 10 });
    assert.deepEqual(browse.rows[0], ['001XX000003DGbY', 'Acme Corp']);
    await d.close();
  }
});

/* ============================================================================
 * 7. Netcatty Database 110-Profile Catalog Supplement & Sandbox Compliance Checks
 * ============================================================================ */

test('engineCatalogAdditions covers all 113 supported engine profiles with valid bundled icon IDs', () => {
  const validIcons = new Set(VALID_ASSET_ICON_IDS);
  assert.equal(GBASE8C_PG_COMPAT_VARIANT.wireFamily, 'postgres');
  assert.equal(ENGINE_LIVE_ALIAS_ADDITIONS.length, 5);
  assert.ok(ENGINE_NEW_LIVE_ADDITIONS.length >= 19);
  assert.ok(ENGINE_CATALOG_ONLY_ADDITIONS.length >= 30);

  // Every addition must have a unique ID and a valid bundled icon with PNG+SVG light/dark files
  const seen = new Set();
  for (const entry of ENGINE_CATALOG_ADDITIONS) {
    assert.equal(seen.has(entry.id), false, `Duplicate ID in ENGINE_CATALOG_ADDITIONS: ${entry.id}`);
    seen.add(entry.id);
    assert.ok(validIcons.has(entry.icon), `Invalid icon '${entry.icon}' on profile '${entry.id}'`);
    for (const theme of ['light', 'dark']) {
      assert.ok(
        existsSync(`assets/icons/${entry.icon}-${theme}.png`),
        `Missing PNG asset for icon '${entry.icon}'`,
      );
      assert.ok(
        existsSync(`assets/icons/${entry.icon}-${theme}.svg`),
        `Missing SVG asset for icon '${entry.icon}'`,
      );
    }
  }

  // Merge with driverRegistry.ts and verify full catalog uniqueness and coverage
  const merged = mergeEngineCatalogProfiles(baseDrivers);
  const mergedIds = new Set(merged.map((p) => p.id));
  assert.equal(mergedIds.size, merged.length, 'Merged catalog must not contain duplicate IDs');
  assert.ok(merged.length >= 113, `Expected at least 113 merged engine profiles, got ${merged.length}`);

  // Check scylladb alias to cassandra exists
  assert.ok(mergedIds.has('scylladb'));
  assert.ok(mergedIds.has('kafka'));
  assert.ok(mergedIds.has('cloudflare-d1'));
});

test('all Wave D source files are 100% browser-sandbox clean (zero node:* imports, zero inline svg/canvas)', () => {
  const files = [
    'src/drivers/httpSqlDriver.ts',
    'src/drivers/cassandraDriver.ts',
    'src/drivers/mqHttpDriver.ts',
    'src/drivers/mqttDriver.ts',
    'src/drivers/kafkaDriver.ts',
    'src/drivers/zookeeperDriver.ts',
    'src/ui/components/MqWorkbenchTab.tsx',
    'src/engineCatalogAdditions.ts',
  ];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /from\s+['"]node:/, `Found forbidden node:* import in ${file}`);
    assert.doesNotMatch(src, /require\(['"]node:/, `Found forbidden node:* require in ${file}`);
    assert.doesNotMatch(src, /<svg\b/i, `Found forbidden inline <svg> in ${file}`);
    assert.doesNotMatch(src, /<canvas\b/i, `Found forbidden <canvas> in ${file}`);
  }
});

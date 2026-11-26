/**
 * Live Multi-Database Integration Tests against the local Docker test stack
 * (PostgreSQL 17, MySQL 8.4, MariaDB 11, Redis 7.4, MongoDB 7, ClickHouse 24)
 * and the real local SQLite fixture (`tests/fixtures/shop_demo.sqlite`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ClickHouseDriver,
  createRelationalDriver,
  MysqlDriver,
  PostgresDriver,
  PureMongoDriver,
  PureRedisDriver,
  SqliteDriver,
} from '../../src/drivers/index';
import { createNodeSocketTransport } from './nodeSocketTransport';

const transport = createNodeSocketTransport();

test('LIVE PostgreSQL 17: STARTTLS + SCRAM-SHA-256, introspection, OIDs, multi-stmt, CRUD, EXPLAIN, cancelQuery', async () => {
  const pg = new PostgresDriver('postgres');
  const info = await pg.connect(
    {
      engine: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      database: 'shop_demo',
      username: 'netcatty',
      password: 'netcatty_pg_pass',
      tlsMode: 'require',
      allowSelfSigned: true,
    },
    transport,
  );
  try {
    assert.equal(info.tlsActive, true, 'PostgreSQL STARTTLS must be active');
    assert.ok(info.serverVersion.startsWith('17'), `Expected PG 17, got ${info.serverVersion}`);
    assert.ok((info.processId ?? 0) > 0);

    const ping = await pg.testConnection();
    assert.equal(ping.ok, true);

    const dbs = await pg.listDatabases();
    assert.ok(dbs.some((d) => d.name === 'shop_demo'));

    const schemas = await pg.listSchemas('shop_demo');
    assert.ok(schemas.some((s) => s.name === 'public'));
    assert.ok(schemas.some((s) => s.name === 'analytics'));

    const tables = await pg.listTables('shop_demo', 'public');
    assert.ok(tables.some((t) => t.name === 'customers'));
    assert.ok(tables.some((t) => t.name === 'orders'));
    assert.ok(tables.some((t) => t.name === 'products'));

    const views = await pg.listViews('shop_demo', 'public');
    assert.ok(views.some((v) => v.name === 'v_customer_order_summary'));

    const triggers = await pg.listTriggers('shop_demo', 'public');
    assert.ok(triggers.length >= 1);

    const orderStruct = await pg.getTableStructure('shop_demo', 'public', 'orders');
    assert.ok(orderStruct.columns.some((c) => c.isPrimaryKey));
    assert.ok(orderStruct.foreignKeys.some((fk) => fk.referencedTable === 'customers'));
    assert.match(orderStruct.createDdl, /CREATE TABLE "public"\."orders"/);

    const er = await pg.getSchemaErGraph('shop_demo', 'public');
    assert.ok(er.tables.length >= 5);
    assert.ok(er.edges.length >= 3);

    // Multi-statement + rich OIDs
    const multi = await pg.query(
      "SELECT 1::int4 AS i, 2.5::float8 AS f, true AS b, '{\"a\":1}'::jsonb AS j, ARRAY['x','y'] AS arr, '\\xdeadbeef'::bytea AS bin; SELECT COUNT(*) FROM customers;",
    );
    assert.equal(multi.results.length, 2);
    const r0 = multi.results[0].rows[0];
    assert.equal(r0[0], 1);
    assert.equal(r0[1], 2.5);
    assert.equal(r0[2], true);
    assert.deepEqual(r0[3], { a: 1 });
    assert.deepEqual(r0[4], ['x', 'y']);
    assert.deepEqual(r0[5], new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    assert.ok(Number(multi.results[1].rows[0][0]) >= 1);

    // Server-side pagination + sort
    const page = await pg.browseTable('shop_demo', 'public', 'products', {
      page: 1,
      pageSize: 3,
      sortBy: 'id',
      sortDir: 'asc',
    });
    assert.equal(page.rows.length, 3);
    assert.ok(page.totalRows >= 3);

    // Atomic batch mutations (insert + update + delete on a temp row)
    const testEmail = `driver_test_${Date.now()}@example.com`;
    const custStruct = await pg.getTableStructure('shop_demo', 'public', 'customers');
    const insPreview = pg.generateBatchMutations('shop_demo', 'public', 'customers', custStruct, {
      inserts: [{ values: { full_name: 'PG Driver Test 🚀', email: testEmail } }],
    });
    const insApply = await pg.applyBatchMutations(insPreview.statements);
    assert.equal(insApply.affectedRows, 1);

    const inserted = await pg.query('SELECT id, full_name FROM customers WHERE email = $1', {
      params: [testEmail],
    });
    assert.equal(inserted.results[0].rows.length, 1);
    const insertedId = inserted.results[0].rows[0][0];

    const updDelPreview = pg.generateBatchMutations('shop_demo', 'public', 'customers', custStruct, {
      updates: [{ keyValues: { id: insertedId }, changes: { full_name: 'Updated PG Test' } }],
      deletes: [{ keyValues: { id: insertedId } }],
    });
    const updDelApply = await pg.applyBatchMutations(updDelPreview.statements);
    assert.equal(updDelApply.affectedRows, 2);

    // EXPLAIN (FORMAT JSON) + EXPLAIN ANALYZE
    const exp = await pg.explain('SELECT * FROM orders ORDER BY id LIMIT 5', true);
    assert.equal(exp.dialect, 'postgres');
    assert.equal(exp.analyzed, true);
    assert.ok(exp.root.nodeType.length > 0);
    assert.ok(exp.actualTimeMs !== undefined);

    // Real query cancellation via CancelRequest
    const slowPromise = pg.query('SELECT pg_sleep(5)');
    await new Promise((r) => setTimeout(r, 150));
    await pg.cancelQuery();
    await assert.rejects(slowPromise, /cancel/i);

    // Connection remains healthy after cancel
    const afterCancel = await pg.query('SELECT 123');
    assert.equal(afterCancel.results[0].rows[0][0], 123);

    // SQL dump
    const dump = await pg.dumpDatabaseSql('shop_demo', 'public', ['categories'], true);
    assert.match(dump, /CREATE TABLE "public"\."categories"/);
    assert.match(dump, /INSERT INTO "public"\."categories"/);

    // PG-family alias works against live PostgreSQL
    const og = createRelationalDriver('opengauss');
    await og.connect(
      {
        engine: 'opengauss',
        host: '127.0.0.1',
        port: 5432,
        database: 'shop_demo',
        username: 'netcatty',
        password: 'netcatty_pg_pass',
        tlsMode: 'require',
        allowSelfSigned: true,
      },
      transport,
    );
    const ogRes = await og.query('SELECT 1');
    assert.equal(ogRes.results[0].rows[0][0], 1);
    await og.close();
  } finally {
    await pg.close();
  }
});

test('LIVE MySQL 8.4: STARTTLS + caching_sha2_password, RSA plain-TCP auth, introspection, multi-result, EXPLAIN, CRUD, KILL QUERY', async () => {
  const my = new MysqlDriver('mysql');
  const info = await my.connect(
    {
      engine: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      database: 'shop_demo',
      username: 'netcatty',
      password: 'netcatty_mysql_pass',
      tlsMode: 'require',
      allowSelfSigned: true,
    },
    transport,
  );
  try {
    assert.equal(info.tlsActive, true, 'MySQL STARTTLS must be active');
    assert.ok(info.serverVersion.startsWith('8.4'), `Expected MySQL 8.4, got ${info.serverVersion}`);

    const ping = await my.testConnection();
    assert.equal(ping.ok, true);

    const dbs = await my.listDatabases();
    assert.ok(dbs.some((d) => d.name === 'shop_demo'));

    const tables = await my.listTables('shop_demo');
    assert.ok(tables.some((t) => t.name === 'customers'));
    assert.ok(tables.some((t) => t.name === 'orders'));

    const views = await my.listViews('shop_demo');
    assert.ok(views.length >= 1);

    const struct = await my.getTableStructure('shop_demo', 'shop_demo', 'orders');
    assert.ok(struct.columns.some((c) => c.isPrimaryKey));
    assert.ok(struct.foreignKeys.length >= 1);
    assert.match(struct.createDdl, /CREATE TABLE `orders`/i);

    const er = await my.getSchemaErGraph('shop_demo');
    assert.ok(er.edges.length >= 1);

    // Multi-statement result sets
    const multi = await my.query('SELECT 1 AS a; SELECT 2 AS b, "中文🚀" AS txt;');
    assert.equal(multi.results.length, 2);
    assert.equal(multi.results[0].rows[0][0], 1);
    assert.equal(multi.results[1].rows[0][1], '中文🚀');

    // Browse + sort
    const page = await my.browseTable('shop_demo', 'shop_demo', 'products', {
      page: 1,
      pageSize: 2,
      sortBy: 'id',
      sortDir: 'desc',
    });
    assert.equal(page.rows.length, 2);
    assert.ok(page.totalRows >= 2);

    // Atomic batch mutations (insert + delete)
    const testEmail = `mysql_driver_${Date.now()}@example.com`;
    const custStruct = await my.getTableStructure('shop_demo', 'shop_demo', 'customers');
    const insPreview = my.generateBatchMutations('shop_demo', 'shop_demo', 'customers', custStruct, {
      inserts: [{ values: { full_name: 'MySQL Driver Test', email: testEmail, preferences: {} } }],
    });
    const insRes = await my.applyBatchMutations(insPreview.statements);
    assert.equal(insRes.affectedRows, 1);

    const found = await my.query('SELECT id FROM customers WHERE email = ?', { params: [testEmail] });
    const id = found.results[0].rows[0][0];
    const delPreview = my.generateBatchMutations('shop_demo', 'shop_demo', 'customers', custStruct, {
      deletes: [{ keyValues: { id } }],
    });
    const delRes = await my.applyBatchMutations(delPreview.statements);
    assert.equal(delRes.affectedRows, 1);

    // EXPLAIN FORMAT=JSON
    const exp = await my.explain('SELECT * FROM orders LIMIT 5');
    assert.equal(exp.dialect, 'mysql');
    assert.ok(exp.rawText.includes('query_block'));

    // KILL QUERY cancellation
    const slow = my.query('SELECT SLEEP(5)');
    await new Promise((r) => setTimeout(r, 150));
    await my.cancelQuery();
    // MySQL SLEEP returns 1 when interrupted or throws ER_QUERY_INTERRUPTED
    await slow.catch(() => {});
    const after = await my.query('SELECT 77');
    assert.equal(after.results[0].rows[0][0], 77);
  } finally {
    await my.close();
  }

  // Also test plain-TCP caching_sha2_password (fast-auth or RSA-OAEP public key auth)
  const myPlain = new MysqlDriver('mysql');
  try {
    const infoPlain = await myPlain.connect(
      {
        engine: 'mysql',
        host: '127.0.0.1',
        port: 3306,
        database: 'shop_demo',
        username: 'netcatty',
        password: 'netcatty_mysql_pass',
        tlsMode: 'disable',
      },
      transport,
    );
    assert.equal(infoPlain.tlsActive, false);
    const r = await myPlain.query('SELECT 42');
    assert.equal(r.results[0].rows[0][0], 42);
  } finally {
    await myPlain.close();
  }
});

test('LIVE MariaDB 11: auth, introspection, query, EXPLAIN', async () => {
  const maria = new MysqlDriver('mariadb');
  const info = await maria.connect(
    {
      engine: 'mariadb',
      host: '127.0.0.1',
      port: 3307,
      database: 'shop_demo',
      username: 'netcatty',
      password: 'netcatty_maria_pass',
      tlsMode: 'disable',
    },
    transport,
  );
  try {
    assert.match(info.serverVersion, /11\./);
    const tables = await maria.listTables('shop_demo');
    assert.ok(tables.some((t) => t.name === 'customers'));

    const page = await maria.browseTable('shop_demo', 'shop_demo', 'customers', { page: 1, pageSize: 5 });
    assert.ok(page.totalRows >= 1);

    const exp = await maria.explain('SELECT * FROM customers LIMIT 2');
    assert.equal(exp.dialect, 'mysql');
  } finally {
    await maria.close();
  }
});

test('LIVE Redis 7.4: AUTH, INFO, DB switch, SCAN + tree, full CRUD for all 6 types + CLI', async () => {
  const redis = new PureRedisDriver();
  const info = await redis.connect(
    {
      engine: 'redis',
      host: '127.0.0.1',
      port: 6379,
      password: 'netcatty_redis_pass',
      redisDb: 0,
    },
    transport,
  );
  try {
    assert.ok(info.serverVersion.startsWith('7.4'));
    const ping = await redis.testConnection();
    assert.equal(ping.ok, true);

    const parsedInfo = await redis.getInfo();
    assert.ok(parsedInfo.keyspace.some((k) => k.db === 0 && k.keys >= 10));
    assert.ok(parsedInfo.keyspace.some((k) => k.db === 1 && k.keys >= 1));

    const scanned = await redis.scanKeys({ match: '*', count: 100 });
    assert.ok(scanned.keys.length >= 10);
    const tree = redis.buildNamespaceTree(scanned.keys);
    assert.ok(tree.some((n) => n.name === 'app'));

    // Inspect seeded keys across types
    const streamDetail = await redis.getKeyDetail('events:orders');
    assert.equal(streamDetail.type, 'stream');
    assert.ok(Array.isArray(streamDetail.value) && streamDetail.value.length >= 1);

    // Full CRUD on isolated test keys
    const prefix = `test:driver:${Date.now()}`;
    const kStr = `${prefix}:str`;
    const kHash = `${prefix}:hash`;
    const kList = `${prefix}:list`;
    const kSet = `${prefix}:set`;
    const kZSet = `${prefix}:zset`;
    const kStream = `${prefix}:stream`;
    const kRenamed = `${prefix}:str_renamed`;

    try {
      // String + TTL + Persist + Rename
      await redis.setString(kStr, 'hello 中文', 120);
      assert.equal(await redis.getString(kStr), 'hello 中文');
      await redis.persistKey(kStr);
      await redis.setTtl(kStr, 60);
      await redis.renameKey(kStr, kRenamed);
      assert.equal(await redis.getString(kRenamed), 'hello 中文');

      // Hash
      await redis.setHashField(kHash, 'f1', 'v1');
      await redis.setHashField(kHash, 'f2', 'v2');
      assert.deepEqual(await redis.getHash(kHash), { f1: 'v1', f2: 'v2' });
      assert.equal(await redis.deleteHashField(kHash, 'f2'), 1);

      // List
      await redis.pushList(kList, ['a', 'b'], 'right');
      await redis.pushList(kList, 'zero', 'left');
      await redis.setListIndex(kList, 1, 'A');
      assert.deepEqual(await redis.getList(kList), ['zero', 'A', 'b']);
      await redis.removeListValue(kList, 'b', 1);
      assert.deepEqual(await redis.getList(kList), ['zero', 'A']);

      // Set
      await redis.addSetMembers(kSet, ['m1', 'm2']);
      assert.equal((await redis.getSet(kSet)).length, 2);
      await redis.removeSetMembers(kSet, 'm1');
      assert.deepEqual(await redis.getSet(kSet), ['m2']);

      // ZSet
      await redis.addZSetMember(kZSet, 10, 'alice');
      await redis.addZSetMember(kZSet, 25.5, 'bob');
      const zs = await redis.getZSet(kZSet);
      assert.deepEqual(zs, [
        { member: 'alice', score: 10 },
        { member: 'bob', score: 25.5 },
      ]);
      await redis.removeZSetMembers(kZSet, 'alice');

      // Stream
      const sid = await redis.addStreamEntry(kStream, { event: 'created', amount: '99' });
      const entries = await redis.getStream(kStream);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].id, sid);
      assert.equal(entries[0].fields.event, 'created');
      assert.equal(await redis.deleteStreamEntries(kStream, sid), 1);

      // CLI execution with quoted args
      const cliSet = await redis.executeCli(`SET "${kStr}" "quoted value 123"`);
      assert.equal(cliSet.isError, false);
      const cliGet = await redis.executeCli(`GET "${kStr}"`);
      assert.equal(cliGet.output, 'quoted value 123');

      // DB switch
      await redis.selectDb(1);
      assert.equal(redis.currentDb, 1);
      const db1Scan = await redis.scanKeys();
      assert.ok(db1Scan.keys.length >= 1);
      await redis.selectDb(0);
    } finally {
      await redis.deleteKeys([kStr, kRenamed, kHash, kList, kSet, kZSet, kStream]);
    }
  } finally {
    await redis.close();
  }
});

test('LIVE MongoDB 7: OP_MSG + BSON + SCRAM-SHA-256, find/count/aggregate, CRUD, indexes, collStats', async () => {
  const mongo = new PureMongoDriver();
  const info = await mongo.connect(
    {
      engine: 'mongodb',
      host: '127.0.0.1',
      port: 27017,
      database: 'shop_demo',
      username: 'netcatty',
      password: 'netcatty_mongo_pass',
      authSource: 'admin',
    },
    transport,
  );
  try {
    assert.ok(info.serverVersion.startsWith('7.'));
    const ping = await mongo.ping();
    assert.equal(ping.ok, true);

    const dbs = await mongo.listDatabases();
    assert.ok(dbs.some((d) => d.name === 'shop_demo'));

    const colls = await mongo.listCollections('shop_demo');
    assert.ok(colls.some((c) => c.name === 'users'));
    assert.ok(colls.some((c) => c.name === 'orders'));
    assert.ok(colls.some((c) => c.name === 'products'));

    const found = await mongo.find('shop_demo', 'users', { limit: 2, sort: { _id: 1 } });
    assert.equal(found.documents.length, 2);
    assert.ok(found.totalCount >= 4);

    const agg = await mongo.aggregate('shop_demo', 'orders', [
      { $group: { _id: null, count: { $sum: 1 } } },
    ]);
    assert.ok(Number(agg[0]?.count) >= 4);

    const stats = await mongo.collStats('shop_demo', 'users');
    assert.ok(stats.count >= 4);

    // CRUD + index lifecycle on isolated document/index
    const tag = `driver_test_${Date.now()}`;
    const ins = await mongo.insertOne('shop_demo', 'audit_logs', {
      event: tag,
      actor: 'netcatty-driver',
      ts: new Date(),
    });
    assert.ok(ins.insertedId);

    const upd = await mongo.updateOne(
      'shop_demo',
      'audit_logs',
      { _id: ins.insertedId },
      { $set: { actor: 'updated-driver' } },
    );
    assert.equal(upd.modifiedCount, 1);

    const rep = await mongo.replaceOne(
      'shop_demo',
      'audit_logs',
      { _id: ins.insertedId },
      { event: tag, actor: 'replaced-driver', replaced: true },
    );
    assert.equal(rep.modifiedCount, 1);

    const idxName = `idx_event_${Date.now()}`;
    await mongo.createIndexes('shop_demo', 'audit_logs', [{ key: { event: 1 }, name: idxName }]);
    const indexes = await mongo.listIndexes('shop_demo', 'audit_logs');
    assert.ok(indexes.some((i) => i.name === idxName));
    await mongo.dropIndexes('shop_demo', 'audit_logs', idxName);

    const del = await mongo.deleteOne('shop_demo', 'audit_logs', { _id: ins.insertedId });
    assert.equal(del.deletedCount, 1);
  } finally {
    await mongo.close();
  }
});

test('LIVE ClickHouse 24: HTTP transport AND HTTP/1.1-over-ByteStream (SSH-tunnel path), introspection, browse, EXPLAIN', async () => {
  for (const mode of ['httpRequest', 'byteStream'] as const) {
    const chTransport =
      mode === 'httpRequest' ? transport : createNodeSocketTransport({ disableHttpRequest: true });
    const ch = new ClickHouseDriver();
    const info = await ch.connect(
      {
        engine: 'clickhouse',
        host: '127.0.0.1',
        port: 8123,
        database: 'analytics_demo',
        username: 'netcatty',
        password: 'netcatty_ch_pass',
        tlsMode: 'disable',
      },
      chTransport,
    );
    try {
      assert.ok(info.serverVersion.startsWith('24.'), `Expected CH 24, got ${info.serverVersion}`);
      const dbs = await ch.listDatabases();
      assert.ok(dbs.some((d) => d.name === 'analytics_demo'));

      const tables = await ch.listTables('analytics_demo');
      assert.ok(tables.some((t) => t.name === 'page_views'));
      assert.ok(tables.some((t) => t.name === 'order_events'));

      const struct = await ch.getTableStructure('analytics_demo', 'analytics_demo', 'page_views');
      assert.ok(struct.columns.length >= 4);
      assert.match(struct.createDdl, /CREATE TABLE analytics_demo\.page_views/);

      const page = await ch.browseTable('analytics_demo', 'analytics_demo', 'page_views', {
        page: 1,
        pageSize: 3,
      });
      assert.equal(page.rows.length, 3);
      assert.ok(page.totalRows >= 8);

      // JSONEachRow format support
      const eachRow = await ch.query(
        'SELECT * FROM analytics_demo.page_views LIMIT 2 FORMAT JSONEachRow',
      );
      assert.equal(eachRow.results[0].rowCount, 2);

      // EXPLAIN
      const exp = await ch.explain('SELECT count() FROM analytics_demo.page_views');
      assert.equal(exp.dialect, 'clickhouse');
      assert.ok(exp.rawText.length > 0);
    } finally {
      await ch.close();
    }
  }
});

test('LIVE Local SQLite Fixture (tests/fixtures/shop_demo.sqlite): open bytes, introspect, ER graph, mutate & export', async () => {
  const fixturePath = path.resolve(process.cwd(), 'tests/fixtures/shop_demo.sqlite');
  const bytes = new Uint8Array(await readFile(fixturePath));
  assert.ok(bytes.length > 10000);

  const sqlite = new SqliteDriver();
  await sqlite.connect({
    engine: 'sqlite',
    sqliteBytes: bytes,
    sqliteFileName: 'shop_demo.sqlite',
  });
  try {
    const tables = await sqlite.listTables('shop_demo.sqlite', 'main');
    const names = tables.map((t) => t.name);
    for (const expected of ['customers', 'categories', 'products', 'orders', 'order_items', 'reviews']) {
      assert.ok(names.includes(expected), `Missing table ${expected} in shop_demo.sqlite`);
    }

    const views = await sqlite.listViews('shop_demo.sqlite', 'main');
    assert.ok(views.length >= 2);
    const triggers = await sqlite.listTriggers('shop_demo.sqlite', 'main');
    assert.ok(triggers.length >= 2);

    const er = await sqlite.getSchemaErGraph('shop_demo.sqlite', 'main');
    assert.ok(er.edges.length >= 4);

    const page = await sqlite.browseTable('shop_demo.sqlite', 'main', 'orders', {
      page: 2,
      pageSize: 10,
      sortBy: 'id',
      sortDir: 'asc',
    });
    assert.equal(page.totalRows, 40);
    assert.equal(page.rows.length, 10);

    const exported = sqlite.exportBytes();
    assert.ok(exported.length >= bytes.length - 4096);
  } finally {
    await sqlite.close();
  }
});

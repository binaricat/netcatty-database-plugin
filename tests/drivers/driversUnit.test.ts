import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBatchMutations,
  buildCreateTableDdl,
  buildRedisNamespaceTree,
  buildSqliteTableRebuildDdl,
  createDriver,
  createRelationalDriver,
  decodePgValue,
  md5Hex,
  parseRedisInfo,
  resolveEngineFamily,
  ScramSha256Session,
  SqliteDriver,
  tokenizeRedisCli,
} from '../../src/drivers/index';

test('resolveEngineFamily maps all PG-family, MySQL-family, and NoSQL aliases', () => {
  for (const pg of ['postgres', 'opengauss', 'gaussdb', 'kingbase', 'highgo', 'vastbase', 'uxdb'] as const) {
    assert.equal(resolveEngineFamily(pg), 'postgres');
    assert.equal(createRelationalDriver(pg).family, 'postgres');
  }
  for (const my of ['mysql', 'mariadb', 'tidb', 'oceanbase', 'goldendb'] as const) {
    assert.equal(resolveEngineFamily(my), 'mysql');
    assert.equal(createRelationalDriver(my).family, 'mysql');
  }
  assert.equal(createDriver('sqlite').family, 'sqlite');
  assert.equal(createDriver('clickhouse').family, 'clickhouse');
  assert.equal(createDriver('redis').family, 'redis');
  assert.equal(createDriver('mongodb').family, 'mongodb');
});

test('crypto: RFC 1321 MD5 test vectors & SCRAM-SHA-256 client message', () => {
  assert.equal(md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(md5Hex('message digest'), 'f96b697d7cb7938d525a2f31aaf161d0');

  const scram = new ScramSha256Session('user=1,2', 'secret', 'fixednonce1234567890');
  assert.equal(scram.clientFirstMessage(), 'n,,n=user=3D1=2C2,r=fixednonce1234567890');
});

test('PostgreSQL OID decoder handles rich types including arrays, jsonb, bytea, bool', () => {
  const te = new TextEncoder();
  assert.equal(decodePgValue(16, te.encode('t')), true);
  assert.equal(decodePgValue(16, te.encode('f')), false);
  assert.equal(decodePgValue(23, te.encode('42')), 42);
  assert.equal(decodePgValue(701, te.encode('3.14')), 3.14);
  assert.deepEqual(decodePgValue(3802, te.encode('{"k":1}')), { k: 1 });
  assert.deepEqual(decodePgValue(1007, te.encode('{1,2,3}')), [1, 2, 3]);
  assert.deepEqual(decodePgValue(1009, te.encode('{"a,b",NULL,c}')), ['a,b', null, 'c']);
  assert.deepEqual(decodePgValue(17, te.encode('\\xdeadbeef')), new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  assert.equal(decodePgValue(25, null), null);
});

test('Redis CLI tokenizer, INFO parser, and namespace tree builder', () => {
  assert.deepEqual(
    tokenizeRedisCli(`SET "user:1:bio" 'hello world' EX 60`),
    ['SET', 'user:1:bio', 'hello world', 'EX', '60'],
  );
  assert.deepEqual(
    tokenizeRedisCli(`HSET my:hash field "line1\\nline2"`),
    ['HSET', 'my:hash', 'field', 'line1\nline2'],
  );

  const info = parseRedisInfo(
    '# Server\r\nredis_version:7.4.2\r\nuptime_in_seconds:1200\r\n# Clients\r\nconnected_clients:3\r\n# Memory\r\nused_memory:1048576\r\nused_memory_human:1.00M\r\n# Keyspace\r\ndb0:keys=12,expires=4,avg_ttl=60000\r\ndb1:keys=3,expires=0,avg_ttl=0\r\n',
  );
  assert.equal(info.serverVersion, '7.4.2');
  assert.equal(info.usedMemoryBytes, 1048576);
  assert.equal(info.keyspace.length, 2);
  assert.equal(info.keyspace[0].keys, 12);

  const tree = buildRedisNamespaceTree([
    { key: 'app:user:1', type: 'hash', ttlMs: -1 },
    { key: 'app:user:2', type: 'hash', ttlMs: 5000 },
    { key: 'app:config:theme', type: 'string', ttlMs: -1 },
    { key: 'standalone', type: 'string', ttlMs: -1 },
  ]);
  assert.equal(tree.length, 2);
  assert.equal(tree[0].name, 'app');
  assert.equal(tree[0].keyCount, 3);
  assert.equal(tree[1].name, 'standalone');
  assert.equal(tree[1].isLeaf, true);
});

test('SQLite in-memory driver full lifecycle: DDL, CRUD, transactions, EXPLAIN, rebuild ALTER, export/reload', async () => {
  const driver = new SqliteDriver();
  const conn = await driver.connect({ engine: 'sqlite', sqliteSeedDemo: true });
  assert.equal(conn.family, 'sqlite');
  assert.ok(conn.serverVersion.startsWith('SQLite'));

  const tables = await driver.listTables('main', 'main');
  assert.ok(tables.some((t) => t.name === 'customers'));
  assert.ok(tables.some((t) => t.name === 'orders'));

  const views = await driver.listViews('main', 'main');
  assert.ok(views.some((v) => v.name === 'customer_order_summary'));

  const er = await driver.getSchemaErGraph('main', 'main');
  assert.ok(er.edges.some((e) => e.sourceTable === 'orders' && e.targetTable === 'customers'));

  // Multi-statement query
  const multi = await driver.query('SELECT COUNT(*) AS c FROM customers; SELECT name FROM customers ORDER BY id LIMIT 2;');
  assert.equal(multi.results.length, 2);
  assert.equal(multi.results[0].rows[0][0], 3);
  assert.equal(multi.results[1].rows[1][0], '林徽因');

  // Batch mutations + atomic apply
  const custStruct = await driver.getTableStructure('main', 'main', 'customers');
  const preview = driver.generateBatchMutations('main', 'main', 'customers', custStruct, {
    inserts: [{ values: { name: 'Alan Turing', email: 'alan@example.com', tier: 'enterprise' } }],
    updates: [{ keyValues: { id: 1 }, changes: { tier: 'vip' } }],
  });
  assert.equal(preview.statements.length, 2);
  const applied = await driver.applyBatchMutations(preview.statements);
  assert.equal(applied.applied, 2);

  // Browse table with pagination & filter
  const page = await driver.browseTable('main', 'main', 'customers', {
    page: 1,
    pageSize: 2,
    sortBy: 'id',
    sortDir: 'asc',
  });
  assert.equal(page.totalRows, 4);
  assert.equal(page.rows.length, 2);

  // Explain plan
  const plan = await driver.explain('SELECT * FROM orders WHERE customer_id = 1');
  assert.equal(plan.dialect, 'sqlite');
  assert.ok(plan.rawText.includes('idx_orders_customer'));

  // SQLite table rebuild ALTER TABLE
  const rebuildSql = buildSqliteTableRebuildDdl('main', 'main', 'products', await driver.getTableStructure('main', 'main', 'products'), {
    alterColumns: [{ name: 'price', dataType: 'NUMERIC', nullable: false }],
    addColumns: [{ name: 'currency', dataType: 'TEXT', nullable: false, defaultValue: "'USD'" }],
  });
  assert.ok(rebuildSql.some((s) => s.includes('CREATE TABLE')));
  assert.ok(rebuildSql.some((s) => s.includes('INSERT INTO')));
  await driver.query(rebuildSql.join('\n'));
  const rebuiltStruct = await driver.getTableStructure('main', 'main', 'products');
  assert.ok(rebuiltStruct.columns.some((c) => c.name === 'currency'));

  // Export bytes & reload into a fresh SqliteDriver
  const exported = driver.exportBytes();
  assert.ok(exported.length > 4096);
  await driver.close();

  const reloaded = new SqliteDriver();
  await reloaded.connect({ engine: 'sqlite', sqliteBytes: exported, sqliteFileName: 'roundtrip.sqlite' });
  const check = await reloaded.query("SELECT name, tier FROM customers WHERE email = 'alan@example.com'");
  assert.equal(check.results[0].rows[0][0], 'Alan Turing');
  assert.equal(check.results[0].rows[0][1], 'enterprise');

  const dump = await reloaded.dumpDatabaseSql('main', 'main', ['customers'], true);
  assert.match(dump, /CREATE TABLE/);
  assert.match(dump, /Alan Turing/);
  await reloaded.close();
});

test('Dialect DDL & Batch Mutation generators quote identifiers properly', () => {
  const pgDdl = buildCreateTableDdl('postgres', 'shop', 'public', {
    name: 'user_notes',
    columns: [
      { name: 'id', dataType: 'integer', isPrimaryKey: true, isAutoIncrement: true },
      { name: 'body', dataType: 'text', nullable: false },
    ],
  });
  assert.match(pgDdl, /CREATE TABLE "public"\."user_notes"/);
  assert.match(pgDdl, /"id" SERIAL PRIMARY KEY/);

  const myPreview = buildBatchMutations(
    'mysql',
    'shop',
    'shop',
    'items',
    {
      database: 'shop',
      schema: 'shop',
      table: 'items',
      columns: [
        { name: 'id', dataType: 'int', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true },
        { name: 'title', dataType: 'varchar(100)', nullable: false, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
      ],
      indexes: [],
      foreignKeys: [],
      checkConstraints: [],
      createDdl: '',
    },
    {
      deletes: [{ keyValues: { id: 7 } }],
    },
  );
  assert.equal(myPreview.statements[0], 'DELETE FROM `shop`.`items` WHERE `id` = 7;');
});

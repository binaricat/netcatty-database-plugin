import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { register } from 'tsx/esm/api';

register();

const { BSON, Binary, ObjectId } = await import('bson');
const {
  signAwsV4Request,
  canonicalizeUri,
  canonicalizeQueryString,
  deriveSigningKey,
  toHex,
} = await import('../src/drivers/awsSigV4.ts');
const {
  SearchVectorDriver,
  marshallDynamoItem,
  unmarshallDynamoItem,
} = await import('../src/drivers/searchVectorDriver.ts');
const {
  KvHttpDriver,
  computeSimpleLineDiff,
  flattenEtcdV2Nodes,
} = await import('../src/drivers/kvHttpDriver.ts');
const {
  PureRedisDriver,
  parseRedisSlowlog,
  parseRedisClientList,
  parseRedisStreamGroups,
  parseRedisStreamConsumers,
  parseRedisStreamPending,
  parseRedisCommandStats,
  decodeRedisValueCodec,
} = await import('../src/drivers/redisDriver.ts');
const {
  PureMongoDriver,
  summarizeMongoExplain,
  parseMongoBulkDocuments,
} = await import('../src/drivers/mongoDriver.ts');
const {
  Neo4jDriver,
  buildCreateNodeCypher,
  buildUpdateNodeCypher,
  buildDeleteNodeCypher,
  buildCreateRelationshipCypher,
  buildUpdateRelationshipCypher,
  buildDeleteRelationshipCypher,
  buildExplainCypher,
  normalizeCypherPlanNode,
} = await import('../src/drivers/neo4jDriver.ts');

const te = new TextEncoder();
const td = new TextDecoder('utf-8');

function createMockHttpTransport(handler) {
  const requests = [];
  const transport = {
    async connect() {
      throw new Error('Unexpected raw connect in mock HTTP transport');
    },
    async httpRequest(req) {
      const parsed = new URL(req.url);
      const bodyStr =
        req.body === undefined
          ? ''
          : typeof req.body === 'string'
            ? req.body
            : td.decode(req.body);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers ?? {})) {
        headers[k.toLowerCase()] = v;
      }
      const rec = {
        method: req.method,
        url: req.url,
        path: `${parsed.pathname}${parsed.search}`,
        headers,
        body: bodyStr,
      };
      requests.push(rec);
      const res = await handler(rec);
      const status = res.status ?? 200;
      const respHeaders = {};
      for (const [k, v] of Object.entries(res.headers ?? {})) {
        respHeaders[k.toLowerCase()] = v;
      }
      const bodyBytes =
        res.json !== undefined
          ? te.encode(JSON.stringify(res.json))
          : te.encode(res.text ?? '');
      return { status, headers: respHeaders, body: bodyBytes };
    },
  };
  return { transport, requests };
}

/* ============================================================================
 * 1. AWS SigV4 Pure-TS WebCrypto Signer (Official AWS Test Vector)
 * ============================================================================ */

test('AWS SigV4 matches official IAM ListUsers reference vector', async () => {
  // Reference vector from AWS SigV4 documentation:
  // https://docs.aws.amazon.com/general/latest/gr/sigv4-signed-request-examples.html
  const result = await signAwsV4Request({
    method: 'GET',
    url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
    headers: {
      Host: 'iam.amazonaws.com',
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      'X-Amz-Date': '20150830T123600Z',
    },
    body: '',
    region: 'us-east-1',
    service: 'iam',
    credentials: {
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    },
    date: new Date('2015-08-30T12:36:00Z'),
  });

  const expectedKey = 'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9';
  const actualKey = toHex(
    await deriveSigningKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830', 'us-east-1', 'iam'),
  );
  assert.equal(actualKey, expectedKey);
  assert.equal(
    result.signature,
    '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
  );
  assert.equal(
    result.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, ' +
      'SignedHeaders=content-type;host;x-amz-date, ' +
      'Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
  );
  assert.equal(canonicalizeUri('/a b/c'), '/a%20b/c');
  assert.equal(canonicalizeQueryString('?b=2&a=1&a=0'), 'a=0&a=1&b=2');
});

/* ============================================================================
 * 2. Search / Vector Engines: Solr, Milvus, DynamoDB, HBase, ES/OS, Meilisearch
 * ============================================================================ */

test('Solr driver handles probe, listCores, schema, select, upsert, delete & deleteByQuery', async () => {
  const { transport, requests } = createMockHttpTransport((req) => {
    if (req.path === '/solr/admin/info/system?wt=json') {
      return { json: { lucene: { 'solr-spec-version': '9.6.1' } } };
    }
    if (req.path === '/solr/admin/cores?action=STATUS&wt=json') {
      return {
        json: {
          status: {
            books: { name: 'books', index: { numDocs: 42, sizeInBytes: 8192 } },
          },
        },
      };
    }
    if (req.path === '/solr/books/schema?wt=json') {
      return { json: { schema: { name: 'default-config', uniqueKey: 'id' } } };
    }
    if (req.path === '/solr/books/select?wt=json' && req.method === 'POST') {
      return {
        json: {
          response: {
            numFound: 1,
            docs: [{ id: 'b1', title: 'Dune', score: 1.5 }],
          },
        },
      };
    }
    if (req.path === '/solr/books/update/json/docs?commit=true&wt=json') {
      return { json: { responseHeader: { status: 0 } } };
    }
    if (req.path === '/solr/books/update?commit=true&wt=json') {
      return { json: { responseHeader: { status: 0 } } };
    }
    return { status: 404, text: `Unexpected Solr path ${req.path}` };
  });

  const driver = new SearchVectorDriver('solr');
  const info = await driver.connect({ engine: 'solr', host: '127.0.0.1', port: 8983 }, transport);
  assert.equal(info.serverVersion, 'Solr 9.6.1');

  const cores = await driver.listIndices();
  assert.equal(cores.length, 1);
  assert.equal(cores[0].name, 'books');
  assert.equal(cores[0].docCount, 42);

  const schema = await driver.getIndexSchema('books');
  assert.equal(schema.schema.uniqueKey, 'id');

  const res = await driver.search('books', 'title:Dune', { from: 0, size: 10 });
  assert.equal(res.totalCount, 1);
  assert.equal(res.documents[0].id, 'b1');
  assert.equal(res.documents[0].source.title, 'Dune');

  const up = await driver.upsertDocument('books', { title: 'Foundation' }, 'b2');
  assert.equal(up.id, 'b2');
  await driver.deleteDocument('books', 'b2');
  await driver.deleteByQuery('books', { query: '*:*' });
  assert.ok(requests.some((r) => r.path.includes('/solr/books/update?commit=true')));
});

test('Milvus REST v2 driver handles databases, collections CRUD, vector search, query & errors', async () => {
  const { transport, requests } = createMockHttpTransport((req) => {
    if (req.path === '/v2/vectordb/databases/list') {
      return { json: { code: 0, data: ['default'] } };
    }
    if (req.path === '/v2/vectordb/collections/list') {
      return { json: { code: 0, data: ['embeddings'] } };
    }
    if (req.path === '/v2/vectordb/collections/describe') {
      return { json: { code: 0, data: { collectionName: 'embeddings', fields: [] } } };
    }
    if (req.path === '/v2/vectordb/collections/create') {
      return { json: { code: 0, data: {} } };
    }
    if (req.path === '/v2/vectordb/collections/rename') {
      return { json: { code: 0, data: {} } };
    }
    if (req.path === '/v2/vectordb/entities/search') {
      return { json: { code: 0, data: [{ id: 101, distance: 0.98, text: 'hello' }] } };
    }
    if (req.path === '/v2/vectordb/entities/query') {
      return { json: { code: 0, data: [{ id: 102, text: 'world' }] } };
    }
    if (req.path === '/v2/vectordb/entities/insert') {
      return { json: { code: 0, data: { insertCount: 1 } } };
    }
    if (req.path === '/v2/vectordb/entities/delete') {
      return { json: { code: 0, data: {} } };
    }
    if (req.path === '/v2/vectordb/collections/drop') {
      return { json: { code: 100, message: 'collection locked' } };
    }
    return { status: 404, text: `Unexpected Milvus path ${req.path}` };
  });

  const driver = new SearchVectorDriver('milvus');
  const info = await driver.connect(
    { engine: 'milvus', host: '127.0.0.1', port: 19530, apiKey: 'root:Milvus' },
    transport,
  );
  assert.equal(info.serverVersion, 'Milvus REST v2');
  assert.equal(requests[0].headers['authorization'], 'Bearer root:Milvus');

  const cols = await driver.listIndices();
  assert.deepEqual(cols.map((c) => c.name), ['embeddings']);

  const vecRes = await driver.search('embeddings', { vector: [0.1, 0.2, 0.3] });
  assert.equal(vecRes.documents[0].id, '101');
  assert.equal(vecRes.documents[0].score, 0.98);

  const qRes = await driver.search('embeddings', 'id > 100');
  assert.equal(qRes.documents[0].id, '102');

  await driver.upsertDocument('embeddings', { vector: [0.1, 0.2], text: 'new' }, '200');
  await driver.deleteDocument('embeddings', '200');
  await driver.renameIndex('embeddings', 'embeddings_v2');
  await assert.rejects(() => driver.deleteIndex('embeddings_v2'), /collection locked/);
});

test('DynamoDB driver signs SigV4 requests and marshalls/unmarshalls items', async () => {
  const marshalled = marshallDynamoItem({ id: 'u1', count: 5, active: true, tags: ['a', 'b'] });
  assert.deepEqual(marshalled, {
    id: { S: 'u1' },
    count: { N: '5' },
    active: { BOOL: true },
    tags: { L: [{ S: 'a' }, { S: 'b' }] },
  });
  assert.deepEqual(unmarshallDynamoItem(marshalled), {
    id: 'u1',
    count: 5,
    active: true,
    tags: ['a', 'b'],
  });

  const { transport, requests } = createMockHttpTransport((req) => {
    const target = req.headers['x-amz-target'];
    assert.equal(req.headers['content-type'], 'application/x-amz-json-1.0');
    assert.match(req.headers['authorization'], /^AWS4-HMAC-SHA256 Credential=AKIA123\/.*\/us-west-2\/dynamodb\/aws4_request/);
    assert.ok(req.headers['x-amz-date']);

    if (target === 'DynamoDB_20120810.ListTables') {
      return { json: { TableNames: ['Orders'] } };
    }
    if (target === 'DynamoDB_20120810.DescribeTable') {
      return {
        json: {
          Table: {
            TableName: 'Orders',
            KeySchema: [{ AttributeName: 'orderId', KeyType: 'HASH' }],
            AttributeDefinitions: [{ AttributeName: 'orderId', AttributeType: 'S' }],
          },
        },
      };
    }
    if (target === 'DynamoDB_20120810.Scan') {
      return {
        json: {
          Count: 1,
          Items: [{ orderId: { S: 'ord-1' }, total: { N: '99.5' } }],
        },
      };
    }
    if (target === 'DynamoDB_20120810.GetItem') {
      return { json: { Item: { orderId: { S: 'ord-1' }, total: { N: '99.5' } } } };
    }
    if (target === 'DynamoDB_20120810.PutItem' || target === 'DynamoDB_20120810.DeleteItem') {
      return { json: {} };
    }
    return { status: 400, text: `Unexpected target ${target}` };
  });

  const driver = new SearchVectorDriver('dynamodb');
  const info = await driver.connect(
    {
      engine: 'dynamodb',
      host: 'dynamodb.us-west-2.amazonaws.com',
      port: 443,
      region: 'us-west-2',
      username: 'AKIA123',
      password: 'SECRET456',
    },
    transport,
  );
  assert.equal(info.serverVersion, 'DynamoDB (us-west-2)');

  const tables = await driver.listIndices();
  assert.equal(tables[0].name, 'Orders');
  await driver.getIndexSchema('Orders');

  const scanRes = await driver.search('Orders', '{}');
  assert.equal(scanRes.documents[0].id, 'ord-1');
  assert.equal(scanRes.documents[0].source.total, 99.5);

  const getRes = await driver.search('Orders', { Key: { orderId: 'ord-1' } });
  assert.equal(getRes.documents[0].source.orderId, 'ord-1');

  await driver.upsertDocument('Orders', { orderId: 'ord-2', total: 10 });
  await driver.deleteDocument('Orders', 'ord-2');
  const delReq = requests[requests.length - 1];
  assert.equal(delReq.headers['x-amz-target'], 'DynamoDB_20120810.DeleteItem');
  assert.deepEqual(JSON.parse(delReq.body), {
    TableName: 'Orders',
    Key: { orderId: { S: 'ord-2' } },
  });
});

test('HBase REST/Stargate driver handles tables, schema, scanner Base64 decode, put & delete', async () => {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const { transport, requests } = createMockHttpTransport((req) => {
    if (req.method === 'GET' && req.path === '/') {
      return { json: { table: [{ name: 'users' }] } };
    }
    if (req.method === 'GET' && req.path === '/users/schema') {
      return { json: { name: 'users', ColumnSchema: [{ name: 'cf' }] } };
    }
    if (req.method === 'PUT' && req.path === '/users/scanner') {
      return { status: 201, headers: { Location: '/users/scanner/scan-1' }, text: '' };
    }
    if (req.method === 'GET' && req.path === '/users/scanner/scan-1') {
      return {
        json: {
          Row: [
            {
              key: b64('row-1'),
              Cell: [{ column: b64('cf:name'), $: b64('Ada') }],
            },
          ],
        },
      };
    }
    if (req.method === 'DELETE' && req.path === '/users/scanner/scan-1') {
      return { status: 200, text: '' };
    }
    if (req.method === 'PUT' && req.path === '/users/row-2') {
      return { status: 200, text: '' };
    }
    if (req.method === 'DELETE' && req.path === '/users/row-2') {
      return { status: 200, text: '' };
    }
    return { status: 404, text: `Unexpected HBase ${req.method} ${req.path}` };
  });

  const driver = new SearchVectorDriver('hbase');
  await driver.connect({ engine: 'hbase', host: '127.0.0.1', port: 8080 }, transport);
  const tables = await driver.listIndices();
  assert.equal(tables[0].name, 'users');

  const scan = await driver.search('users', '');
  assert.equal(scan.documents.length, 1);
  assert.equal(scan.documents[0].id, 'row-1');
  assert.equal(scan.documents[0].source['cf:name'], 'Ada');
  assert.ok(requests.some((r) => r.method === 'DELETE' && r.path === '/users/scanner/scan-1'));

  await driver.upsertDocument('users', { 'cf:name': 'Grace' }, 'row-2');
  await driver.deleteDocument('users', 'row-2');
});

test('Elasticsearch & Meilisearch specialist admin endpoints work cleanly', async () => {
  const { transport } = createMockHttpTransport((req) => {
    if (req.path === '/') return { json: { version: { number: '8.14.0' } } };
    if (req.path === '/_cluster/health') return { json: { status: 'green', number_of_nodes: 3 } };
    if (req.path === '/_cat/nodes?format=json&v=true') return { json: [{ name: 'es-1', ip: '10.0.0.1' }] };
    if (req.path === '/logs/_settings') return { json: { logs: { settings: { index: { number_of_shards: '1' } } } } };
    if (req.path === '/logs/_stats') return { json: { _all: { total: { docs: { count: 12 } } } } };
    if (req.path === '/logs/_alias') return { json: { logs: { aliases: { logs_live: {} } } } };
    if (req.path === '/_aliases' && req.method === 'POST') return { json: { acknowledged: true } };
    if (req.path === '/logs/_delete_by_query?refresh=true') return { json: { deleted: 5 } };
    if (req.path === '/logs/_search' && req.method === 'POST') {
      const body = JSON.parse(req.body);
      assert.equal(body.profile, true);
      return { json: { hits: { total: 1, hits: [] }, profile: { shards: [{ id: '0' }] } } };
    }
    return { status: 404, text: req.path };
  });

  const es = new SearchVectorDriver('elasticsearch');
  await es.connect({ engine: 'elasticsearch', host: '127.0.0.1', port: 9200 }, transport);
  assert.equal((await es.getClusterHealth()).status, 'green');
  assert.equal((await es.getClusterNodes()).length, 1);
  assert.ok((await es.getIndexSettings('logs')).logs);
  assert.ok((await es.getIndexStats('logs'))._all);
  assert.ok((await es.getIndexAliases('logs')).logs);
  assert.equal((await es.updateIndexAliases([{ add: { index: 'logs', alias: 'a1' } }])).acknowledged, true);
  assert.equal((await es.deleteByQuery('logs', { match_all: {} })).deleted, 5);
  const prof = await es.profileSearch('logs', '*');
  assert.ok(prof.profile);

  const meiliMock = createMockHttpTransport((req) => {
    if (req.path === '/version') return { json: { pkgVersion: '1.9.0' } };
    if (req.path.startsWith('/tasks')) return { json: { results: [{ uid: 7, status: 'succeeded', type: 'documentAdditionOrUpdate' }] } };
    if (req.path.startsWith('/keys')) return { json: { results: [{ uid: 'k1', name: 'Search Key', actions: ['search'] }] } };
    return { status: 404, text: req.path };
  });
  const meili = new SearchVectorDriver('meilisearch');
  await meili.connect({ engine: 'meilisearch', host: '127.0.0.1', port: 7700, apiKey: 'master' }, meiliMock.transport);
  assert.equal((await meili.listMeiliTasks())[0].uid, 7);
  assert.equal((await meili.listMeiliKeys())[0].name, 'Search Key');
});

/* ============================================================================
 * 3. KV / Config Registry: etcd-v2, etcd v3, Consul, Nacos
 * ============================================================================ */

test('KV driver supports etcd-v2, etcd v3 admin, Consul services/health/sessions/ACL & Nacos history/diff/namespaces', async () => {
  // etcd-v2
  const v2Mock = createMockHttpTransport((req) => {
    if (req.path === '/version') return { json: { etcdserver: '2.3.8' } };
    if (req.path === '/v2/keys/?recursive=true') {
      return {
        json: {
          node: {
            dir: true,
            nodes: [
              { key: '/app', dir: true, nodes: [{ key: '/app/mode', value: 'prod', modifiedIndex: 12 }] },
            ],
          },
        },
      };
    }
    if (req.path === '/v2/keys/app/mode' && req.method === 'GET') {
      return { json: { node: { key: '/app/mode', value: 'prod', modifiedIndex: 12 } } };
    }
    if (req.path === '/v2/keys/app/mode' && (req.method === 'PUT' || req.method === 'DELETE')) {
      return { json: { action: 'set' } };
    }
    if (req.path === '/v2/members') {
      return { json: { members: [{ id: 'm1', name: 'node1', clientURLs: ['http://127.0.0.1:2379'] }] } };
    }
    return { status: 404, text: req.path };
  });
  const etcdV2 = new KvHttpDriver('etcd-v2');
  await etcdV2.connect({ engine: 'etcd-v2', host: '127.0.0.1', port: 2379 }, v2Mock.transport);
  const v2Keys = await etcdV2.listKeys('');
  assert.equal(v2Keys.length, 1);
  assert.equal(v2Keys[0].key, '/app/mode');
  assert.equal(v2Keys[0].value, 'prod');
  assert.equal((await etcdV2.getKey('/app/mode')).revision, 12);
  await etcdV2.putKey('/app/mode', 'staging');
  await etcdV2.deleteKey('/app/mode');
  assert.equal((await etcdV2.listMembers())[0].name, 'node1');
  assert.equal(flattenEtcdV2Nodes({ dir: true, nodes: [{ key: '/a', value: '1' }] }).length, 1);

  // etcd v3 leases & RBAC
  const v3Mock = createMockHttpTransport((req) => {
    if (req.path === '/version') return { json: { etcdserver: '3.5.14' } };
    if (req.path === '/v3/cluster/member/list') return { json: { members: [{ ID: '1', name: 'etcd0' }] } };
    if (req.path === '/v3/lease/leases') return { json: { leases: [{ ID: '999' }] } };
    if (req.path === '/v3/lease/timetolive') {
      return { json: { TTL: 45, grantedTTL: 60, keys: [Buffer.from('/lock/1').toString('base64')] } };
    }
    if (req.path === '/v3/lease/revoke') return { json: {} };
    if (req.path === '/v3/auth/user/list') return { json: { users: ['root', 'app'] } };
    if (req.path === '/v3/auth/role/list') return { json: { roles: ['root', 'readonly'] } };
    return { status: 404, text: req.path };
  });
  const etcdV3 = new KvHttpDriver('etcd');
  await etcdV3.connect({ engine: 'etcd', host: '127.0.0.1', port: 2379 }, v3Mock.transport);
  assert.equal((await etcdV3.listMembers())[0].name, 'etcd0');
  const leases = await etcdV3.listLeases();
  assert.equal(leases[0].ttlSeconds, 45);
  assert.deepEqual(leases[0].keys, ['/lock/1']);
  await etcdV3.revokeLease('999');
  const rbac = await etcdV3.listEtcdRbac();
  assert.deepEqual(rbac.users, ['root', 'app']);

  // Consul services, health, sessions, ACL
  const consulMock = createMockHttpTransport((req) => {
    if (req.path === '/v1/agent/self') return { json: { Config: { Version: '1.18.0' } } };
    if (req.path === '/v1/catalog/services') return { json: { web: ['v1'], db: ['primary'] } };
    if (req.path === '/v1/health/state/any') {
      return { json: [{ CheckID: 'serfHealth', Name: 'Serf', Status: 'passing', Node: 'n1' }] };
    }
    if (req.path === '/v1/session/list') {
      return { json: [{ ID: 'sess-1', Name: 'leader-lock', Node: 'n1', TTL: '30s' }] };
    }
    if (req.path === '/v1/session/destroy/sess-1' && req.method === 'PUT') return { text: 'true' };
    if (req.path === '/v1/acl/tokens') return { json: [{ AccessorID: 'tok-1' }] };
    if (req.path === '/v1/acl/policies') return { json: [{ Name: 'global-management' }] };
    return { status: 404, text: req.path };
  });
  const consul = new KvHttpDriver('consul');
  await consul.connect({ engine: 'consul', host: '127.0.0.1', port: 8500 }, consulMock.transport);
  assert.equal((await consul.listServices()).length, 2);
  assert.equal((await consul.listConsulHealthChecks())[0].status, 'passing');
  assert.equal((await consul.listConsulSessions())[0].id, 'sess-1');
  await consul.destroyConsulSession('sess-1');
  assert.equal((await consul.getConsulAclOverview()).policies.length, 1);

  // Nacos history, diff, services, namespaces CRUD
  const nacosMock = createMockHttpTransport((req) => {
    if (req.path.startsWith('/nacos/v1/console/server/state')) return { json: { version: '2.3.2' } };
    if (req.path.startsWith('/nacos/v1/cs/history')) {
      return {
        json: {
          pageItems: [{ id: 10, dataId: 'app.yaml', group: 'DEFAULT_GROUP', content: 'port: 8080\n', opType: 'U' }],
        },
      };
    }
    if (req.path.startsWith('/nacos/v1/ns/service/list')) return { json: { doms: ['order-svc'], count: 1 } };
    if (req.path.startsWith('/nacos/v1/console/namespaces') && (req.method === 'POST' || req.method === 'DELETE')) {
      return { text: 'true' };
    }
    return { status: 404, text: req.path };
  });
  const nacos = new KvHttpDriver('nacos');
  await nacos.connect({ engine: 'nacos', host: '127.0.0.1', port: 8848 }, nacosMock.transport);
  const hist = await nacos.getConfigHistory('app.yaml');
  assert.equal(hist[0].id, '10');
  const diff = computeSimpleLineDiff('port: 8080\nmode: dev', 'port: 9090\nmode: dev');
  assert.equal(diff[0].kind, 'remove');
  assert.equal(diff[1].kind, 'add');
  assert.equal(diff[2].kind, 'same');
  assert.equal((await nacos.listServices())[0].name, 'order-svc');
  await nacos.createNamespace('dev', 'Development');
  await nacos.deleteNamespace('dev');
});

/* ============================================================================
 * 4. Redis Slowlog, Clients, Stream Groups/Consumers/Pending & Value Codecs
 * ============================================================================ */

test('Redis parsers and value codecs handle Slowlog, Clients, Streams, CommandStats & Gzip', async () => {
  const slow = parseRedisSlowlog([
    [14, 1700000000, 12500, ['KEYS', '*'], '127.0.0.1:50123', 'worker-1'],
  ]);
  assert.equal(slow.length, 1);
  assert.equal(slow[0].id, 14);
  assert.equal(slow[0].durationUs, 12500);
  assert.deepEqual(slow[0].command, ['KEYS', '*']);
  assert.equal(slow[0].clientName, 'worker-1');

  const clients = parseRedisClientList(
    'id=42 addr=127.0.0.1:54321 laddr=127.0.0.1:6379 name=api db=2 age=120 idle=3 flags=N cmd=get\n' +
      'id=43 addr=10.0.0.5:33112 name= db=0 age=10 idle=0 flags=P cmd=subscribe\n',
  );
  assert.equal(clients.length, 2);
  assert.equal(clients[0].id, '42');
  assert.equal(clients[0].db, 2);
  assert.equal(clients[0].cmd, 'get');
  assert.equal(clients[1].flags, 'P');

  const groups = parseRedisStreamGroups([
    ['name', 'workers', 'consumers', 2, 'pending', 5, 'last-delivered-id', '1700-0', 'lag', 1],
  ]);
  assert.equal(groups[0].name, 'workers');
  assert.equal(groups[0].pending, 5);
  assert.equal(groups[0].lag, 1);

  const consumers = parseRedisStreamConsumers([
    ['name', 'c1', 'pending', 3, 'idle', 4200],
  ]);
  assert.equal(consumers[0].name, 'c1');
  assert.equal(consumers[0].idleMs, 4200);

  const pending = parseRedisStreamPending([
    ['1700-0', 'c1', 900, 2],
  ]);
  assert.equal(pending[0].deliveryCount, 2);

  const stats = parseRedisCommandStats('cmdstat_get:calls=50,usec=250,usec_per_call=5.00\ncmdstat_set:calls=120,usec=600,usec_per_call=5.00');
  assert.equal(stats[0].command, 'SET');
  assert.equal(stats[0].calls, 120);

  // Codecs
  const jsonCodec = await decodeRedisValueCodec('{"a":1}', 'json');
  assert.equal(jsonCodec.text, '{\n  "a": 1\n}');
  const hexCodec = await decodeRedisValueCodec('AB', 'hex');
  assert.match(hexCodec.text, /41 42/);
  const b64Codec = await decodeRedisValueCodec(Buffer.from('hello').toString('base64'), 'base64');
  assert.equal(b64Codec.text, 'hello');

  // Gzip round-trip via browser CompressionStream / DecompressionStream
  if (typeof CompressionStream === 'function' && typeof DecompressionStream === 'function') {
    const cs = new CompressionStream('gzip');
    const w = cs.writable.getWriter();
    w.write(te.encode('compressed redis payload'));
    w.close();
    const r = cs.readable.getReader();
    const parts = [];
    while (true) {
      const { value, done } = await r.read();
      if (done) break;
      parts.push(value);
    }
    const gzB64 = Buffer.concat(parts.map((p) => Buffer.from(p))).toString('base64');
    const gzRes = await decodeRedisValueCodec(gzB64, 'gzip');
    assert.equal(gzRes.text, 'compressed redis payload');
    assert.equal(gzRes.error, undefined);
  }

  // Mocked RESP ByteStream test for PureRedisDriver commands
  const respBulk = (s) => `$${Buffer.byteLength(s, 'utf8')}\r\n${s}\r\n`;
  const responses = [
    respBulk('# Server\r\nredis_version:7.2.0\r\n'), // INFO server
    '*1\r\n*4\r\n:1\r\n:1700000000\r\n:500\r\n*1\r\n$4\r\nPING\r\n', // SLOWLOG GET
    '+OK\r\n', // SLOWLOG RESET
    respBulk('id=7 addr=127.0.0.1:1111 db=0 cmd=info\n'), // CLIENT LIST
    ':1\r\n', // CLIENT KILL ID
    '+OK\r\n', // FLUSHDB
  ];
  let idx = 0;
  const written = [];
  const mockRedisTransport = {
    async connect() {
      return {
        async write(data) {
          written.push(td.decode(data));
        },
        async read() {
          if (idx >= responses.length) return null;
          return te.encode(responses[idx++]);
        },
        async close() {},
      };
    },
  };
  const redis = new PureRedisDriver();
  await redis.connect({ engine: 'redis', host: '127.0.0.1', port: 6379 }, mockRedisTransport);
  assert.equal((await redis.getSlowlog(128))[0].command[0], 'PING');
  await redis.resetSlowlog();
  assert.equal((await redis.listClients())[0].id, '7');
  await redis.killClient('7');
  await redis.flushDb();
  assert.ok(written.some((w) => w.includes('SLOWLOG') && w.includes('128')));
  assert.ok(written.some((w) => w.includes('CLIENT') && w.includes('KILL')));
  assert.ok(written.some((w) => w.includes('FLUSHDB')));
});

/* ============================================================================
 * 5. MongoDB Explain, Bulk EJSON, Validation, GridFS, Users & Collection Ops
 * ============================================================================ */

test('MongoDB helpers & wire commands handle explain, bulk EJSON, GridFS, validation, users & rename', async () => {
  const explainSummary = summarizeMongoExplain({
    executionStats: {
      nReturned: 3,
      executionTimeMillis: 4,
      totalKeysExamined: 3,
      totalDocsExamined: 3,
      executionStages: {
        stage: 'FETCH',
        nReturned: 3,
        inputStage: {
          stage: 'IXSCAN',
          indexName: 'email_1',
          nReturned: 3,
        },
      },
    },
  });
  assert.equal(explainSummary.winningStage, 'FETCH');
  assert.equal(explainSummary.isCollectionScan, false);
  assert.equal(explainSummary.tree.children[0].indexName, 'email_1');

  const bulkArr = parseMongoBulkDocuments('[{"a":1},{"a":2}]');
  assert.equal(bulkArr.length, 2);
  const bulkNdjson = parseMongoBulkDocuments('{"x":1}\n{"x":2}');
  assert.equal(bulkNdjson.length, 2);

  // Mock OP_MSG wire server
  const encodeReply = (doc) => {
    const body = BSON.serialize(doc);
    const total = 21 + body.length;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setInt32(0, total, true);
    dv.setInt32(4, 1, true);
    dv.setInt32(8, 1, true);
    dv.setInt32(12, 2013, true);
    dv.setUint32(16, 0, true);
    out[20] = 0;
    out.set(body, 21);
    return out;
  };

  const sentCommands = [];
  const replyQueue = [];
  const mockMongoTransport = {
    async connect() {
      return {
        async write(frame) {
          const docLen = new DataView(frame.buffer, frame.byteOffset + 21, 4).getInt32(0, true);
          const cmd = BSON.deserialize(frame.subarray(21, 21 + docLen));
          sentCommands.push(cmd);
          if ('hello' in cmd) replyQueue.push(encodeReply({ ok: 1, isWritablePrimary: true }));
          else if ('buildInfo' in cmd) replyQueue.push(encodeReply({ ok: 1, version: '7.0.8' }));
          else if ('renameCollection' in cmd) replyQueue.push(encodeReply({ ok: 1 }));
          else if ('aggregate' in cmd) replyQueue.push(encodeReply({ ok: 1, cursor: { firstBatch: [{ total: 2048 }] } }));
          else if ('explain' in cmd) {
            replyQueue.push(
              encodeReply({
                ok: 1,
                executionStats: { nReturned: 1, executionTimeMillis: 2, totalKeysExamined: 0, totalDocsExamined: 10, executionStages: { stage: 'COLLSCAN' } },
              }),
            );
          } else if ('listCollections' in cmd) {
            replyQueue.push(
              encodeReply({
                ok: 1,
                cursor: {
                  firstBatch: [
                    { name: 'items', type: 'collection', options: { validator: { $jsonSchema: {} }, validationLevel: 'strict', validationAction: 'error' } },
                    { name: 'fs.files', type: 'collection' },
                    { name: 'fs.chunks', type: 'collection' },
                  ],
                },
              }),
            );
          } else if ('collMod' in cmd) replyQueue.push(encodeReply({ ok: 1 }));
          else if ('count' in cmd) replyQueue.push(encodeReply({ ok: 1, n: 1 }));
          else if ('find' in cmd && cmd.find === 'fs.chunks') {
            replyQueue.push(
              encodeReply({
                ok: 1,
                cursor: { firstBatch: [{ n: 0, data: new Binary(te.encode('gridfs-hello')) }] },
              }),
            );
          } else if ('distinct' in cmd) replyQueue.push(encodeReply({ ok: 1, values: ['open', 'closed'] }));
          else if ('usersInfo' in cmd) {
            replyQueue.push(encodeReply({ ok: 1, users: [{ user: 'alice', db: 'app', roles: [{ role: 'readWrite', db: 'app' }] }] }));
          } else if ('createUser' in cmd || 'dropUser' in cmd || 'dropDatabase' in cmd || 'insert' in cmd) {
            replyQueue.push(encodeReply({ ok: 1, n: 2 }));
          } else {
            replyQueue.push(encodeReply({ ok: 1 }));
          }
        },
        async read() {
          return replyQueue.shift() ?? null;
        },
        async close() {},
      };
    },
  };

  const mongo = new PureMongoDriver();
  await mongo.connect({ engine: 'mongodb', host: '127.0.0.1', port: 27017 }, mockMongoTransport);
  await mongo.renameCollection('app', 'old', 'new', true);
  await mongo.cloneCollection('app', 'new', 'new_copy');
  const exp = await mongo.explainQuery('app', 'items', { active: true });
  assert.equal(summarizeMongoExplain(exp).isCollectionScan, true);
  const val = await mongo.getCollectionValidation('app', 'items');
  assert.equal(val.validationLevel, 'strict');
  await mongo.setCollectionValidation('app', 'items', { validator: { $jsonSchema: {} }, validationLevel: 'moderate' });
  const buckets = await mongo.listGridFsBuckets('app');
  assert.equal(buckets[0].name, 'fs');
  const preview = await mongo.readGridFsFilePreview('app', 'fs', new ObjectId());
  assert.equal(preview.textPreview, 'gridfs-hello');
  assert.deepEqual(await mongo.distinctValues('app', 'items', 'status'), ['open', 'closed']);
  assert.equal((await mongo.listUsers('app'))[0].user, 'alice');
  await mongo.createUser('app', 'bob', 'secret', [{ role: 'read', db: 'app' }]);
  await mongo.dropUser('app', 'bob');
  await mongo.dropDatabase('tempdb');
  assert.ok(sentCommands.some((c) => c.renameCollection === 'app.old' && c.to === 'app.new'));
  assert.ok(sentCommands.some((c) => c.dropDatabase === 1 && c.$db === 'tempdb'));
});

/* ============================================================================
 * 6. Neo4j Parameterized CRUD & EXPLAIN / PROFILE Cypher Builders + Execution
 * ============================================================================ */

test('Neo4j CRUD/Explain Cypher builders and HTTP EXPLAIN execution work cleanly', async () => {
  const createN = buildCreateNodeCypher(['Person', 'Admin`Role'], { name: 'Ada' });
  assert.equal(createN.cypher, 'CREATE (n:`Person`:`Admin``Role` $props) RETURN n');
  assert.deepEqual(createN.params, { props: { name: 'Ada' } });

  const updN = buildUpdateNodeCypher('4:abc:1', { role: 'lead' }, false);
  assert.match(updN.cypher, /SET n \+= \$props RETURN n/);
  assert.equal(updN.params.id, '4:abc:1');

  const delN = buildDeleteNodeCypher('4:abc:1', true);
  assert.match(delN.cypher, /DETACH DELETE n/);

  const createR = buildCreateRelationshipCypher('1', '2', 'KNOWS', { since: 2024 });
  assert.match(createR.cypher, /CREATE \(a\)-\[r:`KNOWS` \$props\]->\(b\)/);
  assert.equal(createR.params.startId, '1');
  assert.equal(createR.params.endId, '2');

  assert.match(buildUpdateRelationshipCypher('9', { weight: 2 }).cypher, /SET r \+= \$props/);
  assert.match(buildDeleteRelationshipCypher('9').cypher, /DELETE r/);

  assert.equal(buildExplainCypher('EXPLAIN MATCH (n) RETURN n', 'PROFILE'), 'PROFILE MATCH (n) RETURN n');

  const normalized = normalizeCypherPlanNode({
    root: {
      operatorType: 'ProduceResults',
      identifiers: ['n'],
      arguments: { EstimatedRows: 10, DbHits: 2, Rows: 5 },
      children: [{ operatorType: 'NodeByLabelScan', identifiers: ['n'], arguments: { EstimatedRows: 10, DbHits: 11 } }],
    },
  });
  assert.equal(normalized.operatorType, 'ProduceResults');
  assert.equal(normalized.dbHits, 2);
  assert.equal(normalized.children[0].operatorType, 'NodeByLabelScan');

  const { transport } = createMockHttpTransport((req) => {
    if (req.method === 'GET' && req.path === '/') {
      return { json: { neo4j_version: '5.22.0', transaction: '/db/{databaseName}/tx' } };
    }
    if (req.method === 'POST' && req.path === '/db/neo4j/tx/commit') {
      const payload = JSON.parse(req.body);
      const stmt = payload.statements[0].statement;
      if (stmt.startsWith('EXPLAIN ')) {
        return {
          json: {
            results: [
              {
                columns: ['n'],
                data: [],
                plan: { root: { operatorType: 'AllNodesScan', identifiers: ['n'], arguments: { EstimatedRows: 50 } } },
              },
            ],
            errors: [],
          },
        };
      }
      return { json: { results: [{ columns: ['ok'], data: [{ row: [1] }] }], errors: [] } };
    }
    return { status: 404, text: req.path };
  });

  const neo4j = new Neo4jDriver();
  await neo4j.connect({ engine: 'neo4j', host: '127.0.0.1', port: 7474, protocol: 'http' }, transport);
  const plan = await neo4j.explainCypher('MATCH (n) RETURN n', 'EXPLAIN');
  assert.equal(plan.mode, 'EXPLAIN');
  assert.equal(plan.plan.operatorType, 'AllNodesScan');
  assert.equal(plan.plan.estimatedRows, 50);
});

/* ============================================================================
 * 7. Sandbox Policy Guard: Zero node:* imports and zero inline <svg>/<canvas>
 * ============================================================================ */

test('All Wave C specialist files have zero node:* imports and zero inline svg/canvas', () => {
  const files = [
    'src/drivers/awsSigV4.ts',
    'src/drivers/redisDriver.ts',
    'src/drivers/mongoDriver.ts',
    'src/drivers/searchVectorDriver.ts',
    'src/drivers/kvHttpDriver.ts',
    'src/drivers/neo4jDriver.ts',
    'src/ui/components/RedisWorkbenchTab.tsx',
    'src/ui/components/MongoWorkbenchTab.tsx',
    'src/ui/components/SearchWorkbenchTab.tsx',
    'src/ui/components/KvWorkbenchTab.tsx',
    'src/ui/components/GraphWorkbenchTab.tsx',
  ];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /from\s+['"]node:/, `Forbidden node:* import in ${file}`);
    assert.doesNotMatch(src, /<svg[\s>]/i, `Forbidden inline <svg> in ${file}`);
    assert.doesNotMatch(src, /<canvas[\s>]/i, `Forbidden inline <canvas> in ${file}`);
  }
});

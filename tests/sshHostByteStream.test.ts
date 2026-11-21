import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PluginByteConnection, PluginContext, PluginNetworkClient } from '@netcatty/plugin-sdk';
import {
  canonicalHostStreamEndpoint,
  HostStreamEndpointError,
  supportsHostByteStreams,
  validateSshHostSelection,
  type SelectedSshHost,
} from '../src/hostStreamEndpoint';
import { connectRedisViaHost, RedisSessionError } from '../src/redisSession';
import { createRedisWorkbenchController } from '../src/useRedisWorkbench';
import { RedisWorkbench } from '../src/RedisWorkbench';
import { connectSshHostSql, SshHostSqlError } from '../src/sshHostSqlSession';
import { createSshHostDatabaseController } from '../src/useSshHostDatabase';
import { SshHostDatabasePanel } from '../src/SshHostDatabasePanel';
import { encodeMysqlPacket } from '../src/mysqlProtocol';
import { translator } from '../src/i18n';

const validSshHost: SelectedSshHost = {
  target: {
    kind: 'host.selection',
    scope: 'metadata',
    handle: 'ssh-host-handle-1',
    revision: 'rev-1',
    expiresAt: Date.now() + 60_000,
  },
  metadata: {
    label: 'Prod Jumpbox',
    hostname: 'jump.internal',
    username: 'ops',
    port: 22,
    group: 'Prod',
    tags: [],
    protocol: 'ssh',
  },
};

function makeByteStream(script: Array<{ expectPrefix?: number[]; respond: Uint8Array[] }>) {
  let step = 0;
  const incoming: Uint8Array[] = [];
  const written: Uint8Array[] = [];
  let closed = false;
  let waitingRead: ((chunk: Uint8Array | null) => void) | null = null;

  const pushResponses = (chunks: Uint8Array[]) => {
    for (const chunk of chunks) {
      if (waitingRead) {
        const resolve = waitingRead;
        waitingRead = null;
        resolve(chunk.slice());
      } else {
        incoming.push(chunk.slice());
      }
    }
  };

  // If the first script entry has no expectPrefix (e.g. MySQL server greeting), send immediately.
  if (script.length && !script[0].expectPrefix) {
    pushResponses(script[0].respond);
    step = 1;
  }

  const connection: PluginByteConnection = {
    endpoint: 'tcp://127.0.0.1:3306',
    readable: {
      id: 'read-1',
      read: async () => {
        if (closed) return null;
        if (incoming.length) return incoming.shift()!;
        return new Promise<Uint8Array | null>((resolve) => {
          waitingRead = resolve;
        });
      },
      cancel: () => {
        closed = true;
        if (waitingRead) {
          const resolve = waitingRead;
          waitingRead = null;
          resolve(null);
        }
      },
      dispose: () => { closed = true; },
    },
    writable: {
      id: 'write-1',
      write: async (data: Uint8Array) => {
        if (closed) throw new Error('closed');
        written.push(data.slice());
        const current = script[step];
        if (current) {
          if (current.expectPrefix) {
            for (let i = 0; i < current.expectPrefix.length; i++) {
              assert.equal(data[i], current.expectPrefix[i], `step ${step} byte ${i}`);
            }
          }
          step++;
          pushResponses(current.respond);
        }
      },
      end: async () => { closed = true; },
      fail: () => { closed = true; },
      cancel: () => { closed = true; },
      dispose: () => { closed = true; },
    },
    close: async () => {
      closed = true;
      if (waitingRead) {
        const resolve = waitingRead;
        waitingRead = null;
        resolve(null);
      }
    },
    dispose: () => { closed = true; },
  };

  return { connection, written, isClosed: () => closed };
}

function buildMysqlGreeting(plugin: 'mysql_native_password' | 'caching_sha2_password'): Uint8Array {
  const te = new TextEncoder();
  const version = te.encode('8.4.0\0');
  const connId = new Uint8Array([1, 0, 0, 0]);
  const nonce1 = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const caps = 0x200 | 0x800 | 0x8000 | 0x80000;
  const lowerCaps = new Uint8Array([caps & 0xff, (caps >> 8) & 0xff]);
  const upperCaps = new Uint8Array([(caps >> 16) & 0xff, (caps >> 24) & 0xff]);
  const nonce2 = new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 0]);
  const pluginBytes = te.encode(`${plugin}\0`);
  const payload = new Uint8Array(1 + version.length + 4 + 8 + 1 + 2 + 1 + 2 + 2 + 1 + 10 + 13 + pluginBytes.length);
  let pos = 0;
  payload[pos++] = 10;
  payload.set(version, pos); pos += version.length;
  payload.set(connId, pos); pos += 4;
  payload.set(nonce1, pos); pos += 8;
  payload[pos++] = 0;
  payload.set(lowerCaps, pos); pos += 2;
  payload[pos++] = 45;
  pos += 2; // status flags
  payload.set(upperCaps, pos); pos += 2;
  payload[pos++] = 21;
  pos += 10; // reserved
  payload.set(nonce2, pos); pos += 13;
  payload.set(pluginBytes, pos);
  return encodeMysqlPacket(payload, 0);
}

test('canonicalHostStreamEndpoint allows SSH-remote loopback/private tcp & tls endpoints and rejects invalid inputs', () => {
  assert.equal(canonicalHostStreamEndpoint('tcp://127.0.0.1:5432'), 'tcp://127.0.0.1:5432');
  assert.equal(canonicalHostStreamEndpoint('tcp://LOCALHOST:3306'), 'tcp://localhost:3306');
  assert.equal(canonicalHostStreamEndpoint('tls://db.internal:6379'), 'tls://db.internal:6379');
  assert.equal(canonicalHostStreamEndpoint('tcp://[::1]:5432'), 'tcp://[::1]:5432');
  for (const bad of ['http://127.0.0.1:5432', 'tcp://127.0.0.1:0', 'tcp://127.0.0.1:70000', 'tcp://user@127.0.0.1:3306', 'tcp://127.0.0.1:3306/db', '']) {
    assert.throws(() => canonicalHostStreamEndpoint(bad), (err: unknown) => err instanceof HostStreamEndpointError && err.code === 'invalid-endpoint');
  }
});

test('validateSshHostSelection rejects non-ssh, malformed and expired selections', () => {
  const ok = validateSshHostSelection(validSshHost, validSshHost.target.expiresAt - 1000);
  assert.equal(ok.target.handle, 'ssh-host-handle-1');
  assert.equal(ok.expectedRevision, 'rev-1');

  assert.throws(
    () => validateSshHostSelection({ ...validSshHost, metadata: { ...validSshHost.metadata, protocol: 'telnet' } }, validSshHost.target.expiresAt - 1000),
    (err: unknown) => err instanceof HostStreamEndpointError && err.code === 'host-not-ssh',
  );
  assert.throws(
    () => validateSshHostSelection(validSshHost, validSshHost.target.expiresAt + 1),
    (err: unknown) => err instanceof HostStreamEndpointError && err.code === 'host-expired',
  );
});

test('supportsHostByteStreams requires both byte-streams features and connectViaHost method', () => {
  assert.equal(supportsHostByteStreams({
    enabledFeatures: new Set(['network.byte-streams', 'network.host-byte-streams']),
    network: { connectViaHost: async () => { throw new Error('unused'); } } as unknown as PluginNetworkClient,
  }), true);
  assert.equal(supportsHostByteStreams({
    enabledFeatures: new Set(['network.byte-streams']),
    network: { connectViaHost: async () => { throw new Error('unused'); } } as unknown as PluginNetworkClient,
  }), false);
});

test('connectRedisViaHost opens an SSH host byte stream for loopback tcp endpoint and runs AUTH + PING', async () => {
  const te = new TextEncoder();
  const calls: unknown[] = [];
  const stream = makeByteStream([
    { expectPrefix: [42, 50], respond: [te.encode('+OK\r\n')] },
    { expectPrefix: [42, 49], respond: [te.encode('+PONG\r\n')] },
  ]);
  const network = {
    connectViaHost: async (req: unknown) => {
      calls.push(req);
      return stream.connection;
    },
  } as unknown as PluginNetworkClient;

  const session = await connectRedisViaHost(network, {
    target: validSshHost.target,
    expectedRevision: validSshHost.target.revision,
    endpoint: 'tcp://127.0.0.1:6379',
    authentication: { password: 'ephemeral-password' },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    target: validSshHost.target,
    expectedRevision: 'rev-1',
    endpoint: 'tcp://127.0.0.1:6379',
  });
  await session.close();
  assert.equal(stream.isClosed(), true);
});

test('RedisWorkbench renders SSH host byte-stream controls when SSH host and feature are present even with empty declaredEndpoints', () => {
  let connectCalls = 0;
  const context = {
    environment: { locale: 'en', theme: 'dark' },
    enabledFeatures: new Set(['network.byte-streams', 'network.host-byte-streams']),
    network: {
      connectViaHost: async () => { connectCalls++; throw new Error('must not auto-connect'); },
    },
  } as unknown as PluginContext;
  const html = renderToStaticMarkup(React.createElement(RedisWorkbench, {
    context,
    declaredEndpoints: [],
    selectedHost: validSshHost,
  }));
  assert.equal(connectCalls, 0);
  assert.match(html, /Connect Redis via SSH/);
  assert.match(html, /tcp:\/\/127\.0\.0\.1:6379/);
  assert.match(html, /Prod Jumpbox/);
});

test('Redis workbench controller connects over SSH host byte stream and cleans up on disconnect', async () => {
  let closed = false;
  const received: unknown[] = [];
  const controller = createRedisWorkbenchController({
    connect: async () => { throw new RedisSessionError('transport'); },
    connectViaHost: async (options) => {
      received.push(options);
      return {
        get isClosed() { return closed; },
        close: async () => { closed = true; },
        request: async () => ({ type: 'simple', value: new TextEncoder().encode('PONG') }),
      };
    },
  }, [], validSshHost, () => validSshHost.target.expiresAt - 1000);

  await controller.connectViaHost('tcp://127.0.0.1:6379', { password: 'secret' });
  assert.equal(received.length, 1);
  assert.equal(controller.getSnapshot().status, 'connected');
  assert.equal(controller.getSnapshot().mode, 'ssh-host');
  assert.equal(controller.getSnapshot().endpoint, 'tcp://127.0.0.1:6379');
  assert.ok(!JSON.stringify(controller.getSnapshot()).includes('secret'));
  controller.disconnect();
  assert.equal(closed, true);
  assert.equal(controller.getSnapshot().status, 'disconnected');
});

test('connectSshHostSql authenticates MySQL mysql_native_password and caching_sha2_password fast auth over SSH byte stream', async () => {
  const okPacket = (seq: number) => encodeMysqlPacket(new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]), seq);
  const nativeStream = makeByteStream([
    { respond: [buildMysqlGreeting('mysql_native_password')] },
    { expectPrefix: [], respond: [okPacket(2)] },
  ]);
  const nativeNetwork = {
    connectViaHost: async () => nativeStream.connection,
  } as unknown as PluginNetworkClient;

  const nativeSession = await connectSshHostSql(nativeNetwork, {
    engine: 'mysql',
    target: validSshHost.target,
    expectedRevision: validSshHost.target.revision,
    endpoint: 'tcp://127.0.0.1:3306',
    database: 'appdb',
    username: 'reader',
    password: 'pw',
  });
  assert.equal(nativeSession.engine, 'mysql');
  await nativeSession.close();
  assert.equal(nativeStream.isClosed(), true);

  const fastOkPart1 = encodeMysqlPacket(new Uint8Array([0x01, 0x03]), 2);
  const fastOkPart2 = okPacket(3);
  const coalescedFastOk = new Uint8Array(fastOkPart1.length + fastOkPart2.length);
  coalescedFastOk.set(fastOkPart1, 0);
  coalescedFastOk.set(fastOkPart2, fastOkPart1.length);
  const sha2Stream = makeByteStream([
    { respond: [buildMysqlGreeting('caching_sha2_password')] },
    { expectPrefix: [], respond: [coalescedFastOk] },
  ]);
  const sha2Network = {
    connectViaHost: async () => sha2Stream.connection,
  } as unknown as PluginNetworkClient;
  const sha2Session = await connectSshHostSql(sha2Network, {
    engine: 'mysql',
    target: validSshHost.target,
    expectedRevision: validSshHost.target.revision,
    endpoint: 'tcp://127.0.0.1:3306',
    database: 'appdb',
    username: 'reader',
    password: 'pw',
  });
  await sha2Session.close();
  assert.equal(sha2Stream.isClosed(), true);

  // caching_sha2_password full-auth over plain tcp:// rejects cleanly instead of sending cleartext password
  const fullAuthRefusedStream = makeByteStream([
    { respond: [buildMysqlGreeting('caching_sha2_password')] },
    { expectPrefix: [], respond: [encodeMysqlPacket(new Uint8Array([0x01, 0x04]), 2)] },
  ]);
  await assert.rejects(
    connectSshHostSql({ connectViaHost: async () => fullAuthRefusedStream.connection } as unknown as PluginNetworkClient, {
      engine: 'mysql',
      target: validSshHost.target,
      expectedRevision: validSshHost.target.revision,
      endpoint: 'tcp://127.0.0.1:3306',
      database: 'appdb',
      username: 'reader',
      password: 'pw',
    }),
    (err: unknown) => err instanceof SshHostSqlError && err.code === 'authentication',
  );
  assert.equal(fullAuthRefusedStream.isClosed(), true);
});

test('SshHostDatabaseController manages connect, listTables, selectTable, readSelectedTable and disconnect cleanly', async () => {
  let closed = false;
  const controller = createSshHostDatabaseController({
    connect: async (opts) => {
      assert.equal(opts.engine, 'postgres');
      assert.equal(opts.endpoint, 'tcp://127.0.0.1:5432');
      return {
        engine: 'postgres',
        endpoint: opts.endpoint,
        database: opts.database,
        get isClosed() { return closed; },
        close: async () => { closed = true; },
        listTables: async () => ({ items: [{ name: 'users', kind: 'table' }], truncated: false }),
        listColumns: async () => ({ items: [{ name: 'id', dataType: 'integer', nullable: false }], truncated: false }),
        readTable: async () => ({ columns: ['id'], rows: [[1]], rowCount: 1, limit: 50 }),
      };
    },
  }, validSshHost, () => validSshHost.target.expiresAt - 1000);

  await controller.connect({
    engine: 'postgres',
    endpoint: 'tcp://127.0.0.1:5432',
    database: 'app',
    schema: 'public',
    username: 'readonly',
    password: 'super-secret-password',
  });
  assert.equal(controller.getSnapshot().status, 'connected');
  assert.ok(!JSON.stringify(controller.getSnapshot()).includes('super-secret-password'));
  await controller.listTables('public');
  assert.deepEqual(controller.getSnapshot().tables, [{ name: 'users', kind: 'table' }]);
  await controller.selectTable('users');
  assert.equal(controller.getSnapshot().columns[0]?.name, 'id');
  await controller.readSelectedTable(50);
  assert.deepEqual(controller.getSnapshot().result?.rows, [[1]]);
  controller.disconnect();
  assert.equal(closed, true);
  assert.equal(controller.getSnapshot().status, 'disconnected');
});

test('SshHostDatabasePanel renders unavailable notice when feature is disabled and controls when enabled without auto-connecting', () => {
  const t = translator('en');
  let called = 0;
  const disabledCtx = {
    environment: { locale: 'en', theme: 'light' },
    enabledFeatures: new Set(['network.byte-streams']),
    network: { connectViaHost: async () => { called++; throw new Error('no'); } },
  } as unknown as PluginContext;
  const disabledHtml = renderToStaticMarkup(React.createElement(SshHostDatabasePanel, {
    context: disabledCtx,
    selectedHost: validSshHost,
    t,
  }));
  assert.equal(called, 0);
  assert.match(disabledHtml, /has not enabled network\.host-byte-streams/);

  const enabledCtx = {
    environment: { locale: 'zh-CN', theme: 'dark' },
    enabledFeatures: new Set(['network.byte-streams', 'network.host-byte-streams']),
    network: { connectViaHost: async () => { called++; throw new Error('no'); } },
  } as unknown as PluginContext;
  const enabledHtml = renderToStaticMarkup(React.createElement(SshHostDatabasePanel, {
    context: enabledCtx,
    selectedHost: validSshHost,
    t: translator('zh-CN'),
  }));
  assert.equal(called, 0);
  assert.match(enabledHtml, /通过 SSH 连接数据库/);
  assert.match(enabledHtml, /type="password"/);
});

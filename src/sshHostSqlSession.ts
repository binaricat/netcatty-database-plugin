import { CancellationTokenSource, type PluginByteConnection, type PluginNetworkClient } from '@netcatty/plugin-sdk';
import { canonicalHostStreamEndpoint, type HostStreamTargetRef } from './hostStreamEndpoint';
import { authenticatePostgresTls, PostgresStartupError } from './postgresSession';
import { createPostgresMetadataReader, PostgresMetadataError } from './postgresMetadata';
import { executePostgresRead, PostgresReadError } from './postgresQuery';
import { encodeMysqlPacket, MysqlPacketDecoder, parseMysqlError, parseMysqlHandshake, type MysqlPacket } from './mysqlProtocol';
import { createMysqlMetadataClient, MysqlMetadataError } from './mysqlMetadata';
import { executeMysqlRead, MysqlReadError } from './mysqlRead';
import type { DatabaseScalar } from './databaseTypes';

export type SshHostSqlEngine = 'postgres' | 'mysql';

export interface SshHostSqlConnectOptions {
  engine: SshHostSqlEngine;
  target: HostStreamTargetRef;
  expectedRevision: string;
  endpoint: string;
  database: string;
  username: string;
  password: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SshHostTableSummary {
  name: string;
  kind: 'table' | 'view';
}

export interface SshHostColumnSummary {
  name: string;
  dataType: string;
  nullable: boolean;
}

export interface SshHostReadResult {
  columns: string[];
  rows: DatabaseScalar[][];
  rowCount: number;
  limit: number;
}

export class SshHostSqlError extends Error {
  constructor(
    readonly code:
      | 'endpoint'
      | 'input'
      | 'authentication'
      | 'unsupported'
      | 'protocol'
      | 'limit'
      | 'server'
      | 'timeout'
      | 'aborted'
      | 'closed'
      | 'busy'
      | 'transport',
  ) {
    super(`SSH host SQL ${code}`);
  }
}

const DEFAULT_TIMEOUT_MS = 8000;
const MYSQL_SSH_CAPS = 0x200 | 0x8000 | 0x80000; // CLIENT_PROTOCOL_41 | CLIENT_SECURE_CONNECTION | CLIENT_PLUGIN_AUTH
const MYSQL_MAX_PACKET_BYTES = 96 * 1024;
const te = new TextEncoder();

function validTimeout(ms: number | undefined): number {
  const value = ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 1 || value > 15000) {
    throw new SshHostSqlError('limit');
  }
  return value;
}

function validIdentifier(value: unknown, max = 128): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function digestBytes(algorithm: 'SHA-1' | 'SHA-256', bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(algorithm, bytes as BufferSource));
}

async function mysqlNativeAuthToken(passwordBytes: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
  if (!passwordBytes.length) return new Uint8Array(0);
  let stage1: Uint8Array | undefined;
  let stage2: Uint8Array | undefined;
  let mixed: Uint8Array | undefined;
  let mask: Uint8Array | undefined;
  try {
    stage1 = await digestBytes('SHA-1', passwordBytes);
    stage2 = await digestBytes('SHA-1', stage1);
    mixed = concatBytes(nonce, stage2);
    mask = await digestBytes('SHA-1', mixed);
    return stage1.map((byte, idx) => byte ^ mask![idx]);
  } finally {
    stage1?.fill(0);
    stage2?.fill(0);
    mixed?.fill(0);
    mask?.fill(0);
  }
}

async function mysqlCachingSha2Token(passwordBytes: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
  if (!passwordBytes.length) return new Uint8Array(0);
  let stage1: Uint8Array | undefined;
  let stage2: Uint8Array | undefined;
  let mixed: Uint8Array | undefined;
  let mask: Uint8Array | undefined;
  try {
    stage1 = await digestBytes('SHA-256', passwordBytes);
    stage2 = await digestBytes('SHA-256', stage1);
    mixed = concatBytes(stage2, nonce);
    mask = await digestBytes('SHA-256', mixed);
    return stage1.map((byte, idx) => byte ^ mask![idx]);
  } finally {
    stage1?.fill(0);
    stage2?.fill(0);
    mixed?.fill(0);
    mask?.fill(0);
  }
}

function closeConnection(connection: PluginByteConnection | undefined): void {
  if (!connection) return;
  try { connection.readable.cancel(); } catch { /* ignore */ }
  try { connection.writable.cancel(); } catch { /* ignore */ }
  void Promise.resolve().then(() => connection.close()).catch(() => {});
}

async function authenticateMysqlOverSsh(
  connection: PluginByteConnection,
  options: { username: string; password: string; allowCleartextFullAuth: boolean; timeoutMs: number; signal?: AbortSignal },
): Promise<void> {
  if (!validIdentifier(options.username, 128) || !options.username.trim() || !/^[\x20-\x7e]+$/.test(options.username)
    || typeof options.password !== 'string' || options.password.length > 1024) {
    throw new SshHostSqlError('input');
  }
  const passwordBytes = te.encode(options.password);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopReject!: (error: SshHostSqlError) => void;
  const stop = new Promise<never>((_, reject) => { stopReject = reject; });
  const halt = (code: 'timeout' | 'aborted') => {
    if (stopped) return;
    stopped = true;
    closeConnection(connection);
    stopReject(new SshHostSqlError(code));
  };
  const abort = () => halt('aborted');
  const deadline = performance.now() + options.timeoutMs;
  const check = () => {
    if (stopped) throw new SshHostSqlError('aborted');
    if (performance.now() >= deadline) throw new SshHostSqlError('timeout');
  };

  let reads = 0;
  let totalBytes = 0;
  let activeDecoder: MysqlPacketDecoder | null = null;
  let queuedPackets: MysqlPacket[] = [];

  const resetReader = (nextSequence: number) => {
    if (queuedPackets.length) {
      for (const packet of queuedPackets) packet.payload.fill(0);
      queuedPackets = [];
      throw new SshHostSqlError('protocol');
    }
    if (activeDecoder) {
      try { activeDecoder.finish(); } catch { throw new SshHostSqlError('protocol'); }
    }
    activeDecoder = new MysqlPacketDecoder(nextSequence);
  };

  const readNextPacket = async (expectedSequence: number): Promise<MysqlPacket> => {
    if (!activeDecoder) activeDecoder = new MysqlPacketDecoder(expectedSequence);
    while (!queuedPackets.length) {
      check();
      if (++reads > 1024) throw new SshHostSqlError('limit');
      const chunk = await connection.readable.read();
      try {
        check();
        if (!(chunk instanceof Uint8Array) || !chunk.length) throw new SshHostSqlError('protocol');
        totalBytes += chunk.length;
        if (totalBytes > 96 * 1024) throw new SshHostSqlError('limit');
        let packets: MysqlPacket[];
        try {
          packets = activeDecoder.feed(chunk);
        } catch {
          throw new SshHostSqlError('protocol');
        }
        if (packets.length) queuedPackets.push(...packets);
      } finally {
        if (chunk instanceof Uint8Array) chunk.fill(0);
      }
    }
    const packet = queuedPackets.shift()!;
    if (packet.sequence !== expectedSequence) {
      packet.payload.fill(0);
      throw new SshHostSqlError('protocol');
    }
    return packet;
  };

  const assertReaderDrained = () => {
    if (queuedPackets.length) {
      for (const packet of queuedPackets) packet.payload.fill(0);
      queuedPackets = [];
      throw new SshHostSqlError('protocol');
    }
    if (activeDecoder) {
      try { activeDecoder.finish(); } catch { throw new SshHostSqlError('protocol'); }
      activeDecoder = null;
    }
  };

  try {
    timer = setTimeout(() => halt('timeout'), options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) halt('aborted');

    const run = async () => {
      resetReader(0);
      const greetingPacket = await readNextPacket(0);
      assertReaderDrained();
      let hello;
      try {
        hello = parseMysqlHandshake(greetingPacket.payload);
      } catch {
        throw new SshHostSqlError('protocol');
      } finally {
        greetingPacket.payload.fill(0);
      }

      try {
        if ((hello.capabilities & MYSQL_SSH_CAPS) !== MYSQL_SSH_CAPS) {
          throw new SshHostSqlError('unsupported');
        }
        const plugin = hello.authPlugin;
        if (plugin !== 'mysql_native_password' && plugin !== 'caching_sha2_password') {
          throw new SshHostSqlError('unsupported');
        }
        const token = plugin === 'mysql_native_password'
          ? await mysqlNativeAuthToken(passwordBytes, hello.authPluginData)
          : await mysqlCachingSha2Token(passwordBytes, hello.authPluginData);

        const userBytes = te.encode(`${options.username}\0`);
        const pluginBytes = te.encode(`${plugin}\0`);
        const header = new Uint8Array(32);
        const view = new DataView(header.buffer);
        view.setUint32(0, MYSQL_SSH_CAPS, true);
        view.setUint32(4, MYSQL_MAX_PACKET_BYTES, true);
        header[8] = 45; // utf8mb4
        const body = concatBytes(header, userBytes, Uint8Array.of(token.length), token, pluginBytes);
        const wire = encodeMysqlPacket(body, 1);
        header.fill(0);
        token.fill(0);
        body.fill(0);
        try {
          check();
          await connection.writable.write(wire);
        } finally {
          wire.fill(0);
        }

        resetReader(2);
        const firstReply = await readNextPacket(2);
        try {
          const payload = firstReply.payload;
          if (payload[0] === 0xff) {
            try { parseMysqlError(payload); } catch { throw new SshHostSqlError('protocol'); }
            throw new SshHostSqlError('authentication');
          }
          if (payload[0] === 0x00 && payload.length >= 7) {
            assertReaderDrained();
            return;
          }
          if (plugin === 'caching_sha2_password' && payload.length === 2 && payload[0] === 0x01) {
            if (payload[1] === 0x03) {
              const okPacket = await readNextPacket(3);
              try {
                if (okPacket.payload[0] === 0xff) throw new SshHostSqlError('authentication');
                if (okPacket.payload[0] !== 0x00 || okPacket.payload.length < 7) throw new SshHostSqlError('protocol');
                assertReaderDrained();
                return;
              } finally {
                okPacket.payload.fill(0);
              }
            }
            if (payload[1] === 0x04) {
              assertReaderDrained();
              if (!options.allowCleartextFullAuth) {
                throw new SshHostSqlError('authentication');
              }
              const fullBody = concatBytes(passwordBytes, Uint8Array.of(0));
              const fullWire = encodeMysqlPacket(fullBody, 3);
              fullBody.fill(0);
              try {
                check();
                await connection.writable.write(fullWire);
              } finally {
                fullWire.fill(0);
              }
              resetReader(4);
              const okPacket = await readNextPacket(4);
              try {
                if (okPacket.payload[0] === 0xff) throw new SshHostSqlError('authentication');
                if (okPacket.payload[0] !== 0x00 || okPacket.payload.length < 7) throw new SshHostSqlError('protocol');
                assertReaderDrained();
                return;
              } finally {
                okPacket.payload.fill(0);
              }
            }
          }
          throw new SshHostSqlError('protocol');
        } finally {
          firstReply.payload.fill(0);
        }
      } finally {
        hello.authPluginData.fill(0);
      }
    };

    await Promise.race([run(), stop]);
  } catch (error) {
    if (!stopped) {
      stopped = true;
      closeConnection(connection);
    }
    throw error instanceof SshHostSqlError ? error : new SshHostSqlError('transport');
  } finally {
    for (const packet of queuedPackets) packet.payload.fill(0);
    queuedPackets = [];
    passwordBytes.fill(0);
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

function mapDownstreamError(error: unknown): SshHostSqlError {
  if (error instanceof SshHostSqlError) return error;
  if (error instanceof PostgresStartupError) {
    if (error.code === 'authentication' || error.code === 'server') return new SshHostSqlError('authentication');
    if (error.code === 'timeout' || error.code === 'aborted' || error.code === 'input' || error.code === 'limit') {
      return new SshHostSqlError(error.code);
    }
    return new SshHostSqlError('protocol');
  }
  if (error instanceof PostgresReadError || error instanceof MysqlReadError) {
    if (error.code === 'timeout' || error.code === 'aborted' || error.code === 'input' || error.code === 'limit'
      || error.code === 'closed' || error.code === 'busy' || error.code === 'server' || error.code === 'transport') {
      return new SshHostSqlError(error.code);
    }
    return new SshHostSqlError('protocol');
  }
  if (error instanceof PostgresMetadataError || error instanceof MysqlMetadataError) {
    if (error.code === 'input') return new SshHostSqlError('input');
    if (error.code === 'budget' || error.code === 'limit') return new SshHostSqlError('limit');
    return new SshHostSqlError('protocol');
  }
  return new SshHostSqlError('transport');
}

export class SshHostSqlSession {
  private connection: PluginByteConnection | null;
  private closed = false;
  private busy = false;
  private closePromise: Promise<void> | null = null;
  private lifetimeCleanup: () => void = () => {};

  private constructor(
    readonly engine: SshHostSqlEngine,
    readonly endpoint: string,
    readonly database: string,
    connection: PluginByteConnection,
  ) {
    this.connection = connection;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private bindLifetime(signal?: AbortSignal): void {
    if (!signal) return;
    const abort = () => { void this.close(); };
    this.lifetimeCleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  }

  private async runExclusive<T>(fn: (connection: PluginByteConnection) => Promise<T>): Promise<T> {
    if (this.closed || !this.connection) throw new SshHostSqlError('closed');
    if (this.busy) throw new SshHostSqlError('busy');
    this.busy = true;
    try {
      return await fn(this.connection);
    } catch (error) {
      const mapped = mapDownstreamError(error);
      if (mapped.code !== 'input' && mapped.code !== 'busy') {
        void this.close();
      }
      throw mapped;
    } finally {
      this.busy = false;
    }
  }

  async listTables(schema: string, options: { limit?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ items: SshHostTableSummary[]; truncated: boolean }> {
    const resolvedSchema = schema.trim();
    if (!validIdentifier(resolvedSchema, this.engine === 'mysql' ? 64 : 128)) {
      throw new SshHostSqlError('input');
    }
    return this.runExclusive(async (connection) => {
      if (this.engine === 'postgres') {
        const reader = createPostgresMetadataReader(connection);
        const page = await reader.listTables(resolvedSchema, {
          limit: options.limit ?? 32,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
        });
        return {
          items: page.items.map((item) => ({
            name: item.name,
            kind: item.kind === 'VIEW' ? 'view' : 'table',
          })),
          truncated: page.truncated,
        };
      }
      const client = createMysqlMetadataClient(connection);
      const page = await client.tables({
        schema: resolvedSchema,
        limit: options.limit ?? 64,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
      return {
        items: page.tables.map((item) => ({ name: item.name, kind: item.kind })),
        truncated: page.possiblyTruncated,
      };
    });
  }

  async listColumns(schema: string, table: string, options: { limit?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ items: SshHostColumnSummary[]; truncated: boolean }> {
    const resolvedSchema = schema.trim();
    const resolvedTable = table.trim();
    const maxLen = this.engine === 'mysql' ? 64 : 128;
    if (!validIdentifier(resolvedSchema, maxLen) || !validIdentifier(resolvedTable, maxLen)) {
      throw new SshHostSqlError('input');
    }
    return this.runExclusive(async (connection) => {
      if (this.engine === 'postgres') {
        const reader = createPostgresMetadataReader(connection);
        const page = await reader.listColumns(resolvedSchema, resolvedTable, {
          limit: options.limit ?? 64,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
        });
        return {
          items: page.items.map((col) => ({
            name: col.name,
            dataType: col.dataType,
            nullable: col.nullable,
          })),
          truncated: page.truncated,
        };
      }
      const client = createMysqlMetadataClient(connection);
      const page = await client.columns({
        schema: resolvedSchema,
        table: resolvedTable,
        limit: options.limit ?? 64,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
      return {
        items: page.columns.map((col) => ({
          name: col.name,
          dataType: col.columnType || col.dataType,
          nullable: col.nullable,
        })),
        truncated: page.possiblyTruncated,
      };
    });
  }

  async readTable(
    schema: string,
    table: string,
    columns: string[],
    options: { limit?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<SshHostReadResult> {
    const resolvedSchema = schema.trim();
    const resolvedTable = table.trim();
    const selectedColumns = columns.slice(0, 16);
    if (!validIdentifier(resolvedSchema) || !validIdentifier(resolvedTable) || !selectedColumns.length) {
      throw new SshHostSqlError('input');
    }
    return this.runExclusive(async (connection) => {
      if (this.engine === 'postgres') {
        const result = await executePostgresRead(connection, {
          schema: resolvedSchema,
          table: resolvedTable,
          columns: selectedColumns,
          limit: options.limit ?? 50,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
        });
        return {
          columns: result.columns,
          rows: result.rows,
          rowCount: result.rowCount,
          limit: result.limit,
        };
      }
      const result = await executeMysqlRead(connection, {
        schema: resolvedSchema,
        table: resolvedTable,
        columns: selectedColumns,
        limit: options.limit ?? 50,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
      return {
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rowCount,
        limit: result.limit,
      };
    });
  }

  close(): Promise<void> {
    if (this.closed) return this.closePromise ?? Promise.resolve();
    this.closed = true;
    this.lifetimeCleanup();
    this.lifetimeCleanup = () => {};
    const conn = this.connection;
    this.connection = null;
    try { conn?.readable.cancel(); } catch { /* ignore */ }
    try { conn?.writable.cancel(); } catch { /* ignore */ }
    this.closePromise = Promise.resolve().then(() => conn?.close()).then(() => {}, () => {});
    return this.closePromise;
  }

  static async connect(network: PluginNetworkClient, options: SshHostSqlConnectOptions): Promise<SshHostSqlSession> {
    let exactEndpoint: string;
    try {
      exactEndpoint = canonicalHostStreamEndpoint(options.endpoint);
    } catch {
      throw new SshHostSqlError('endpoint');
    }
    const ms = validTimeout(options.timeoutMs);
    const database = options.database.trim();
    const username = options.username.trim();
    if (!validIdentifier(database) || !validIdentifier(username)) {
      throw new SshHostSqlError('input');
    }

    const cancellation = new CancellationTokenSource();
    let connection: PluginByteConnection | undefined;
    let timedOut = false;
    let aborted = false;
    let rejectStop!: (error: SshHostSqlError) => void;
    const stop = new Promise<never>((_, reject) => { rejectStop = reject; });
    const cancel = (code: 'timeout' | 'aborted') => {
      timedOut = code === 'timeout';
      aborted = code === 'aborted';
      cancellation.cancel();
      rejectStop(new SshHostSqlError(code));
    };
    const abort = () => cancel('aborted');
    const timer = setTimeout(() => cancel('timeout'), ms);
    options.signal?.addEventListener('abort', abort, { once: true });

    try {
      if (options.signal?.aborted) abort();
      const opening = Promise.resolve().then(() => {
        if (timedOut || aborted) throw new SshHostSqlError(aborted ? 'aborted' : 'timeout');
        return network.connectViaHost(
          { target: options.target, expectedRevision: options.expectedRevision, endpoint: exactEndpoint },
          cancellation.token,
        );
      }).then((value) => {
        if (timedOut || aborted) {
          closeConnection(value);
          throw new SshHostSqlError(aborted ? 'aborted' : 'timeout');
        }
        connection = value;
        return value;
      });
      await Promise.race([opening, stop]);
    } catch (error) {
      throw error instanceof SshHostSqlError ? error : new SshHostSqlError('transport');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      cancellation.dispose();
    }

    try {
      if (options.engine === 'postgres') {
        await authenticatePostgresTls(connection!, {
          user: username,
          database,
          password: options.password,
          timeoutMs: ms,
          signal: options.signal,
        });
      } else {
        await authenticateMysqlOverSsh(connection!, {
          username,
          password: options.password,
          allowCleartextFullAuth: exactEndpoint.startsWith('tls://'),
          timeoutMs: ms,
          signal: options.signal,
        });
      }
    } catch (error) {
      closeConnection(connection);
      throw mapDownstreamError(error);
    }

    const session = new SshHostSqlSession(options.engine, exactEndpoint, database, connection!);
    session.bindLifetime(options.signal);
    return session;
  }
}

export function connectSshHostSql(network: PluginNetworkClient, options: SshHostSqlConnectOptions): Promise<SshHostSqlSession> {
  return SshHostSqlSession.connect(network, options);
}

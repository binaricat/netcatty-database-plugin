/**
 * Pure-TS MySQL / MariaDB Wire Protocol Driver (100% browser-sandbox compatible).
 * Powers MySQL, MariaDB, TiDB, OceanBase, and GoldenDB.
 *
 * Features:
 * - HandshakeV10 + STARTTLS (CLIENT_SSL -> upgradeTls)
 * - mysql_native_password, caching_sha2_password (fast auth + TLS full auth + RSA-OAEP public key auth),
 *   mysql_clear_password, and AuthSwitchRequest (0xFE)
 * - Multi-statement / multi-result sets (SERVER_MORE_RESULTS_EXISTS)
 * - Real KILL QUERY cancellation on side connection
 * - Full INFORMATION_SCHEMA + SHOW CREATE TABLE/VIEW introspection, ER graph, EXPLAIN FORMAT=JSON
 */

import { rsaOaepEncryptPem, sha1, sha256, xorBytes } from './crypto';
import {
  buildAlterTableDdl,
  buildBatchMutations,
  buildCreateTableDdl,
  buildDropObjectSql,
  buildTruncateTableSql,
  qualifiedTableName,
  quoteIdent,
} from './sqlDialect';
import { BufferedByteStream, concatBytes } from './streamBuffer';
import {
  QueryError,
  type BatchMutationApplyResult,
  type BatchMutationChanges,
  type BatchMutationPreview,
  type BrowseTableOptions,
  type BrowseTableResult,
  type ByteStreamTransport,
  type CellValue,
  type ColumnMeta,
  type ColumnStructure,
  type ConnectionConfig,
  type ConnectionInfo,
  type CreateTableSpec,
  type DatabaseEngineId,
  type DatabaseInfo,
  type DatabaseUserSummary,
  type DropObjectKind,
  type EventSummary,
  type ExplainResult,
  type ForeignKeyStructure,
  type IndexStructure,
  type MultiQueryResult,
  type PartitionSummary,
  type ProcessEntry,
  type ServerStatusSnapshot,
  type QueryOptions,
  type QueryResultSet,
  type RelationalDriver,
  type RoutineSummary,
  type SchemaDiffResult,
  type SchemaErEdge,
  type SchemaErGraph,
  type SchemaErTable,
  type SchemaInfo,
  type SchemaSnapshot,
  type TableStructure,
  type TableStructureDiff,
  type TableSummary,
  type TestConnectionResult,
  type TriggerSummary,
  type ViewSummary,
} from './types';
import { parseMysqlExplainJson } from '../sql/explainParser';
import { diffSchemas as runSchemaDiff, generateSqlDump } from '../sql/schemaDiff';

const te = new TextEncoder();
const td = new TextDecoder('utf-8');

const CLIENT_LONG_PASSWORD = 0x00000001;
const CLIENT_FOUND_ROWS = 0x00000002;
const CLIENT_LONG_FLAG = 0x00000004;
const CLIENT_CONNECT_WITH_DB = 0x00000008;
const CLIENT_PROTOCOL_41 = 0x00000200;
const CLIENT_SSL = 0x00000800;
const CLIENT_TRANSACTIONS = 0x00002000;
const CLIENT_SECURE_CONNECTION = 0x00008000;
const CLIENT_MULTI_STATEMENTS = 0x00010000;
const CLIENT_MULTI_RESULTS = 0x00020000;
const CLIENT_PS_MULTI_RESULTS = 0x00040000;
const CLIENT_PLUGIN_AUTH = 0x00080000;

const SERVER_STATUS_IN_TRANS = 0x0001;
const SERVER_MORE_RESULTS_EXISTS = 0x0008;

const MYSQL_FIELD_TYPES: Record<number, string> = {
  0x00: 'DECIMAL',
  0x01: 'TINYINT',
  0x02: 'SMALLINT',
  0x03: 'INT',
  0x04: 'FLOAT',
  0x05: 'DOUBLE',
  0x06: 'NULL',
  0x07: 'TIMESTAMP',
  0x08: 'BIGINT',
  0x09: 'MEDIUMINT',
  0x0a: 'DATE',
  0x0b: 'TIME',
  0x0c: 'DATETIME',
  0x0d: 'YEAR',
  0x0f: 'VARCHAR',
  0x10: 'BIT',
  0xf5: 'JSON',
  0xf6: 'DECIMAL',
  0xf7: 'ENUM',
  0xf8: 'SET',
  0xf9: 'TINYBLOB',
  0xfa: 'MEDIUMBLOB',
  0xfb: 'LONGBLOB',
  0xfc: 'BLOB',
  0xfd: 'VARCHAR',
  0xfe: 'CHAR',
  0xff: 'GEOMETRY',
};

function readLenEncInt(buf: Uint8Array, offset: number): { value: number; next: number } {
  const first = buf[offset];
  if (first < 0xfb) return { value: first, next: offset + 1 };
  if (first === 0xfc) {
    return { value: buf[offset + 1] | (buf[offset + 2] << 8), next: offset + 3 };
  }
  if (first === 0xfd) {
    return {
      value: buf[offset + 1] | (buf[offset + 2] << 8) | (buf[offset + 3] << 16),
      next: offset + 4,
    };
  }
  if (first === 0xfe) {
    const dv = new DataView(buf.buffer, buf.byteOffset + offset + 1, 8);
    const lo = dv.getUint32(0, true);
    const hi = dv.getUint32(4, true);
    return { value: hi * 0x100000000 + lo, next: offset + 9 };
  }
  return { value: -1, next: offset + 1 };
}

function readLenEncStr(buf: Uint8Array, offset: number): { value: string | null; next: number } {
  if (buf[offset] === 0xfb) return { value: null, next: offset + 1 };
  const { value: len, next } = readLenEncInt(buf, offset);
  const str = td.decode(buf.subarray(next, next + len));
  return { value: str, next: next + len };
}

function readLenEncBytes(buf: Uint8Array, offset: number): { value: Uint8Array | null; next: number } {
  if (buf[offset] === 0xfb) return { value: null, next: offset + 1 };
  const { value: len, next } = readLenEncInt(buf, offset);
  return { value: buf.slice(next, next + len), next: next + len };
}

function encodePacket(payload: Uint8Array, seq: number): Uint8Array {
  const header = new Uint8Array(4);
  header[0] = payload.length & 0xff;
  header[1] = (payload.length >>> 8) & 0xff;
  header[2] = (payload.length >>> 16) & 0xff;
  header[3] = seq & 0xff;
  return concatBytes(header, payload);
}

function parseErrPacket(payload: Uint8Array): QueryError {
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const code = dv.getUint16(1, true);
  let pos = 3;
  let sqlState = '';
  if (payload[pos] === 0x23) {
    sqlState = td.decode(payload.subarray(pos + 1, pos + 6));
    pos += 6;
  }
  const msg = td.decode(payload.subarray(pos));
  const lineMatch = /\bat line (\d+)\b/i.exec(msg);
  const line = lineMatch ? Number(lineMatch[1]) : undefined;
  return new QueryError(`MySQL Error ${code}${sqlState ? ` (${sqlState})` : ''}: ${msg}`, {
    code: sqlState || String(code),
    line,
    column: line ? 1 : undefined,
  });
}

async function nativePasswordAuth(password: string, scramble: Uint8Array): Promise<Uint8Array> {
  if (!password) return new Uint8Array(0);
  const s1 = await sha1(te.encode(password));
  const s2 = await sha1(s1);
  const mask = await sha1(concatBytes(scramble.subarray(0, 20), s2));
  return xorBytes(s1, mask);
}

async function cachingSha2Auth(password: string, scramble: Uint8Array): Promise<Uint8Array> {
  if (!password) return new Uint8Array(0);
  const s1 = await sha256(te.encode(password));
  const s2 = await sha256(s1);
  const mask = await sha256(concatBytes(s2, scramble.subarray(0, 20)));
  return xorBytes(s1, mask);
}

function decodeMysqlTextCell(
  colType: number,
  flags: number,
  bytes: Uint8Array | null,
): CellValue {
  if (bytes === null) return null;
  // Binary / BLOB (flag 0x80 = BINARY_FLAG on BLOB/BINARY types)
  if ((colType >= 0xf9 && colType <= 0xfc) && (flags & 0x80) !== 0 && colType !== 0xf5) {
    // Check if valid UTF-8 text vs binary blob (MySQL sends TEXT columns with type 0xfc and charset != 63)
    // We check charset via flags passed in caller
    return bytes;
  }
  const text = td.decode(bytes);
  switch (colType) {
    case 0x01: // TINYINT
    case 0x02: // SMALLINT
    case 0x03: // INT
    case 0x09: // MEDIUMINT
    case 0x0d: // YEAR
      return Number(text);
    case 0x08: { // BIGINT
      const n = Number(text);
      return Number.isSafeInteger(n) ? n : text;
    }
    case 0x04: // FLOAT
    case 0x05: // DOUBLE
      return Number(text);
    case 0xf5: // JSON
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    default:
      return text;
  }
}

interface ParsedHandshake {
  serverVersion: string;
  connectionId: number;
  capabilities: number;
  authPlugin: string;
  scramble: Uint8Array;
}

function parseHandshakeV10(payload: Uint8Array): ParsedHandshake {
  let p = 0;
  const proto = payload[p++];
  if (proto !== 10) throw new Error(`Unsupported MySQL protocol version: ${proto}`);
  const verEnd = payload.indexOf(0, p);
  const serverVersion = td.decode(payload.subarray(p, verEnd));
  p = verEnd + 1;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const connectionId = dv.getUint32(p, true);
  p += 4;
  const scramble1 = payload.subarray(p, p + 8);
  p += 9; // 8 bytes + filler 0x00
  const capLow = dv.getUint16(p, true);
  p += 2;
  let capabilities = capLow;
  let authDataLen = 0;
  let scramble2: Uint8Array = new Uint8Array(0);
  let authPlugin = 'mysql_native_password';

  if (p < payload.length) {
    p += 1; // charset
    p += 2; // status flags
    const capHigh = dv.getUint16(p, true);
    p += 2;
    capabilities = (capLow | (capHigh << 16)) >>> 0;
    authDataLen = (capabilities & CLIENT_PLUGIN_AUTH) ? payload[p] : 0;
    p += 1;
    p += 10; // reserved
    if (capabilities & CLIENT_SECURE_CONNECTION) {
      const len2 = Math.max(13, authDataLen - 8);
      const raw2 = payload.subarray(p, p + len2);
      scramble2 = raw2[raw2.length - 1] === 0 ? raw2.subarray(0, raw2.length - 1) : raw2;
      p += len2;
    }
    if ((capabilities & CLIENT_PLUGIN_AUTH) && p < payload.length) {
      const end = payload.indexOf(0, p);
      authPlugin = td.decode(payload.subarray(p, end < 0 ? payload.length : end));
    }
  }
  return {
    serverVersion,
    connectionId,
    capabilities,
    authPlugin,
    scramble: concatBytes(scramble1, scramble2),
  };
}

export class MysqlDriver implements RelationalDriver {
  readonly engine: DatabaseEngineId;
  readonly family = 'mysql' as const;

  private stream: BufferedByteStream | null = null;
  private transport: ByteStreamTransport | null = null;
  private config: ConnectionConfig | null = null;
  private _connected = false;
  private _inTransaction = false;
  private _serverVersion = '';
  private _tlsActive = false;
  private connectionId = 0;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(engine: DatabaseEngineId = 'mysql') {
    this.engine = engine;
  }

  get connected(): boolean {
    return this._connected;
  }
  get inTransaction(): boolean {
    return this._inTransaction;
  }
  get serverVersion(): string {
    return this._serverVersion;
  }

  private async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => {});
    return run;
  }

  private async readPacket(): Promise<{ seq: number; payload: Uint8Array }> {
    if (!this.stream) throw new Error('MySQL connection is closed');
    const chunks: Uint8Array[] = [];
    let lastSeq = 0;
    while (true) {
      const hdr = await this.stream.readExact(4);
      const len = hdr[0] | (hdr[1] << 8) | (hdr[2] << 16);
      lastSeq = hdr[3];
      const part = len > 0 ? await this.stream.readExact(len) : new Uint8Array(0);
      chunks.push(part);
      if (len < 0xffffff) break;
    }
    return { seq: lastSeq, payload: chunks.length === 1 ? chunks[0] : concatBytes(...chunks) };
  }

  private async writePacket(payload: Uint8Array, seq: number): Promise<void> {
    if (!this.stream) throw new Error('MySQL connection is closed');
    let offset = 0;
    let curSeq = seq;
    while (true) {
      const chunkLen = Math.min(0xffffff, payload.length - offset);
      const chunk = payload.subarray(offset, offset + chunkLen);
      await this.stream.write(encodePacket(chunk, curSeq));
      curSeq = (curSeq + 1) & 0xff;
      offset += chunkLen;
      if (chunkLen < 0xffffff) break;
    }
  }

  async connect(config: ConnectionConfig, transport?: ByteStreamTransport): Promise<ConnectionInfo> {
    if (!transport) throw new Error('MySQL driver requires a ByteStreamTransport');
    const started = performance.now();
    this.config = config;
    this.transport = transport;
    const host = config.host ?? '127.0.0.1';
    const port = config.port ?? 3306;
    const database = config.database ?? '';
    const username = config.username ?? 'root';
    const password = config.password ?? '';
    const tlsMode = config.tlsMode ?? 'prefer';

    const rawStream = await transport.connect({
      host,
      port,
      tls: false,
      servername: host,
      allowSelfSigned: config.allowSelfSigned ?? tlsMode !== 'verify-full',
      caPem: config.caPem,
      timeoutMs: config.timeoutMs ?? 15000,
    });
    const bs = new BufferedByteStream(rawStream);
    this.stream = bs;

    try {
      const greetingPkt = await this.readPacket();
      if (greetingPkt.payload[0] === 0xff) {
        throw parseErrPacket(greetingPkt.payload);
      }
      const hs = parseHandshakeV10(greetingPkt.payload);
      this._serverVersion = hs.serverVersion;
      this.connectionId = hs.connectionId;

      let clientCaps =
        CLIENT_LONG_PASSWORD |
        CLIENT_FOUND_ROWS |
        CLIENT_LONG_FLAG |
        CLIENT_PROTOCOL_41 |
        CLIENT_TRANSACTIONS |
        CLIENT_SECURE_CONNECTION |
        CLIENT_MULTI_STATEMENTS |
        CLIENT_MULTI_RESULTS |
        CLIENT_PS_MULTI_RESULTS |
        CLIENT_PLUGIN_AUTH;
      if (database) clientCaps |= CLIENT_CONNECT_WITH_DB;

      let seq = 1;
      const serverHasSsl = (hs.capabilities & CLIENT_SSL) !== 0;
      if (tlsMode !== 'disable') {
        if (serverHasSsl) {
          clientCaps |= CLIENT_SSL;
          const sslBody = new Uint8Array(32);
          const sv = new DataView(sslBody.buffer);
          sv.setUint32(0, clientCaps, true);
          sv.setUint32(4, 0x01000000, true);
          sslBody[8] = 45; // utf8mb4
          await this.writePacket(sslBody, seq++);
          await bs.upgradeTls({
            servername: host,
            allowSelfSigned: config.allowSelfSigned ?? tlsMode !== 'verify-full',
            caPem: config.caPem,
          });
          this._tlsActive = true;
        } else if (tlsMode === 'require' || tlsMode === 'verify-full') {
          throw new Error('MySQL server does not advertise SSL/TLS support');
        }
      }

      // Compute initial auth response
      let currentPlugin = hs.authPlugin || 'mysql_native_password';
      let currentScramble = hs.scramble;
      const authResp = await this.computeAuthToken(currentPlugin, password, currentScramble);

      const header = new Uint8Array(32);
      const hv = new DataView(header.buffer);
      hv.setUint32(0, clientCaps, true);
      hv.setUint32(4, 0x01000000, true);
      header[8] = 45; // utf8mb4_general_ci

      const parts: Uint8Array[] = [
        header,
        te.encode(username + '\0'),
        new Uint8Array([authResp.length]),
        authResp,
      ];
      if (database) parts.push(te.encode(database + '\0'));
      parts.push(te.encode(currentPlugin + '\0'));

      await this.writePacket(concatBytes(...parts), seq++);

      // Auth negotiation loop
      while (true) {
        const pkt = await this.readPacket();
        const p = pkt.payload;
        seq = (pkt.seq + 1) & 0xff;

        if (p[0] === 0x00) {
          // OK
          break;
        }
        if (p[0] === 0xff) {
          throw parseErrPacket(p);
        }
        if (p[0] === 0xfe) {
          // AuthSwitchRequest
          const nameEnd = p.indexOf(0, 1);
          currentPlugin = td.decode(p.subarray(1, nameEnd < 0 ? p.length : nameEnd));
          const rawScramble = nameEnd >= 0 ? p.subarray(nameEnd + 1) : new Uint8Array(0);
          currentScramble =
            rawScramble.length > 0 && rawScramble[rawScramble.length - 1] === 0
              ? rawScramble.subarray(0, rawScramble.length - 1)
              : rawScramble;
          const switchToken = await this.computeAuthToken(currentPlugin, password, currentScramble);
          await this.writePacket(switchToken, seq++);
          continue;
        }
        if (p[0] === 0x01 && currentPlugin === 'caching_sha2_password') {
          if (p[1] === 0x03) {
            // Fast auth succeeded; next packet will be OK
            continue;
          }
          if (p[1] === 0x04) {
            // Perform full authentication
            const passNul = concatBytes(te.encode(password), new Uint8Array([0]));
            if (this._tlsActive) {
              await this.writePacket(passNul, seq++);
            } else {
              // Request RSA public key (0x02)
              await this.writePacket(new Uint8Array([0x02]), seq++);
              const keyPkt = await this.readPacket();
              seq = (keyPkt.seq + 1) & 0xff;
              if (keyPkt.payload[0] === 0xff) throw parseErrPacket(keyPkt.payload);
              const pem = td.decode(keyPkt.payload.subarray(1));
              const xored = new Uint8Array(passNul.length);
              for (let i = 0; i < passNul.length; i++) {
                xored[i] = passNul[i] ^ currentScramble[i % currentScramble.length];
              }
              const encrypted = await rsaOaepEncryptPem(pem, xored);
              await this.writePacket(encrypted, seq++);
            }
            continue;
          }
        }
        throw new Error(`Unexpected MySQL auth packet 0x${p[0].toString(16)}`);
      }

      this._connected = true;
      return {
        engine: this.engine,
        family: 'mysql',
        serverVersion: this._serverVersion,
        database,
        tlsActive: this._tlsActive,
        latencyMs: Math.round(performance.now() - started),
        connectionId: this.connectionId,
      };
    } catch (error) {
      await bs.close().catch(() => {});
      this.stream = null;
      this._connected = false;
      throw error;
    }
  }

  private async computeAuthToken(
    plugin: string,
    password: string,
    scramble: Uint8Array,
  ): Promise<Uint8Array> {
    if (plugin === 'caching_sha2_password') {
      return cachingSha2Auth(password, scramble);
    }
    if (plugin === 'mysql_clear_password') {
      return concatBytes(te.encode(password), new Uint8Array([0]));
    }
    return nativePasswordAuth(password, scramble);
  }

  async switchDatabase(db: string): Promise<ConnectionInfo> {
    const started = performance.now();
    await this.query(`USE ${quoteIdent(db, 'mysql')}`);
    if (this.config) this.config = { ...this.config, database: db };
    return {
      engine: this.engine,
      family: 'mysql',
      serverVersion: this._serverVersion,
      database: db,
      tlsActive: this._tlsActive,
      latencyMs: Math.round(performance.now() - started),
      connectionId: this.connectionId,
    };
  }

  async testConnection(): Promise<TestConnectionResult> {
    const started = performance.now();
    try {
      const res = await this.query('SELECT VERSION()');
      const ver = String(res.results[0]?.rows[0]?.[0] ?? this._serverVersion);
      return {
        ok: true,
        serverVersion: ver,
        latencyMs: Math.round(performance.now() - started),
        tlsActive: this._tlsActive,
      };
    } catch (err) {
      return {
        ok: false,
        serverVersion: this._serverVersion,
        latencyMs: Math.round(performance.now() - started),
        tlsActive: this._tlsActive,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async close(): Promise<void> {
    this._connected = false;
    this._inTransaction = false;
    const bs = this.stream;
    this.stream = null;
    if (bs) {
      try {
        await bs.write(encodePacket(new Uint8Array([0x01]), 0)); // COM_QUIT
      } catch {
        // ignore
      }
      await bs.close().catch(() => {});
    }
  }

  async cancelQuery(): Promise<void> {
    if (!this.transport || !this.config || !this.connectionId) return;
    const side = new MysqlDriver(this.engine);
    try {
      await side.connect({ ...this.config, database: undefined }, this.transport);
      await side.query(`KILL QUERY ${this.connectionId}`);
    } finally {
      await side.close().catch(() => {});
    }
  }

  private parseColumnDef(payload: Uint8Array): {
    meta: ColumnMeta;
    colType: number;
    flags: number;
    charset: number;
  } {
    let p = 0;
    p = readLenEncStr(payload, p).next; // catalog
    p = readLenEncStr(payload, p).next; // schema
    const tbl = readLenEncStr(payload, p);
    p = tbl.next;
    p = readLenEncStr(payload, p).next; // org_table
    const name = readLenEncStr(payload, p);
    p = name.next;
    p = readLenEncStr(payload, p).next; // org_name
    p += 1; // filler 0x0c
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const charset = dv.getUint16(p, true);
    p += 2;
    p += 4; // column_length
    const colType = payload[p++];
    const flags = dv.getUint16(p, true);
    return {
      meta: {
        name: name.value ?? '',
        tableName: tbl.value ?? undefined,
        dataType: MYSQL_FIELD_TYPES[colType] ?? `TYPE(${colType})`,
        typeOid: colType,
        isPrimaryKey: (flags & 0x0002) !== 0,
        nullable: (flags & 0x0001) === 0,
      },
      colType,
      flags,
      charset,
    };
  }

  async query(sql: string, options?: QueryOptions): Promise<MultiQueryResult> {
    if (!this._connected || !this.stream) throw new Error('MySQL is not connected');
    const maxRows = options?.maxRows ?? 10000;
    const totalStart = performance.now();

    const onAbort = () => {
      void this.cancelQuery().catch(() => {});
    };
    options?.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      return await this.enqueue(async () => {
        const querySql = options?.params?.length
          ? interpolateParams(sql, options.params)
          : sql;
        const cmd = concatBytes(new Uint8Array([0x03]), te.encode(querySql)); // COM_QUERY
        await this.writePacket(cmd, 0);

        const results: QueryResultSet[] = [];
        let moreResults = true;

        while (moreResults) {
          moreResults = false;
          const resStart = performance.now();
          const first = await this.readPacket();
          const p = first.payload;

          if (p[0] === 0xff) {
            throw parseErrPacket(p);
          }

          if (p[0] === 0x00) {
            // OK packet
            const aff = readLenEncInt(p, 1);
            const ins = readLenEncInt(p, aff.next);
            const dv = new DataView(p.buffer, p.byteOffset + ins.next, 4);
            const statusFlags = dv.getUint16(0, true);
            const warnings = dv.getUint16(2, true);
            this._inTransaction = (statusFlags & SERVER_STATUS_IN_TRANS) !== 0;
            moreResults = (statusFlags & SERVER_MORE_RESULTS_EXISTS) !== 0;
            results.push({
              sql: querySql,
              columns: [],
              rows: [],
              rowCount: 0,
              affectedRows: aff.value,
              insertId: ins.value,
              warningCount: warnings,
              executionMs: Math.round(performance.now() - resStart),
              truncated: false,
              commandTag: 'OK',
            });
            continue;
          }

          // Resultset: first packet is column count
          const colCount = readLenEncInt(p, 0).value;
          const colDefs: Array<{ meta: ColumnMeta; colType: number; flags: number; charset: number }> = [];
          for (let i = 0; i < colCount; i++) {
            const colPkt = await this.readPacket();
            colDefs.push(this.parseColumnDef(colPkt.payload));
          }

          // EOF packet after column definitions
          const eof1 = await this.readPacket();
          if (eof1.payload[0] === 0xff) throw parseErrPacket(eof1.payload);

          // Row packets until EOF or ERR
          const rows: CellValue[][] = [];
          let truncated = false;
          while (true) {
            const rowPkt = await this.readPacket();
            const rp = rowPkt.payload;
            if (rp[0] === 0xff) throw parseErrPacket(rp);
            if (rp[0] === 0xfe && rp.length < 9) {
              if (rp.length >= 5) {
                const dv = new DataView(rp.buffer, rp.byteOffset + 1, 4);
                const statusFlags = dv.getUint16(2, true);
                this._inTransaction = (statusFlags & SERVER_STATUS_IN_TRANS) !== 0;
                moreResults = (statusFlags & SERVER_MORE_RESULTS_EXISTS) !== 0;
              }
              break;
            }
            if (rows.length < maxRows) {
              const row: CellValue[] = new Array(colCount);
              let off = 0;
              for (let c = 0; c < colCount; c++) {
                const cell = readLenEncBytes(rp, off);
                off = cell.next;
                const def = colDefs[c];
                // Treat BLOB as binary only if charset === 63 (binary)
                const effectiveFlags = def.charset === 63 ? def.flags : def.flags & ~0x80;
                row[c] = decodeMysqlTextCell(def.colType, effectiveFlags, cell.value);
              }
              rows.push(row);
            } else {
              truncated = true;
            }
          }

          results.push({
            sql: querySql,
            columns: colDefs.map((d) => d.meta),
            rows,
            rowCount: rows.length,
            affectedRows: 0,
            executionMs: Math.round(performance.now() - resStart),
            truncated,
            commandTag: 'SELECT',
          });
        }

        return {
          results,
          totalExecutionMs: Math.round(performance.now() - totalStart),
        };
      });
    } finally {
      options?.signal?.removeEventListener('abort', onAbort);
    }
  }

  async beginTransaction(): Promise<void> {
    await this.query('START TRANSACTION');
    this._inTransaction = true;
  }
  async commitTransaction(): Promise<void> {
    await this.query('COMMIT');
    this._inTransaction = false;
  }
  async rollbackTransaction(): Promise<void> {
    await this.query('ROLLBACK');
    this._inTransaction = false;
  }

  async listDatabases(): Promise<DatabaseInfo[]> {
    if (this.isOceanBaseOracle()) {
      const res = await this.query(
        `SELECT USERNAME FROM ALL_USERS
         WHERE USERNAME NOT IN ('SYS','LBACSYS','__public')
            OR USERNAME = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')
         ORDER BY USERNAME`,
      );
      return (res.results[0]?.rows ?? []).map((r) => ({
        name: String(r[0]),
      }));
    }
    const res = await this.query(
      'SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM INFORMATION_SCHEMA.SCHEMATA ORDER BY SCHEMA_NAME',
    );
    return (res.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      encoding: r[1] ? String(r[1]) : undefined,
      collation: r[2] ? String(r[2]) : undefined,
    }));
  }

  async listSchemas(db?: string): Promise<SchemaInfo[]> {
    if (db) return [{ name: db, isSystem: false }];
    const dbs = await this.listDatabases();
    return dbs.map((d) => ({
      name: d.name,
      isSystem: ['information_schema', 'mysql', 'performance_schema', 'sys'].includes(d.name.toLowerCase()),
    }));
  }

  private resolveDb(db?: string, schema?: string): string {
    return db || schema || this.config?.database || '';
  }

  private isOceanBaseOracle(): boolean {
    return this.engine === 'oceanbase-oracle';
  }

  async listTables(db?: string, schema?: string): Promise<TableSummary[]> {
    const targetDb = this.resolveDb(db, schema);
    if (this.isOceanBaseOracle()) {
      const owner = targetDb.toUpperCase();
      const res = await this.query(
        `SELECT TABLE_NAME, NUM_ROWS FROM ALL_TABLES WHERE OWNER = ? ORDER BY TABLE_NAME`,
        { params: [owner] },
      );
      return (res.results[0]?.rows ?? []).map((r) => ({
        name: String(r[0]),
        schema: owner,
        database: owner,
        kind: 'table',
        rowCountEstimate: r[1] != null ? Number(r[1]) : undefined,
      }));
    }
    const res = await this.query(
      `SELECT TABLE_NAME, ENGINE, TABLE_ROWS, (COALESCE(DATA_LENGTH,0) + COALESCE(INDEX_LENGTH,0)) AS size_bytes, TABLE_COMMENT
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
      { params: [targetDb] },
    );
    return (res.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      schema: targetDb,
      database: targetDb,
      kind: 'table',
      engine: r[1] ? String(r[1]) : undefined,
      rowCountEstimate: r[2] !== null ? Number(r[2]) : undefined,
      sizeBytes: r[3] !== null ? Number(r[3]) : undefined,
      comment: r[4] ? String(r[4]) : undefined,
    }));
  }

  async listViews(db?: string, schema?: string): Promise<ViewSummary[]> {
    const targetDb = this.resolveDb(db, schema);
    if (this.isOceanBaseOracle()) {
      const owner = targetDb.toUpperCase();
      const res = await this.query(
        `SELECT VIEW_NAME, TEXT FROM ALL_VIEWS WHERE OWNER = ? ORDER BY VIEW_NAME`,
        { params: [owner] },
      );
      return (res.results[0]?.rows ?? []).map((r) => ({
        name: String(r[0]),
        schema: owner,
        database: owner,
        definition: r[1] ? String(r[1]) : undefined,
      }));
    }
    const res = await this.query(
      `SELECT TABLE_NAME, VIEW_DEFINITION
       FROM INFORMATION_SCHEMA.VIEWS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME`,
      { params: [targetDb] },
    );
    return (res.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      schema: targetDb,
      database: targetDb,
      definition: r[1] ? String(r[1]) : undefined,
    }));
  }

  async listRoutines(db?: string, schema?: string): Promise<RoutineSummary[]> {
    const targetDb = this.resolveDb(db, schema);
    if (this.isOceanBaseOracle()) {
      const owner = targetDb.toUpperCase();
      const res = await this.query(
        `SELECT OBJECT_NAME, OBJECT_TYPE FROM ALL_OBJECTS WHERE OWNER = ? AND OBJECT_TYPE IN ('FUNCTION', 'PROCEDURE') ORDER BY OBJECT_NAME`,
        { params: [owner] },
      ).catch(() => null);
      return (res?.results[0]?.rows ?? []).map((r) => ({
        name: String(r[0]),
        schema: owner,
        database: owner,
        kind: String(r[1]).toUpperCase() === 'PROCEDURE' ? 'procedure' : 'function',
      }));
    }
    const res = await this.query(
      `SELECT ROUTINE_NAME, ROUTINE_TYPE, DTD_IDENTIFIER, ROUTINE_DEFINITION
       FROM INFORMATION_SCHEMA.ROUTINES
       WHERE ROUTINE_SCHEMA = ?
       ORDER BY ROUTINE_NAME`,
      { params: [targetDb] },
    );
    return (res.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      schema: targetDb,
      database: targetDb,
      kind: String(r[1]).toUpperCase() === 'PROCEDURE' ? 'procedure' : 'function',
      returnType: r[2] ? String(r[2]) : undefined,
      definition: r[3] ? String(r[3]) : undefined,
    }));
  }

  async listTriggers(db?: string, schema?: string): Promise<TriggerSummary[]> {
    const targetDb = this.resolveDb(db, schema);
    if (this.isOceanBaseOracle()) {
      const owner = targetDb.toUpperCase();
      const res = await this.query(
        `SELECT TRIGGER_NAME, TABLE_NAME, TRIGGER_TYPE, TRIGGERING_EVENT, TRIGGER_BODY, STATUS
         FROM ALL_TRIGGERS
         WHERE OWNER = ?
         ORDER BY TABLE_NAME, TRIGGER_NAME`,
        { params: [owner] },
      ).catch(() => null);
      return (res?.results[0]?.rows ?? []).map((r) => {
        const triggerType = String(r[2] ?? '').toUpperCase();
        const timing = triggerType.includes('BEFORE')
          ? 'BEFORE'
          : triggerType.includes('AFTER')
            ? 'AFTER'
            : 'INSTEAD OF';
        return {
          name: String(r[0]),
          schema: owner,
          database: owner,
          tableName: String(r[1] ?? ''),
          timing,
          event: r[3] ? String(r[3]) : undefined,
          definition: r[4] ? String(r[4]) : undefined,
          enabled: r[5] != null ? String(r[5]).toUpperCase() === 'ENABLED' : true,
        };
      });
    }
    const res = await this.query(
      `SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT
       FROM INFORMATION_SCHEMA.TRIGGERS
       WHERE TRIGGER_SCHEMA = ?
       ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME`,
      { params: [targetDb] },
    );
    return (res.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      schema: targetDb,
      database: targetDb,
      tableName: String(r[1]),
      timing: r[2] ? String(r[2]) : undefined,
      event: r[3] ? String(r[3]) : undefined,
      definition: r[4] ? String(r[4]) : undefined,
    }));
  }

  async listEvents(db?: string, schema?: string): Promise<EventSummary[]> {
    const targetDb = this.resolveDb(db, schema);
    const res = await this.query(
      `SELECT EVENT_NAME, EVENT_TYPE, EXECUTE_AT, INTERVAL_VALUE, INTERVAL_FIELD,
              STARTS, ENDS, STATUS, ON_COMPLETION, EVENT_COMMENT, EVENT_DEFINITION, LAST_EXECUTED
       FROM INFORMATION_SCHEMA.EVENTS
       WHERE EVENT_SCHEMA = ?
       ORDER BY EVENT_NAME`,
      { params: [targetDb] },
    ).catch(() => null);
    return (res?.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      schema: targetDb,
      database: targetDb,
      eventType: r[1] ? String(r[1]) : undefined,
      executeAt: r[2] != null ? String(r[2]) : null,
      intervalValue: r[3] != null ? String(r[3]) : null,
      intervalField: r[4] != null ? String(r[4]) : null,
      starts: r[5] != null ? String(r[5]) : null,
      ends: r[6] != null ? String(r[6]) : null,
      status: r[7] ? String(r[7]) : undefined,
      onCompletion: r[8] ? String(r[8]) : undefined,
      comment: r[9] ? String(r[9]) : undefined,
      definition: r[10] ? String(r[10]) : undefined,
      lastExecuted: r[11] != null ? String(r[11]) : null,
    }));
  }

  async getObjectDefinition(db: string, schema: string, name: string, kind: string): Promise<string> {
    const targetDb = this.resolveDb(db, schema);
    if (this.isOceanBaseOracle()) {
      const owner = targetDb.toUpperCase();
      const objName = name.toUpperCase();
      const ddlTypeMap: Record<string, string> = {
        table: 'TABLE',
        view: 'VIEW',
        materialized_view: 'MATERIALIZED_VIEW',
        procedure: 'PROCEDURE',
        function: 'FUNCTION',
        trigger: 'TRIGGER',
        sequence: 'SEQUENCE',
        synonym: 'SYNONYM',
      };
      const ddlType = ddlTypeMap[kind] ?? 'TABLE';
      try {
        const r = owner
          ? await this.query(`SELECT DBMS_METADATA.GET_DDL(?, ?, ?) FROM DUAL`, {
              params: [ddlType, objName, owner],
            })
          : await this.query(`SELECT DBMS_METADATA.GET_DDL(?, ?) FROM DUAL`, {
              params: [ddlType, objName],
            });
        const ddl = r.results[0]?.rows[0]?.[0];
        if (ddl) return String(ddl).trim();
      } catch {
        // Fallback to ALL_VIEWS / ALL_SOURCE when DBMS_METADATA is unavailable
      }
      if (kind === 'view') {
        const vr = await this.query(
          `SELECT TEXT FROM ALL_VIEWS WHERE OWNER = ? AND VIEW_NAME = ?`,
          { params: [owner, objName] },
        ).catch(() => null);
        const text = vr?.results[0]?.rows[0]?.[0];
        return text ? `CREATE OR REPLACE VIEW "${owner}"."${objName}" AS\n${String(text).trim()};` : '';
      }
      if (kind === 'procedure' || kind === 'function' || kind === 'trigger') {
        const sr = await this.query(
          `SELECT TEXT FROM ALL_SOURCE WHERE OWNER = ? AND NAME = ? AND TYPE = ? ORDER BY LINE`,
          { params: [owner, objName, kind.toUpperCase()] },
        ).catch(() => null);
        const joined = (sr?.results[0]?.rows ?? []).map((row) => String(row[0] ?? '')).join('');
        if (!joined.trim()) return '';
        return /^CREATE\b/i.test(joined.trim()) ? joined.trim() : `CREATE OR REPLACE ${joined.trim()}`;
      }
      return '';
    }
    const qObj = qualifiedTableName(targetDb, targetDb, name, 'mysql');
    if (kind === 'view') {
      const r = await this.query(`SHOW CREATE VIEW ${qObj}`);
      return String(r.results[0]?.rows[0]?.[1] ?? '');
    }
    if (kind === 'procedure') {
      const r = await this.query(`SHOW CREATE PROCEDURE ${qObj}`);
      return String(r.results[0]?.rows[0]?.[2] ?? '');
    }
    if (kind === 'function') {
      const r = await this.query(`SHOW CREATE FUNCTION ${qObj}`);
      return String(r.results[0]?.rows[0]?.[2] ?? '');
    }
    if (kind === 'trigger') {
      const r = await this.query(`SHOW CREATE TRIGGER ${qObj}`);
      return String(r.results[0]?.rows[0]?.[2] ?? '');
    }
    if (kind === 'event') {
      const r = await this.query(`SHOW CREATE EVENT ${qObj}`);
      return String(r.results[0]?.rows[0]?.[3] ?? '');
    }
    const r = await this.query(`SHOW CREATE TABLE ${qObj}`);
    return String(r.results[0]?.rows[0]?.[1] ?? '');
  }

  async listTablePartitions(db: string, schema: string, table: string): Promise<PartitionSummary[]> {
    const targetDb = this.resolveDb(db, schema);
    const res = await this.query(
      `SELECT PARTITION_NAME, SUBPARTITION_NAME, PARTITION_METHOD, PARTITION_EXPRESSION,
              PARTITION_DESCRIPTION, TABLE_ROWS, DATA_LENGTH
       FROM INFORMATION_SCHEMA.PARTITIONS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND PARTITION_NAME IS NOT NULL
       ORDER BY PARTITION_ORDINAL_POSITION`,
      { params: [targetDb, table] },
    ).catch(() => null);
    return (res?.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      subpartitionName: r[1] ? String(r[1]) : null,
      method: r[2] ? String(r[2]) : undefined,
      expression: r[3] ? String(r[3]) : undefined,
      bound: r[4] ? String(r[4]) : undefined,
      rowCountEstimate: r[5] != null ? Number(r[5]) : undefined,
      sizeBytes: r[6] != null ? Number(r[6]) : undefined,
    }));
  }

  async createDatabase(name: string, options?: { charset?: string; collation?: string }): Promise<void> {
    const parts = [`CREATE DATABASE ${quoteIdent(name, 'mysql')}`];
    if (options?.charset) parts.push(`CHARACTER SET ${options.charset.replace(/[^a-zA-Z0-9_]/g, '')}`);
    if (options?.collation) parts.push(`COLLATE ${options.collation.replace(/[^a-zA-Z0-9_]/g, '')}`);
    await this.query(`${parts.join(' ')};`);
  }

  async listProcesses(): Promise<ProcessEntry[]> {
    const res = await this.query('SHOW FULL PROCESSLIST');
    return (res.results[0]?.rows ?? []).map((r) => ({
      id: String(r[0]),
      user: String(r[1] ?? ''),
      host: String(r[2] ?? ''),
      database: r[3] ? String(r[3]) : '',
      command: r[4] ? String(r[4]) : '',
      durationSec: r[5] != null ? Number(r[5]) : 0,
      state: r[6] ? String(r[6]) : '',
      sql: r[7] ? String(r[7]) : '',
    }));
  }

  async killProcess(id: string, mode: 'cancel' | 'terminate' = 'cancel'): Promise<void> {
    const connId = Number(id);
    if (!Number.isInteger(connId) || connId <= 0) throw new Error('Invalid MySQL thread ID');
    await this.query(mode === 'terminate' ? `KILL ${connId};` : `KILL QUERY ${connId};`);
  }

  async getServerStatus(): Promise<ServerStatusSnapshot> {
    const [statusRes, varsRes] = await Promise.all([
      this.query('SHOW GLOBAL STATUS').catch(() => null),
      this.query('SHOW GLOBAL VARIABLES').catch(() => null),
    ]);
    const map = new Map<string, string>();
    for (const r of statusRes?.results[0]?.rows ?? []) {
      map.set(String(r[0]).toLowerCase(), String(r[1] ?? '0'));
    }
    const num = (k: string) => Number(map.get(k) ?? 0) || 0;
    const reads = num('innodb_buffer_pool_reads');
    const requests = num('innodb_buffer_pool_read_requests');
    const cacheHitRatio = requests > 0 ? Math.round(((requests - reads) / requests) * 10000) / 100 : 100;
    return {
      engine: this.engine,
      timestamp: Date.now(),
      uptimeSeconds: num('uptime'),
      activeConnections: num('threads_running'),
      totalConnections: num('threads_connected'),
      qpsOrTps: num('questions'),
      cacheHitRatio,
      slowQueries: num('slow_queries'),
      bytesIn: num('bytes_received'),
      bytesOut: num('bytes_sent'),
      metrics: [
        { key: 'questions', label: 'Queries', value: String(num('questions')), group: 'Throughput' },
        { key: 'com_select', label: 'SELECTs', value: String(num('com_select')), group: 'Commands' },
        { key: 'com_insert', label: 'INSERTs', value: String(num('com_insert')), group: 'Commands' },
        { key: 'com_update', label: 'UPDATEs', value: String(num('com_update')), group: 'Commands' },
        { key: 'com_delete', label: 'DELETEs', value: String(num('com_delete')), group: 'Commands' },
        { key: 'buffer_hit', label: 'InnoDB Buffer Hit', value: `${cacheHitRatio}%`, group: 'Memory' },
      ],
      variables: (varsRes?.results[0]?.rows ?? []).slice(0, 350).map((r) => ({
        name: String(r[0]),
        value: String(r[1] ?? ''),
      })),
    };
  }

  async listUsers(): Promise<DatabaseUserSummary[]> {
    try {
      const res = await this.query(
        `SELECT User, Host, plugin, account_locked FROM mysql.user ORDER BY User, Host`,
      );
      return (res.results[0]?.rows ?? []).map((r) => ({
        name: String(r[0]),
        host: String(r[1] ?? '%'),
        authPlugin: r[2] ? String(r[2]) : undefined,
        locked: String(r[3] ?? '').toUpperCase() === 'Y',
        canLogin: true,
      }));
    } catch {
      const res = await this.query(
        `SELECT DISTINCT GRANTEE FROM INFORMATION_SCHEMA.USER_PRIVILEGES ORDER BY GRANTEE`,
      ).catch(() => null);
      return (res?.results[0]?.rows ?? []).map((r) => ({
        name: String(r[0]).replaceAll("'", ''),
        canLogin: true,
      }));
    }
  }

  async getUserGrants(user: string, host = '%'): Promise<string[]> {
    const escU = user.replaceAll("'", "''");
    const escH = host.replaceAll("'", "''");
    const res = await this.query(`SHOW GRANTS FOR '${escU}'@'${escH}'`).catch(() => null);
    return (res?.results[0]?.rows ?? []).map((r) => String(r[0]));
  }

  async getTableStructure(db: string, schema: string, table: string): Promise<TableStructure> {
    const targetDb = this.resolveDb(db, schema);
    if (this.isOceanBaseOracle()) {
      const owner = targetDb.toUpperCase();
      const tbl = table.toUpperCase();
      const [colsRes, idxRes, fkRes, ddlRes] = await Promise.all([
        this.query(
          `SELECT c.COLUMN_NAME, c.DATA_TYPE, c.NULLABLE, c.DATA_DEFAULT,
                  c.DATA_LENGTH, c.DATA_PRECISION, c.DATA_SCALE,
                  CASE WHEN cc.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PK
           FROM ALL_TAB_COLUMNS c
           LEFT JOIN (
             SELECT cols.OWNER, cols.TABLE_NAME, cols.COLUMN_NAME
             FROM ALL_CONS_COLUMNS cols
             JOIN ALL_CONSTRAINTS con ON con.CONSTRAINT_NAME = cols.CONSTRAINT_NAME AND con.OWNER = cols.OWNER
             WHERE con.CONSTRAINT_TYPE = 'P'
           ) cc ON cc.OWNER = c.OWNER AND cc.TABLE_NAME = c.TABLE_NAME AND cc.COLUMN_NAME = c.COLUMN_NAME
           WHERE c.OWNER = ? AND c.TABLE_NAME = ?
           ORDER BY c.COLUMN_ID`,
          { params: [owner, tbl] },
        ),
        this.query(
          `SELECT ai.INDEX_NAME, ai.UNIQUENESS, ai.INDEX_TYPE, aic.COLUMN_NAME,
                  CASE WHEN ac.CONSTRAINT_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PRIMARY
           FROM ALL_INDEXES ai
           JOIN ALL_IND_COLUMNS aic ON ai.INDEX_NAME = aic.INDEX_NAME AND ai.OWNER = aic.INDEX_OWNER
             AND ai.TABLE_OWNER = aic.TABLE_OWNER AND ai.TABLE_NAME = aic.TABLE_NAME
           LEFT JOIN ALL_CONSTRAINTS ac ON ac.INDEX_NAME = ai.INDEX_NAME AND ac.OWNER = ai.TABLE_OWNER
             AND ac.TABLE_NAME = ai.TABLE_NAME AND ac.CONSTRAINT_TYPE = 'P'
           WHERE ai.TABLE_OWNER = ? AND ai.TABLE_NAME = ?
           ORDER BY ai.INDEX_NAME, aic.COLUMN_POSITION`,
          { params: [owner, tbl] },
        ).catch(() => null),
        this.query(
          `SELECT ac.CONSTRAINT_NAME, acc.COLUMN_NAME, ac2.OWNER, ac2.TABLE_NAME, acc2.COLUMN_NAME
           FROM ALL_CONSTRAINTS ac
           JOIN ALL_CONS_COLUMNS acc ON ac.CONSTRAINT_NAME = acc.CONSTRAINT_NAME AND ac.OWNER = acc.OWNER
           JOIN ALL_CONSTRAINTS ac2 ON ac.R_CONSTRAINT_NAME = ac2.CONSTRAINT_NAME AND ac.R_OWNER = ac2.OWNER
           JOIN ALL_CONS_COLUMNS acc2 ON ac2.CONSTRAINT_NAME = acc2.CONSTRAINT_NAME AND ac2.OWNER = acc2.OWNER
             AND acc.POSITION = acc2.POSITION
           WHERE ac.CONSTRAINT_TYPE = 'R' AND ac.OWNER = ? AND ac.TABLE_NAME = ?
           ORDER BY ac.CONSTRAINT_NAME, acc.POSITION`,
          { params: [owner, tbl] },
        ).catch(() => null),
        this.query(`SELECT DBMS_METADATA.GET_DDL('TABLE', ?, ?) FROM DUAL`, { params: [tbl, owner] }).catch(() => null),
      ]);

      const fkMap = new Map<string, ForeignKeyStructure>();
      for (const r of fkRes?.results[0]?.rows ?? []) {
        const name = String(r[0]);
        let fk = fkMap.get(name);
        if (!fk) {
          fk = {
            name,
            columns: [],
            referencedSchema: String(r[2] ?? owner),
            referencedTable: String(r[3] ?? ''),
            referencedColumns: [],
          };
          fkMap.set(name, fk);
        }
        fk.columns.push(String(r[1]));
        fk.referencedColumns.push(String(r[4]));
      }
      const foreignKeys = Array.from(fkMap.values());
      const fkColSet = new Set(foreignKeys.flatMap((fk) => fk.columns));

      const columns: ColumnStructure[] = (colsRes.results[0]?.rows ?? []).map((r) => {
        const colName = String(r[0]);
        const baseType = String(r[1] ?? 'VARCHAR2');
        const len = r[4] != null ? Number(r[4]) : null;
        const prec = r[5] != null ? Number(r[5]) : null;
        const scale = r[6] != null ? Number(r[6]) : null;
        let dataType = baseType;
        if (baseType.toUpperCase() === 'NUMBER' && prec != null) {
          dataType = scale != null && scale > 0 ? `NUMBER(${prec},${scale})` : `NUMBER(${prec})`;
        } else if (/^(N?VARCHAR2|N?CHAR|RAW)$/i.test(baseType) && len != null) {
          dataType = `${baseType}(${len})`;
        }
        return {
          name: colName,
          dataType,
          nullable: String(r[2]).toUpperCase() === 'Y',
          defaultValue: r[3] != null ? String(r[3]).trim() : null,
          isPrimaryKey: Number(r[7]) === 1,
          isForeignKey: fkColSet.has(colName),
          isAutoIncrement: false,
          maxLength: len,
          numericPrecision: prec,
          numericScale: scale,
        };
      });

      const indexMap = new Map<string, IndexStructure>();
      for (const r of idxRes?.results[0]?.rows ?? []) {
        const name = String(r[0]);
        let idx = indexMap.get(name);
        if (!idx) {
          idx = {
            name,
            unique: String(r[1]).toUpperCase() === 'UNIQUE',
            primary: Number(r[4]) === 1,
            type: r[2] ? String(r[2]) : undefined,
            columns: [],
          };
          indexMap.set(name, idx);
        }
        if (r[3]) idx.columns.push(String(r[3]));
      }

      const ddlText = ddlRes?.results[0]?.rows[0]?.[0]
        ? String(ddlRes.results[0].rows[0][0]).trim()
        : buildCreateTableDdl('postgres', owner, owner, {
            name: tbl,
            columns: columns.map((c) => ({
              name: c.name,
              dataType: c.dataType,
              nullable: c.nullable,
              defaultValue: c.defaultValue,
              isPrimaryKey: c.isPrimaryKey,
            })),
          });

      return {
        database: owner,
        schema: owner,
        table: tbl,
        objectKind: 'table',
        columns,
        indexes: Array.from(indexMap.values()),
        foreignKeys,
        checkConstraints: [],
        createDdl: ddlText,
      };
    }
    const qTable = qualifiedTableName(targetDb, targetDb, table, 'mysql');

    const [tblMetaRes, colsRes, idxRes, fkRes, ddlRes] = await Promise.all([
      this.query(
        `SELECT TABLE_TYPE, ENGINE, TABLE_COMMENT
         FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         LIMIT 1`,
        { params: [targetDb, table] },
      ),
      this.query(
        `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT,
                CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        { params: [targetDb, table] },
      ),
      this.query(
        `SELECT INDEX_NAME, NON_UNIQUE, INDEX_TYPE, COLUMN_NAME, SEQ_IN_INDEX
         FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
        { params: [targetDb, table] },
      ),
      this.query(
        `SELECT kcu.CONSTRAINT_NAME,
                kcu.COLUMN_NAME,
                kcu.REFERENCED_TABLE_SCHEMA,
                kcu.REFERENCED_TABLE_NAME,
                kcu.REFERENCED_COLUMN_NAME,
                rc.UPDATE_RULE,
                rc.DELETE_RULE
         FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
           ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
          AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
          AND rc.TABLE_NAME = kcu.TABLE_NAME
         WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ? AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
        { params: [targetDb, table] },
      ),
      this.query(`SHOW CREATE TABLE ${qTable}`).catch(() => null),
    ]);

    const tblMeta = tblMetaRes.results[0]?.rows[0];
    const tableTypeStr = tblMeta?.[0] ? String(tblMeta[0]).toUpperCase() : 'BASE TABLE';
    const objectKind: TableStructure['objectKind'] = tableTypeStr === 'VIEW' ? 'view' : 'table';

    const fkMap = new Map<string, ForeignKeyStructure>();
    for (const r of fkRes.results[0]?.rows ?? []) {
      const name = String(r[0]);
      let fk = fkMap.get(name);
      if (!fk) {
        fk = {
          name,
          columns: [],
          referencedSchema: String(r[2]),
          referencedTable: String(r[3]),
          referencedColumns: [],
          onUpdate: r[5] ? String(r[5]) : undefined,
          onDelete: r[6] ? String(r[6]) : undefined,
        };
        fkMap.set(name, fk);
      }
      fk.columns.push(String(r[1]));
      fk.referencedColumns.push(String(r[4]));
    }
    const foreignKeys = Array.from(fkMap.values());
    const fkColSet = new Set(foreignKeys.flatMap((fk) => fk.columns));

    const columns: ColumnStructure[] = (colsRes.results[0]?.rows ?? []).map((r) => {
      const name = String(r[0]);
      return {
        name,
        dataType: String(r[1]),
        nullable: String(r[2]).toUpperCase() === 'YES',
        defaultValue: r[3] !== null ? String(r[3]) : null,
        isPrimaryKey: String(r[4]).toUpperCase() === 'PRI',
        isForeignKey: fkColSet.has(name),
        isAutoIncrement: String(r[5] ?? '').toLowerCase().includes('auto_increment'),
        extra: r[5] ? String(r[5]) : null,
        comment: r[6] ? String(r[6]) : null,
        maxLength: r[7] !== null ? Number(r[7]) : null,
        numericPrecision: r[8] !== null ? Number(r[8]) : null,
        numericScale: r[9] !== null ? Number(r[9]) : null,
      };
    });

    const indexMap = new Map<string, IndexStructure>();
    for (const r of idxRes.results[0]?.rows ?? []) {
      const name = String(r[0]);
      let idx = indexMap.get(name);
      if (!idx) {
        idx = {
          name,
          unique: Number(r[1]) === 0,
          primary: name === 'PRIMARY',
          type: r[2] ? String(r[2]) : undefined,
          columns: [],
        };
        indexMap.set(name, idx);
      }
      if (r[3]) idx.columns.push(String(r[3]));
    }

    let createDdl = ddlRes?.results[0]?.rows[0]?.[1]
      ? String(ddlRes.results[0].rows[0][1]) + ';'
      : '';
    if (!createDdl && objectKind === 'view') {
      const viewDdlRes = await this.query(`SHOW CREATE VIEW ${qTable}`).catch(() => null);
      if (viewDdlRes?.results[0]?.rows[0]?.[1]) {
        createDdl = String(viewDdlRes.results[0].rows[0][1]) + ';';
      }
    }
    if (!createDdl) {
      createDdl = buildCreateTableDdl('mysql', targetDb, targetDb, {
        name: table,
        columns: columns.map((c) => ({
          name: c.name,
          dataType: c.dataType,
          nullable: c.nullable,
          defaultValue: c.defaultValue,
          isPrimaryKey: c.isPrimaryKey,
          isAutoIncrement: c.isAutoIncrement,
        })),
      });
    }

    return {
      database: targetDb,
      schema: targetDb,
      table,
      objectKind,
      columns,
      indexes: Array.from(indexMap.values()),
      foreignKeys,
      checkConstraints: [],
      createDdl,
      engine: tblMeta?.[1] ? String(tblMeta[1]) : undefined,
      comment: tblMeta?.[2] ? String(tblMeta[2]) : null,
    };
  }

  async getSchemaErGraph(db: string, schema = ''): Promise<SchemaErGraph> {
    const targetDb = this.resolveDb(db, schema);
    const tables = await this.listTables(targetDb, targetDb);
    const erTables: SchemaErTable[] = [];
    const edges: SchemaErEdge[] = [];
    for (const t of tables) {
      const struct = await this.getTableStructure(targetDb, targetDb, t.name);
      erTables.push({ name: t.name, schema: targetDb, columns: struct.columns });
      for (const fk of struct.foreignKeys) {
        edges.push({
          id: `${t.name}.${fk.name}`,
          name: fk.name,
          sourceTable: t.name,
          sourceColumns: fk.columns,
          targetTable: fk.referencedTable,
          targetColumns: fk.referencedColumns,
          onDelete: fk.onDelete,
          onUpdate: fk.onUpdate,
        });
      }
    }
    return { database: targetDb, schema: targetDb, tables: erTables, edges };
  }

  async browseTable(
    db: string,
    schema: string,
    table: string,
    options?: BrowseTableOptions,
  ): Promise<BrowseTableResult> {
    const targetDb = this.resolveDb(db, schema);
    const page = Math.max(1, options?.page ?? 1);
    const pageSize = Math.min(1000, Math.max(1, options?.pageSize ?? 50));
    const offset = (page - 1) * pageSize;
    const qTable = qualifiedTableName(targetDb, targetDb, table, 'mysql');

    const where = options?.whereClause?.trim() ? ` WHERE ${options.whereClause.trim()}` : '';
    const order = options?.sortBy
      ? ` ORDER BY ${quoteIdent(options.sortBy, 'mysql')} ${options.sortDir === 'desc' ? 'DESC' : 'ASC'}`
      : '';
    const dataSql = `SELECT * FROM ${qTable}${where}${order} LIMIT ${pageSize} OFFSET ${offset}`;
    const countSql = `SELECT COUNT(*) FROM ${qTable}${where}`;

    const started = performance.now();
    const dataRes = await this.query(dataSql, { maxRows: pageSize, signal: options?.signal });
    const countRes = await this.query(countSql, { maxRows: 1, signal: options?.signal });
    const rs = dataRes.results[0];
    const totalRows = Number(countRes.results[0]?.rows[0]?.[0] ?? rs?.rowCount ?? 0);

    return {
      database: targetDb,
      schema: targetDb,
      table,
      columns: rs?.columns ?? [],
      rows: rs?.rows ?? [],
      page,
      pageSize,
      totalRows,
      totalEstimated: false,
      executionMs: Math.round(performance.now() - started),
      sql: dataSql,
    };
  }

  generateBatchMutations(
    db: string,
    schema: string,
    table: string,
    structure: TableStructure,
    changes: BatchMutationChanges,
  ): BatchMutationPreview {
    return buildBatchMutations('mysql', this.resolveDb(db, schema), schema, table, structure, changes);
  }

  async applyBatchMutations(sqlStatements: readonly string[]): Promise<BatchMutationApplyResult> {
    const started = performance.now();
    let affectedRows = 0;
    const wasInTx = this._inTransaction;
    if (!wasInTx) await this.beginTransaction();
    try {
      for (const stmt of sqlStatements) {
        const res = await this.query(stmt);
        for (const r of res.results) affectedRows += r.affectedRows;
      }
      if (!wasInTx) await this.commitTransaction();
      return {
        applied: sqlStatements.length,
        affectedRows,
        executionMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      if (!wasInTx) await this.rollbackTransaction().catch(() => {});
      throw err;
    }
  }

  async explain(sql: string, analyze = false): Promise<ExplainResult> {
    if (analyze) {
      // MySQL 8 supports EXPLAIN ANALYZE (returns TREE text)
      const res = await this.query(`EXPLAIN ANALYZE ${sql}`);
      const text = (res.results[0]?.rows ?? []).map((r) => String(r[0] ?? '')).join('\n');
      return {
        dialect: 'mysql',
        analyzed: true,
        root: { id: 'mysql-analyze', nodeType: 'EXPLAIN ANALYZE', detail: text, children: [] },
        rawText: text,
      };
    }
    const res = await this.query(`EXPLAIN FORMAT=JSON ${sql}`);
    const raw = res.results[0]?.rows[0]?.[0];
    return parseMysqlExplainJson(raw, false);
  }

  generateAlterTableDdl(db: string, schema: string, table: string, diff: TableStructureDiff): string[] {
    return buildAlterTableDdl('mysql', this.resolveDb(db, schema), schema, table, diff);
  }

  generateCreateTableDdl(db: string, schema: string, spec: CreateTableSpec): string {
    return buildCreateTableDdl('mysql', this.resolveDb(db, schema), schema, spec);
  }

  async dropObject(
    db: string,
    schema: string,
    name: string,
    kind: DropObjectKind,
    cascade = false,
    tableName?: string,
  ): Promise<void> {
    await this.query(buildDropObjectSql('mysql', this.resolveDb(db, schema), schema, name, kind, cascade, tableName));
  }

  async truncateTable(db: string, schema: string, table: string, cascade = false): Promise<void> {
    await this.query(buildTruncateTableSql('mysql', this.resolveDb(db, schema), schema, table, cascade));
  }

  async dumpDatabaseSql(
    db: string,
    schema = '',
    tables?: string[],
    includeData = true,
  ): Promise<string> {
    const targetDb = this.resolveDb(db, schema);
    const list = tables ?? (await this.listTables(targetDb, targetDb)).map((t) => t.name);
    const dumpTables = [];
    for (const table of list) {
      const structure = await this.getTableStructure(targetDb, targetDb, table);
      let columns = structure.columns.map((c) => c.name);
      let rows: CellValue[][] = [];
      if (includeData) {
        const qTable = qualifiedTableName(targetDb, targetDb, table, 'mysql');
        const res = await this.query(`SELECT * FROM ${qTable}`, { maxRows: 50000 });
        columns = res.results[0]?.columns.map((c) => c.name) ?? columns;
        rows = res.results[0]?.rows ?? [];
      }
      dumpTables.push({ structure, columns, rows });
    }
    return generateSqlDump('mysql', targetDb, targetDb, dumpTables, includeData);
  }

  diffSchemas(leftSchema: SchemaSnapshot, rightSchema: SchemaSnapshot): SchemaDiffResult {
    return runSchemaDiff(leftSchema, rightSchema);
  }
}

function interpolateParams(sql: string, params: readonly (string | number | boolean | null)[]): string {
  let idx = 0;
  let out = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      out += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      out += ch;
      continue;
    }
    if (ch === '?' && !inSingle && !inDouble && idx < params.length) {
      const val = params[idx++];
      if (val === null || val === undefined) out += 'NULL';
      else if (typeof val === 'boolean') out += val ? '1' : '0';
      else if (typeof val === 'number') out += String(val);
      else out += "'" + String(val).replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Pure-TS Browser-Sandbox Apache Cassandra / ScyllaDB Driver (`family: 'cql'`).
 * Implements CQL Native Binary Protocol v4 over `ByteStream`:
 * - STARTUP, AUTHENTICATE -> AUTH_RESPONSE (PLAIN) -> AUTH_SUCCESS, READY, OPTIONS
 * - QUERY, RESULT (Void / Rows / Set_keyspace / Schema_change), ERROR
 * - Value decoders for ascii, text, varchar, int, smallint, tinyint, bigint, counter,
 *   boolean, float, double, decimal, varint, uuid, timeuuid, timestamp, date, time,
 *   inet, blob, list, set, map, custom
 * - `system_schema.{keyspaces,tables,views,columns,indexes,functions}` introspection
 *
 * 100% browser-sandbox compatible (zero `node:*` imports).
 */

import { BufferedByteStream, concatBytes } from './streamBuffer';
import {
  buildAlterTableDdl,
  buildBatchMutations,
  buildCreateTableDdl,
  buildDropObjectSql,
  buildTruncateTableSql,
  quoteIdent,
} from './sqlDialect';
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
  type DropObjectKind,
  type ExplainResult,
  type IndexStructure,
  type MultiQueryResult,
  type QueryOptions,
  type QueryResultSet,
  type RelationalDriver,
  type RoutineSummary,
  type SchemaDiffResult,
  type SchemaErGraph,
  type SchemaInfo,
  type SchemaSnapshot,
  type SqlDialect,
  type TableStructure,
  type TableStructureDiff,
  type TableSummary,
  type TestConnectionResult,
  type TriggerSummary,
  type ViewSummary,
} from './types';
import { diffSchemas as runSchemaDiff, generateSqlDump } from '../sql/schemaDiff';
import { splitSqlStatements } from '../sql/splitter';

const te = new TextEncoder();
const td = new TextDecoder('utf-8');

export const CQL_VERSION_REQUEST = 0x04;
export const CQL_VERSION_RESPONSE = 0x84;

export const CQL_OPCODE = {
  ERROR: 0x00,
  STARTUP: 0x01,
  READY: 0x02,
  AUTHENTICATE: 0x03,
  OPTIONS: 0x05,
  SUPPORTED: 0x06,
  QUERY: 0x07,
  RESULT: 0x08,
  PREPARE: 0x09,
  EXECUTE: 0x0a,
  AUTH_CHALLENGE: 0x0e,
  AUTH_RESPONSE: 0x0f,
  AUTH_SUCCESS: 0x10,
} as const;

export const CQL_RESULT_KIND = {
  VOID: 0x0001,
  ROWS: 0x0002,
  SET_KEYSPACE: 0x0003,
  PREPARED: 0x0004,
  SCHEMA_CHANGE: 0x0005,
} as const;

export const CQL_TYPE = {
  CUSTOM: 0x0000,
  ASCII: 0x0001,
  BIGINT: 0x0002,
  BLOB: 0x0003,
  BOOLEAN: 0x0004,
  COUNTER: 0x0005,
  DECIMAL: 0x0006,
  DOUBLE: 0x0007,
  FLOAT: 0x0008,
  INT: 0x0009,
  TEXT: 0x000a,
  TIMESTAMP: 0x000b,
  UUID: 0x000c,
  VARCHAR: 0x000d,
  VARINT: 0x000e,
  TIMEUUID: 0x000f,
  INET: 0x0010,
  DATE: 0x0011,
  TIME: 0x0012,
  SMALLINT: 0x0013,
  TINYINT: 0x0014,
  LIST: 0x0020,
  MAP: 0x0021,
  SET: 0x0022,
  UDT: 0x0030,
  TUPLE: 0x0031,
} as const;

const CQL_TYPE_NAMES: Record<number, string> = {
  [CQL_TYPE.CUSTOM]: 'custom',
  [CQL_TYPE.ASCII]: 'ascii',
  [CQL_TYPE.BIGINT]: 'bigint',
  [CQL_TYPE.BLOB]: 'blob',
  [CQL_TYPE.BOOLEAN]: 'boolean',
  [CQL_TYPE.COUNTER]: 'counter',
  [CQL_TYPE.DECIMAL]: 'decimal',
  [CQL_TYPE.DOUBLE]: 'double',
  [CQL_TYPE.FLOAT]: 'float',
  [CQL_TYPE.INT]: 'int',
  [CQL_TYPE.TEXT]: 'text',
  [CQL_TYPE.TIMESTAMP]: 'timestamp',
  [CQL_TYPE.UUID]: 'uuid',
  [CQL_TYPE.VARCHAR]: 'varchar',
  [CQL_TYPE.VARINT]: 'varint',
  [CQL_TYPE.TIMEUUID]: 'timeuuid',
  [CQL_TYPE.INET]: 'inet',
  [CQL_TYPE.DATE]: 'date',
  [CQL_TYPE.TIME]: 'time',
  [CQL_TYPE.SMALLINT]: 'smallint',
  [CQL_TYPE.TINYINT]: 'tinyint',
  [CQL_TYPE.LIST]: 'list',
  [CQL_TYPE.MAP]: 'map',
  [CQL_TYPE.SET]: 'set',
  [CQL_TYPE.UDT]: 'udt',
  [CQL_TYPE.TUPLE]: 'tuple',
};

export interface CqlFrameHeader {
  version: number;
  flags: number;
  stream: number;
  opcode: number;
  length: number;
}

export interface CqlTypeOption {
  typeId: number;
  customClass?: string;
  subTypes?: CqlTypeOption[];
}

export interface CqlColumnSpec {
  keyspace: string;
  table: string;
  name: string;
  type: CqlTypeOption;
  dataType: string;
}

export type CqlParsedResult =
  | { kind: 'void' }
  | { kind: 'set_keyspace'; keyspace: string }
  | { kind: 'schema_change'; changeType: string; target: string; options: string[] }
  | { kind: 'rows'; columns: CqlColumnSpec[]; rows: CellValue[][]; pagingState?: Uint8Array };

/* ============================================================================
 * Pure Binary CQL v4 Frame & Type Codecs
 * ============================================================================ */

function writeUint16BE(v: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v & 0xffff, false);
  return b;
}

function writeInt32BE(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v, false);
  return b;
}

function encodeCqlString(text: string): Uint8Array {
  const raw = te.encode(text);
  return concatBytes(writeUint16BE(raw.length), raw);
}

function encodeCqlLongString(text: string): Uint8Array {
  const raw = te.encode(text);
  return concatBytes(writeInt32BE(raw.length), raw);
}

function encodeCqlBytes(data: Uint8Array): Uint8Array {
  return concatBytes(writeInt32BE(data.length), data);
}

/**
 * Encode a CQL Native Protocol v4 request frame (9-byte header + body).
 */
export function encodeCqlFrame(
  opcode: number,
  streamId: number,
  body: Uint8Array = new Uint8Array(0),
  flags = 0,
): Uint8Array {
  const header = new Uint8Array(9);
  const view = new DataView(header.buffer);
  header[0] = CQL_VERSION_REQUEST;
  header[1] = flags;
  view.setInt16(2, streamId, false);
  header[4] = opcode;
  view.setInt32(5, body.length, false);
  return body.length > 0 ? concatBytes(header, body) : header;
}

/**
 * Decode a 9-byte CQL Native Protocol v4 frame header.
 */
export function decodeCqlFrameHeader(header: Uint8Array): CqlFrameHeader {
  if (header.length < 9) {
    throw new Error(`Invalid CQL frame header length: ${header.length}`);
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  return {
    version: header[0],
    flags: header[1],
    stream: view.getInt16(2, false),
    opcode: header[4],
    length: view.getInt32(5, false),
  };
}

/**
 * Encode STARTUP body: `[string map]` with `CQL_VERSION = 3.0.0`.
 */
export function encodeCqlStartupBody(cqlVersion = '3.0.0'): Uint8Array {
  return concatBytes(
    writeUint16BE(1),
    encodeCqlString('CQL_VERSION'),
    encodeCqlString(cqlVersion),
  );
}

/**
 * Encode SASL PLAIN AUTH_RESPONSE body: `[bytes]` = `\0username\0password`.
 */
export function encodeCqlAuthResponseBody(username: string, password: string): Uint8Array {
  const userBytes = te.encode(username);
  const passBytes = te.encode(password);
  const token = new Uint8Array(1 + userBytes.length + 1 + passBytes.length);
  token[0] = 0;
  token.set(userBytes, 1);
  token[1 + userBytes.length] = 0;
  token.set(passBytes, 2 + userBytes.length);
  return encodeCqlBytes(token);
}

/**
 * Encode QUERY body: `[long string]` + `[short consistency]` + `[byte flags]` + optional pageSize/pagingState.
 */
export function encodeCqlQueryBody(
  cql: string,
  options?: { consistency?: number; pageSize?: number; pagingState?: Uint8Array },
): Uint8Array {
  const parts: Uint8Array[] = [
    encodeCqlLongString(cql),
    writeUint16BE(options?.consistency ?? 0x0001), // ONE
  ];
  let flags = 0;
  if (options?.pageSize && options.pageSize > 0) flags |= 0x04;
  if (options?.pagingState && options.pagingState.length > 0) flags |= 0x08;
  parts.push(new Uint8Array([flags]));
  if (options?.pageSize && options.pageSize > 0) {
    parts.push(writeInt32BE(options.pageSize));
  }
  if (options?.pagingState && options.pagingState.length > 0) {
    parts.push(encodeCqlBytes(options.pagingState));
  }
  return concatBytes(...parts);
}

class CqlReader {
  offset = 0;
  private readonly view: DataView;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  readByte(): number {
    return this.data[this.offset++];
  }

  readUint16(): number {
    const v = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return v;
  }

  readInt32(): number {
    const v = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return v;
  }

  readString(): string {
    const len = this.readUint16();
    const slice = this.data.subarray(this.offset, this.offset + len);
    this.offset += len;
    return td.decode(slice);
  }

  readBytes(): Uint8Array | null {
    const len = this.readInt32();
    if (len < 0) return null;
    const slice = this.data.slice(this.offset, this.offset + len);
    this.offset += len;
    return slice;
  }

  readTypeOption(): CqlTypeOption {
    const typeId = this.readUint16();
    if (typeId === CQL_TYPE.CUSTOM) {
      return { typeId, customClass: this.readString() };
    }
    if (typeId === CQL_TYPE.LIST || typeId === CQL_TYPE.SET) {
      return { typeId, subTypes: [this.readTypeOption()] };
    }
    if (typeId === CQL_TYPE.MAP) {
      const k = this.readTypeOption();
      const v = this.readTypeOption();
      return { typeId, subTypes: [k, v] };
    }
    if (typeId === CQL_TYPE.TUPLE) {
      const count = this.readUint16();
      const subTypes: CqlTypeOption[] = [];
      for (let i = 0; i < count; i++) subTypes.push(this.readTypeOption());
      return { typeId, subTypes };
    }
    if (typeId === CQL_TYPE.UDT) {
      this.readString(); // keyspace
      this.readString(); // udt name
      const count = this.readUint16();
      const subTypes: CqlTypeOption[] = [];
      for (let i = 0; i < count; i++) {
        this.readString(); // field name
        subTypes.push(this.readTypeOption());
      }
      return { typeId, subTypes };
    }
    return { typeId };
  }
}

export function formatCqlTypeOption(opt: CqlTypeOption): string {
  if (opt.typeId === CQL_TYPE.CUSTOM) return opt.customClass || 'custom';
  if (opt.typeId === CQL_TYPE.LIST && opt.subTypes?.[0]) {
    return `list<${formatCqlTypeOption(opt.subTypes[0])}>`;
  }
  if (opt.typeId === CQL_TYPE.SET && opt.subTypes?.[0]) {
    return `set<${formatCqlTypeOption(opt.subTypes[0])}>`;
  }
  if (opt.typeId === CQL_TYPE.MAP && opt.subTypes?.[0] && opt.subTypes?.[1]) {
    return `map<${formatCqlTypeOption(opt.subTypes[0])}, ${formatCqlTypeOption(opt.subTypes[1])}>`;
  }
  return CQL_TYPE_NAMES[opt.typeId] || `type_${opt.typeId}`;
}

function readSignedBigIntBE(bytes: Uint8Array): bigint {
  if (bytes.length === 0) return 0n;
  let val = 0n;
  for (const b of bytes) {
    val = (val << 8n) | BigInt(b);
  }
  if (bytes[0] & 0x80) {
    const bits = BigInt(bytes.length * 8);
    val -= 1n << bits;
  }
  return val;
}

function formatUuidBytes(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  if (hex.length !== 32) return hex;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Decode a raw CQL v4 cell byte slice into a typed `CellValue`.
 */
export function decodeCqlValue(opt: CqlTypeOption, bytes: Uint8Array | null): CellValue {
  if (bytes === null) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  switch (opt.typeId) {
    case CQL_TYPE.ASCII:
    case CQL_TYPE.TEXT:
    case CQL_TYPE.VARCHAR:
      return td.decode(bytes);

    case CQL_TYPE.BOOLEAN:
      return bytes.length > 0 && bytes[0] !== 0;

    case CQL_TYPE.TINYINT:
      return bytes.length >= 1 ? view.getInt8(0) : 0;

    case CQL_TYPE.SMALLINT:
      return bytes.length >= 2 ? view.getInt16(0, false) : 0;

    case CQL_TYPE.INT:
      return bytes.length >= 4 ? view.getInt32(0, false) : 0;

    case CQL_TYPE.BIGINT:
    case CQL_TYPE.COUNTER: {
      if (bytes.length < 8) return 0;
      const bi = view.getBigInt64(0, false);
      const n = Number(bi);
      return Number.isSafeInteger(n) ? n : bi.toString();
    }

    case CQL_TYPE.FLOAT:
      return bytes.length >= 4 ? view.getFloat32(0, false) : 0;

    case CQL_TYPE.DOUBLE:
      return bytes.length >= 8 ? view.getFloat64(0, false) : 0;

    case CQL_TYPE.UUID:
    case CQL_TYPE.TIMEUUID:
      return formatUuidBytes(bytes);

    case CQL_TYPE.TIMESTAMP: {
      if (bytes.length < 8) return '';
      const ms = Number(view.getBigInt64(0, false));
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? String(ms) : d.toISOString();
    }

    case CQL_TYPE.DATE: {
      if (bytes.length < 4) return '';
      const daysSinceEpoch = view.getUint32(0, false) - 0x80000000;
      const d = new Date(daysSinceEpoch * 86400000);
      return Number.isNaN(d.getTime()) ? String(daysSinceEpoch) : d.toISOString().slice(0, 10);
    }

    case CQL_TYPE.TIME: {
      if (bytes.length < 8) return '';
      const ns = view.getBigInt64(0, false);
      const totalMs = Number(ns / 1000000n);
      const h = Math.floor(totalMs / 3600000);
      const m = Math.floor((totalMs % 3600000) / 60000);
      const s = Math.floor((totalMs % 60000) / 1000);
      const ms = totalMs % 1000;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
    }

    case CQL_TYPE.VARINT:
      return readSignedBigIntBE(bytes).toString();

    case CQL_TYPE.DECIMAL: {
      if (bytes.length < 4) return '0';
      const scale = view.getInt32(0, false);
      const unscaled = readSignedBigIntBE(bytes.subarray(4));
      if (scale <= 0) return (unscaled * 10n ** BigInt(-scale)).toString();
      const sign = unscaled < 0n ? '-' : '';
      const digits = (unscaled < 0n ? -unscaled : unscaled).toString().padStart(scale + 1, '0');
      const intPart = digits.slice(0, digits.length - scale);
      const fracPart = digits.slice(digits.length - scale);
      return `${sign}${intPart}.${fracPart}`;
    }

    case CQL_TYPE.INET: {
      if (bytes.length === 4) {
        return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
      }
      if (bytes.length === 16) {
        const groups: string[] = [];
        for (let i = 0; i < 16; i += 2) {
          groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
        }
        return groups.join(':');
      }
      return td.decode(bytes);
    }

    case CQL_TYPE.BLOB:
      return bytes;

    case CQL_TYPE.LIST:
    case CQL_TYPE.SET: {
      const r = new CqlReader(bytes);
      const count = r.readInt32();
      const elemType = opt.subTypes?.[0] ?? { typeId: CQL_TYPE.TEXT };
      const out: CellValue[] = [];
      for (let i = 0; i < count; i++) {
        out.push(decodeCqlValue(elemType, r.readBytes()));
      }
      return out;
    }

    case CQL_TYPE.MAP: {
      const r = new CqlReader(bytes);
      const count = r.readInt32();
      const keyType = opt.subTypes?.[0] ?? { typeId: CQL_TYPE.TEXT };
      const valType = opt.subTypes?.[1] ?? { typeId: CQL_TYPE.TEXT };
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < count; i++) {
        const k = decodeCqlValue(keyType, r.readBytes());
        const v = decodeCqlValue(valType, r.readBytes());
        obj[String(k)] = v;
      }
      return obj;
    }

    default:
      return bytes;
  }
}

export function decodeCqlError(body: Uint8Array): { code: number; message: string } {
  const r = new CqlReader(body);
  const code = r.readInt32();
  const message = r.readString();
  return { code, message };
}

export function decodeCqlResult(body: Uint8Array): CqlParsedResult {
  const r = new CqlReader(body);
  const kind = r.readInt32();

  if (kind === CQL_RESULT_KIND.VOID) {
    return { kind: 'void' };
  }

  if (kind === CQL_RESULT_KIND.SET_KEYSPACE) {
    return { kind: 'set_keyspace', keyspace: r.readString() };
  }

  if (kind === CQL_RESULT_KIND.SCHEMA_CHANGE) {
    const changeType = r.readString();
    const target = r.readString();
    const options: string[] = [];
    if (r.offset < body.length) options.push(r.readString());
    if (r.offset < body.length) options.push(r.readString());
    return { kind: 'schema_change', changeType, target, options };
  }

  if (kind === CQL_RESULT_KIND.ROWS) {
    const flags = r.readInt32();
    const colCount = r.readInt32();
    let pagingState: Uint8Array | undefined;
    if (flags & 0x0002) {
      pagingState = r.readBytes() ?? undefined;
    }
    let globalKs = '';
    let globalTbl = '';
    if (flags & 0x0001) {
      globalKs = r.readString();
      globalTbl = r.readString();
    }

    const columns: CqlColumnSpec[] = [];
    if (!(flags & 0x0004)) {
      for (let i = 0; i < colCount; i++) {
        const ks = flags & 0x0001 ? globalKs : r.readString();
        const tbl = flags & 0x0001 ? globalTbl : r.readString();
        const name = r.readString();
        const type = r.readTypeOption();
        columns.push({
          keyspace: ks,
          table: tbl,
          name,
          type,
          dataType: formatCqlTypeOption(type),
        });
      }
    }

    const rowCount = r.readInt32();
    const rows: CellValue[][] = [];
    for (let rowIdx = 0; rowIdx < rowCount; rowIdx++) {
      const row: CellValue[] = [];
      for (let colIdx = 0; colIdx < colCount; colIdx++) {
        const rawCell = r.readBytes();
        const colType = columns[colIdx]?.type ?? { typeId: CQL_TYPE.TEXT };
        row.push(decodeCqlValue(colType, rawCell));
      }
      rows.push(row);
    }

    return { kind: 'rows', columns, rows, pagingState };
  }

  return { kind: 'void' };
}

function escapeCqlString(val: string): string {
  return val.replaceAll("'", "''");
}

function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '');
}

/* ============================================================================
 * CassandraDriver (implements RelationalDriver)
 * ============================================================================ */

export class CassandraDriver implements RelationalDriver {
  readonly engine: DatabaseEngineId;
  readonly family = 'cql' as const;
  readonly dialect: SqlDialect = 'cql';

  private stream: BufferedByteStream | null = null;
  private config: ConnectionConfig | null = null;
  private _connected = false;
  private _inTransaction = false;
  private _serverVersion = '';
  private _tlsActive = false;
  private activeKeyspace = '';
  private nextStreamId = 1;
  private rpcChain: Promise<void> = Promise.resolve();

  constructor(engine: DatabaseEngineId = 'cassandra') {
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

  private requireStream(): BufferedByteStream {
    if (!this._connected || !this.stream) {
      throw new Error('Cassandra driver is not connected');
    }
    return this.stream;
  }

  private allocStreamId(): number {
    const id = this.nextStreamId;
    this.nextStreamId = this.nextStreamId >= 32000 ? 1 : this.nextStreamId + 1;
    return id;
  }

  private sendAndReceive(
    opcode: number,
    body: Uint8Array = new Uint8Array(0),
  ): Promise<{ header: CqlFrameHeader; body: Uint8Array }> {
    const run = async (): Promise<{ header: CqlFrameHeader; body: Uint8Array }> => {
      const bs = this.requireStream();
      const streamId = this.allocStreamId();
      const frame = encodeCqlFrame(opcode, streamId, body);
      await bs.write(frame);

      const respHeaderBytes = await bs.readExact(9);
      const header = decodeCqlFrameHeader(respHeaderBytes);
      const respBody = header.length > 0 ? await bs.readExact(header.length) : new Uint8Array(0);

      if (header.opcode === CQL_OPCODE.ERROR) {
        const err = decodeCqlError(respBody);
        throw new QueryError(err.message, { code: `0x${err.code.toString(16)}` });
      }
      return { header, body: respBody };
    };
    const next = this.rpcChain.then(run, run);
    this.rpcChain = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  async connect(config: ConnectionConfig, transport?: ByteStreamTransport): Promise<ConnectionInfo> {
    if (!transport) {
      throw new Error('Cassandra driver requires a ByteStreamTransport');
    }
    const started = performance.now();
    const port = config.port ?? 9042;
    const tls = config.tlsMode === 'require' || config.tlsMode === 'verify-full';

    const raw = await transport.connect({
      host: config.host || '127.0.0.1',
      port,
      tls,
      servername: config.host || '127.0.0.1',
      allowSelfSigned: config.allowSelfSigned,
      caPem: config.caPem,
      timeoutMs: config.timeoutMs ?? 15000,
    });

    this.stream = new BufferedByteStream(raw);
    this.config = { ...config, port };
    this._tlsActive = tls;
    this.activeKeyspace = config.database || config.schema || '';
    this._connected = true;

    try {
      const startupResp = await this.sendAndReceive(CQL_OPCODE.STARTUP, encodeCqlStartupBody());
      if (startupResp.header.opcode === CQL_OPCODE.AUTHENTICATE) {
        const authResp = await this.sendAndReceive(
          CQL_OPCODE.AUTH_RESPONSE,
          encodeCqlAuthResponseBody(config.username || '', config.password || ''),
        );
        if (authResp.header.opcode !== CQL_OPCODE.AUTH_SUCCESS) {
          throw new Error(`Unexpected CQL auth response opcode: ${authResp.header.opcode}`);
        }
      } else if (startupResp.header.opcode !== CQL_OPCODE.READY) {
        throw new Error(`Unexpected CQL startup response opcode: ${startupResp.header.opcode}`);
      }

      try {
        const verRes = await this.executeSingle('SELECT release_version FROM system.local');
        const v = verRes.rows[0]?.[0];
        this._serverVersion = v ? `Cassandra ${String(v)}` : 'Cassandra (CQL v4)';
      } catch {
        this._serverVersion = 'Cassandra (CQL v4)';
      }

      if (this.activeKeyspace) {
        await this.executeSingle(`USE ${quoteIdent(this.activeKeyspace, 'cql')}`).catch(() => {});
      }

      return {
        engine: this.engine,
        family: 'cql',
        serverVersion: this._serverVersion,
        database: this.activeKeyspace,
        tlsActive: this._tlsActive,
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      this._connected = false;
      await this.stream.close().catch(() => {});
      this.stream = null;
      throw err;
    }
  }

  async switchDatabase(db: string): Promise<ConnectionInfo> {
    this.requireStream();
    await this.executeSingle(`USE ${quoteIdent(db, 'cql')}`);
    this.activeKeyspace = db;
    return {
      engine: this.engine,
      family: 'cql',
      serverVersion: this._serverVersion,
      database: db,
      tlsActive: this._tlsActive,
      latencyMs: 0,
    };
  }

  async testConnection(): Promise<TestConnectionResult> {
    const started = performance.now();
    try {
      await this.sendAndReceive(CQL_OPCODE.OPTIONS);
      return {
        ok: true,
        serverVersion: this._serverVersion,
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
    if (this.stream) {
      await this.stream.close().catch(() => {});
      this.stream = null;
    }
  }

  async query(sql: string, options?: QueryOptions): Promise<MultiQueryResult> {
    this.requireStream();
    const totalStart = performance.now();
    const parts = splitSqlStatements(sql, 'cql');
    const stmts = parts.length > 0 ? parts.map((p) => p.sql) : [sql];
    const results: QueryResultSet[] = [];
    for (const stmt of stmts) {
      if (!stmt.trim()) continue;
      results.push(await this.executeSingle(stmt, options));
    }
    return {
      results,
      totalExecutionMs: Math.round(performance.now() - totalStart),
    };
  }

  private async executeSingle(sql: string, options?: QueryOptions): Promise<QueryResultSet> {
    const started = performance.now();
    const clean = stripTrailingSemicolon(sql);
    const body = encodeCqlQueryBody(clean, {
      pageSize: options?.maxRows ? Math.min(options.maxRows + 1, 5000) : 1000,
    });
    const resp = await this.sendAndReceive(CQL_OPCODE.QUERY, body);
    if (resp.header.opcode !== CQL_OPCODE.RESULT) {
      throw new QueryError(`Unexpected CQL response opcode: ${resp.header.opcode}`);
    }

    const parsed = decodeCqlResult(resp.body);
    if (parsed.kind === 'set_keyspace') {
      this.activeKeyspace = parsed.keyspace;
      return {
        sql,
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: 0,
        executionMs: Math.round(performance.now() - started),
        truncated: false,
        commandTag: `USE ${parsed.keyspace}`,
      };
    }
    if (parsed.kind === 'schema_change') {
      return {
        sql,
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: 0,
        executionMs: Math.round(performance.now() - started),
        truncated: false,
        commandTag: `${parsed.changeType} ${parsed.target}`,
      };
    }
    if (parsed.kind === 'rows') {
      const columns: ColumnMeta[] = parsed.columns.map((c) => ({
        name: c.name,
        dataType: c.dataType,
        tableName: c.table,
      }));
      const maxRows = options?.maxRows;
      const truncated = Boolean((maxRows && parsed.rows.length > maxRows) || parsed.pagingState);
      const rows = maxRows ? parsed.rows.slice(0, maxRows) : parsed.rows;
      return {
        sql,
        columns,
        rows,
        rowCount: rows.length,
        affectedRows: 0,
        executionMs: Math.round(performance.now() - started),
        truncated,
        commandTag: 'SELECT',
      };
    }

    return {
      sql,
      columns: [],
      rows: [],
      rowCount: 0,
      affectedRows: 0,
      executionMs: Math.round(performance.now() - started),
      truncated: false,
      commandTag: 'OK',
    };
  }

  async cancelQuery(): Promise<void> {
    // CQL v4 does not provide an out-of-band cancel opcode.
  }

  async beginTransaction(): Promise<void> {
    this.requireStream();
  }

  async commitTransaction(): Promise<void> {
    this.requireStream();
  }

  async rollbackTransaction(): Promise<void> {
    this.requireStream();
  }

  /* --------------------------------------------------------------------------
   * Metadata Introspection (`system_schema`)
   * -------------------------------------------------------------------------- */

  async listDatabases(): Promise<DatabaseInfo[]> {
    const res = await this.executeSingle('SELECT keyspace_name FROM system_schema.keyspaces');
    return res.rows.map((r) => ({ name: String(r[0]) })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async listSchemas(db?: string): Promise<SchemaInfo[]> {
    const ks = db || this.activeKeyspace;
    if (ks) {
      return [{ name: ks, isSystem: ks.startsWith('system') }];
    }
    const dbs = await this.listDatabases();
    return dbs.map((d) => ({ name: d.name, isSystem: d.name.startsWith('system') }));
  }

  async listTables(db?: string, schema?: string): Promise<TableSummary[]> {
    const ks = db || schema || this.activeKeyspace;
    if (!ks) return [];
    const res = await this.executeSingle(
      `SELECT table_name, comment FROM system_schema.tables WHERE keyspace_name = '${escapeCqlString(ks)}'`,
    );
    return res.rows
      .map((r) => ({
        name: String(r[0]),
        schema: ks,
        database: ks,
        kind: 'table' as const,
        comment: r[1] ? String(r[1]) : undefined,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listViews(db?: string, schema?: string): Promise<ViewSummary[]> {
    const ks = db || schema || this.activeKeyspace;
    if (!ks) return [];
    try {
      const res = await this.executeSingle(
        `SELECT view_name, base_table_name, where_clause FROM system_schema.views WHERE keyspace_name = '${escapeCqlString(ks)}'`,
      );
      return res.rows.map((r) => ({
        name: String(r[0]),
        schema: ks,
        database: ks,
        isMaterialized: true,
        definition: `Materialized view on ${String(r[1] ?? '')}${r[2] ? ` WHERE ${String(r[2])}` : ''}`,
      }));
    } catch {
      return [];
    }
  }

  async listRoutines(db?: string, schema?: string): Promise<RoutineSummary[]> {
    const ks = db || schema || this.activeKeyspace;
    if (!ks) return [];
    try {
      const res = await this.executeSingle(
        `SELECT function_name, return_type, language, body FROM system_schema.functions WHERE keyspace_name = '${escapeCqlString(ks)}'`,
      );
      return res.rows.map((r) => ({
        name: String(r[0]),
        schema: ks,
        database: ks,
        kind: 'function' as const,
        returnType: r[1] ? String(r[1]) : undefined,
        language: r[2] ? String(r[2]) : undefined,
        definition: r[3] ? String(r[3]) : undefined,
      }));
    } catch {
      return [];
    }
  }

  async listTriggers(): Promise<TriggerSummary[]> {
    return [];
  }

  async getTableStructure(db: string, schema: string, table: string): Promise<TableStructure> {
    const ks = db || schema || this.activeKeyspace;
    const colRes = await this.executeSingle(
      `SELECT column_name, kind, position, type FROM system_schema.columns WHERE keyspace_name = '${escapeCqlString(ks)}' AND table_name = '${escapeCqlString(table)}'`,
    );
    const idxRes = await this.executeSingle(
      `SELECT index_name, kind, options FROM system_schema.indexes WHERE keyspace_name = '${escapeCqlString(ks)}' AND table_name = '${escapeCqlString(table)}'`,
    ).catch(() => null);

    const partitionKeys: Array<{ name: string; pos: number }> = [];
    const clusteringKeys: Array<{ name: string; pos: number }> = [];
    const columns: ColumnStructure[] = colRes.rows.map((r) => {
      const name = String(r[0]);
      const kind = String(r[1] ?? 'regular');
      const pos = Number(r[2] ?? 0);
      const dataType = String(r[3] ?? 'text');
      const isPk = kind === 'partition_key' || kind === 'clustering';
      if (kind === 'partition_key') partitionKeys.push({ name, pos });
      if (kind === 'clustering') clusteringKeys.push({ name, pos });
      return {
        name,
        dataType,
        nullable: !isPk,
        defaultValue: null,
        isPrimaryKey: isPk,
        primaryKeyOrdinal: isPk ? pos + 1 : undefined,
        isAutoIncrement: false,
        extra: kind !== 'regular' ? kind : null,
      };
    });

    partitionKeys.sort((a, b) => a.pos - b.pos);
    clusteringKeys.sort((a, b) => a.pos - b.pos);

    const indexes: IndexStructure[] = (idxRes?.rows ?? []).map((r) => {
      const opts = r[2] as Record<string, unknown> | null;
      const target = opts && typeof opts === 'object' ? String(opts.target ?? '') : '';
      return {
        name: String(r[0]),
        columns: target ? [target] : [],
        unique: false,
        primary: false,
        type: r[1] ? String(r[1]) : 'SECONDARY',
      };
    });

    const pkClause =
      partitionKeys.length > 0
        ? clusteringKeys.length > 0
          ? `PRIMARY KEY ((${partitionKeys.map((k) => quoteIdent(k.name, 'cql')).join(', ')}), ${clusteringKeys.map((k) => quoteIdent(k.name, 'cql')).join(', ')})`
          : `PRIMARY KEY (${partitionKeys.map((k) => quoteIdent(k.name, 'cql')).join(', ')})`
        : '';

    const colLines = columns.map((c) => `  ${quoteIdent(c.name, 'cql')} ${c.dataType}`);
    if (pkClause) colLines.push(`  ${pkClause}`);
    const qTable = ks ? `${quoteIdent(ks, 'cql')}.${quoteIdent(table, 'cql')}` : quoteIdent(table, 'cql');
    const createDdl = `CREATE TABLE ${qTable} (\n${colLines.join(',\n')}\n);`;

    return {
      database: ks,
      schema: ks,
      table,
      columns,
      indexes,
      foreignKeys: [],
      checkConstraints: [],
      createDdl,
    };
  }

  async getSchemaErGraph(db: string, schema = ''): Promise<SchemaErGraph> {
    const ks = db || schema || this.activeKeyspace;
    const tables = await this.listTables(ks, ks);
    const erTables: SchemaErGraph['tables'] = [];
    for (const t of tables) {
      const s = await this.getTableStructure(ks, ks, t.name);
      erTables.push({ name: t.name, schema: ks, columns: s.columns });
    }
    return { database: ks, schema: ks, tables: erTables, edges: [] };
  }

  async browseTable(
    db: string,
    schema: string,
    table: string,
    options?: BrowseTableOptions,
  ): Promise<BrowseTableResult> {
    const started = performance.now();
    const ks = db || schema || this.activeKeyspace;
    const page = Math.max(1, options?.page ?? 1);
    const pageSize = Math.min(1000, Math.max(1, options?.pageSize ?? 50));
    const offset = (page - 1) * pageSize;
    const qTable = ks ? `${quoteIdent(ks, 'cql')}.${quoteIdent(table, 'cql')}` : quoteIdent(table, 'cql');
    const where = options?.whereClause?.trim() ? ` WHERE ${options.whereClause.trim()} ALLOW FILTERING` : '';
    const fetchLimit = offset + pageSize;
    const cql = `SELECT * FROM ${qTable}${where} LIMIT ${fetchLimit}`;

    const rs = await this.executeSingle(cql, { maxRows: fetchLimit });
    const sliced = rs.rows.slice(offset, offset + pageSize);
    return {
      database: ks,
      schema: ks,
      table,
      columns: rs.columns,
      rows: sliced,
      page,
      pageSize,
      totalRows: rs.truncated ? fetchLimit + 1 : rs.rows.length,
      totalEstimated: true,
      executionMs: Math.round(performance.now() - started),
      sql: cql,
    };
  }

  generateBatchMutations(
    db: string,
    schema: string,
    table: string,
    structure: TableStructure,
    changes: BatchMutationChanges,
  ): BatchMutationPreview {
    return buildBatchMutations('cql', db || this.activeKeyspace, schema || db || this.activeKeyspace, table, structure, changes);
  }

  async applyBatchMutations(sqlStatements: readonly string[]): Promise<BatchMutationApplyResult> {
    const started = performance.now();
    for (const stmt of sqlStatements) {
      await this.executeSingle(stmt);
    }
    return {
      applied: sqlStatements.length,
      affectedRows: sqlStatements.length,
      executionMs: Math.round(performance.now() - started),
    };
  }

  async explain(sql: string, analyze = false): Promise<ExplainResult> {
    return {
      dialect: 'cql',
      analyzed: analyze,
      root: {
        id: 'plan-1',
        nodeType: 'CQL Query',
        detail: `CQL execution: ${stripTrailingSemicolon(sql)}`,
        children: [],
      },
      rawText: `CQL execution: ${stripTrailingSemicolon(sql)}`,
    };
  }

  generateAlterTableDdl(db: string, schema: string, table: string, diff: TableStructureDiff): string[] {
    return buildAlterTableDdl('cql', db || this.activeKeyspace, schema || db || this.activeKeyspace, table, diff);
  }

  generateCreateTableDdl(db: string, schema: string, spec: CreateTableSpec): string {
    return buildCreateTableDdl('cql', db || this.activeKeyspace, schema || db || this.activeKeyspace, spec);
  }

  async dropObject(
    db: string,
    schema: string,
    name: string,
    kind: DropObjectKind,
    cascade = false,
  ): Promise<void> {
    await this.executeSingle(
      buildDropObjectSql('cql', db || this.activeKeyspace, schema || db || this.activeKeyspace, name, kind, cascade),
    );
  }

  async truncateTable(db: string, schema: string, table: string, cascade = false): Promise<void> {
    await this.executeSingle(
      buildTruncateTableSql('cql', db || this.activeKeyspace, schema || db || this.activeKeyspace, table, cascade),
    );
  }

  async dumpDatabaseSql(
    db: string,
    schema = '',
    tables?: string[],
    includeData = true,
  ): Promise<string> {
    const ks = db || schema || this.activeKeyspace;
    const list = tables ?? (await this.listTables(ks, ks)).map((t) => t.name);
    const dumpTables = [];
    for (const table of list) {
      const structure = await this.getTableStructure(ks, ks, table);
      let columns = structure.columns.map((c) => c.name);
      let rows: CellValue[][] = [];
      if (includeData) {
        const browse = await this.browseTable(ks, ks, table, { page: 1, pageSize: 1000 });
        columns = browse.columns.map((c) => c.name);
        rows = browse.rows;
      }
      dumpTables.push({ structure, columns, rows });
    }
    return generateSqlDump('cql', ks, ks, dumpTables, includeData);
  }

  diffSchemas(leftSchema: SchemaSnapshot, rightSchema: SchemaSnapshot): SchemaDiffResult {
    return runSchemaDiff(leftSchema, rightSchema);
  }
}

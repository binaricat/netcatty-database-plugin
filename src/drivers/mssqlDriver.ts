/**
 * Pure-TS Microsoft SQL Server TDS 7.4 Wire Protocol Driver
 * (100% browser-sandbox compatible, zero Node-only imports).
 *
 * Implements:
 * - PRELOGIN (0x12) + optional TLS upgrade (stream.upgradeTls for prefer/require,
 *   or direct TLS for verify-full)
 * - LOGIN7 (0x10) with UTF-16LE fields and TDS password obfuscation (nibble swap + XOR 0xA5)
 * - SQL_BATCH (0x01) with TDS 7.4 ALL_HEADERS transaction descriptor + UTF-16LE SQL
 * - ATTENTION (0x06) query cancellation
 * - Full TDS token stream parser: COLMETADATA (0x81), ROW (0xD1), NBCROW (0xD2),
 *   DONE (0xFD), DONEPROC (0xFE), DONEINPROC (0xFF), ERROR (0xAA), INFO (0xAB),
 *   ENVCHANGE (0xE3), LOGINACK (0xAD)
 * - Complete RelationalDriver interface for SQL Server (dialect: 'mssql')
 */

import {
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
  type CheckConstraintStructure,
  type ColumnMeta,
  type ColumnStructure,
  type ConnectionConfig,
  type ConnectionInfo,
  type CreateColumnSpec,
  type CreateTableSpec,
  type DatabaseEngineId,
  type DatabaseInfo,
  type DatabaseUserSummary,
  type DropObjectKind,
  type ExplainNode,
  type ObjectDependency,
  type ProcessEntry,
  type SequenceSummary,
  type ServerStatusSnapshot,
  type SynonymSummary,
  type ExplainResult,
  type ForeignKeyStructure,
  type IndexStructure,
  type LinkedServerSummary,
  type MultiQueryResult,
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
import { parseClickHouseExplainText } from '../sql/explainParser';
import { diffSchemas as runSchemaDiff, generateSqlDump } from '../sql/schemaDiff';
import { splitSqlStatements } from '../sql/splitter';

const tdUtf8 = new TextDecoder('utf-8');
const tdUtf16Le = new TextDecoder('utf-16le');

// TDS packet types
export const TDS_PKT_SQL_BATCH = 0x01;
export const TDS_PKT_TABULAR_RESULT = 0x04;
export const TDS_PKT_ATTENTION = 0x06;
export const TDS_PKT_LOGIN7 = 0x10;
export const TDS_PKT_PRELOGIN = 0x12;

// TDS packet status flags
const TDS_STATUS_NORMAL = 0x00;
const TDS_STATUS_EOM = 0x01;

// TDS PRELOGIN encryption options
export const TDS_ENCRYPT_OFF = 0x00;
export const TDS_ENCRYPT_ON = 0x01;
export const TDS_ENCRYPT_NOT_SUP = 0x02;
export const TDS_ENCRYPT_REQ = 0x03;

// TDS 7.4 version constant (wire bytes 04 00 00 74 -> uint32 LE 0x74000004)
const TDS_VERSION_74 = 0x74000004;
const DEFAULT_PACKET_SIZE = 4096;

// TDS token types
const TOK_RETURNSTATUS = 0x79;
const TOK_COLMETADATA = 0x81;
const TOK_TABNAME = 0xa4;
const TOK_COLINFO = 0xa5;
const TOK_ORDER = 0xa9;
const TOK_ERROR = 0xaa;
const TOK_INFO = 0xab;
const TOK_RETURNVALUE = 0xac;
const TOK_LOGINACK = 0xad;
const TOK_ROW = 0xd1;
const TOK_NBCROW = 0xd2;
const TOK_ENVCHANGE = 0xe3;
const TOK_SESSIONSTATE = 0xe4;
const TOK_FEATUREEXTACK = 0xee;
const TOK_DONE = 0xfd;
const TOK_DONEPROC = 0xfe;
const TOK_DONEINPROC = 0xff;

// TDS data type IDs
const TYPE_NULL = 0x1f;
const TYPE_IMAGE = 0x22;
const TYPE_TEXT = 0x23;
const TYPE_GUID = 0x24;
const TYPE_VARBINARY_LEGACY = 0x25;
const TYPE_INTN = 0x26;
const TYPE_VARCHAR_LEGACY = 0x27;
const TYPE_DATE = 0x28;
const TYPE_TIME = 0x29;
const TYPE_DATETIME2 = 0x2a;
const TYPE_DATETIMEOFFSET = 0x2b;
const TYPE_BINARY_LEGACY = 0x2d;
const TYPE_CHAR_LEGACY = 0x2f;
const TYPE_INT1 = 0x30;
const TYPE_BIT = 0x32;
const TYPE_INT2 = 0x34;
const TYPE_DECIMAL_LEGACY = 0x37;
const TYPE_INT4 = 0x38;
const TYPE_DATETIM4 = 0x3a;
const TYPE_FLT4 = 0x3b;
const TYPE_MONEY = 0x3c;
const TYPE_DATETIME = 0x3d;
const TYPE_FLT8 = 0x3e;
const TYPE_NUMERIC_LEGACY = 0x3f;
const TYPE_NTEXT = 0x63;
const TYPE_BITN = 0x68;
const TYPE_DECIMALN = 0x6a;
const TYPE_NUMERICN = 0x6c;
const TYPE_FLTN = 0x6d;
const TYPE_MONEYN = 0x6e;
const TYPE_DATETIMN = 0x6f;
const TYPE_MONEY4 = 0x7a;
const TYPE_INT8 = 0x7f;
const TYPE_BIGVARBINARY = 0xa5;
const TYPE_BIGVARCHAR = 0xa7;
const TYPE_BIGBINARY = 0xad;
const TYPE_BIGCHAR = 0xaf;
const TYPE_NVARCHAR = 0xe7;
const TYPE_NCHAR = 0xef;
const TYPE_XML = 0xf1;

/* ============================================================================
 * Pure-TS UTF-16LE & TDS Wire Packet Builders
 * ============================================================================ */

function encodeUtf16Le(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[i * 2] = code & 0xff;
    out[i * 2 + 1] = (code >> 8) & 0xff;
  }
  return out;
}

function encodeAscii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    out[i] = text.charCodeAt(i) & 0x7f;
  }
  return out;
}

/**
 * Obfuscate a password for TDS LOGIN7:
 * Encode as UTF-16LE, swap low/high nibbles of each byte, then XOR with 0xA5.
 */
export function encodeTdsPassword(password: string): Uint8Array {
  const raw = encodeUtf16Le(password);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    const swapped = ((b & 0x0f) << 4) | ((b & 0xf0) >> 4);
    out[i] = swapped ^ 0xa5;
  }
  return out;
}

/**
 * Wrap a TDS payload into one or more TDS packets with 8-byte headers.
 */
export function wrapTdsPackets(
  packetType: number,
  payload: Uint8Array,
  packetSize = DEFAULT_PACKET_SIZE,
): Uint8Array {
  const maxPayload = Math.max(512, packetSize) - 8;
  if (payload.length === 0) {
    const pkt = new Uint8Array(8);
    pkt[0] = packetType & 0xff;
    pkt[1] = TDS_STATUS_EOM;
    pkt[2] = 0;
    pkt[3] = 8;
    pkt[6] = 1;
    return pkt;
  }

  const packets: Uint8Array[] = [];
  let seq = 1;
  for (let offset = 0; offset < payload.length; offset += maxPayload) {
    const end = Math.min(offset + maxPayload, payload.length);
    const slice = payload.subarray(offset, end);
    const isLast = end >= payload.length;
    const totalLen = 8 + slice.length;
    const header = new Uint8Array(8);
    header[0] = packetType & 0xff;
    header[1] = isLast ? TDS_STATUS_EOM : TDS_STATUS_NORMAL;
    header[2] = (totalLen >> 8) & 0xff;
    header[3] = totalLen & 0xff;
    header[4] = 0;
    header[5] = 0;
    header[6] = seq & 0xff;
    header[7] = 0;
    packets.push(header, slice);
    seq = (seq + 1) & 0xff;
  }
  return concatBytes(...packets);
}

/**
 * Build a TDS 7.4 PRELOGIN packet (type 0x12).
 */
export function buildTdsPreloginPacket(options?: {
  encryption?: number;
  instanceName?: string;
}): Uint8Array {
  const encryption = options?.encryption ?? TDS_ENCRYPT_NOT_SUP;
  const instBytes = options?.instanceName
    ? concatBytes(encodeAscii(options.instanceName), new Uint8Array([0]))
    : new Uint8Array([0]);

  const versionData = new Uint8Array([0x00, 0x03, 0x00, 0x00, 0x00, 0x00]); // 0.3.0.0
  const encData = new Uint8Array([encryption & 0xff]);
  const threadData = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
  const marsData = new Uint8Array([0x00]);

  const entries: Array<{ token: number; data: Uint8Array }> = [
    { token: 0x00, data: versionData }, // VERSION
    { token: 0x01, data: encData }, // ENCRYPTION
    { token: 0x02, data: instBytes }, // INSTOPT
    { token: 0x03, data: threadData }, // THREADID
    { token: 0x04, data: marsData }, // MARS
  ];

  // Option table: 5 bytes per entry + 1 terminator byte (0xFF)
  const headerSize = entries.length * 5 + 1;
  const table = new Uint8Array(headerSize);
  const tv = new DataView(table.buffer);
  let dataOffset = headerSize;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    table[i * 5] = e.token;
    tv.setUint16(i * 5 + 1, dataOffset, false);
    tv.setUint16(i * 5 + 3, e.data.length, false);
    dataOffset += e.data.length;
  }
  table[headerSize - 1] = 0xff;

  const payload = concatBytes(table, ...entries.map((e) => e.data));
  return wrapTdsPackets(TDS_PKT_PRELOGIN, payload);
}

/**
 * Build a TDS 7.4 LOGIN7 packet (type 0x10).
 */
export function buildTdsLogin7Packet(options: {
  username: string;
  password: string;
  database?: string;
  hostName?: string;
  appName?: string;
  serverName?: string;
  packetSize?: number;
}): Uint8Array {
  const hostName = options.hostName ?? 'netcatty-client';
  const username = options.username ?? '';
  const password = options.password ?? '';
  const appName = options.appName ?? 'NetcattyDatabase';
  const serverName = options.serverName ?? 'localhost';
  const cltIntName = 'NetcattyTDS';
  const language = '';
  const database = options.database ?? '';
  const packetSize = options.packetSize ?? DEFAULT_PACKET_SIZE;

  const hostBytes = encodeUtf16Le(hostName);
  const userBytes = encodeUtf16Le(username);
  const passBytes = encodeTdsPassword(password);
  const appBytes = encodeUtf16Le(appName);
  const srvBytes = encodeUtf16Le(serverName);
  const intBytes = encodeUtf16Le(cltIntName);
  const langBytes = encodeUtf16Le(language);
  const dbBytes = encodeUtf16Le(database);

  const FIXED_LEN = 94;
  const header = new Uint8Array(FIXED_LEN);
  const hv = new DataView(header.buffer);

  const varParts = [hostBytes, userBytes, passBytes, appBytes, srvBytes, intBytes, langBytes, dbBytes];
  const varLen = varParts.reduce((sum, p) => sum + p.length, 0);
  const totalPayloadLen = FIXED_LEN + varLen;

  hv.setUint32(0, totalPayloadLen, true); // Length
  hv.setUint32(4, TDS_VERSION_74, true); // TDSVersion 7.4
  hv.setUint32(8, packetSize, true); // PacketSize
  hv.setUint32(12, 0x07000000, true); // ClientProgVer
  hv.setUint32(16, 1, true); // ClientPID
  hv.setUint32(20, 0, true); // ConnectionID
  header[24] = 0xe0; // OptionFlags1: fUseDB | fInitDB | fLangWarn
  header[25] = 0x03; // OptionFlags2: fInitLang | fODBC
  header[26] = 0x00; // TypeFlags
  header[27] = 0x00; // OptionFlags3
  hv.setInt32(28, 0, true); // ClientTimeZone
  hv.setUint32(32, 0x00000409, true); // ClientLCID (en-US)

  let offset = FIXED_LEN;
  const setField = (pos: number, bytes: Uint8Array, charLen: number) => {
    hv.setUint16(pos, offset, true);
    hv.setUint16(pos + 2, charLen, true);
    offset += bytes.length;
  };

  setField(36, hostBytes, hostName.length); // HostName
  setField(40, userBytes, username.length); // UserName
  setField(44, passBytes, password.length); // Password
  setField(48, appBytes, appName.length); // AppName
  setField(52, srvBytes, serverName.length); // ServerName
  // 56..59: Extension / unused
  hv.setUint16(56, 0, true);
  hv.setUint16(58, 0, true);
  setField(60, intBytes, cltIntName.length); // CltIntName
  setField(64, langBytes, language.length); // Language
  setField(68, dbBytes, database.length); // Database
  // 72..77: ClientID (6 bytes, 0)
  // 78..81: SSPI
  hv.setUint16(78, offset, true);
  hv.setUint16(80, 0, true);
  // 82..85: AtchDBFile
  hv.setUint16(82, offset, true);
  hv.setUint16(84, 0, true);
  // 86..89: ChangePassword
  hv.setUint16(86, offset, true);
  hv.setUint16(88, 0, true);
  // 90..93: cbSSPILong
  hv.setUint32(90, 0, true);

  const payload = concatBytes(header, ...varParts);
  return wrapTdsPackets(TDS_PKT_LOGIN7, payload, packetSize);
}

/**
 * Build a TDS 7.4 SQL_BATCH packet (type 0x01) with ALL_HEADERS + UTF-16LE SQL.
 */
export function buildTdsSqlBatchPacket(
  sql: string,
  txDescriptor?: Uint8Array,
  packetSize = DEFAULT_PACKET_SIZE,
): Uint8Array {
  const allHeaders = new Uint8Array(22);
  const hv = new DataView(allHeaders.buffer);
  hv.setUint32(0, 22, true); // TotalLength
  hv.setUint32(4, 18, true); // HeaderLength
  hv.setUint16(8, 0x0002, true); // HeaderType: Transaction Descriptor
  if (txDescriptor && txDescriptor.length === 8) {
    allHeaders.set(txDescriptor, 10);
  }
  hv.setUint32(18, 1, true); // OutstandingRequestCount

  const payload = concatBytes(allHeaders, encodeUtf16Le(sql));
  return wrapTdsPackets(TDS_PKT_SQL_BATCH, payload, packetSize);
}

/* ============================================================================
 * TDS Binary Reader & Token Stream Parser
 * ============================================================================ */

interface TdsColumnDef {
  name: string;
  userType: number;
  flags: number;
  typeId: number;
  typeName: string;
  maxLen: number;
  precision: number;
  scale: number;
  isPlp: boolean;
  nullable: boolean;
}

interface TdsErrorInfo {
  number: number;
  state: number;
  severity: number;
  message: string;
  serverName: string;
  procName: string;
  lineNumber: number;
}

interface TdsParsedResultSet {
  columns: ColumnMeta[];
  rows: CellValue[][];
  affectedRows: number;
  truncated: boolean;
}

interface TdsTokenStreamOutput {
  resultSets: TdsParsedResultSet[];
  errors: TdsErrorInfo[];
  infos: TdsErrorInfo[];
  loginAck?: {
    progName: string;
    serverVersion: string;
    tdsVersion: number;
  };
  envChanges: {
    database?: string;
    packetSize?: number;
    txDescriptor?: Uint8Array;
    inTransaction?: boolean;
  };
}

class TdsReader {
  private readonly view: DataView;
  offset = 0;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  private ensure(n: number): void {
    if (this.offset + n > this.buf.length) {
      throw new Error(`Unexpected end of TDS stream (need ${n} bytes at offset ${this.offset})`);
    }
  }

  skip(n: number): void {
    this.ensure(n);
    this.offset += n;
  }

  readU8(): number {
    this.ensure(1);
    return this.buf[this.offset++];
  }

  readU16LE(): number {
    this.ensure(2);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  readI16LE(): number {
    this.ensure(2);
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  readU32LE(): number {
    this.ensure(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readU32BE(): number {
    this.ensure(4);
    const v = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return v;
  }

  readI32LE(): number {
    this.ensure(4);
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readI64LE(): bigint {
    this.ensure(8);
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }

  readU64LE(): bigint {
    this.ensure(8);
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  readF32LE(): number {
    this.ensure(4);
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readF64LE(): number {
    this.ensure(8);
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }

  readBytes(len: number): Uint8Array {
    this.ensure(len);
    const out = this.buf.slice(this.offset, this.offset + len);
    this.offset += len;
    return out;
  }

  readBVarChar(): string {
    const charLen = this.readU8();
    if (charLen === 0) return '';
    return tdUtf16Le.decode(this.readBytes(charLen * 2));
  }

  readUsVarChar(): string {
    const charLen = this.readU16LE();
    if (charLen === 0) return '';
    return tdUtf16Le.decode(this.readBytes(charLen * 2));
  }

  readBVarByte(): Uint8Array {
    const len = this.readU8();
    return len === 0 ? new Uint8Array(0) : this.readBytes(len);
  }
}

function tdsTypeName(typeId: number, maxLen: number): string {
  switch (typeId) {
    case TYPE_INT1:
      return 'tinyint';
    case TYPE_INT2:
      return 'smallint';
    case TYPE_INT4:
      return 'int';
    case TYPE_INT8:
      return 'bigint';
    case TYPE_INTN:
      if (maxLen === 1) return 'tinyint';
      if (maxLen === 2) return 'smallint';
      if (maxLen === 8) return 'bigint';
      return 'int';
    case TYPE_BIT:
    case TYPE_BITN:
      return 'bit';
    case TYPE_FLT4:
      return 'real';
    case TYPE_FLT8:
      return 'float';
    case TYPE_FLTN:
      return maxLen === 4 ? 'real' : 'float';
    case TYPE_DECIMAL_LEGACY:
    case TYPE_DECIMALN:
      return 'decimal';
    case TYPE_NUMERIC_LEGACY:
    case TYPE_NUMERICN:
      return 'numeric';
    case TYPE_MONEY:
    case TYPE_MONEYN:
      return maxLen === 4 ? 'smallmoney' : 'money';
    case TYPE_MONEY4:
      return 'smallmoney';
    case TYPE_CHAR_LEGACY:
    case TYPE_BIGCHAR:
      return 'char';
    case TYPE_VARCHAR_LEGACY:
    case TYPE_BIGVARCHAR:
      return maxLen === 0xffff ? 'varchar(max)' : 'varchar';
    case TYPE_NCHAR:
      return 'nchar';
    case TYPE_NVARCHAR:
      return maxLen === 0xffff ? 'nvarchar(max)' : 'nvarchar';
    case TYPE_TEXT:
      return 'text';
    case TYPE_NTEXT:
      return 'ntext';
    case TYPE_BINARY_LEGACY:
    case TYPE_BIGBINARY:
      return 'binary';
    case TYPE_VARBINARY_LEGACY:
    case TYPE_BIGVARBINARY:
      return maxLen === 0xffff ? 'varbinary(max)' : 'varbinary';
    case TYPE_IMAGE:
      return 'image';
    case TYPE_GUID:
      return 'uniqueidentifier';
    case TYPE_DATE:
      return 'date';
    case TYPE_TIME:
      return 'time';
    case TYPE_DATETIME:
    case TYPE_DATETIMN:
      return maxLen === 4 ? 'smalldatetime' : 'datetime';
    case TYPE_DATETIM4:
      return 'smalldatetime';
    case TYPE_DATETIME2:
      return 'datetime2';
    case TYPE_DATETIMEOFFSET:
      return 'datetimeoffset';
    case TYPE_XML:
      return 'xml';
    case TYPE_NULL:
      return 'null';
    default:
      return `tds_0x${typeId.toString(16)}`;
  }
}

function readTdsColumnType(r: TdsReader): Omit<TdsColumnDef, 'name' | 'userType' | 'flags' | 'nullable'> {
  const typeId = r.readU8();
  let maxLen = 0;
  let precision = 0;
  let scale = 0;
  let isPlp = false;

  switch (typeId) {
    // Fixed-length types
    case TYPE_NULL:
    case TYPE_INT1:
    case TYPE_BIT:
    case TYPE_INT2:
    case TYPE_INT4:
    case TYPE_INT8:
    case TYPE_FLT4:
    case TYPE_FLT8:
    case TYPE_MONEY:
    case TYPE_MONEY4:
    case TYPE_DATETIME:
    case TYPE_DATETIM4:
    case TYPE_DATE:
      break;

    // Scale-only date/time types
    case TYPE_TIME:
    case TYPE_DATETIME2:
    case TYPE_DATETIMEOFFSET:
      scale = r.readU8();
      break;

    // 1-byte length types
    case TYPE_GUID:
    case TYPE_INTN:
    case TYPE_BITN:
    case TYPE_FLTN:
    case TYPE_MONEYN:
    case TYPE_DATETIMN:
    case TYPE_CHAR_LEGACY:
    case TYPE_VARCHAR_LEGACY:
    case TYPE_BINARY_LEGACY:
    case TYPE_VARBINARY_LEGACY:
      maxLen = r.readU8();
      break;

    // Decimal / numeric: len + precision + scale
    case TYPE_DECIMAL_LEGACY:
    case TYPE_NUMERIC_LEGACY:
    case TYPE_DECIMALN:
    case TYPE_NUMERICN:
      maxLen = r.readU8();
      precision = r.readU8();
      scale = r.readU8();
      break;

    // 2-byte length binary types
    case TYPE_BIGVARBINARY:
    case TYPE_BIGBINARY:
      maxLen = r.readU16LE();
      isPlp = maxLen === 0xffff;
      break;

    // 2-byte length string types + 5-byte collation
    case TYPE_BIGVARCHAR:
    case TYPE_BIGCHAR:
    case TYPE_NVARCHAR:
    case TYPE_NCHAR:
      maxLen = r.readU16LE();
      isPlp = maxLen === 0xffff;
      r.skip(5); // collation
      break;

    // Legacy 4-byte length LOB types
    case TYPE_TEXT:
    case TYPE_NTEXT: {
      maxLen = r.readU32LE();
      r.skip(5); // collation
      const numParts = r.readU8();
      for (let i = 0; i < numParts; i++) {
        r.readUsVarChar();
      }
      break;
    }
    case TYPE_IMAGE: {
      maxLen = r.readU32LE();
      const numParts = r.readU8();
      for (let i = 0; i < numParts; i++) {
        r.readUsVarChar();
      }
      break;
    }

    // XML (PLP)
    case TYPE_XML: {
      isPlp = true;
      const schemaPresent = r.readU8();
      if (schemaPresent === 1) {
        r.readBVarChar();
        r.readBVarChar();
        r.readUsVarChar();
      }
      break;
    }

    default:
      throw new Error(`Unsupported TDS column type ID: 0x${typeId.toString(16)}`);
  }

  return {
    typeId,
    typeName: tdsTypeName(typeId, maxLen),
    maxLen,
    precision,
    scale,
    isPlp,
  };
}

function readPlpBytes(r: TdsReader): Uint8Array | null {
  const lo = r.readU32LE();
  const hi = r.readU32LE();
  if (lo === 0xffffffff && hi === 0xffffffff) {
    return null;
  }
  const chunks: Uint8Array[] = [];
  while (true) {
    const chunkLen = r.readU32LE();
    if (chunkLen === 0) break;
    chunks.push(r.readBytes(chunkLen));
  }
  return concatBytes(...chunks);
}

function pad2(n: number): string {
  return String(Math.abs(Math.trunc(n))).padStart(2, '0');
}

function formatTdsDaysSince0001(days: number): string {
  // 1970-01-01 is day 719162 counting from 0001-01-01 (day 0)
  const dt = new Date(Date.UTC(1970, 0, 1) + (days - 719162) * 86400000);
  const year = String(dt.getUTCFullYear()).padStart(4, '0');
  return `${year}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function readUintLE(r: TdsReader, byteLen: number): bigint {
  let val = 0n;
  for (let i = 0; i < byteLen; i++) {
    val |= BigInt(r.readU8()) << BigInt(i * 8);
  }
  return val;
}

function formatTdsTimeTicks(ticks: bigint, scale: number): { hhmmss: string; frac: string; totalMs: number } {
  const divisor = 10n ** BigInt(scale);
  const totalSec = Number(ticks / divisor);
  const rem = ticks % divisor;
  const h = Math.floor(totalSec / 3600) % 24;
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const hhmmss = `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  let frac = '';
  if (scale > 0 && rem > 0n) {
    frac = '.' + rem.toString().padStart(scale, '0').replace(/0+$/, '');
  }
  const ms = Number((ticks * 1000n) / divisor);
  return { hhmmss, frac, totalMs: ms };
}

function formatTdsGuid(bytes: Uint8Array): string {
  const hex = (b: number) => b.toString(16).padStart(2, '0');
  const p1 = hex(bytes[3]) + hex(bytes[2]) + hex(bytes[1]) + hex(bytes[0]);
  const p2 = hex(bytes[5]) + hex(bytes[4]);
  const p3 = hex(bytes[7]) + hex(bytes[6]);
  const p4 = hex(bytes[8]) + hex(bytes[9]);
  const p5 =
    hex(bytes[10]) +
    hex(bytes[11]) +
    hex(bytes[12]) +
    hex(bytes[13]) +
    hex(bytes[14]) +
    hex(bytes[15]);
  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

function formatTdsDecimal(sign: number, magBytes: Uint8Array, scale: number): number | string {
  let acc = 0n;
  for (let i = 0; i < magBytes.length; i++) {
    acc |= BigInt(magBytes[i]) << BigInt(i * 8);
  }
  let digits = acc.toString();
  if (scale > 0) {
    if (digits.length <= scale) {
      digits = '0.' + digits.padStart(scale, '0');
    } else {
      const split = digits.length - scale;
      digits = digits.slice(0, split) + '.' + digits.slice(split);
    }
  }
  const text = sign === 0 && acc !== 0n ? `-${digits}` : digits;
  const asNum = Number(text);
  if (digits.replace('.', '').length <= 15 && Number.isFinite(asNum)) {
    return asNum;
  }
  return text;
}

function decodeTdsDateTime8(days: number, ticks: number): string {
  const ms = Date.UTC(1900, 0, 1) + days * 86400000 + Math.round((ticks * 1000) / 300);
  const dt = new Date(ms);
  const year = String(dt.getUTCFullYear()).padStart(4, '0');
  const msPart = dt.getUTCMilliseconds();
  const frac = msPart > 0 ? `.${String(msPart).padStart(3, '0')}` : '';
  return `${year}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())} ${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}:${pad2(dt.getUTCSeconds())}${frac}`;
}

function decodeTdsDateTime4(days: number, mins: number): string {
  const ms = Date.UTC(1900, 0, 1) + days * 86400000 + mins * 60000;
  const dt = new Date(ms);
  const year = String(dt.getUTCFullYear()).padStart(4, '0');
  return `${year}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())} ${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}:00`;
}

function readTdsColumnValue(r: TdsReader, col: TdsColumnDef): CellValue {
  switch (col.typeId) {
    case TYPE_NULL:
      return null;
    case TYPE_INT1:
      return r.readU8();
    case TYPE_INT2:
      return r.readI16LE();
    case TYPE_INT4:
      return r.readI32LE();
    case TYPE_INT8: {
      const v = r.readI64LE();
      return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(v)
        : v.toString();
    }
    case TYPE_INTN: {
      const len = r.readU8();
      if (len === 0) return null;
      if (len === 1) return r.readU8();
      if (len === 2) return r.readI16LE();
      if (len === 4) return r.readI32LE();
      if (len === 8) {
        const v = r.readI64LE();
        return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(v)
          : v.toString();
      }
      throw new Error(`Invalid INTN length: ${len}`);
    }
    case TYPE_BIT:
      return r.readU8() !== 0;
    case TYPE_BITN: {
      const len = r.readU8();
      if (len === 0) return null;
      return r.readU8() !== 0;
    }
    case TYPE_FLT4:
      return r.readF32LE();
    case TYPE_FLT8:
      return r.readF64LE();
    case TYPE_FLTN: {
      const len = r.readU8();
      if (len === 0) return null;
      if (len === 4) return r.readF32LE();
      if (len === 8) return r.readF64LE();
      throw new Error(`Invalid FLTN length: ${len}`);
    }
    case TYPE_DECIMAL_LEGACY:
    case TYPE_NUMERIC_LEGACY:
    case TYPE_DECIMALN:
    case TYPE_NUMERICN: {
      const len = r.readU8();
      if (len === 0) return null;
      const sign = r.readU8();
      const magBytes = r.readBytes(len - 1);
      return formatTdsDecimal(sign, magBytes, col.scale);
    }
    case TYPE_MONEY4:
      return r.readI32LE() / 10000;
    case TYPE_MONEY: {
      const hi = r.readI32LE();
      const lo = r.readU32LE();
      return (hi * 4294967296 + lo) / 10000;
    }
    case TYPE_MONEYN: {
      const len = r.readU8();
      if (len === 0) return null;
      if (len === 4) return r.readI32LE() / 10000;
      if (len === 8) {
        const hi = r.readI32LE();
        const lo = r.readU32LE();
        return (hi * 4294967296 + lo) / 10000;
      }
      throw new Error(`Invalid MONEYN length: ${len}`);
    }
    case TYPE_CHAR_LEGACY:
    case TYPE_VARCHAR_LEGACY: {
      const len = r.readU8();
      if (len === 0) return '';
      return tdUtf8.decode(r.readBytes(len));
    }
    case TYPE_BIGCHAR:
    case TYPE_BIGVARCHAR: {
      if (col.isPlp) {
        const bytes = readPlpBytes(r);
        return bytes === null ? null : tdUtf8.decode(bytes);
      }
      const len = r.readU16LE();
      if (len === 0xffff) return null;
      return len === 0 ? '' : tdUtf8.decode(r.readBytes(len));
    }
    case TYPE_NCHAR:
    case TYPE_NVARCHAR: {
      if (col.isPlp) {
        const bytes = readPlpBytes(r);
        return bytes === null ? null : tdUtf16Le.decode(bytes);
      }
      const len = r.readU16LE();
      if (len === 0xffff) return null;
      return len === 0 ? '' : tdUtf16Le.decode(r.readBytes(len));
    }
    case TYPE_BINARY_LEGACY:
    case TYPE_VARBINARY_LEGACY: {
      const len = r.readU8();
      return len === 0 ? new Uint8Array(0) : r.readBytes(len);
    }
    case TYPE_BIGBINARY:
    case TYPE_BIGVARBINARY: {
      if (col.isPlp) {
        return readPlpBytes(r);
      }
      const len = r.readU16LE();
      if (len === 0xffff) return null;
      return len === 0 ? new Uint8Array(0) : r.readBytes(len);
    }
    case TYPE_XML: {
      const bytes = readPlpBytes(r);
      return bytes === null ? null : tdUtf16Le.decode(bytes);
    }
    case TYPE_TEXT:
    case TYPE_NTEXT:
    case TYPE_IMAGE: {
      const textPtrLen = r.readU8();
      if (textPtrLen === 0) return null;
      r.skip(textPtrLen + 8); // textptr + 8-byte timestamp
      const dataLen = r.readI32LE();
      if (dataLen < 0) return null;
      const bytes = r.readBytes(dataLen);
      if (col.typeId === TYPE_NTEXT) return tdUtf16Le.decode(bytes);
      if (col.typeId === TYPE_TEXT) return tdUtf8.decode(bytes);
      return bytes;
    }
    case TYPE_GUID: {
      const len = r.readU8();
      if (len === 0) return null;
      return formatTdsGuid(r.readBytes(len));
    }
    case TYPE_DATE: {
      const len = r.readU8();
      if (len === 0) return null;
      const days = Number(readUintLE(r, 3));
      return formatTdsDaysSince0001(days);
    }
    case TYPE_TIME: {
      const len = r.readU8();
      if (len === 0) return null;
      const ticks = readUintLE(r, len);
      const t = formatTdsTimeTicks(ticks, col.scale);
      return `${t.hhmmss}${t.frac}`;
    }
    case TYPE_DATETIM4: {
      const days = r.readU16LE();
      const mins = r.readU16LE();
      return decodeTdsDateTime4(days, mins);
    }
    case TYPE_DATETIME: {
      const days = r.readI32LE();
      const ticks = r.readU32LE();
      return decodeTdsDateTime8(days, ticks);
    }
    case TYPE_DATETIMN: {
      const len = r.readU8();
      if (len === 0) return null;
      if (len === 4) {
        const days = r.readU16LE();
        const mins = r.readU16LE();
        return decodeTdsDateTime4(days, mins);
      }
      if (len === 8) {
        const days = r.readI32LE();
        const ticks = r.readU32LE();
        return decodeTdsDateTime8(days, ticks);
      }
      throw new Error(`Invalid DATETIMN length: ${len}`);
    }
    case TYPE_DATETIME2: {
      const len = r.readU8();
      if (len === 0) return null;
      const timeBytes = len - 3;
      const ticks = readUintLE(r, timeBytes);
      const days = Number(readUintLE(r, 3));
      const dateStr = formatTdsDaysSince0001(days);
      const t = formatTdsTimeTicks(ticks, col.scale);
      return `${dateStr} ${t.hhmmss}${t.frac}`;
    }
    case TYPE_DATETIMEOFFSET: {
      const len = r.readU8();
      if (len === 0) return null;
      const timeBytes = len - 5;
      const ticks = readUintLE(r, timeBytes);
      const days = Number(readUintLE(r, 3));
      const offsetMins = r.readI16LE();
      const t = formatTdsTimeTicks(ticks, col.scale);
      const utcMs = Date.UTC(1970, 0, 1) + (days - 719162) * 86400000 + t.totalMs;
      const localDt = new Date(utcMs + offsetMins * 60000);
      const year = String(localDt.getUTCFullYear()).padStart(4, '0');
      const sign = offsetMins >= 0 ? '+' : '-';
      const absOff = Math.abs(offsetMins);
      const offH = pad2(Math.floor(absOff / 60));
      const offM = pad2(absOff % 60);
      return (
        `${year}-${pad2(localDt.getUTCMonth() + 1)}-${pad2(localDt.getUTCDate())} ` +
        `${pad2(localDt.getUTCHours())}:${pad2(localDt.getUTCMinutes())}:${pad2(localDt.getUTCSeconds())}` +
        `${t.frac}${sign}${offH}:${offM}`
      );
    }
    default:
      throw new Error(`Unsupported TDS row value type: 0x${col.typeId.toString(16)}`);
  }
}

function parseTdsTokenStream(payload: Uint8Array, maxRows?: number): TdsTokenStreamOutput {
  const r = new TdsReader(payload);
  const out: TdsTokenStreamOutput = {
    resultSets: [],
    errors: [],
    infos: [],
    envChanges: {},
  };

  let currentCols: TdsColumnDef[] | null = null;
  let currentRows: CellValue[][] = [];
  let currentTruncated = false;

  const flushResultSet = (affectedRows: number) => {
    if (currentCols !== null) {
      out.resultSets.push({
        columns: currentCols.map((c) => ({
          name: c.name,
          dataType: c.typeName,
          nullable: c.nullable,
        })),
        rows: currentRows,
        affectedRows,
        truncated: currentTruncated,
      });
      currentCols = null;
      currentRows = [];
      currentTruncated = false;
    } else if (affectedRows > 0) {
      out.resultSets.push({
        columns: [],
        rows: [],
        affectedRows,
        truncated: false,
      });
    }
  };

  while (r.remaining > 0) {
    const token = r.readU8();

    switch (token) {
      case TOK_COLMETADATA: {
        // Flush any previous un-flushed result set
        if (currentCols !== null) {
          flushResultSet(0);
        }
        const count = r.readU16LE();
        if (count === 0xffff) {
          currentCols = null;
          currentRows = [];
          currentTruncated = false;
          break;
        }
        const cols: TdsColumnDef[] = [];
        for (let i = 0; i < count; i++) {
          const userType = r.readU32LE();
          const flags = r.readU16LE();
          const typeInfo = readTdsColumnType(r);
          const name = r.readBVarChar();
          cols.push({
            name,
            userType,
            flags,
            nullable: (flags & 0x01) !== 0,
            ...typeInfo,
          });
        }
        currentCols = cols;
        currentRows = [];
        currentTruncated = false;
        break;
      }

      case TOK_ROW: {
        if (!currentCols) throw new Error('Received TDS ROW token without preceding COLMETADATA');
        const row: CellValue[] = [];
        for (const col of currentCols) {
          row.push(readTdsColumnValue(r, col));
        }
        if (maxRows && maxRows > 0 && currentRows.length >= maxRows) {
          currentTruncated = true;
        } else {
          currentRows.push(row);
        }
        break;
      }

      case TOK_NBCROW: {
        if (!currentCols) throw new Error('Received TDS NBCROW token without preceding COLMETADATA');
        const bitmapLen = Math.ceil(currentCols.length / 8);
        const bitmap = r.readBytes(bitmapLen);
        const row: CellValue[] = [];
        for (let i = 0; i < currentCols.length; i++) {
          const isNull = (bitmap[i >> 3] & (1 << (i & 7))) !== 0;
          if (isNull) {
            row.push(null);
          } else {
            row.push(readTdsColumnValue(r, currentCols[i]));
          }
        }
        if (maxRows && maxRows > 0 && currentRows.length >= maxRows) {
          currentTruncated = true;
        } else {
          currentRows.push(row);
        }
        break;
      }

      case TOK_DONE:
      case TOK_DONEPROC:
      case TOK_DONEINPROC: {
        const status = r.readU16LE();
        r.readU16LE(); // curCmd
        const rowCountBig = r.readU64LE();
        const hasCount = (status & 0x0010) !== 0;
        const affected = hasCount ? Number(rowCountBig) : 0;
        flushResultSet(affected);
        break;
      }

      case TOK_ERROR:
      case TOK_INFO: {
        const len = r.readU16LE();
        const endPos = r.offset + len;
        const number = r.readI32LE();
        const state = r.readU8();
        const severity = r.readU8();
        const message = r.readUsVarChar();
        const serverName = r.readBVarChar();
        const procName = r.readBVarChar();
        const lineNumber = r.offset + 4 <= endPos ? r.readU32LE() : r.offset + 2 <= endPos ? r.readU16LE() : 0;
        r.offset = endPos;
        const info: TdsErrorInfo = { number, state, severity, message, serverName, procName, lineNumber };
        if (token === TOK_ERROR) out.errors.push(info);
        else out.infos.push(info);
        break;
      }

      case TOK_ENVCHANGE: {
        const len = r.readU16LE();
        const endPos = r.offset + len;
        const envType = r.readU8();
        if (envType === 1) {
          // DATABASE
          out.envChanges.database = r.readBVarChar();
        } else if (envType === 4) {
          // PACKET_SIZE
          const sizeStr = r.readBVarChar();
          const parsedSize = Number(sizeStr);
          if (Number.isFinite(parsedSize) && parsedSize >= 512) {
            out.envChanges.packetSize = parsedSize;
          }
        } else if (envType === 8) {
          // BEGIN_TRANS
          const desc = r.readBVarByte();
          if (desc.length === 8) {
            out.envChanges.txDescriptor = desc;
            out.envChanges.inTransaction = true;
          }
        } else if (envType === 9 || envType === 10 || envType === 12) {
          // COMMIT_TRANS / ROLLBACK_TRANS / DEFECT_TRANS
          out.envChanges.txDescriptor = new Uint8Array(8);
          out.envChanges.inTransaction = false;
        }
        r.offset = endPos;
        break;
      }

      case TOK_LOGINACK: {
        const len = r.readU16LE();
        const endPos = r.offset + len;
        r.readU8(); // interface
        const tdsVersion = r.readU32BE();
        const progName = r.readBVarChar();
        const major = r.readU8();
        const minor = r.readU8();
        const buildHi = r.readU8();
        const buildLo = r.readU8();
        const build = (buildHi << 8) | buildLo;
        out.loginAck = {
          progName,
          serverVersion: `${progName || 'SQL Server'} ${major}.${minor}.${build}`,
          tdsVersion,
        };
        r.offset = endPos;
        break;
      }

      case TOK_RETURNSTATUS:
        r.skip(4);
        break;

      case TOK_ORDER:
      case TOK_TABNAME:
      case TOK_COLINFO: {
        const len = r.readU16LE();
        r.skip(len);
        break;
      }

      case TOK_SESSIONSTATE: {
        const len = r.readU32LE();
        r.skip(len);
        break;
      }

      case TOK_FEATUREEXTACK: {
        while (r.remaining > 0) {
          const fid = r.readU8();
          if (fid === 0xff) break;
          const dlen = r.readU32LE();
          r.skip(dlen);
        }
        break;
      }

      case TOK_RETURNVALUE: {
        r.readU16LE(); // paramOrdinal
        r.readBVarChar(); // paramName
        r.readU8(); // status
        r.readU32LE(); // userType
        r.readU16LE(); // flags
        const typeInfo = readTdsColumnType(r);
        readTdsColumnValue(r, {
          name: '',
          userType: 0,
          flags: 0,
          nullable: true,
          ...typeInfo,
        });
        break;
      }

      default:
        throw new Error(`Unsupported TDS token: 0x${token.toString(16)} at offset ${r.offset - 1}`);
    }
  }

  return out;
}

function parsePreloginResponse(payload: Uint8Array): { encryption: number; serverVersion: string } {
  let encryption = TDS_ENCRYPT_NOT_SUP;
  let serverVersion = '';
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let pos = 0;
  while (pos < payload.length) {
    const token = payload[pos];
    if (token === 0xff) break;
    if (pos + 5 > payload.length) break;
    const offset = view.getUint16(pos + 1, false);
    const length = view.getUint16(pos + 3, false);
    if (token === 0x01 && length >= 1 && offset < payload.length) {
      encryption = payload[offset];
    } else if (token === 0x00 && length >= 4 && offset + 4 <= payload.length) {
      const maj = payload[offset];
      const min = payload[offset + 1];
      const build = (payload[offset + 2] << 8) | payload[offset + 3];
      serverVersion = `SQL Server ${maj}.${min}.${build}`;
    }
    pos += 5;
  }
  return { encryption, serverVersion };
}

/* ============================================================================
 * SQL Server DDL & Helpers
 * ============================================================================ */

function escSql(value: string): string {
  return value.replaceAll("'", "''");
}

function splitTsqlBatches(sql: string): string[] {
  const goBlocks = sql.split(/^\s*GO(?:\s+\d+)?\s*;?\s*$/gim);
  const out: string[] = [];
  for (const block of goBlocks) {
    const stmts = splitSqlStatements(block, 'mssql');
    if (stmts.length > 0) {
      for (const s of stmts) out.push(s.sql);
    } else if (block.trim()) {
      out.push(block.trim());
    }
  }
  return out.length > 0 ? out : [sql];
}

function formatMssqlColumnDef(col: CreateColumnSpec): string {
  const parts: string[] = [quoteIdent(col.name, 'mssql'), col.dataType];
  if (col.isAutoIncrement) parts.push('IDENTITY(1,1)');
  if (col.nullable === false) parts.push('NOT NULL');
  else if (col.nullable === true) parts.push('NULL');
  if (col.unique) parts.push('UNIQUE');
  if (col.defaultValue !== undefined && col.defaultValue !== null && col.defaultValue !== '') {
    parts.push(`DEFAULT ${col.defaultValue}`);
  }
  return parts.join(' ');
}

function buildMssqlAlterTableDdl(
  db: string,
  schema: string,
  table: string,
  diff: TableStructureDiff,
): string[] {
  const stmts: string[] = [];
  const targetSchema = schema || 'dbo';
  let currentTable = table;
  const qCurrent = () => qualifiedTableName(db, targetSchema, currentTable, 'mssql');

  if (diff.renameTableTo && diff.renameTableTo !== table) {
    stmts.push(
      `EXEC sp_rename N'${escSql(targetSchema)}.${escSql(currentTable)}', N'${escSql(diff.renameTableTo)}';`,
    );
    currentTable = diff.renameTableTo;
  }

  for (const col of diff.addColumns ?? []) {
    stmts.push(`ALTER TABLE ${qCurrent()} ADD ${formatMssqlColumnDef(col)};`);
  }

  for (const ren of diff.renameColumns ?? []) {
    stmts.push(
      `EXEC sp_rename N'${escSql(targetSchema)}.${escSql(currentTable)}.${escSql(ren.from)}', N'${escSql(ren.to)}', N'COLUMN';`,
    );
  }

  for (const alt of diff.alterColumns ?? []) {
    const qCol = quoteIdent(alt.name, 'mssql');
    if (alt.dataType || alt.nullable !== undefined) {
      const dt = alt.dataType ?? 'NVARCHAR(255)';
      const nullability = alt.nullable === false ? ' NOT NULL' : ' NULL';
      stmts.push(`ALTER TABLE ${qCurrent()} ALTER COLUMN ${qCol} ${dt}${nullability};`);
    }
    if (alt.defaultValue !== undefined && alt.defaultValue !== null && alt.defaultValue !== '') {
      const dfName = quoteIdent(`DF_${currentTable}_${alt.name}`, 'mssql');
      stmts.push(`ALTER TABLE ${qCurrent()} ADD CONSTRAINT ${dfName} DEFAULT ${alt.defaultValue} FOR ${qCol};`);
    }
    if (alt.unique === true) {
      const uqName = quoteIdent(`UQ_${currentTable}_${alt.name}`, 'mssql');
      stmts.push(`ALTER TABLE ${qCurrent()} ADD CONSTRAINT ${uqName} UNIQUE (${qCol});`);
    }
  }

  for (const colName of diff.dropColumns ?? []) {
    stmts.push(`ALTER TABLE ${qCurrent()} DROP COLUMN ${quoteIdent(colName, 'mssql')};`);
  }

  for (const fkName of diff.dropForeignKeys ?? []) {
    stmts.push(`ALTER TABLE ${qCurrent()} DROP CONSTRAINT ${quoteIdent(fkName, 'mssql')};`);
  }

  for (const fk of diff.addForeignKeys ?? []) {
    const constraintName =
      fk.name || `FK_${currentTable}_${fk.columns.join('_')}_${fk.referencedTable}`;
    const srcCols = fk.columns.map((c) => quoteIdent(c, 'mssql')).join(', ');
    const refTbl = qualifiedTableName(db, fk.referencedSchema ?? targetSchema, fk.referencedTable, 'mssql');
    const refCols = fk.referencedColumns.map((c) => quoteIdent(c, 'mssql')).join(', ');
    let stmt = `ALTER TABLE ${qCurrent()} ADD CONSTRAINT ${quoteIdent(constraintName, 'mssql')} FOREIGN KEY (${srcCols}) REFERENCES ${refTbl} (${refCols})`;
    if (fk.onDelete && fk.onDelete !== 'NO ACTION') stmt += ` ON DELETE ${fk.onDelete}`;
    if (fk.onUpdate && fk.onUpdate !== 'NO ACTION') stmt += ` ON UPDATE ${fk.onUpdate}`;
    stmts.push(`${stmt};`);
  }

  for (const chkName of diff.dropCheckConstraints ?? []) {
    stmts.push(`ALTER TABLE ${qCurrent()} DROP CONSTRAINT ${quoteIdent(chkName, 'mssql')};`);
  }

  for (const chk of diff.addCheckConstraints ?? []) {
    const name = chk.name || `CK_${currentTable}_${stmts.length + 1}`;
    const expr = /^\s*CHECK\s*\(/i.test(chk.expression)
      ? chk.expression.trim()
      : `CHECK (${chk.expression.trim()})`;
    stmts.push(`ALTER TABLE ${qCurrent()} ADD CONSTRAINT ${quoteIdent(name, 'mssql')} ${expr};`);
  }

  for (const idx of diff.addIndexes ?? []) {
    const uniqueKw = idx.unique ? 'UNIQUE ' : '';
    const cols = idx.columns.map((c) => quoteIdent(c, 'mssql')).join(', ');
    stmts.push(`CREATE ${uniqueKw}INDEX ${quoteIdent(idx.name, 'mssql')} ON ${qCurrent()} (${cols});`);
  }

  for (const idxName of diff.dropIndexes ?? []) {
    stmts.push(`DROP INDEX ${quoteIdent(idxName, 'mssql')} ON ${qCurrent()};`);
  }

  return stmts;
}

function enrichMssqlExplainNode(node: ExplainNode): void {
  const detail = node.detail ?? '';
  if (/\bTable Scan\b/i.test(detail)) {
    node.warnings = [...(node.warnings ?? []), 'Full table scan'];
  }
  const objMatch = /OBJECT:\(([^)]+)\)/i.exec(detail);
  if (objMatch) {
    node.relation = objMatch[1];
  }
  for (const child of node.children) {
    enrichMssqlExplainNode(child);
  }
}

/* ============================================================================
 * MssqlDriver Implementation
 * ============================================================================ */

export class MssqlDriver implements RelationalDriver {
  readonly engine: DatabaseEngineId;
  readonly family = 'mssql' as const;

  private config: ConnectionConfig | null = null;
  private bs: BufferedByteStream | null = null;
  private packetSize = DEFAULT_PACKET_SIZE;
  private txDescriptor: Uint8Array = new Uint8Array(8);
  private _connected = false;
  private _inTransaction = false;
  private _serverVersion = '';
  private _currentDatabase = 'master';
  private _tlsActive = false;
  private lockQueue: Promise<unknown> = Promise.resolve();

  constructor(engine: DatabaseEngineId = 'sqlserver') {
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

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lockQueue.then(fn, fn);
    this.lockQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async readTdsMessage(): Promise<{ type: number; payload: Uint8Array }> {
    if (!this.bs) throw new Error('MSSQL stream is not connected');
    const chunks: Uint8Array[] = [];
    let pktType = 0;
    while (true) {
      const header = await this.bs.readExact(8);
      pktType = header[0];
      const status = header[1];
      const length = (header[2] << 8) | header[3];
      if (length < 8) {
        throw new Error(`Invalid TDS packet length: ${length}`);
      }
      if (length > 8) {
        chunks.push(await this.bs.readExact(length - 8));
      }
      if ((status & TDS_STATUS_EOM) !== 0) {
        break;
      }
    }
    return { type: pktType, payload: concatBytes(...chunks) };
  }

  private applyEnvChanges(env: TdsTokenStreamOutput['envChanges']): void {
    if (env.database !== undefined) this._currentDatabase = env.database;
    if (env.packetSize !== undefined) this.packetSize = env.packetSize;
    if (env.txDescriptor !== undefined) this.txDescriptor = env.txDescriptor;
    if (env.inTransaction !== undefined) this._inTransaction = env.inTransaction;
  }

  async connect(config: ConnectionConfig, transport?: ByteStreamTransport): Promise<ConnectionInfo> {
    if (!transport) throw new Error('MSSQL driver requires a ByteStreamTransport');
    const started = performance.now();
    this.config = config;
    const host = config.host || '127.0.0.1';
    const port = config.port ?? 1433;
    const tlsMode = config.tlsMode ?? 'prefer';
    this._currentDatabase = config.database?.trim() || 'master';
    this.packetSize = DEFAULT_PACKET_SIZE;
    this.txDescriptor = new Uint8Array(8);
    this._inTransaction = false;

    const directTls = tlsMode === 'verify-full';
    const rawStream = await transport.connect({
      host,
      port,
      tls: directTls,
      servername: host,
      allowSelfSigned: config.allowSelfSigned,
      caPem: config.caPem,
      timeoutMs: config.timeoutMs ?? 30000,
    });
    this.bs = new BufferedByteStream(rawStream);
    this._tlsActive = directTls || this.bs.isTls;

    try {
      // 1. PRELOGIN
      const requestedEnc = directTls
        ? TDS_ENCRYPT_ON
        : tlsMode === 'disable'
          ? TDS_ENCRYPT_NOT_SUP
          : TDS_ENCRYPT_ON;
      await this.bs.write(buildTdsPreloginPacket({ encryption: requestedEnc }));
      const preResp = await this.readTdsMessage();
      const parsedPre = parsePreloginResponse(preResp.payload);
      if (parsedPre.serverVersion) {
        this._serverVersion = parsedPre.serverVersion;
      }

      // 2. Optional STARTTLS upgrade when tlsMode is prefer/require and not already TLS
      if (!this._tlsActive) {
        const serverWantsTls =
          parsedPre.encryption === TDS_ENCRYPT_ON || parsedPre.encryption === TDS_ENCRYPT_REQ;
        if (tlsMode === 'require') {
          if (parsedPre.encryption === TDS_ENCRYPT_NOT_SUP) {
            throw new Error('SQL Server does not support TLS encryption (required by tlsMode=require)');
          }
          await this.bs.upgradeTls({
            servername: host,
            allowSelfSigned: config.allowSelfSigned,
            caPem: config.caPem,
          });
          this._tlsActive = true;
        } else if (tlsMode === 'prefer' && serverWantsTls) {
          try {
            await this.bs.upgradeTls({
              servername: host,
              allowSelfSigned: config.allowSelfSigned,
              caPem: config.caPem,
            });
            this._tlsActive = true;
          } catch {
            // Fall back to plaintext when tlsMode is prefer and upgradeTls is unavailable
          }
        } else if (tlsMode === 'disable' && parsedPre.encryption === TDS_ENCRYPT_REQ) {
          throw new Error('SQL Server requires encryption, but tlsMode is disable');
        }
      }

      // 3. LOGIN7
      const loginPacket = buildTdsLogin7Packet({
        username: config.username ?? '',
        password: config.password ?? '',
        database: this._currentDatabase,
        serverName: host,
        packetSize: this.packetSize,
      });
      await this.bs.write(loginPacket);
      const loginResp = await this.readTdsMessage();
      const parsedLogin = parseTdsTokenStream(loginResp.payload);
      this.applyEnvChanges(parsedLogin.envChanges);

      if (parsedLogin.errors.length > 0) {
        const first = parsedLogin.errors[0];
        throw new QueryError(first.message || 'SQL Server login failed', {
          code: String(first.number),
          line: first.lineNumber || undefined,
        });
      }
      if (parsedLogin.loginAck?.serverVersion) {
        this._serverVersion = parsedLogin.loginAck.serverVersion;
      }

      this._connected = true;

      return {
        engine: this.engine,
        family: 'mssql',
        serverVersion: this._serverVersion || 'SQL Server',
        database: this._currentDatabase,
        tlsActive: this._tlsActive,
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      await this.bs?.close().catch(() => {});
      this.bs = null;
      this._connected = false;
      throw err;
    }
  }

  async switchDatabase(db: string): Promise<ConnectionInfo> {
    if (!this._connected) throw new Error('MSSQL driver is not connected');
    const started = performance.now();
    const target = db.trim() || 'master';
    await this.executeBatch(`USE ${quoteIdent(target, 'mssql')}`);
    this._currentDatabase = target;
    return {
      engine: this.engine,
      family: 'mssql',
      serverVersion: this._serverVersion || 'SQL Server',
      database: this._currentDatabase,
      tlsActive: this._tlsActive,
      latencyMs: Math.round(performance.now() - started),
    };
  }

  async testConnection(): Promise<TestConnectionResult> {
    const started = performance.now();
    try {
      const res = await this.query('SELECT @@VERSION AS version');
      const ver = res.results[0]?.rows[0]?.[0];
      const serverVersion = typeof ver === 'string' && ver.length > 0 ? ver.split('\n')[0] : this._serverVersion;
      if (serverVersion) this._serverVersion = serverVersion;
      return {
        ok: true,
        serverVersion: this._serverVersion || 'SQL Server',
        latencyMs: Math.round(performance.now() - started),
        tlsActive: this._tlsActive,
      };
    } catch (err) {
      return {
        ok: false,
        serverVersion: this._serverVersion || 'SQL Server',
        latencyMs: Math.round(performance.now() - started),
        tlsActive: this._tlsActive,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async close(): Promise<void> {
    const stream = this.bs;
    this.bs = null;
    this._connected = false;
    this._inTransaction = false;
    this.txDescriptor = new Uint8Array(8);
    if (stream) {
      await stream.close().catch(() => {});
    }
  }

  async cancelQuery(): Promise<void> {
    if (!this.bs || !this._connected) return;
    await this.bs.write(wrapTdsPackets(TDS_PKT_ATTENTION, new Uint8Array(0), this.packetSize));
  }

  private executeBatch(sql: string, maxRows?: number): Promise<QueryResultSet[]> {
    return this.withLock(async () => {
      if (!this.bs || !this._connected) throw new Error('MSSQL driver is not connected');
      const started = performance.now();
      const pkt = buildTdsSqlBatchPacket(sql, this.txDescriptor, this.packetSize);
      await this.bs.write(pkt);
      const resp = await this.readTdsMessage();
      const parsed = parseTdsTokenStream(resp.payload, maxRows);
      this.applyEnvChanges(parsed.envChanges);

      if (parsed.errors.length > 0) {
        const first = parsed.errors[0];
        throw new QueryError(first.message || 'SQL Server query error', {
          code: String(first.number),
          line: first.lineNumber || undefined,
        });
      }

      const elapsed = Math.round(performance.now() - started);
      if (parsed.resultSets.length === 0) {
        return [
          {
            sql,
            columns: [],
            rows: [],
            rowCount: 0,
            affectedRows: 0,
            executionMs: elapsed,
            truncated: false,
            commandTag: 'OK',
          },
        ];
      }

      return parsed.resultSets.map((rs) => ({
        sql,
        columns: rs.columns,
        rows: rs.rows,
        rowCount: rs.rows.length,
        affectedRows: rs.affectedRows,
        executionMs: elapsed,
        truncated: rs.truncated,
        commandTag: rs.columns.length > 0 ? 'SELECT' : 'OK',
      }));
    });
  }

  async query(sql: string, options?: QueryOptions): Promise<MultiQueryResult> {
    if (!this._connected) throw new Error('MSSQL driver is not connected');
    const totalStart = performance.now();
    const statements = splitTsqlBatches(sql);
    const results: QueryResultSet[] = [];
    for (const stmt of statements) {
      const sets = await this.executeBatch(stmt, options?.maxRows);
      results.push(...sets);
    }
    return {
      results,
      totalExecutionMs: Math.round(performance.now() - totalStart),
    };
  }

  async beginTransaction(): Promise<void> {
    await this.executeBatch('BEGIN TRANSACTION');
    this._inTransaction = true;
  }

  async commitTransaction(): Promise<void> {
    await this.executeBatch('COMMIT TRANSACTION');
    this._inTransaction = false;
  }

  async rollbackTransaction(): Promise<void> {
    await this.executeBatch('ROLLBACK TRANSACTION');
    this._inTransaction = false;
  }

  private dbPrefix(db?: string): string {
    const target = db?.trim() || this._currentDatabase;
    return target ? `${quoteIdent(target, 'mssql')}.` : '';
  }

  async listDatabases(): Promise<DatabaseInfo[]> {
    const res = await this.query(
      'SELECT name, SUSER_SNAME(owner_sid) AS owner, collation_name FROM sys.databases ORDER BY name',
    );
    return (res.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0] ?? ''),
      owner: r[1] != null ? String(r[1]) : undefined,
      collation: r[2] != null ? String(r[2]) : undefined,
    }));
  }

  async listSchemas(db?: string): Promise<SchemaInfo[]> {
    const prefix = this.dbPrefix(db);
    const res = await this.query(
      `SELECT name, USER_NAME(principal_id) AS owner FROM ${prefix}sys.schemas ORDER BY name`,
    );
    const systemNames = new Set([
      'sys',
      'INFORMATION_SCHEMA',
      'guest',
      'db_owner',
      'db_accessadmin',
      'db_securityadmin',
      'db_ddladmin',
      'db_backupoperator',
      'db_datareader',
      'db_datawriter',
      'db_denydatareader',
      'db_denydatawriter',
    ]);
    return (res.results[0]?.rows ?? []).map((r) => {
      const name = String(r[0] ?? '');
      return {
        name,
        owner: r[1] != null ? String(r[1]) : undefined,
        isSystem: systemNames.has(name),
      };
    });
  }

  async listTables(db?: string, schema?: string): Promise<TableSummary[]> {
    const targetDb = db?.trim() || this._currentDatabase;
    const prefix = this.dbPrefix(targetDb);
    const schemaFilter = schema ? `WHERE s.name = N'${escSql(schema)}'` : '';
    const res = await this.query(
      `SELECT t.name, s.name AS schema_name, SUM(p.rows) AS row_count
       FROM ${prefix}sys.tables t
       INNER JOIN ${prefix}sys.schemas s ON t.schema_id = s.schema_id
       LEFT JOIN ${prefix}sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0, 1)
       ${schemaFilter}
       GROUP BY t.name, s.name
       ORDER BY s.name, t.name`,
    );
    return (res.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0] ?? ''),
      schema: String(r[1] ?? schema ?? 'dbo'),
      database: targetDb,
      kind: 'table',
      rowCountEstimate: r[2] != null ? Number(r[2]) : undefined,
    }));
  }

  async listViews(db?: string, schema?: string): Promise<ViewSummary[]> {
    const targetDb = db?.trim() || this._currentDatabase;
    const prefix = this.dbPrefix(targetDb);
    const schemaFilter = schema ? `WHERE s.name = N'${escSql(schema)}'` : '';
    const res = await this.query(
      `SELECT v.name, s.name AS schema_name, m.definition
       FROM ${prefix}sys.views v
       INNER JOIN ${prefix}sys.schemas s ON v.schema_id = s.schema_id
       LEFT JOIN ${prefix}sys.sql_modules m ON v.object_id = m.object_id
       ${schemaFilter}
       ORDER BY s.name, v.name`,
    );
    return (res.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0] ?? ''),
      schema: String(r[1] ?? schema ?? 'dbo'),
      database: targetDb,
      definition: r[2] != null ? String(r[2]) : undefined,
    }));
  }

  async listRoutines(db?: string, schema?: string): Promise<RoutineSummary[]> {
    const targetDb = db?.trim() || this._currentDatabase;
    const prefix = this.dbPrefix(targetDb);
    const schemaFilter = schema ? `AND s.name = N'${escSql(schema)}'` : '';
    const res = await this.query(
      `SELECT o.name, s.name AS schema_name,
              CASE WHEN o.type IN ('P', 'PC') THEN 'PROCEDURE' ELSE 'FUNCTION' END AS routine_type,
              m.definition
       FROM ${prefix}sys.objects o
       INNER JOIN ${prefix}sys.schemas s ON o.schema_id = s.schema_id
       LEFT JOIN ${prefix}sys.sql_modules m ON o.object_id = m.object_id
       WHERE o.type IN ('P', 'PC', 'FN', 'IF', 'TF') ${schemaFilter}
       ORDER BY s.name, o.name`,
    );
    return (res.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0] ?? ''),
      schema: String(r[1] ?? schema ?? 'dbo'),
      database: targetDb,
      kind: String(r[2] ?? '').toUpperCase() === 'PROCEDURE' ? 'procedure' : 'function',
      definition: r[3] != null ? String(r[3]) : undefined,
    }));
  }

  async listSequences(db?: string, schema?: string): Promise<SequenceSummary[]> {
    const targetDb = db?.trim() || this._currentDatabase;
    const prefix = this.dbPrefix(targetDb);
    const schemaFilter = schema ? `WHERE s.name = N'${escSql(schema)}'` : '';
    const res = await this.query(
      `SELECT seq.name, s.name AS schema_name, TYPE_NAME(seq.system_type_id),
              CAST(seq.start_value AS NVARCHAR(64)), CAST(seq.minimum_value AS NVARCHAR(64)),
              CAST(seq.maximum_value AS NVARCHAR(64)), CAST(seq.increment AS NVARCHAR(64)),
              seq.is_cycling, CAST(seq.current_value AS NVARCHAR(64))
       FROM ${prefix}sys.sequences seq
       INNER JOIN ${prefix}sys.schemas s ON seq.schema_id = s.schema_id
       ${schemaFilter}
       ORDER BY s.name, seq.name`,
    ).catch(() => null);
    return (res?.results[0]?.rows ?? []).map((r) => {
      const name = String(r[0] ?? '');
      const sch = String(r[1] ?? schema ?? 'dbo');
      const dataType = r[2] ? String(r[2]) : 'bigint';
      const startValue = r[3] != null ? String(r[3]) : '1';
      const increment = r[6] != null ? String(r[6]) : '1';
      return {
        name,
        schema: sch,
        database: targetDb,
        dataType,
        startValue,
        minValue: r[4] != null ? String(r[4]) : undefined,
        maxValue: r[5] != null ? String(r[5]) : undefined,
        increment,
        cycle: Boolean(r[7]),
        lastValue: r[8] != null ? String(r[8]) : null,
        definition: `CREATE SEQUENCE ${qualifiedTableName(targetDb, sch, name, 'mssql')} AS ${dataType} START WITH ${startValue} INCREMENT BY ${increment};`,
      };
    });
  }

  async listSynonyms(db?: string, schema?: string): Promise<SynonymSummary[]> {
    const targetDb = db?.trim() || this._currentDatabase;
    const prefix = this.dbPrefix(targetDb);
    const schemaFilter = schema ? `WHERE s.name = N'${escSql(schema)}'` : '';
    const res = await this.query(
      `SELECT syn.name, s.name AS schema_name, syn.base_object_name
       FROM ${prefix}sys.synonyms syn
       INNER JOIN ${prefix}sys.schemas s ON syn.schema_id = s.schema_id
       ${schemaFilter}
       ORDER BY s.name, syn.name`,
    ).catch(() => null);
    return (res?.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0] ?? ''),
      schema: String(r[1] ?? schema ?? 'dbo'),
      database: targetDb,
      baseObject: String(r[2] ?? ''),
    }));
  }

  async listLinkedServers(): Promise<LinkedServerSummary[]> {
    const res = await this.query(
      `SELECT name, product, provider, data_source, catalog
       FROM sys.servers
       WHERE is_linked = 1
       ORDER BY name`,
    ).catch(() => null);
    return (res?.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0] ?? ''),
      product: r[1] != null ? String(r[1]) : undefined,
      provider: r[2] != null ? String(r[2]) : undefined,
      dataSource: r[3] != null ? String(r[3]) : undefined,
      catalog: r[4] != null ? String(r[4]) : undefined,
    }));
  }

  async listObjectDependencies(db: string, schema: string, name: string): Promise<ObjectDependency[]> {
    const targetDb = db?.trim() || this._currentDatabase;
    const prefix = this.dbPrefix(targetDb);
    const res = await this.query(
      `SELECT DISTINCT COALESCE(d.referenced_schema_name, 'dbo'), d.referenced_entity_name
       FROM ${prefix}sys.sql_expression_dependencies d
       INNER JOIN ${prefix}sys.objects o ON o.object_id = d.referencing_id
       INNER JOIN ${prefix}sys.schemas s ON s.schema_id = o.schema_id
       WHERE s.name = N'${escSql(schema || 'dbo')}' AND o.name = N'${escSql(name)}'`,
    ).catch(() => null);
    return (res?.results[0]?.rows ?? []).map((r) => ({
      direction: 'depends_on',
      kind: 'object',
      schema: String(r[0] ?? 'dbo'),
      name: String(r[1] ?? ''),
    }));
  }

  async createDatabase(name: string): Promise<void> {
    await this.query(`CREATE DATABASE ${quoteIdent(name, 'mssql')};`);
  }

  async createSchema(_db: string, name: string): Promise<void> {
    await this.query(`CREATE SCHEMA ${quoteIdent(name, 'mssql')};`);
  }

  async listProcesses(): Promise<ProcessEntry[]> {
    const res = await this.query(
      `SELECT CAST(s.session_id AS NVARCHAR(32)), COALESCE(s.login_name, ''), COALESCE(s.host_name, ''),
              COALESCE(DB_NAME(s.database_id), ''), COALESCE(r.command, s.status), COALESCE(r.status, s.status),
              COALESCE(r.total_elapsed_time / 1000, 0), COALESCE(t.text, ''), COALESCE(r.wait_type, ''),
              CASE WHEN s.session_id = @@SPID THEN 1 ELSE 0 END
       FROM sys.dm_exec_sessions s
       LEFT JOIN sys.dm_exec_requests r ON s.session_id = r.session_id
       OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
       WHERE s.is_user_process = 1
       ORDER BY s.session_id`,
    ).catch(() => null);
    return (res?.results[0]?.rows ?? []).map((r) => ({
      id: String(r[0]),
      user: String(r[1] ?? ''),
      host: String(r[2] ?? ''),
      database: String(r[3] ?? ''),
      command: String(r[4] ?? ''),
      state: String(r[5] ?? ''),
      durationSec: r[6] != null ? Number(r[6]) : 0,
      sql: r[7] ? String(r[7]) : '',
      waitEvent: r[8] ? String(r[8]) : undefined,
      isCurrentSession: Boolean(r[9]),
    }));
  }

  async killProcess(id: string): Promise<void> {
    const spid = Number(id);
    if (!Number.isInteger(spid) || spid <= 0) throw new Error('Invalid SQL Server SPID');
    await this.query(`KILL ${spid};`);
  }

  async getServerStatus(): Promise<ServerStatusSnapshot> {
    const res = await this.query(
      `SELECT DATEDIFF(SECOND, sqlserver_start_time, GETDATE()),
              (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1),
              (SELECT COUNT(*) FROM sys.dm_exec_requests WHERE session_id > 50)
       FROM sys.dm_os_sys_info`,
    ).catch(() => null);
    const row = res?.results[0]?.rows[0];
    return {
      engine: 'sqlserver',
      timestamp: Date.now(),
      uptimeSeconds: Number(row?.[0] ?? 0),
      totalConnections: Number(row?.[1] ?? 0),
      activeConnections: Number(row?.[2] ?? 0),
      metrics: [
        { key: 'user_sessions', label: 'User Sessions', value: String(row?.[1] ?? 0), group: 'Connections' },
        { key: 'active_requests', label: 'Active Requests', value: String(row?.[2] ?? 0), group: 'Connections' },
      ],
      variables: [],
    };
  }

  async listUsers(): Promise<DatabaseUserSummary[]> {
    const res = await this.query(
      `SELECT name, type_desc FROM sys.database_principals WHERE type IN ('S', 'U', 'G', 'R') ORDER BY name`,
    ).catch(() => null);
    return (res?.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      authPlugin: r[1] ? String(r[1]) : undefined,
      canLogin: String(r[1] ?? '').includes('USER'),
    }));
  }

  async listTriggers(db?: string, schema?: string): Promise<TriggerSummary[]> {
    const targetDb = db?.trim() || this._currentDatabase;
    const prefix = this.dbPrefix(targetDb);
    const schemaFilter = schema ? `WHERE s.name = N'${escSql(schema)}'` : '';
    const res = await this.query(
      `SELECT tr.name, s.name AS schema_name, t.name AS table_name,
              CASE WHEN tr.is_instead_of_trigger = 1 THEN 'INSTEAD OF' ELSE 'AFTER' END AS timing,
              m.definition
       FROM ${prefix}sys.triggers tr
       INNER JOIN ${prefix}sys.tables t ON tr.parent_id = t.object_id
       INNER JOIN ${prefix}sys.schemas s ON t.schema_id = s.schema_id
       LEFT JOIN ${prefix}sys.sql_modules m ON tr.object_id = m.object_id
       ${schemaFilter}
       ORDER BY s.name, t.name, tr.name`,
    );
    return (res.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0] ?? ''),
      schema: String(r[1] ?? schema ?? 'dbo'),
      database: targetDb,
      tableName: String(r[2] ?? ''),
      timing: r[3] != null ? String(r[3]) : undefined,
      definition: r[4] != null ? String(r[4]) : undefined,
    }));
  }

  async getTableStructure(db: string, schema: string, table: string): Promise<TableStructure> {
    const targetDb = db?.trim() || this._currentDatabase;
    const targetSchema = schema?.trim() || 'dbo';
    const prefix = this.dbPrefix(targetDb);
    const escSch = escSql(targetSchema);
    const escTbl = escSql(table);

    const colsRes = await this.query(
      `SELECT c.name, ty.name AS data_type, c.max_length, c.precision, c.scale,
              c.is_nullable, c.is_identity, dc.definition AS default_value
       FROM ${prefix}sys.columns c
       INNER JOIN ${prefix}sys.objects o ON c.object_id = o.object_id
       INNER JOIN ${prefix}sys.schemas s ON o.schema_id = s.schema_id
       INNER JOIN ${prefix}sys.types ty ON c.user_type_id = ty.user_type_id
       LEFT JOIN ${prefix}sys.default_constraints dc ON c.default_object_id = dc.object_id
       WHERE s.name = N'${escSch}' AND o.name = N'${escTbl}'
       ORDER BY c.column_id`,
    );

    const idxRes = await this.query(
      `SELECT i.name, i.is_unique, i.is_primary_key, i.type_desc, c.name AS col_name, ic.key_ordinal
       FROM ${prefix}sys.indexes i
       INNER JOIN ${prefix}sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
       INNER JOIN ${prefix}sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
       INNER JOIN ${prefix}sys.objects o ON i.object_id = o.object_id
       INNER JOIN ${prefix}sys.schemas s ON o.schema_id = s.schema_id
       WHERE s.name = N'${escSch}' AND o.name = N'${escTbl}' AND i.name IS NOT NULL AND ic.is_included_column = 0
       ORDER BY i.index_id, ic.key_ordinal`,
    ).catch(() => null);

    const fkRes = await this.query(
      `SELECT fk.name, pc.name AS col_name, rs.name AS ref_schema, rt.name AS ref_table,
              rc.name AS ref_col, fk.delete_referential_action_desc, fk.update_referential_action_desc
       FROM ${prefix}sys.foreign_keys fk
       INNER JOIN ${prefix}sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
       INNER JOIN ${prefix}sys.tables pt ON fkc.parent_object_id = pt.object_id
       INNER JOIN ${prefix}sys.schemas ps ON pt.schema_id = ps.schema_id
       INNER JOIN ${prefix}sys.columns pc ON fkc.parent_object_id = pc.object_id AND fkc.parent_column_id = pc.column_id
       INNER JOIN ${prefix}sys.tables rt ON fkc.referenced_object_id = rt.object_id
       INNER JOIN ${prefix}sys.schemas rs ON rt.schema_id = rs.schema_id
       INNER JOIN ${prefix}sys.columns rc ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id
       WHERE ps.name = N'${escSch}' AND pt.name = N'${escTbl}'
       ORDER BY fk.name, fkc.constraint_column_id`,
    ).catch(() => null);

    const chkRes = await this.query(
      `SELECT cc.name, cc.definition
       FROM ${prefix}sys.check_constraints cc
       INNER JOIN ${prefix}sys.tables t ON cc.parent_object_id = t.object_id
       INNER JOIN ${prefix}sys.schemas s ON t.schema_id = s.schema_id
       WHERE s.name = N'${escSch}' AND t.name = N'${escTbl}'
       ORDER BY cc.name`,
    ).catch(() => null);

    // Group indexes
    const idxMap = new Map<string, IndexStructure>();
    const pkOrdinals = new Map<string, number>();
    for (const r of idxRes?.results[0]?.rows ?? []) {
      const idxName = String(r[0] ?? '');
      const isUnique = Boolean(r[1]);
      const isPrimary = Boolean(r[2]);
      const typeDesc = r[3] != null ? String(r[3]) : undefined;
      const colName = String(r[4] ?? '');
      const ordinal = Number(r[5] ?? 1);
      if (isPrimary && colName) pkOrdinals.set(colName, ordinal);
      let entry = idxMap.get(idxName);
      if (!entry) {
        entry = { name: idxName, columns: [], unique: isUnique, primary: isPrimary, type: typeDesc };
        idxMap.set(idxName, entry);
      }
      if (colName) entry.columns.push(colName);
    }

    // Group foreign keys
    const fkMap = new Map<string, ForeignKeyStructure>();
    const fkColsSet = new Set<string>();
    for (const r of fkRes?.results[0]?.rows ?? []) {
      const fkName = String(r[0] ?? '');
      const colName = String(r[1] ?? '');
      const refSchema = String(r[2] ?? targetSchema);
      const refTable = String(r[3] ?? '');
      const refCol = String(r[4] ?? '');
      const onDelete = r[5] != null ? String(r[5]).replaceAll('_', ' ') : undefined;
      const onUpdate = r[6] != null ? String(r[6]).replaceAll('_', ' ') : undefined;
      if (colName) fkColsSet.add(colName);
      let entry = fkMap.get(fkName);
      if (!entry) {
        entry = {
          name: fkName,
          columns: [],
          referencedSchema: refSchema,
          referencedTable: refTable,
          referencedColumns: [],
          onDelete,
          onUpdate,
        };
        fkMap.set(fkName, entry);
      }
      if (colName) entry.columns.push(colName);
      if (refCol) entry.referencedColumns.push(refCol);
    }

    const checkConstraints: CheckConstraintStructure[] = (chkRes?.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0] ?? ''),
      expression: String(r[1] ?? ''),
    }));

    const columns: ColumnStructure[] = (colsRes.results[0]?.rows ?? []).map((r) => {
      const colName = String(r[0] ?? '');
      const baseType = String(r[1] ?? 'nvarchar');
      const rawMaxLen = r[2] != null ? Number(r[2]) : null;
      const precision = r[3] != null ? Number(r[3]) : null;
      const scale = r[4] != null ? Number(r[4]) : null;
      const nullable = Boolean(r[5]);
      const isIdentity = Boolean(r[6]);
      const defaultValue = r[7] != null ? String(r[7]) : null;

      let formattedType = baseType;
      const lowerType = baseType.toLowerCase();
      if (lowerType === 'nvarchar' || lowerType === 'nchar') {
        formattedType = rawMaxLen === -1 ? `${baseType}(max)` : rawMaxLen ? `${baseType}(${Math.floor(rawMaxLen / 2)})` : baseType;
      } else if (lowerType === 'varchar' || lowerType === 'char' || lowerType === 'varbinary' || lowerType === 'binary') {
        formattedType = rawMaxLen === -1 ? `${baseType}(max)` : rawMaxLen ? `${baseType}(${rawMaxLen})` : baseType;
      } else if ((lowerType === 'decimal' || lowerType === 'numeric') && precision !== null) {
        formattedType = `${baseType}(${precision},${scale ?? 0})`;
      }

      const pkOrd = pkOrdinals.get(colName);
      return {
        name: colName,
        dataType: formattedType,
        nullable,
        defaultValue,
        isPrimaryKey: pkOrd !== undefined,
        primaryKeyOrdinal: pkOrd,
        isForeignKey: fkColsSet.has(colName),
        isAutoIncrement: isIdentity,
        maxLength: rawMaxLen,
        numericPrecision: precision,
        numericScale: scale,
      };
    });

    const indexes = Array.from(idxMap.values());
    const foreignKeys = Array.from(fkMap.values());
    const createDdl = buildCreateTableDdl('mssql', targetDb, targetSchema, {
      name: table,
      columns: columns.map((c) => ({
        name: c.name,
        dataType: c.dataType,
        nullable: c.nullable,
        defaultValue: c.defaultValue,
        isPrimaryKey: c.isPrimaryKey,
        isAutoIncrement: c.isAutoIncrement,
      })),
      foreignKeys: foreignKeys.map((fk) => ({
        name: fk.name,
        columns: fk.columns,
        referencedSchema: fk.referencedSchema,
        referencedTable: fk.referencedTable,
        referencedColumns: fk.referencedColumns,
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
      })),
    });

    return {
      database: targetDb,
      schema: targetSchema,
      table,
      columns,
      indexes,
      foreignKeys,
      checkConstraints,
      createDdl,
    };
  }

  async getSchemaErGraph(db: string, schema = 'dbo'): Promise<SchemaErGraph> {
    const targetDb = db?.trim() || this._currentDatabase;
    const targetSchema = schema?.trim() || 'dbo';
    const tables = await this.listTables(targetDb, targetSchema);
    const erTables: SchemaErTable[] = [];
    const edges: SchemaErEdge[] = [];

    for (const t of tables) {
      const struct = await this.getTableStructure(targetDb, targetSchema, t.name);
      erTables.push({ name: t.name, schema: targetSchema, columns: struct.columns });
      for (const fk of struct.foreignKeys) {
        edges.push({
          id: `${t.name}:${fk.name}`,
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

    return {
      database: targetDb,
      schema: targetSchema,
      tables: erTables,
      edges,
    };
  }

  async browseTable(
    db: string,
    schema: string,
    table: string,
    options?: BrowseTableOptions,
  ): Promise<BrowseTableResult> {
    const targetDb = db?.trim() || this._currentDatabase;
    const targetSchema = schema?.trim() || 'dbo';
    const page = Math.max(1, options?.page ?? 1);
    const pageSize = Math.min(1000, Math.max(1, options?.pageSize ?? 50));
    const offset = (page - 1) * pageSize;
    const qTable = qualifiedTableName(targetDb, targetSchema, table, 'mssql');

    const where = options?.whereClause?.trim() ? ` WHERE ${options.whereClause.trim()}` : '';
    const order = options?.sortBy
      ? ` ORDER BY ${quoteIdent(options.sortBy, 'mssql')} ${options.sortDir === 'desc' ? 'DESC' : 'ASC'}`
      : ' ORDER BY (SELECT NULL)';
    const dataSql = `SELECT * FROM ${qTable}${where}${order} OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY`;
    const countSql = `SELECT COUNT(*) AS total_rows FROM ${qTable}${where}`;

    const started = performance.now();
    const dataRes = await this.query(dataSql, { maxRows: pageSize, signal: options?.signal });
    const countRes = await this.query(countSql, { maxRows: 1, signal: options?.signal });

    const rs = dataRes.results[0];
    const totalRows = Number(countRes.results[0]?.rows[0]?.[0] ?? rs?.rowCount ?? 0);
    return {
      database: targetDb,
      schema: targetSchema,
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
    return buildBatchMutations(
      'mssql',
      db || this._currentDatabase,
      schema || 'dbo',
      table,
      structure,
      changes,
    );
  }

  async applyBatchMutations(sqlStatements: readonly string[]): Promise<BatchMutationApplyResult> {
    const started = performance.now();
    const manageTx = !this._inTransaction;
    let affectedRows = 0;

    if (manageTx) await this.beginTransaction();
    try {
      for (const stmt of sqlStatements) {
        const res = await this.query(stmt);
        for (const r of res.results) {
          affectedRows += r.affectedRows;
        }
      }
      if (manageTx) await this.commitTransaction();
    } catch (err) {
      if (manageTx) {
        await this.rollbackTransaction().catch(() => {});
      }
      throw err;
    }

    return {
      applied: sqlStatements.length,
      affectedRows,
      executionMs: Math.round(performance.now() - started),
    };
  }

  async explain(sql: string, analyze = false): Promise<ExplainResult> {
    const setting = analyze ? 'STATISTICS PROFILE' : 'SHOWPLAN_TEXT';
    await this.executeBatch(`SET ${setting} ON`);
    let planLines: string[] = [];
    try {
      const sets = await this.executeBatch(sql);
      // For SHOWPLAN_TEXT, result set 0 has StmtText; for STATISTICS PROFILE, the last set has StmtText
      const targetSet = analyze ? sets[sets.length - 1] : sets[0];
      const stmtIdx = (targetSet?.columns ?? []).findIndex((c) => c.name.toLowerCase() === 'stmttext');
      const colIdx = stmtIdx >= 0 ? stmtIdx : 0;
      planLines = (targetSet?.rows ?? [])
        .map((r) => (r[colIdx] != null ? String(r[colIdx]) : ''))
        .filter((line) => line.trim().length > 0);
    } finally {
      await this.executeBatch(`SET ${setting} OFF`).catch(() => {});
    }

    const parsed = parseClickHouseExplainText(planLines);
    enrichMssqlExplainNode(parsed.root);
    return {
      ...parsed,
      dialect: 'mssql',
      analyzed: analyze,
      rawText: planLines.join('\n'),
    };
  }

  generateAlterTableDdl(db: string, schema: string, table: string, diff: TableStructureDiff): string[] {
    return buildMssqlAlterTableDdl(db || this._currentDatabase, schema || 'dbo', table, diff);
  }

  generateCreateTableDdl(db: string, schema: string, spec: CreateTableSpec): string {
    return buildCreateTableDdl('mssql', db || this._currentDatabase, schema || 'dbo', spec);
  }

  async dropObject(
    db: string,
    schema: string,
    name: string,
    kind: DropObjectKind,
    cascade = false,
    tableName?: string,
  ): Promise<void> {
    const targetDb = db || this._currentDatabase;
    const targetSchema = schema || 'dbo';
    if (kind === 'routine') {
      const qName = qualifiedTableName(targetDb, targetSchema, name, 'mssql');
      await this.query(`DROP PROCEDURE IF EXISTS ${qName}; DROP FUNCTION IF EXISTS ${qName};`);
      return;
    }
    await this.query(buildDropObjectSql('mssql', targetDb, targetSchema, name, kind, cascade, tableName));
  }

  async truncateTable(db: string, schema: string, table: string, cascade = false): Promise<void> {
    await this.query(
      buildTruncateTableSql('mssql', db || this._currentDatabase, schema || 'dbo', table, cascade),
    );
  }

  async dumpDatabaseSql(
    db: string,
    schema = 'dbo',
    tables?: string[],
    includeData = true,
  ): Promise<string> {
    const targetDb = db?.trim() || this._currentDatabase;
    const targetSchema = schema?.trim() || 'dbo';
    const list = tables ?? (await this.listTables(targetDb, targetSchema)).map((t) => t.name);
    const dumpTables = [];
    for (const table of list) {
      const structure = await this.getTableStructure(targetDb, targetSchema, table);
      let columns = structure.columns.map((c) => c.name);
      let rows: CellValue[][] = [];
      if (includeData) {
        const qTable = qualifiedTableName(targetDb, targetSchema, table, 'mssql');
        const res = await this.query(`SELECT TOP (50000) * FROM ${qTable}`);
        columns = res.results[0]?.columns.map((c) => c.name) ?? columns;
        rows = res.results[0]?.rows ?? [];
      }
      dumpTables.push({ structure, columns, rows });
    }
    return generateSqlDump('mssql', targetDb, targetSchema, dumpTables, includeData);
  }

  diffSchemas(leftSchema: SchemaSnapshot, rightSchema: SchemaSnapshot): SchemaDiffResult {
    return runSchemaDiff(leftSchema, rightSchema);
  }
}

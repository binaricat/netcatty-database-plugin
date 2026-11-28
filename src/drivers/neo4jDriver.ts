/**
 * Pure-TS Neo4j Database Driver (100% browser-sandbox compatible).
 *
 * Supports BOTH:
 * 1. Bolt v4.3 / v4.4 / v5.0-v5.4 binary wire protocol with full PackStream v1
 *    encoder/decoder over ByteStream (including TLS via transport.connect).
 * 2. HTTP Cypher API fallback (Neo4j 5 /db/{db}/query/v2 and Neo4j 4/5
 *    /db/{db}/tx/commit with resultDataContents: ["row", "graph"]) via
 *    sendHttpRequest when config.protocol === 'http' or port is 7474 / 7473.
 */

import {
  decodeResponseJson,
  decodeResponseText,
  encodeBasicAuth,
  resolveHttpTls,
  sendHttpRequest,
  type HttpEndpointConfig,
} from './httpClient';
import { BufferedByteStream, concatBytes } from './streamBuffer';
import {
  QueryError,
  type ByteStreamTransport,
  type CellValue,
  type ConnectionConfig,
  type ConnectionInfo,
  type DatabaseInfo,
  type GraphConstraintSummary,
  type GraphDriver,
  type GraphIndexSummary,
  type GraphLabelSummary,
  type GraphNode,
  type GraphQueryCounters,
  type GraphQueryResult,
  type GraphRelationship,
  type GraphSchemaSummary,
  type TestConnectionResult,
} from './types';

const te = new TextEncoder();
const td = new TextDecoder('utf-8');

/* ============================================================================
 * Parameterized Cypher CRUD & EXPLAIN/PROFILE Plan Helpers
 * ============================================================================ */

export interface CypherPlanNode {
  operatorType: string;
  identifiers: string[];
  estimatedRows?: number;
  dbHits?: number;
  rows?: number;
  arguments: Record<string, unknown>;
  children: CypherPlanNode[];
}

export interface GraphExplainPlanResult {
  mode: 'EXPLAIN' | 'PROFILE';
  cypher: string;
  plan: CypherPlanNode | null;
  rawPlan?: unknown;
  notifications?: string[];
  counters?: GraphQueryCounters;
  rowCount: number;
  executionMs: number;
}

function escapeCypherIdentifier(ident: string): string {
  const trimmed = ident.trim();
  if (!trimmed) throw new Error('Cypher identifier cannot be empty');
  return '`' + trimmed.replaceAll('`', '``') + '`';
}

export function buildCreateNodeCypher(
  labels: readonly string[],
  properties: Record<string, unknown> = {},
): { cypher: string; params: Record<string, unknown> } {
  const cleanLabels = labels.map((l) => l.trim()).filter(Boolean);
  const labelExpr =
    cleanLabels.length > 0
      ? cleanLabels.map((l) => `:${escapeCypherIdentifier(l)}`).join('')
      : '';
  return {
    cypher: `CREATE (n${labelExpr} $props) RETURN n`,
    params: { props: properties },
  };
}

export function buildUpdateNodeCypher(
  nodeId: string,
  properties: Record<string, unknown>,
  replaceAll = false,
): { cypher: string; params: Record<string, unknown> } {
  const op = replaceAll ? '=' : '+=';
  return {
    cypher: `MATCH (n) WHERE elementId(n) = $id OR toString(id(n)) = $id SET n ${op} $props RETURN n`,
    params: { id: nodeId, props: properties },
  };
}

export function buildDeleteNodeCypher(
  nodeId: string,
  detach = true,
): { cypher: string; params: Record<string, unknown> } {
  const verb = detach ? 'DETACH DELETE' : 'DELETE';
  return {
    cypher: `MATCH (n) WHERE elementId(n) = $id OR toString(id(n)) = $id ${verb} n`,
    params: { id: nodeId },
  };
}

export function buildCreateRelationshipCypher(
  startNodeId: string,
  endNodeId: string,
  relType: string,
  properties: Record<string, unknown> = {},
): { cypher: string; params: Record<string, unknown> } {
  const safeType = escapeCypherIdentifier(relType);
  return {
    cypher:
      `MATCH (a), (b) ` +
      `WHERE (elementId(a) = $startId OR toString(id(a)) = $startId) ` +
      `AND (elementId(b) = $endId OR toString(id(b)) = $endId) ` +
      `CREATE (a)-[r:${safeType} $props]->(b) RETURN a, r, b`,
    params: { startId: startNodeId, endId: endNodeId, props: properties },
  };
}

export function buildUpdateRelationshipCypher(
  relId: string,
  properties: Record<string, unknown>,
  replaceAll = false,
): { cypher: string; params: Record<string, unknown> } {
  const op = replaceAll ? '=' : '+=';
  return {
    cypher: `MATCH ()-[r]-() WHERE elementId(r) = $id OR toString(id(r)) = $id SET r ${op} $props RETURN r`,
    params: { id: relId, props: properties },
  };
}

export function buildDeleteRelationshipCypher(
  relId: string,
): { cypher: string; params: Record<string, unknown> } {
  return {
    cypher: `MATCH ()-[r]-() WHERE elementId(r) = $id OR toString(id(r)) = $id DELETE r`,
    params: { id: relId },
  };
}

export function buildExplainCypher(cypher: string, mode: 'EXPLAIN' | 'PROFILE' = 'EXPLAIN'): string {
  const stripped = cypher.trim().replace(/^(EXPLAIN|PROFILE)\s+/i, '');
  if (!stripped) throw new Error('Cypher statement is required');
  return `${mode} ${stripped}`;
}

export function normalizeCypherPlanNode(raw: unknown): CypherPlanNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const root =
    obj.root && typeof obj.root === 'object' ? (obj.root as Record<string, unknown>) : obj;
  const operatorType = String(root.operatorType ?? root.operator ?? 'Plan');
  const args =
    root.args && typeof root.args === 'object'
      ? (root.args as Record<string, unknown>)
      : root.arguments && typeof root.arguments === 'object'
        ? (root.arguments as Record<string, unknown>)
        : {};
  const identifiers = Array.isArray(root.identifiers) ? root.identifiers.map(String) : [];
  const rawChildren = Array.isArray(root.children) ? root.children : [];
  const children = rawChildren
    .map((c) => normalizeCypherPlanNode(c))
    .filter((c): c is CypherPlanNode => c !== null);

  const pickNum = (...vals: unknown[]): number | undefined => {
    for (const v of vals) {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return undefined;
  };

  return {
    operatorType,
    identifiers,
    estimatedRows: pickNum(root.estimatedRows, args.EstimatedRows, args.estimatedRows),
    dbHits: pickNum(root.dbHits, root['db-hits'], args.DbHits, args.dbHits),
    rows: pickNum(root.rows, args.Rows, args.rows),
    arguments: args,
    children,
  };
}

/* ============================================================================
 * PackStream v1 Structs & Codec
 * ============================================================================ */

export interface PackStreamStruct {
  readonly __packstreamStruct: true;
  tag: number;
  fields: unknown[];
}

export function makePackStreamStruct(tag: number, fields: unknown[]): PackStreamStruct {
  return { __packstreamStruct: true, tag, fields };
}

export function isPackStreamStruct(value: unknown): value is PackStreamStruct {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<PackStreamStruct>).__packstreamStruct === true &&
    typeof (value as Partial<PackStreamStruct>).tag === 'number' &&
    Array.isArray((value as Partial<PackStreamStruct>).fields)
  );
}

// Bolt message tags
const MSG_HELLO = 0x01;
const MSG_GOODBYE = 0x02;
const MSG_RESET = 0x0f;
const MSG_RUN = 0x10;
const MSG_DISCARD = 0x2f;
const MSG_PULL = 0x3f;
const MSG_LOGON = 0x6a;

const MSG_SUCCESS = 0x70;
const MSG_RECORD = 0x71;
const MSG_IGNORED = 0x7e;
const MSG_FAILURE = 0x7f;

// PackStream graph / temporal / spatial struct tags
const TAG_NODE = 0x4e; // 'N'
const TAG_RELATIONSHIP = 0x52; // 'R'
const TAG_UNBOUND_REL = 0x72; // 'r'
const TAG_PATH = 0x50; // 'P'
const TAG_DATE = 0x44; // 'D'
const TAG_TIME = 0x54; // 'T'
const TAG_LOCAL_TIME = 0x74; // 't'
const TAG_DATETIME_OFFSET_V4 = 0x46; // 'F'
const TAG_DATETIME_ZONE_V4 = 0x66; // 'f'
const TAG_DATETIME_OFFSET_V5 = 0x49; // 'I'
const TAG_DATETIME_ZONE_V5 = 0x69; // 'i'
const TAG_LOCAL_DATETIME = 0x64; // 'd'
const TAG_DURATION = 0x45; // 'E'
const TAG_POINT_2D = 0x58; // 'X'
const TAG_POINT_3D = 0x59; // 'Y'

const BOLT_MAGIC = new Uint8Array([0x60, 0x60, 0xb0, 0x17]);
const BOLT_MAX_CHUNK = 0x8000;

class ByteWriter {
  private chunks: Uint8Array[] = [];
  private total = 0;

  pushByte(b: number): void {
    this.chunks.push(new Uint8Array([b & 0xff]));
    this.total += 1;
  }

  pushBytes(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.chunks.push(bytes);
    this.total += bytes.length;
  }

  pushUint16BE(n: number): void {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n, false);
    this.pushBytes(b);
  }

  pushUint32BE(n: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, false);
    this.pushBytes(b);
  }

  pushInt8(n: number): void {
    const b = new Uint8Array(1);
    new DataView(b.buffer).setInt8(0, n);
    this.pushBytes(b);
  }

  pushInt16BE(n: number): void {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setInt16(0, n, false);
    this.pushBytes(b);
  }

  pushInt32BE(n: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, n, false);
    this.pushBytes(b);
  }

  pushInt64BE(n: bigint): void {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, n, false);
    this.pushBytes(b);
  }

  pushFloat64BE(n: number): void {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, n, false);
    this.pushBytes(b);
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.total);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }
}

function encodePackInt(w: ByteWriter, n: bigint): void {
  if (n >= -16n && n <= 127n) {
    w.pushByte(Number(n) & 0xff);
  } else if (n >= -128n && n <= -17n) {
    w.pushByte(0xc8);
    w.pushInt8(Number(n));
  } else if (n >= -32768n && n <= 32767n) {
    w.pushByte(0xc9);
    w.pushInt16BE(Number(n));
  } else if (n >= -2147483648n && n <= 2147483647n) {
    w.pushByte(0xca);
    w.pushInt32BE(Number(n));
  } else {
    w.pushByte(0xcb);
    w.pushInt64BE(n);
  }
}

function encodePackValue(w: ByteWriter, value: unknown): void {
  if (value === null || value === undefined) {
    w.pushByte(0xc0);
    return;
  }
  if (typeof value === 'boolean') {
    w.pushByte(value ? 0xc3 : 0xc2);
    return;
  }
  if (typeof value === 'bigint') {
    encodePackInt(w, value);
    return;
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value) && !Object.is(value, -0) && Number.isSafeInteger(value)) {
      encodePackInt(w, BigInt(value));
    } else {
      w.pushByte(0xc1);
      w.pushFloat64BE(value);
    }
    return;
  }
  if (typeof value === 'string') {
    const utf8 = te.encode(value);
    const len = utf8.length;
    if (len <= 15) {
      w.pushByte(0x80 | len);
    } else if (len <= 255) {
      w.pushByte(0xd0);
      w.pushByte(len);
    } else if (len <= 65535) {
      w.pushByte(0xd1);
      w.pushUint16BE(len);
    } else {
      w.pushByte(0xd2);
      w.pushUint32BE(len);
    }
    w.pushBytes(utf8);
    return;
  }
  if (value instanceof Uint8Array) {
    const len = value.length;
    if (len <= 255) {
      w.pushByte(0xcc);
      w.pushByte(len);
    } else if (len <= 65535) {
      w.pushByte(0xcd);
      w.pushUint16BE(len);
    } else {
      w.pushByte(0xce);
      w.pushUint32BE(len);
    }
    w.pushBytes(value);
    return;
  }
  if (Array.isArray(value)) {
    const len = value.length;
    if (len <= 15) {
      w.pushByte(0x90 | len);
    } else if (len <= 255) {
      w.pushByte(0xd4);
      w.pushByte(len);
    } else if (len <= 65535) {
      w.pushByte(0xd5);
      w.pushUint16BE(len);
    } else {
      w.pushByte(0xd6);
      w.pushUint32BE(len);
    }
    for (const item of value) {
      encodePackValue(w, item);
    }
    return;
  }
  if (isPackStreamStruct(value)) {
    const len = value.fields.length;
    if (len <= 15) {
      w.pushByte(0xb0 | len);
    } else if (len <= 255) {
      w.pushByte(0xdc);
      w.pushByte(len);
    } else {
      w.pushByte(0xdd);
      w.pushUint16BE(len);
    }
    w.pushByte(value.tag & 0xff);
    for (const f of value.fields) {
      encodePackValue(w, f);
    }
    return;
  }
  if (value instanceof Map) {
    const entries: Array<[string, unknown]> = [];
    for (const [k, v] of value.entries()) {
      if (v !== undefined) entries.push([String(k), v]);
    }
    encodePackDict(w, entries);
    return;
  }
  if (typeof value === 'object') {
    const entries: Array<[string, unknown]> = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) entries.push([k, v]);
    }
    encodePackDict(w, entries);
    return;
  }
  throw new Error(`Unsupported PackStream value type: ${typeof value}`);
}

function encodePackDict(w: ByteWriter, entries: Array<[string, unknown]>): void {
  const len = entries.length;
  if (len <= 15) {
    w.pushByte(0xa0 | len);
  } else if (len <= 255) {
    w.pushByte(0xd8);
    w.pushByte(len);
  } else if (len <= 65535) {
    w.pushByte(0xd9);
    w.pushUint16BE(len);
  } else {
    w.pushByte(0xda);
    w.pushUint32BE(len);
  }
  for (const [k, v] of entries) {
    encodePackValue(w, k);
    encodePackValue(w, v);
  }
}

export function packStreamEncode(value: unknown): Uint8Array {
  const w = new ByteWriter();
  encodePackValue(w, value);
  return w.toUint8Array();
}

class ByteReader {
  private readonly view: DataView;
  offset: number;

  constructor(private readonly bytes: Uint8Array, startOffset = 0) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = startOffset;
  }

  private ensure(n: number): void {
    if (this.offset + n > this.bytes.length) {
      throw new Error(`Unexpected end of PackStream buffer (need ${n} bytes at offset ${this.offset})`);
    }
  }

  readUint8(): number {
    this.ensure(1);
    return this.bytes[this.offset++];
  }

  readInt8(): number {
    this.ensure(1);
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readUint16BE(): number {
    this.ensure(2);
    const v = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return v;
  }

  readInt16BE(): number {
    this.ensure(2);
    const v = this.view.getInt16(this.offset, false);
    this.offset += 2;
    return v;
  }

  readUint32BE(): number {
    this.ensure(4);
    const v = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return v;
  }

  readInt32BE(): number {
    this.ensure(4);
    const v = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return v;
  }

  readInt64BE(): bigint {
    this.ensure(8);
    const v = this.view.getBigInt64(this.offset, false);
    this.offset += 8;
    return v;
  }

  readFloat64BE(): number {
    this.ensure(8);
    const v = this.view.getFloat64(this.offset, false);
    this.offset += 8;
    return v;
  }

  readSlice(len: number): Uint8Array {
    this.ensure(len);
    const out = this.bytes.slice(this.offset, this.offset + len);
    this.offset += len;
    return out;
  }
}

function decodePackValue(r: ByteReader): unknown {
  const marker = r.readUint8();

  // Positive TINY_INT: 0x00..0x7F
  if (marker <= 0x7f) return marker;
  // Negative TINY_INT: 0xF0..0xFF
  if (marker >= 0xf0) return marker - 256;

  // TINY_STRING: 0x80..0x8F
  if ((marker & 0xf0) === 0x80) {
    return td.decode(r.readSlice(marker & 0x0f));
  }
  // TINY_LIST: 0x90..0x9F
  if ((marker & 0xf0) === 0x90) {
    return decodePackList(r, marker & 0x0f);
  }
  // TINY_MAP: 0xA0..0xAF
  if ((marker & 0xf0) === 0xa0) {
    return decodePackMap(r, marker & 0x0f);
  }
  // TINY_STRUCT: 0xB0..0xBF
  if ((marker & 0xf0) === 0xb0) {
    return decodePackStruct(r, marker & 0x0f);
  }

  switch (marker) {
    case 0xc0:
      return null;
    case 0xc1:
      return r.readFloat64BE();
    case 0xc2:
      return false;
    case 0xc3:
      return true;
    case 0xc8:
      return r.readInt8();
    case 0xc9:
      return r.readInt16BE();
    case 0xca:
      return r.readInt32BE();
    case 0xcb: {
      const big = r.readInt64BE();
      if (big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(big);
      }
      return big.toString();
    }
    case 0xcc:
      return r.readSlice(r.readUint8());
    case 0xcd:
      return r.readSlice(r.readUint16BE());
    case 0xce:
      return r.readSlice(r.readUint32BE());
    case 0xd0:
      return td.decode(r.readSlice(r.readUint8()));
    case 0xd1:
      return td.decode(r.readSlice(r.readUint16BE()));
    case 0xd2:
      return td.decode(r.readSlice(r.readUint32BE()));
    case 0xd4:
      return decodePackList(r, r.readUint8());
    case 0xd5:
      return decodePackList(r, r.readUint16BE());
    case 0xd6:
      return decodePackList(r, r.readUint32BE());
    case 0xd8:
      return decodePackMap(r, r.readUint8());
    case 0xd9:
      return decodePackMap(r, r.readUint16BE());
    case 0xda:
      return decodePackMap(r, r.readUint32BE());
    case 0xdc:
      return decodePackStruct(r, r.readUint8());
    case 0xdd:
      return decodePackStruct(r, r.readUint16BE());
    default:
      throw new Error(`Unknown PackStream marker: 0x${marker.toString(16)}`);
  }
}

function decodePackList(r: ByteReader, len: number): unknown[] {
  const arr: unknown[] = [];
  for (let i = 0; i < len; i++) {
    arr.push(decodePackValue(r));
  }
  return arr;
}

function decodePackMap(r: ByteReader, len: number): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < len; i++) {
    const k = String(decodePackValue(r));
    obj[k] = decodePackValue(r);
  }
  return obj;
}

function decodePackStruct(r: ByteReader, len: number): PackStreamStruct {
  const tag = r.readUint8();
  const fields: unknown[] = [];
  for (let i = 0; i < len; i++) {
    fields.push(decodePackValue(r));
  }
  return makePackStreamStruct(tag, fields);
}

export function packStreamDecode(bytes: Uint8Array): unknown {
  const reader = new ByteReader(bytes, 0);
  return decodePackValue(reader);
}

/* ============================================================================
 * Temporal / Spatial / Graph Struct Normalization
 * ============================================================================ */

function pad2(n: number): string {
  return String(Math.abs(Math.trunc(n))).padStart(2, '0');
}

function formatNanos(nanos: number): string {
  if (!nanos) return '';
  const frac = String(Math.abs(Math.trunc(nanos))).padStart(9, '0').replace(/0+$/, '');
  return frac ? `.${frac}` : '';
}

function formatTzOffset(offsetSeconds: number): string {
  if (offsetSeconds === 0) return 'Z';
  const sign = offsetSeconds >= 0 ? '+' : '-';
  const abs = Math.abs(Math.trunc(offsetSeconds));
  const hours = Math.floor(abs / 3600);
  const mins = Math.floor((abs % 3600) / 60);
  const secs = abs % 60;
  return secs > 0 ? `${sign}${pad2(hours)}:${pad2(mins)}:${pad2(secs)}` : `${sign}${pad2(hours)}:${pad2(mins)}`;
}

function formatEpochDate(daysSinceEpoch: number): string {
  const dt = new Date(daysSinceEpoch * 86400000);
  const y = dt.getUTCFullYear();
  const yearStr = y < 0 ? `-${String(-y).padStart(4, '0')}` : String(y).padStart(4, '0');
  return `${yearStr}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function formatNanosOfDay(ns: number): string {
  const totalSec = Math.floor(ns / 1e9);
  const remNs = Math.floor(ns - totalSec * 1e9);
  const h = Math.floor(totalSec / 3600) % 24;
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}${formatNanos(remNs)}`;
}

function formatEpochDateTime(epochSeconds: number, nanos: number, offsetSeconds?: number, zoneId?: string): string {
  const adjustedSec = offsetSeconds !== undefined ? epochSeconds + offsetSeconds : epochSeconds;
  const dt = new Date(adjustedSec * 1000);
  const y = dt.getUTCFullYear();
  const yearStr = y < 0 ? `-${String(-y).padStart(4, '0')}` : String(y).padStart(4, '0');
  const base =
    `${yearStr}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}` +
    `T${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}:${pad2(dt.getUTCSeconds())}${formatNanos(nanos)}`;
  if (zoneId) return `${base}[${zoneId}]`;
  if (offsetSeconds !== undefined) return `${base}${formatTzOffset(offsetSeconds)}`;
  return base;
}

function formatDuration(months: number, days: number, seconds: number, nanos: number): string {
  let out = 'P';
  if (months) out += `${months}M`;
  if (days) out += `${days}D`;
  if (seconds || nanos || (!months && !days)) {
    out += 'T';
    if (nanos) {
      const sign = seconds < 0 || (seconds === 0 && nanos < 0) ? '-' : '';
      out += `${sign}${Math.abs(seconds)}${formatNanos(nanos)}S`;
    } else {
      out += `${seconds}S`;
    }
  }
  return out;
}

interface GraphCollector {
  nodes: Map<string, GraphNode>;
  relationships: Map<string, GraphRelationship>;
}

function addGraphNode(col: GraphCollector, node: GraphNode): void {
  if (!col.nodes.has(node.id)) {
    col.nodes.set(node.id, node);
  }
}

function addGraphRel(col: GraphCollector, rel: GraphRelationship): void {
  if (!col.relationships.has(rel.id)) {
    col.relationships.set(rel.id, rel);
  }
}

function structToGraphNode(s: PackStreamStruct, col: GraphCollector): GraphNode {
  const rawId = s.fields[0];
  const labels = Array.isArray(s.fields[1]) ? s.fields[1].map(String) : [];
  const rawProps = (s.fields[2] && typeof s.fields[2] === 'object' ? s.fields[2] : {}) as Record<string, unknown>;
  const elementId = typeof s.fields[3] === 'string' && s.fields[3].length > 0 ? s.fields[3] : String(rawId);
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawProps)) {
    properties[k] = normalizeBoltValue(v, col);
  }
  const node: GraphNode = { id: elementId, labels, properties };
  addGraphNode(col, node);
  return node;
}

function structToGraphRel(s: PackStreamStruct, col: GraphCollector): GraphRelationship {
  const rawId = s.fields[0];
  const rawStart = s.fields[1];
  const rawEnd = s.fields[2];
  const type = String(s.fields[3] ?? '');
  const rawProps = (s.fields[4] && typeof s.fields[4] === 'object' ? s.fields[4] : {}) as Record<string, unknown>;
  const elementId = typeof s.fields[5] === 'string' && s.fields[5].length > 0 ? s.fields[5] : String(rawId);
  const startNodeId = typeof s.fields[6] === 'string' && s.fields[6].length > 0 ? s.fields[6] : String(rawStart);
  const endNodeId = typeof s.fields[7] === 'string' && s.fields[7].length > 0 ? s.fields[7] : String(rawEnd);
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawProps)) {
    properties[k] = normalizeBoltValue(v, col);
  }
  const rel: GraphRelationship = { id: elementId, type, startNodeId, endNodeId, properties };
  addGraphRel(col, rel);
  return rel;
}

function normalizeBoltValue(value: unknown, col: GraphCollector): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeBoltValue(item, col));
  }
  if (isPackStreamStruct(value)) {
    switch (value.tag) {
      case TAG_NODE: {
        const node = structToGraphNode(value, col);
        return { id: node.id, labels: node.labels, properties: node.properties };
      }
      case TAG_RELATIONSHIP: {
        const rel = structToGraphRel(value, col);
        return {
          id: rel.id,
          type: rel.type,
          startNodeId: rel.startNodeId,
          endNodeId: rel.endNodeId,
          properties: rel.properties,
        };
      }
      case TAG_UNBOUND_REL: {
        const rawId = value.fields[0];
        const type = String(value.fields[1] ?? '');
        const rawProps = (value.fields[2] ?? {}) as Record<string, unknown>;
        const elementId =
          typeof value.fields[3] === 'string' && value.fields[3].length > 0 ? value.fields[3] : String(rawId);
        const properties: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rawProps)) {
          properties[k] = normalizeBoltValue(v, col);
        }
        return { id: elementId, type, properties };
      }
      case TAG_PATH: {
        const rawNodes = Array.isArray(value.fields[0]) ? value.fields[0] : [];
        const rawRels = Array.isArray(value.fields[1]) ? value.fields[1] : [];
        const indices = Array.isArray(value.fields[2]) ? value.fields[2].map(Number) : [];

        const pathNodes: GraphNode[] = [];
        for (const rn of rawNodes) {
          if (isPackStreamStruct(rn) && rn.tag === TAG_NODE) {
            pathNodes.push(structToGraphNode(rn, col));
          }
        }

        const unboundRels: Array<{ id: string; type: string; properties: Record<string, unknown> }> = [];
        for (const rr of rawRels) {
          if (isPackStreamStruct(rr) && rr.tag === TAG_UNBOUND_REL) {
            const rid =
              typeof rr.fields[3] === 'string' && rr.fields[3].length > 0
                ? rr.fields[3]
                : String(rr.fields[0]);
            const type = String(rr.fields[1] ?? '');
            const rawProps = (rr.fields[2] && typeof rr.fields[2] === 'object'
              ? rr.fields[2]
              : {}) as Record<string, unknown>;
            const properties: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(rawProps)) {
              properties[k] = normalizeBoltValue(v, col);
            }
            unboundRels.push({ id: rid, type, properties });
          }
        }

        const pathRels: GraphRelationship[] = [];
        if (pathNodes.length > 0) {
          let prevNode = pathNodes[0];
          for (let i = 0; i + 1 < indices.length; i += 2) {
            const relIdx = indices[i];
            const nextNodeIdx = indices[i + 1];
            const nextNode = pathNodes[nextNodeIdx];
            const ur = unboundRels[Math.abs(relIdx) - 1];
            if (ur && nextNode) {
              const bound: GraphRelationship =
                relIdx > 0
                  ? {
                      id: ur.id,
                      type: ur.type,
                      startNodeId: prevNode.id,
                      endNodeId: nextNode.id,
                      properties: ur.properties,
                    }
                  : {
                      id: ur.id,
                      type: ur.type,
                      startNodeId: nextNode.id,
                      endNodeId: prevNode.id,
                      properties: ur.properties,
                    };
              addGraphRel(col, bound);
              pathRels.push(bound);
              prevNode = nextNode;
            }
          }
        }
        return { nodes: pathNodes, relationships: pathRels };
      }
      case TAG_DATE:
        return formatEpochDate(Number(value.fields[0] ?? 0));
      case TAG_TIME:
        return `${formatNanosOfDay(Number(value.fields[0] ?? 0))}${formatTzOffset(Number(value.fields[1] ?? 0))}`;
      case TAG_LOCAL_TIME:
        return formatNanosOfDay(Number(value.fields[0] ?? 0));
      case TAG_DATETIME_OFFSET_V4:
      case TAG_DATETIME_OFFSET_V5:
        return formatEpochDateTime(
          Number(value.fields[0] ?? 0),
          Number(value.fields[1] ?? 0),
          Number(value.fields[2] ?? 0),
        );
      case TAG_DATETIME_ZONE_V4:
      case TAG_DATETIME_ZONE_V5:
        return formatEpochDateTime(
          Number(value.fields[0] ?? 0),
          Number(value.fields[1] ?? 0),
          undefined,
          String(value.fields[2] ?? 'UTC'),
        );
      case TAG_LOCAL_DATETIME:
        return formatEpochDateTime(Number(value.fields[0] ?? 0), Number(value.fields[1] ?? 0));
      case TAG_DURATION:
        return formatDuration(
          Number(value.fields[0] ?? 0),
          Number(value.fields[1] ?? 0),
          Number(value.fields[2] ?? 0),
          Number(value.fields[3] ?? 0),
        );
      case TAG_POINT_2D:
        return {
          srid: Number(value.fields[0] ?? 0),
          x: Number(value.fields[1] ?? 0),
          y: Number(value.fields[2] ?? 0),
        };
      case TAG_POINT_3D:
        return {
          srid: Number(value.fields[0] ?? 0),
          x: Number(value.fields[1] ?? 0),
          y: Number(value.fields[2] ?? 0),
          z: Number(value.fields[3] ?? 0),
        };
      default:
        return { tag: value.tag, fields: value.fields.map((f) => normalizeBoltValue(f, col)) };
    }
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeBoltValue(v, col);
    }
    return out;
  }
  return String(value);
}

function parseStatsObject(stats: unknown): GraphQueryCounters | undefined {
  if (!stats || typeof stats !== 'object') return undefined;
  const s = stats as Record<string, unknown>;
  const pick = (kebab: string, snake: string, camel: string): number | undefined => {
    const val = s[kebab] ?? s[snake] ?? s[camel];
    return typeof val === 'number' ? val : undefined;
  };
  const counters: GraphQueryCounters = {};
  const map: Array<[keyof GraphQueryCounters, string, string, string]> = [
    ['nodesCreated', 'nodes-created', 'nodes_created', 'nodesCreated'],
    ['nodesDeleted', 'nodes-deleted', 'nodes_deleted', 'nodesDeleted'],
    ['relationshipsCreated', 'relationships-created', 'relationships_created', 'relationshipsCreated'],
    ['relationshipsDeleted', 'relationships-deleted', 'relationships_deleted', 'relationshipsDeleted'],
    ['propertiesSet', 'properties-set', 'properties_set', 'propertiesSet'],
    ['labelsAdded', 'labels-added', 'labels_added', 'labelsAdded'],
    ['labelsRemoved', 'labels-removed', 'labels_removed', 'labelsRemoved'],
    ['indexesAdded', 'indexes-added', 'indexes_added', 'indexesAdded'],
    ['indexesRemoved', 'indexes-removed', 'indexes_removed', 'indexesRemoved'],
    ['constraintsAdded', 'constraints-added', 'constraints_added', 'constraintsAdded'],
    ['constraintsRemoved', 'constraints-removed', 'constraints_removed', 'constraintsRemoved'],
  ];
  let any = false;
  for (const [prop, kebab, snake, camel] of map) {
    const v = pick(kebab, snake, camel);
    if (v !== undefined) {
      counters[prop] = v;
      any = true;
    }
  }
  return any ? counters : undefined;
}

/* ============================================================================
 * Bolt Chunk Framing Helpers
 * ============================================================================ */

function frameBoltMessage(struct: PackStreamStruct): Uint8Array {
  const payload = packStreamEncode(struct);
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < payload.length; offset += BOLT_MAX_CHUNK) {
    const end = Math.min(offset + BOLT_MAX_CHUNK, payload.length);
    const len = end - offset;
    parts.push(new Uint8Array([(len >> 8) & 0xff, len & 0xff]));
    parts.push(payload.subarray(offset, end));
  }
  parts.push(new Uint8Array([0x00, 0x00]));
  return concatBytes(...parts);
}

async function readBoltMessage(bs: BufferedByteStream): Promise<PackStreamStruct> {
  while (true) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const lenBytes = await bs.readExact(2);
      const chunkLen = (lenBytes[0] << 8) | lenBytes[1];
      if (chunkLen === 0) break;
      chunks.push(await bs.readExact(chunkLen));
      total += chunkLen;
    }
    if (total === 0) {
      // Bolt NOOP keepalive chunk (0x0000); keep reading next message.
      continue;
    }
    const decoded = packStreamDecode(concatBytes(...chunks));
    if (!isPackStreamStruct(decoded)) {
      throw new Error('Expected PackStream struct for Bolt message');
    }
    return decoded;
  }
}

function buildBoltHandshake(): Uint8Array {
  // Bolt 5.4..5.0 (range 4), Bolt 5.0, Bolt 4.4..4.3 (range 1), 0.0
  const versions = new Uint8Array([
    0x00, 0x04, 0x04, 0x05,
    0x00, 0x00, 0x00, 0x05,
    0x00, 0x01, 0x04, 0x04,
    0x00, 0x00, 0x00, 0x00,
  ]);
  return concatBytes(BOLT_MAGIC, versions);
}

/* ============================================================================
 * HTTP Cypher Helpers
 * ============================================================================ */

function extractHttpGraphEntities(val: unknown, col: GraphCollector): CellValue {
  if (val === null || val === undefined) return null;
  if (typeof val === 'boolean' || typeof val === 'number' || typeof val === 'string') return val;
  if (val instanceof Uint8Array) return val;
  if (Array.isArray(val)) return val.map((item) => extractHttpGraphEntities(item, col));

  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    // Neo4j Query API v2 typed wrapper or direct node/relationship objects
    if (typeof obj.$type === 'string' && obj._value !== undefined) {
      if (obj.$type === 'Node' && typeof obj._value === 'object' && obj._value !== null) {
        const nv = obj._value as Record<string, unknown>;
        const node: GraphNode = {
          id: String(nv._element_id ?? nv.elementId ?? nv.id ?? ''),
          labels: Array.isArray(nv._labels ?? nv.labels) ? ((nv._labels ?? nv.labels) as unknown[]).map(String) : [],
          properties: ((nv._properties ?? nv.properties ?? {}) as Record<string, unknown>),
        };
        addGraphNode(col, node);
        return { id: node.id, labels: node.labels, properties: node.properties };
      }
      if (obj.$type === 'Relationship' && typeof obj._value === 'object' && obj._value !== null) {
        const rv = obj._value as Record<string, unknown>;
        const rel: GraphRelationship = {
          id: String(rv._element_id ?? rv.elementId ?? rv.id ?? ''),
          type: String(rv._type ?? rv.type ?? ''),
          startNodeId: String(rv._start_node_element_id ?? rv.startNodeElementId ?? rv.startNode ?? ''),
          endNodeId: String(rv._end_node_element_id ?? rv.endNodeElementId ?? rv.endNode ?? ''),
          properties: ((rv._properties ?? rv.properties ?? {}) as Record<string, unknown>),
        };
        addGraphRel(col, rel);
        return {
          id: rel.id,
          type: rel.type,
          startNodeId: rel.startNodeId,
          endNodeId: rel.endNodeId,
          properties: rel.properties,
        };
      }
      if (obj.$type === 'Path' && typeof obj._value === 'object' && obj._value !== null) {
        const pv = obj._value as Record<string, unknown>;
        if (Array.isArray(pv._nodes)) {
          for (const n of pv._nodes) extractHttpGraphEntities(n, col);
        }
        if (Array.isArray(pv._relationships)) {
          for (const r of pv._relationships) extractHttpGraphEntities(r, col);
        }
        return extractHttpGraphEntities(pv, col);
      }
      return extractHttpGraphEntities(obj._value, col);
    }

    // Plain object matching Neo4j Query API v2 JSON node/relationship shape
    if (
      typeof obj.elementId === 'string' &&
      Array.isArray(obj.labels) &&
      obj.properties &&
      typeof obj.properties === 'object'
    ) {
      const node: GraphNode = {
        id: obj.elementId,
        labels: obj.labels.map(String),
        properties: obj.properties as Record<string, unknown>,
      };
      addGraphNode(col, node);
      return { id: node.id, labels: node.labels, properties: node.properties };
    }
    if (
      typeof obj.elementId === 'string' &&
      typeof obj.type === 'string' &&
      typeof obj.startNodeElementId === 'string' &&
      typeof obj.endNodeElementId === 'string'
    ) {
      const rel: GraphRelationship = {
        id: obj.elementId,
        type: obj.type,
        startNodeId: obj.startNodeElementId,
        endNodeId: obj.endNodeElementId,
        properties: (obj.properties && typeof obj.properties === 'object'
          ? obj.properties
          : {}) as Record<string, unknown>,
      };
      addGraphRel(col, rel);
      return {
        id: rel.id,
        type: rel.type,
        startNodeId: rel.startNodeId,
        endNodeId: rel.endNodeId,
        properties: rel.properties,
      };
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = extractHttpGraphEntities(v, col);
    }
    return out;
  }
  return String(val);
}

/* ============================================================================
 * Neo4jDriver Implementation
 * ============================================================================ */

export class Neo4jDriver implements GraphDriver {
  readonly engine = 'neo4j' as const;
  readonly family = 'graph' as const;

  private config: ConnectionConfig | null = null;
  private transport: ByteStreamTransport | null = null;
  private bs: BufferedByteStream | null = null;
  private boltMajor = 0;
  private boltMinor = 0;
  private httpEndpoint: HttpEndpointConfig | null = null;
  private preferHttpQueryV2 = false;

  private _connected = false;
  private _serverVersion = '';
  private _activeDatabase = 'neo4j';
  private _transportProtocol: 'bolt' | 'http' = 'bolt';
  private _tlsActive = false;
  private boltQueue: Promise<unknown> = Promise.resolve();
  private lastRawPlan: unknown = null;

  get connected(): boolean {
    return this._connected;
  }
  get serverVersion(): string {
    return this._serverVersion;
  }
  get activeDatabase(): string {
    return this._activeDatabase;
  }
  get transportProtocol(): 'bolt' | 'http' {
    return this._transportProtocol;
  }

  private withBoltLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.boltQueue.then(fn, fn);
    this.boltQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async connect(config: ConnectionConfig, transport: ByteStreamTransport): Promise<ConnectionInfo> {
    if (!transport) throw new Error('Neo4j driver requires a ByteStreamTransport');
    const started = performance.now();
    this.config = config;
    this.transport = transport;
    this._activeDatabase = config.database?.trim() || 'neo4j';

    const useHttp =
      config.protocol === 'http' || config.port === 7474 || config.port === 7473;
    this._transportProtocol = useHttp ? 'http' : 'bolt';

    if (useHttp) {
      await this.connectHttp(config, transport);
    } else {
      await this.connectBolt(config, transport);
    }

    this._connected = true;
    return {
      engine: 'neo4j',
      family: 'graph',
      serverVersion: this._serverVersion || 'Neo4j',
      database: this._activeDatabase,
      tlsActive: this._tlsActive,
      latencyMs: Math.round(performance.now() - started),
    };
  }

  private async connectBolt(config: ConnectionConfig, transport: ByteStreamTransport): Promise<void> {
    const host = config.host || '127.0.0.1';
    const port = config.port ?? 7687;
    const tlsMode = config.tlsMode ?? 'disable';

    const openAndHandshake = async (useTls: boolean): Promise<BufferedByteStream> => {
      const raw = await transport.connect({
        host,
        port,
        tls: useTls,
        servername: host,
        allowSelfSigned: config.allowSelfSigned,
        caPem: config.caPem,
        timeoutMs: config.timeoutMs ?? 30000,
      });
      const stream = new BufferedByteStream(raw);
      try {
        await stream.write(buildBoltHandshake());
        const verBytes = await stream.readExact(4);
        const major = verBytes[3];
        const minor = verBytes[2];
        if (major === 0 && minor === 0) {
          throw new Error('Neo4j server rejected proposed Bolt protocol versions (5.x / 4.x)');
        }
        this.boltMajor = major;
        this.boltMinor = minor;
        this._tlsActive = useTls || stream.isTls;
        return stream;
      } catch (err) {
        await stream.close().catch(() => {});
        throw err;
      }
    };

    if (tlsMode === 'require' || tlsMode === 'verify-full') {
      this.bs = await openAndHandshake(true);
    } else if (tlsMode === 'prefer') {
      try {
        this.bs = await openAndHandshake(true);
      } catch {
        this.bs = await openAndHandshake(false);
      }
    } else {
      this.bs = await openAndHandshake(false);
    }

    try {
      const authMap = this.buildAuthMap(config);
      const isBolt51Plus = this.boltMajor > 5 || (this.boltMajor === 5 && this.boltMinor >= 1);
      const isBolt53Plus = this.boltMajor > 5 || (this.boltMajor === 5 && this.boltMinor >= 3);

      const helloMeta: Record<string, unknown> = {
        user_agent: 'NetcattyDatabase/0.3',
      };
      if (isBolt53Plus) {
        helloMeta.bolt_agent = { product: 'NetcattyDatabase/0.3' };
      }
      if (!isBolt51Plus) {
        Object.assign(helloMeta, authMap);
      }

      await this.bs.write(frameBoltMessage(makePackStreamStruct(MSG_HELLO, [helloMeta])));
      const helloResp = await readBoltMessage(this.bs);
      if (helloResp.tag === MSG_FAILURE) {
        const meta = (helloResp.fields[0] ?? {}) as Record<string, unknown>;
        throw new QueryError(String(meta.message ?? 'Neo4j HELLO failed'), {
          code: typeof meta.code === 'string' ? meta.code : undefined,
        });
      }
      if (helloResp.tag !== MSG_SUCCESS) {
        throw new Error(`Unexpected Bolt HELLO response tag: 0x${helloResp.tag.toString(16)}`);
      }
      const helloInfo = (helloResp.fields[0] ?? {}) as Record<string, unknown>;
      if (typeof helloInfo.server === 'string') {
        this._serverVersion = helloInfo.server;
      }

      if (isBolt51Plus) {
        await this.bs.write(frameBoltMessage(makePackStreamStruct(MSG_LOGON, [authMap])));
        const logonResp = await readBoltMessage(this.bs);
        if (logonResp.tag === MSG_FAILURE) {
          const meta = (logonResp.fields[0] ?? {}) as Record<string, unknown>;
          throw new QueryError(String(meta.message ?? 'Neo4j authentication failed'), {
            code: typeof meta.code === 'string' ? meta.code : undefined,
          });
        }
        if (logonResp.tag !== MSG_SUCCESS) {
          throw new Error(`Unexpected Bolt LOGON response tag: 0x${logonResp.tag.toString(16)}`);
        }
      }
    } catch (err) {
      await this.bs?.close().catch(() => {});
      this.bs = null;
      throw err;
    }
  }

  private buildAuthMap(config: ConnectionConfig): Record<string, unknown> {
    if (config.username || config.password) {
      return {
        scheme: 'basic',
        principal: config.username ?? '',
        credentials: config.password ?? '',
      };
    }
    if (config.apiKey) {
      return {
        scheme: 'bearer',
        credentials: config.apiKey,
      };
    }
    return { scheme: 'none' };
  }

  private buildHttpHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...extra,
    };
    if (this.config?.username || this.config?.password) {
      headers.Authorization = encodeBasicAuth(this.config.username ?? '', this.config.password ?? '');
    } else if (this.config?.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  private async connectHttp(config: ConnectionConfig, transport: ByteStreamTransport): Promise<void> {
    const host = config.host || '127.0.0.1';
    const tls = resolveHttpTls(config.tlsMode, config.port ?? 7474);
    const port = config.port ?? (tls ? 7473 : 7474);
    this._tlsActive = tls;
    this.httpEndpoint = {
      host,
      port,
      tls,
      allowSelfSigned: config.allowSelfSigned,
      caPem: config.caPem,
      basePath: config.httpPath,
      sshTunnel: config.sshTunnel,
    };
    this.preferHttpQueryV2 = false;

    const resp = await sendHttpRequest(transport, this.httpEndpoint, '/', {
      method: 'GET',
      headers: this.buildHttpHeaders(),
      timeoutMs: config.timeoutMs ?? 30000,
    });

    if (resp.status >= 400 && resp.status !== 404) {
      throw new QueryError(decodeResponseText(resp).trim() || `Neo4j HTTP ${resp.status}`, {
        code: `HTTP_${resp.status}`,
      });
    }

    if (resp.status >= 200 && resp.status < 300) {
      try {
        const discovery = decodeResponseJson<Record<string, unknown>>(resp);
        if (typeof discovery.neo4j_version === 'string') {
          this._serverVersion = `Neo4j/${discovery.neo4j_version}`;
        }
        const hasQueryV2 = typeof discovery.query === 'string' && discovery.query.includes('/query/v2');
        const hasTx = typeof discovery.transaction === 'string';
        if (hasQueryV2 && !hasTx) {
          this.preferHttpQueryV2 = true;
        }
      } catch {
        // Ignore non-JSON discovery response
      }
    }

    // Verify credentials and database reachability with a lightweight Cypher check
    this._connected = true;
    try {
      await this.executeCypher('RETURN 1 AS ok');
    } catch (err) {
      this._connected = false;
      throw err;
    }
  }

  async testConnection(): Promise<TestConnectionResult> {
    const started = performance.now();
    try {
      await this.executeCypher('RETURN 1 AS ok');
      return {
        ok: true,
        serverVersion: this._serverVersion || 'Neo4j',
        latencyMs: Math.round(performance.now() - started),
        tlsActive: this._tlsActive,
      };
    } catch (err) {
      return {
        ok: false,
        serverVersion: this._serverVersion || 'Neo4j',
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
    if (stream) {
      try {
        await stream.write(frameBoltMessage(makePackStreamStruct(MSG_GOODBYE, [])));
      } catch {
        // Ignore write error during shutdown
      }
      await stream.close().catch(() => {});
    }
  }

  async listDatabases(): Promise<DatabaseInfo[]> {
    if (!this._connected) throw new Error('Neo4j driver is not connected');
    try {
      const res = await this.executeCypher('SHOW DATABASES', { database: 'system' });
      const nameIdx = res.columns.findIndex((c) => c.toLowerCase() === 'name');
      const colIdx = nameIdx >= 0 ? nameIdx : 0;
      const seen = new Set<string>();
      const dbs: DatabaseInfo[] = [];
      for (const row of res.rows) {
        const name = row[colIdx];
        if (typeof name === 'string' && name.length > 0 && !seen.has(name)) {
          seen.add(name);
          dbs.push({ name });
        }
      }
      if (dbs.length > 0) return dbs;
    } catch {
      // Community edition or restricted permissions: fall back to current database
    }
    return [{ name: this._activeDatabase }];
  }

  async switchDatabase(db: string): Promise<ConnectionInfo> {
    if (!this._connected) throw new Error('Neo4j driver is not connected');
    const started = performance.now();
    const target = db.trim() || 'neo4j';
    await this.executeCypher('RETURN 1 AS ok', { database: target });
    this._activeDatabase = target;
    return {
      engine: 'neo4j',
      family: 'graph',
      serverVersion: this._serverVersion || 'Neo4j',
      database: this._activeDatabase,
      tlsActive: this._tlsActive,
      latencyMs: Math.round(performance.now() - started),
    };
  }

  async getSchemaSummary(db?: string): Promise<GraphSchemaSummary> {
    if (!this._connected) throw new Error('Neo4j driver is not connected');
    const targetDb = db?.trim() || this._activeDatabase;

    const safeRun = async (cypher: string): Promise<GraphQueryResult | null> => {
      try {
        return await this.executeCypher(cypher, { database: targetDb });
      } catch {
        return null;
      }
    };

    const labelsRes = await safeRun('CALL db.labels() YIELD label RETURN label ORDER BY label');
    const labels: GraphLabelSummary[] = (labelsRes?.rows ?? [])
      .map((r) => ({ label: String(r[0] ?? '') }))
      .filter((l) => l.label.length > 0);

    const relTypesRes = await safeRun(
      'CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType',
    );
    const relationshipTypes: string[] = (relTypesRes?.rows ?? [])
      .map((r) => String(r[0] ?? ''))
      .filter((s) => s.length > 0);

    const propKeysRes = await safeRun(
      'CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey ORDER BY propertyKey',
    );
    const propertyKeys: string[] = (propKeysRes?.rows ?? [])
      .map((r) => String(r[0] ?? ''))
      .filter((s) => s.length > 0);

    const indexesRes = (await safeRun('SHOW INDEXES')) ?? (await safeRun('CALL db.indexes()'));
    const indexes: GraphIndexSummary[] = [];
    if (indexesRes) {
      const idxOf = (names: string[]) =>
        indexesRes.columns.findIndex((c) => names.includes(c.toLowerCase()));
      const iName = idxOf(['name', 'indexname']);
      const iType = idxOf(['type']);
      const iEntity = idxOf(['entitytype']);
      const iLabels = idxOf(['labelsortypes', 'tokennames']);
      const iProps = idxOf(['properties']);
      const iState = idxOf(['state']);
      for (const row of indexesRes.rows) {
        const name = String(row[iName >= 0 ? iName : 0] ?? '');
        if (!name) continue;
        indexes.push({
          name,
          type: iType >= 0 && row[iType] != null ? String(row[iType]) : undefined,
          entityType: iEntity >= 0 && row[iEntity] != null ? String(row[iEntity]) : undefined,
          labelsOrTypes:
            iLabels >= 0 && Array.isArray(row[iLabels])
              ? (row[iLabels] as unknown[]).map(String)
              : undefined,
          properties:
            iProps >= 0 && Array.isArray(row[iProps])
              ? (row[iProps] as unknown[]).map(String)
              : undefined,
          state: iState >= 0 && row[iState] != null ? String(row[iState]) : undefined,
        });
      }
    }

    const constraintsRes =
      (await safeRun('SHOW CONSTRAINTS')) ?? (await safeRun('CALL db.constraints()'));
    const constraints: GraphConstraintSummary[] = [];
    if (constraintsRes) {
      const idxOf = (names: string[]) =>
        constraintsRes.columns.findIndex((c) => names.includes(c.toLowerCase()));
      const iName = idxOf(['name']);
      const iType = idxOf(['type']);
      const iEntity = idxOf(['entitytype']);
      const iLabels = idxOf(['labelsortypes']);
      const iProps = idxOf(['properties']);
      for (const row of constraintsRes.rows) {
        const name = String(row[iName >= 0 ? iName : 0] ?? '');
        if (!name) continue;
        constraints.push({
          name,
          type: iType >= 0 && row[iType] != null ? String(row[iType]) : undefined,
          entityType: iEntity >= 0 && row[iEntity] != null ? String(row[iEntity]) : undefined,
          labelsOrTypes:
            iLabels >= 0 && Array.isArray(row[iLabels])
              ? (row[iLabels] as unknown[]).map(String)
              : undefined,
          properties:
            iProps >= 0 && Array.isArray(row[iProps])
              ? (row[iProps] as unknown[]).map(String)
              : undefined,
        });
      }
    }

    return {
      database: targetDb,
      labels,
      relationshipTypes,
      propertyKeys,
      indexes,
      constraints,
    };
  }

  async executeCypher(
    cypher: string,
    options?: {
      database?: string;
      params?: Record<string, unknown>;
      maxRows?: number;
      signal?: AbortSignal;
    },
  ): Promise<GraphQueryResult> {
    if (!this._connected) throw new Error('Neo4j driver is not connected');
    if (this._transportProtocol === 'http') {
      return this.executeCypherHttp(cypher, options);
    }
    return this.withBoltLock(() => this.executeCypherBolt(cypher, options));
  }

  private async resetBolt(): Promise<void> {
    if (!this.bs) return;
    await this.bs.write(frameBoltMessage(makePackStreamStruct(MSG_RESET, [])));
    await readBoltMessage(this.bs);
  }

  private async executeCypherBolt(
    cypher: string,
    options?: {
      database?: string;
      params?: Record<string, unknown>;
      maxRows?: number;
      signal?: AbortSignal;
    },
  ): Promise<GraphQueryResult> {
    if (!this.bs) throw new Error('Bolt stream is not connected');
    const started = performance.now();
    const targetDb = options?.database?.trim() || this._activeDatabase;
    const params = options?.params ?? {};
    const extra: Record<string, unknown> = {};
    if (targetDb) extra.db = targetDb;

    await this.bs.write(frameBoltMessage(makePackStreamStruct(MSG_RUN, [cypher, params, extra])));
    const runResp = await readBoltMessage(this.bs);
    if (runResp.tag === MSG_FAILURE) {
      const meta = (runResp.fields[0] ?? {}) as Record<string, unknown>;
      await this.resetBolt().catch(() => {});
      throw new QueryError(String(meta.message ?? 'Cypher RUN failed'), {
        code: typeof meta.code === 'string' ? meta.code : undefined,
      });
    }
    if (runResp.tag !== MSG_SUCCESS) {
      throw new Error(`Unexpected Bolt RUN response tag: 0x${runResp.tag.toString(16)}`);
    }

    const runMeta = (runResp.fields[0] ?? {}) as Record<string, unknown>;
    const columns: string[] = Array.isArray(runMeta.fields) ? runMeta.fields.map(String) : [];

    const maxRows = options?.maxRows;
    const pullMeta: Record<string, unknown> = { n: maxRows && maxRows > 0 ? maxRows : -1 };
    if (typeof runMeta.qid === 'number') {
      pullMeta.qid = runMeta.qid;
    }

    await this.bs.write(frameBoltMessage(makePackStreamStruct(MSG_PULL, [pullMeta])));

    const col: GraphCollector = { nodes: new Map(), relationships: new Map() };
    const rows: CellValue[][] = [];
    let truncated = false;
    let counters: GraphQueryCounters | undefined;
    let notifications: string[] | undefined;

    while (true) {
      const msg = await readBoltMessage(this.bs);
      if (msg.tag === MSG_RECORD) {
        const rawRow = Array.isArray(msg.fields[0]) ? msg.fields[0] : [];
        rows.push(rawRow.map((cell) => normalizeBoltValue(cell, col)));
        continue;
      }
      if (msg.tag === MSG_SUCCESS) {
        const pullSuccessMeta = (msg.fields[0] ?? {}) as Record<string, unknown>;
        counters = parseStatsObject(pullSuccessMeta.stats);
        this.lastRawPlan = pullSuccessMeta.profile ?? pullSuccessMeta.plan ?? null;
        if (Array.isArray(pullSuccessMeta.notifications) && pullSuccessMeta.notifications.length > 0) {
          notifications = pullSuccessMeta.notifications.map((n) => {
            if (typeof n === 'string') return n;
            const no = n as Record<string, unknown>;
            return String(no.description ?? no.title ?? JSON.stringify(n));
          });
        }
        if (pullSuccessMeta.has_more === true) {
          truncated = true;
          const discardMeta: Record<string, unknown> = { n: -1 };
          if (typeof runMeta.qid === 'number') discardMeta.qid = runMeta.qid;
          await this.bs.write(frameBoltMessage(makePackStreamStruct(MSG_DISCARD, [discardMeta])));
          const discardResp = await readBoltMessage(this.bs);
          if (discardResp.tag === MSG_FAILURE) {
            await this.resetBolt().catch(() => {});
          }
        }
        break;
      }
      if (msg.tag === MSG_FAILURE) {
        const meta = (msg.fields[0] ?? {}) as Record<string, unknown>;
        await this.resetBolt().catch(() => {});
        throw new QueryError(String(meta.message ?? 'Cypher PULL failed'), {
          code: typeof meta.code === 'string' ? meta.code : undefined,
        });
      }
      if (msg.tag === MSG_IGNORED) {
        break;
      }
    }

    return {
      cypher,
      columns,
      rows,
      nodes: Array.from(col.nodes.values()),
      relationships: Array.from(col.relationships.values()),
      rowCount: rows.length,
      executionMs: Math.round(performance.now() - started),
      truncated,
      counters,
      notifications,
    };
  }

  private async executeCypherHttp(
    cypher: string,
    options?: {
      database?: string;
      params?: Record<string, unknown>;
      maxRows?: number;
      signal?: AbortSignal;
    },
  ): Promise<GraphQueryResult> {
    if (!this.transport || !this.httpEndpoint) {
      throw new Error('Neo4j HTTP endpoint is not configured');
    }
    const targetDb = options?.database?.trim() || this._activeDatabase;
    const params = options?.params ?? {};

    if (this.preferHttpQueryV2) {
      const v2 = await this.tryHttpQueryV2(targetDb, cypher, params, options);
      if (v2 !== null) return v2;
      this.preferHttpQueryV2 = false;
      return this.executeHttpTxCommit(targetDb, cypher, params, options);
    }

    const txResult = await this.tryHttpTxCommit(targetDb, cypher, params, options);
    if (txResult !== null) return txResult;
    this.preferHttpQueryV2 = true;
    const v2 = await this.tryHttpQueryV2(targetDb, cypher, params, options);
    if (v2 !== null) return v2;
    throw new Error(`Neo4j HTTP API endpoint not available for database '${targetDb}'`);
  }

  private async tryHttpTxCommit(
    db: string,
    cypher: string,
    params: Record<string, unknown>,
    options?: { maxRows?: number; signal?: AbortSignal },
  ): Promise<GraphQueryResult | null> {
    const started = performance.now();
    const path = `/db/${encodeURIComponent(db)}/tx/commit`;
    const body = JSON.stringify({
      statements: [
        {
          statement: cypher,
          parameters: params,
          resultDataContents: ['row', 'graph'],
          includeStats: true,
        },
      ],
    });
    const resp = await sendHttpRequest(this.transport!, this.httpEndpoint!, path, {
      method: 'POST',
      headers: this.buildHttpHeaders(),
      body,
      timeoutMs: this.config?.timeoutMs ?? 30000,
      signal: options?.signal,
    });
    if (resp.status === 404 || resp.status === 405 || resp.status === 501) {
      return null;
    }
    if (resp.status >= 400) {
      throw new QueryError(decodeResponseText(resp).trim() || `Neo4j HTTP ${resp.status}`, {
        code: `HTTP_${resp.status}`,
      });
    }
    return this.parseTxCommitResponse(cypher, resp.body, started, options?.maxRows);
  }

  private async executeHttpTxCommit(
    db: string,
    cypher: string,
    params: Record<string, unknown>,
    options?: { maxRows?: number; signal?: AbortSignal },
  ): Promise<GraphQueryResult> {
    const res = await this.tryHttpTxCommit(db, cypher, params, options);
    if (!res) {
      throw new Error(`Neo4j HTTP /tx/commit endpoint returned 404 for database '${db}'`);
    }
    return res;
  }

  private parseTxCommitResponse(
    cypher: string,
    bodyBytes: Uint8Array,
    started: number,
    maxRows?: number,
  ): GraphQueryResult {
    const parsed = JSON.parse(td.decode(bodyBytes) || '{}') as {
      results?: Array<{
        columns?: string[];
        data?: Array<{
          row?: unknown[];
          graph?: {
            nodes?: Array<{ id: string | number; labels?: string[]; properties?: Record<string, unknown> }>;
            relationships?: Array<{
              id: string | number;
              type?: string;
              startNode: string | number;
              endNode: string | number;
              properties?: Record<string, unknown>;
            }>;
          };
        }>;
        stats?: Record<string, unknown>;
        plan?: unknown;
      }>;
      errors?: Array<{ code?: string; message?: string }>;
      notifications?: Array<{ description?: string; title?: string }>;
    };

    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      const first = parsed.errors[0];
      throw new QueryError(first.message || 'Neo4j Cypher error', { code: first.code });
    }

    const firstResult = parsed.results?.[0];
    this.lastRawPlan = firstResult?.plan ?? null;
    const columns = firstResult?.columns ?? [];
    const data = firstResult?.data ?? [];
    const col: GraphCollector = { nodes: new Map(), relationships: new Map() };
    const rows: CellValue[][] = [];
    let truncated = false;

    for (const item of data) {
      if (maxRows && maxRows > 0 && rows.length >= maxRows) {
        truncated = true;
        break;
      }
      if (item.graph) {
        for (const n of item.graph.nodes ?? []) {
          addGraphNode(col, {
            id: String(n.id),
            labels: Array.isArray(n.labels) ? n.labels.map(String) : [],
            properties: n.properties ?? {},
          });
        }
        for (const r of item.graph.relationships ?? []) {
          addGraphRel(col, {
            id: String(r.id),
            type: String(r.type ?? ''),
            startNodeId: String(r.startNode),
            endNodeId: String(r.endNode),
            properties: r.properties ?? {},
          });
        }
      }
      const row = Array.isArray(item.row)
        ? item.row.map((cell) => extractHttpGraphEntities(cell, col))
        : [];
      rows.push(row);
    }

    const notifications =
      Array.isArray(parsed.notifications) && parsed.notifications.length > 0
        ? parsed.notifications.map((n) => n.description ?? n.title ?? JSON.stringify(n))
        : undefined;

    return {
      cypher,
      columns,
      rows,
      nodes: Array.from(col.nodes.values()),
      relationships: Array.from(col.relationships.values()),
      rowCount: rows.length,
      executionMs: Math.round(performance.now() - started),
      truncated,
      counters: parseStatsObject(firstResult?.stats),
      notifications,
    };
  }

  private async tryHttpQueryV2(
    db: string,
    cypher: string,
    params: Record<string, unknown>,
    options?: { maxRows?: number; signal?: AbortSignal },
  ): Promise<GraphQueryResult | null> {
    const started = performance.now();
    const path = `/db/${encodeURIComponent(db)}/query/v2`;
    const body = JSON.stringify({
      statement: cypher,
      parameters: params,
      includeCounters: true,
    });
    const resp = await sendHttpRequest(this.transport!, this.httpEndpoint!, path, {
      method: 'POST',
      headers: this.buildHttpHeaders({
        Accept: 'application/vnd.neo4j.query+json, application/json',
      }),
      body,
      timeoutMs: this.config?.timeoutMs ?? 30000,
      signal: options?.signal,
    });
    if (resp.status === 404 || resp.status === 405 || resp.status === 501) {
      return null;
    }
    if (resp.status >= 400) {
      const text = decodeResponseText(resp).trim();
      try {
        const errJson = JSON.parse(text) as { errors?: Array<{ code?: string; message?: string }> };
        if (errJson.errors?.[0]) {
          throw new QueryError(errJson.errors[0].message || text, { code: errJson.errors[0].code });
        }
      } catch (e) {
        if (e instanceof QueryError) throw e;
      }
      throw new QueryError(text || `Neo4j Query API v2 HTTP ${resp.status}`, {
        code: `HTTP_${resp.status}`,
      });
    }

    const parsed = decodeResponseJson<{
      data?: { fields?: string[]; values?: unknown[][] };
      counters?: Record<string, unknown>;
      errors?: Array<{ code?: string; message?: string }>;
      notifications?: Array<{ description?: string; title?: string }>;
    }>(resp);

    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      const first = parsed.errors[0];
      throw new QueryError(first.message || 'Neo4j Query API v2 error', { code: first.code });
    }

    const columns = parsed.data?.fields ?? [];
    const rawValues = parsed.data?.values ?? [];
    const col: GraphCollector = { nodes: new Map(), relationships: new Map() };
    const rows: CellValue[][] = [];
    let truncated = false;
    const maxRows = options?.maxRows;

    for (const rawRow of rawValues) {
      if (maxRows && maxRows > 0 && rows.length >= maxRows) {
        truncated = true;
        break;
      }
      rows.push(
        Array.isArray(rawRow) ? rawRow.map((cell) => extractHttpGraphEntities(cell, col)) : [],
      );
    }

    const notifications =
      Array.isArray(parsed.notifications) && parsed.notifications.length > 0
        ? parsed.notifications.map((n) => n.description ?? n.title ?? JSON.stringify(n))
        : undefined;

    return {
      cypher,
      columns,
      rows,
      nodes: Array.from(col.nodes.values()),
      relationships: Array.from(col.relationships.values()),
      rowCount: rows.length,
      executionMs: Math.round(performance.now() - started),
      truncated,
      counters: parseStatsObject(parsed.counters),
      notifications,
    };
  }

  /* --------------------------------------------------------------------------
   * Specialist CRUD & EXPLAIN / PROFILE Operations
   * -------------------------------------------------------------------------- */

  async explainCypher(
    cypher: string,
    mode: 'EXPLAIN' | 'PROFILE' = 'EXPLAIN',
    options?: { database?: string; params?: Record<string, unknown>; signal?: AbortSignal },
  ): Promise<GraphExplainPlanResult> {
    this.lastRawPlan = null;
    const fullCypher = buildExplainCypher(cypher, mode);
    const res = await this.executeCypher(fullCypher, {
      database: options?.database,
      params: options?.params,
      signal: options?.signal,
    });
    const rawPlan = this.lastRawPlan;
    return {
      mode,
      cypher: fullCypher,
      plan: normalizeCypherPlanNode(rawPlan),
      rawPlan,
      notifications: res.notifications,
      counters: res.counters,
      rowCount: res.rowCount,
      executionMs: res.executionMs,
    };
  }

  async createNode(
    labels: readonly string[],
    properties: Record<string, unknown> = {},
    database?: string,
  ): Promise<GraphQueryResult> {
    const { cypher, params } = buildCreateNodeCypher(labels, properties);
    return this.executeCypher(cypher, { database, params });
  }

  async updateNode(
    nodeId: string,
    properties: Record<string, unknown>,
    options?: { replaceAll?: boolean; database?: string },
  ): Promise<GraphQueryResult> {
    const { cypher, params } = buildUpdateNodeCypher(nodeId, properties, options?.replaceAll);
    return this.executeCypher(cypher, { database: options?.database, params });
  }

  async deleteNode(
    nodeId: string,
    detach = true,
    database?: string,
  ): Promise<GraphQueryResult> {
    const { cypher, params } = buildDeleteNodeCypher(nodeId, detach);
    return this.executeCypher(cypher, { database, params });
  }

  async createRelationship(
    startNodeId: string,
    endNodeId: string,
    relType: string,
    properties: Record<string, unknown> = {},
    database?: string,
  ): Promise<GraphQueryResult> {
    const { cypher, params } = buildCreateRelationshipCypher(
      startNodeId,
      endNodeId,
      relType,
      properties,
    );
    return this.executeCypher(cypher, { database, params });
  }

  async updateRelationship(
    relId: string,
    properties: Record<string, unknown>,
    options?: { replaceAll?: boolean; database?: string },
  ): Promise<GraphQueryResult> {
    const { cypher, params } = buildUpdateRelationshipCypher(relId, properties, options?.replaceAll);
    return this.executeCypher(cypher, { database: options?.database, params });
  }

  async deleteRelationship(
    relId: string,
    database?: string,
  ): Promise<GraphQueryResult> {
    const { cypher, params } = buildDeleteRelationshipCypher(relId);
    return this.executeCypher(cypher, { database, params });
  }
}

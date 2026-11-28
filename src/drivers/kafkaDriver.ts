/**
 * Pure-TS Browser-Sandbox Apache Kafka Binary TCP Wire Protocol Driver (`family: 'mq'`).
 * Implements Kafka wire protocol over `ByteStream` (port 9092):
 * - ApiVersions (ApiKey 18, v0–v3)
 * - Metadata (ApiKey 3, v1 / v4)
 * - ListOffsets (ApiKey 2, v1)
 * - Fetch (ApiKey 1, v2 / v4 — decodes both MessageSet v0/v1 and RecordBatch v2)
 * - Produce (ApiKey 0, v2 / v3 — MessageSet v1 with pure-TS IEEE CRC32)
 * - ListGroups (ApiKey 16, v0)
 * - SASL PLAIN (SaslHandshake ApiKey 17 v1 + SaslAuthenticate ApiKey 36 v0)
 *
 * Implements `MqBrokerDriver` (and `MqDriver`).
 * 100% browser-sandbox compatible (zero `node:*` imports).
 */

import { BufferedByteStream, concatBytes } from './streamBuffer';
import type {
  MqBrokerDriver,
  MqConsumerGroupInfo,
  MqNodeInfo,
  MqPartitionInfo,
} from './mqHttpDriver';
import type {
  ByteStreamTransport,
  ConnectionConfig,
  ConnectionInfo,
  DatabaseEngineId,
  MqBindingInfo,
  MqExchangeInfo,
  MqMessage,
  MqOverview,
  MqQueueInfo,
  TestConnectionResult,
} from './types';

const te = new TextEncoder();
const td = new TextDecoder('utf-8');

export const KAFKA_API_KEY = {
  PRODUCE: 0,
  FETCH: 1,
  LIST_OFFSETS: 2,
  METADATA: 3,
  LIST_GROUPS: 16,
  SASL_HANDSHAKE: 17,
  API_VERSIONS: 18,
  CREATE_TOPICS: 19,
  DELETE_TOPICS: 20,
  SASL_AUTHENTICATE: 36,
} as const;

/* ============================================================================
 * Pure-TS IEEE CRC32 & Kafka Binary Encoding Primitives
 * ============================================================================ */

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function computeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function i8(v: number): Uint8Array {
  return new Uint8Array([v & 0xff]);
}

function i16(v: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setInt16(0, v, false);
  return b;
}

function i32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v, false);
  return b;
}

function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, false);
  return b;
}

function i64(v: bigint | number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(v), false);
  return b;
}

function kString(s: string): Uint8Array {
  const raw = te.encode(s);
  return concatBytes(i16(raw.length), raw);
}

function kNullableString(s: string | null | undefined): Uint8Array {
  if (s === null || s === undefined) return i16(-1);
  return kString(s);
}

function kBytes(data: Uint8Array | null): Uint8Array {
  if (data === null) return i32(-1);
  return concatBytes(i32(data.length), data);
}

function kCompactString(s: string): Uint8Array {
  const raw = te.encode(s);
  return concatBytes(encodeUnsignedVarint(raw.length + 1), raw);
}

function encodeUnsignedVarint(n: number): Uint8Array {
  const out: number[] = [];
  let v = n >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return new Uint8Array(out);
}

class KafkaReader {
  offset = 0;
  private readonly view: DataView;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get remaining(): number {
    return this.data.length - this.offset;
  }

  readInt8(): number {
    return this.view.getInt8(this.offset++);
  }

  readInt16(): number {
    const v = this.view.getInt16(this.offset, false);
    this.offset += 2;
    return v;
  }

  readInt32(): number {
    const v = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return v;
  }

  readInt64(): bigint {
    const v = this.view.getBigInt64(this.offset, false);
    this.offset += 8;
    return v;
  }

  readBool(): boolean {
    return this.readInt8() !== 0;
  }

  readString(): string {
    const len = this.readInt16();
    if (len < 0) return '';
    const slice = this.data.subarray(this.offset, this.offset + len);
    this.offset += len;
    return td.decode(slice);
  }

  readNullableString(): string | null {
    const len = this.readInt16();
    if (len < 0) return null;
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

  readUnsignedVarint(): number {
    let val = 0;
    let shift = 0;
    while (this.offset < this.data.length) {
      const b = this.data[this.offset++];
      val |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return val >>> 0;
      shift += 7;
    }
    return val >>> 0;
  }

  readZigZagVarint(): number {
    const u = this.readUnsignedVarint();
    return (u >>> 1) ^ -(u & 1);
  }

  readZigZagVarlong(): bigint {
    let val = 0n;
    let shift = 0n;
    while (this.offset < this.data.length) {
      const b = BigInt(this.data[this.offset++]);
      val |= (b & 0x7fn) << shift;
      if ((b & 0x80n) === 0n) break;
      shift += 7n;
    }
    return (val >> 1n) ^ -(val & 1n);
  }

  skipTaggedFields(): void {
    const count = this.readUnsignedVarint();
    for (let i = 0; i < count; i++) {
      this.readUnsignedVarint(); // tag
      const size = this.readUnsignedVarint();
      this.offset += size;
    }
  }
}

/* ============================================================================
 * Exported Pure Kafka Wire Encoders & Decoders
 * ============================================================================ */

export function encodeKafkaRequestFrame(
  apiKey: number,
  apiVersion: number,
  correlationId: number,
  clientId: string,
  body: Uint8Array,
  flexibleHeader = false,
): Uint8Array {
  const headerParts: Uint8Array[] = [
    i16(apiKey),
    i16(apiVersion),
    i32(correlationId),
    kNullableString(clientId),
  ];
  if (flexibleHeader) {
    headerParts.push(i8(0)); // empty tagged fields for RequestHeader v2
  }
  const payload = concatBytes(...headerParts, body);
  return concatBytes(i32(payload.length), payload);
}

export function encodeKafkaApiVersionsRequest(apiVersion = 0): Uint8Array {
  if (apiVersion >= 3) {
    // ApiVersions v3 uses flexible body: client_software_name, client_software_version, tagged_fields
    return concatBytes(kCompactString('netcatty-db'), kCompactString('0.3.0'), i8(0));
  }
  return new Uint8Array(0);
}

export interface KafkaApiVersionEntry {
  apiKey: number;
  minVersion: number;
  maxVersion: number;
}

export function decodeKafkaApiVersionsResponse(
  body: Uint8Array,
  apiVersion = 0,
): { errorCode: number; apiKeys: KafkaApiVersionEntry[] } {
  const r = new KafkaReader(body);
  const errorCode = r.readInt16();
  const apiKeys: KafkaApiVersionEntry[] = [];
  if (apiVersion >= 3) {
    const count = Math.max(0, r.readUnsignedVarint() - 1);
    for (let i = 0; i < count; i++) {
      const apiKey = r.readInt16();
      const minVersion = r.readInt16();
      const maxVersion = r.readInt16();
      r.skipTaggedFields();
      apiKeys.push({ apiKey, minVersion, maxVersion });
    }
  } else {
    const count = r.readInt32();
    for (let i = 0; i < count; i++) {
      apiKeys.push({
        apiKey: r.readInt16(),
        minVersion: r.readInt16(),
        maxVersion: r.readInt16(),
      });
    }
  }
  return { errorCode, apiKeys };
}

export function encodeKafkaMetadataRequest(
  topics: string[] | null = null,
  apiVersion: 1 | 4 = 1,
): Uint8Array {
  const parts: Uint8Array[] = [];
  if (topics === null) {
    parts.push(i32(-1)); // null array = all topics
  } else {
    parts.push(i32(topics.length));
    for (const t of topics) parts.push(kString(t));
  }
  if (apiVersion >= 4) {
    parts.push(i8(0)); // allow_auto_topic_creation = false
  }
  return concatBytes(...parts);
}

export interface KafkaBrokerMeta {
  nodeId: number;
  host: string;
  port: number;
  rack: string | null;
}

export interface KafkaTopicMeta {
  errorCode: number;
  name: string;
  isInternal: boolean;
  partitions: MqPartitionInfo[];
}

export interface KafkaMetadataResult {
  brokers: KafkaBrokerMeta[];
  clusterId: string | null;
  controllerId: number;
  topics: KafkaTopicMeta[];
}

export function decodeKafkaMetadataResponse(
  body: Uint8Array,
  apiVersion: 1 | 4 = 1,
): KafkaMetadataResult {
  const r = new KafkaReader(body);
  if (apiVersion >= 3) {
    r.readInt32(); // throttle_time_ms
  }
  const brokerCount = r.readInt32();
  const brokers: KafkaBrokerMeta[] = [];
  for (let i = 0; i < brokerCount; i++) {
    brokers.push({
      nodeId: r.readInt32(),
      host: r.readString(),
      port: r.readInt32(),
      rack: r.readNullableString(),
    });
  }
  const clusterId = apiVersion >= 2 ? r.readNullableString() : null;
  const controllerId = r.readInt32();

  const topicCount = r.readInt32();
  const topics: KafkaTopicMeta[] = [];
  for (let i = 0; i < topicCount; i++) {
    const errorCode = r.readInt16();
    const name = r.readString();
    const isInternal = r.readBool();
    const partCount = r.readInt32();
    const partitions: MqPartitionInfo[] = [];
    for (let p = 0; p < partCount; p++) {
      r.readInt16(); // partition errorCode
      const partitionId = r.readInt32();
      const leader = r.readInt32();
      const repCount = r.readInt32();
      const replicas: number[] = [];
      for (let j = 0; j < repCount; j++) replicas.push(r.readInt32());
      const isrCount = r.readInt32();
      const isr: number[] = [];
      for (let j = 0; j < isrCount; j++) isr.push(r.readInt32());
      partitions.push({ topic: name, partitionId, leader, replicas, isr });
    }
    topics.push({ errorCode, name, isInternal, partitions });
  }

  return { brokers, clusterId, controllerId, topics };
}

export function encodeKafkaListOffsetsRequest(
  topic: string,
  partitions: number[],
  timestamp: bigint = -1n, // -1 = latest, -2 = earliest
): Uint8Array {
  const parts: Uint8Array[] = [
    i32(-1), // replica_id
    i32(1), // 1 topic
    kString(topic),
    i32(partitions.length),
  ];
  for (const p of partitions) {
    parts.push(i32(p), i64(timestamp));
  }
  return concatBytes(...parts);
}

export function decodeKafkaListOffsetsResponse(
  body: Uint8Array,
): Array<{ topic: string; partition: number; errorCode: number; timestamp: number; offset: number }> {
  const r = new KafkaReader(body);
  const out: Array<{ topic: string; partition: number; errorCode: number; timestamp: number; offset: number }> = [];
  const topicCount = r.readInt32();
  for (let i = 0; i < topicCount; i++) {
    const topic = r.readString();
    const partCount = r.readInt32();
    for (let p = 0; p < partCount; p++) {
      const partition = r.readInt32();
      const errorCode = r.readInt16();
      const timestamp = Number(r.readInt64());
      const offset = Number(r.readInt64());
      out.push({ topic, partition, errorCode, timestamp, offset });
    }
  }
  return out;
}

export function encodeKafkaFetchRequest(
  topic: string,
  partition: number,
  fetchOffset: number,
  maxBytes = 65536,
  maxWaitMs = 500,
  apiVersion: 2 | 4 = 2,
): Uint8Array {
  const parts: Uint8Array[] = [
    i32(-1), // replica_id
    i32(maxWaitMs),
    i32(1), // min_bytes
  ];
  if (apiVersion >= 3) {
    parts.push(i32(maxBytes)); // max_bytes
  }
  if (apiVersion >= 4) {
    parts.push(i8(0)); // isolation_level = READ_UNCOMMITTED
  }
  parts.push(
    i32(1), // 1 topic
    kString(topic),
    i32(1), // 1 partition
    i32(partition),
    i64(fetchOffset),
    i32(maxBytes), // partition_max_bytes
  );
  return concatBytes(...parts);
}

export interface KafkaFetchedRecord {
  offset: number;
  timestamp?: number;
  key?: string;
  value: string;
}

export function decodeKafkaRecordSet(bytes: Uint8Array): KafkaFetchedRecord[] {
  const records: KafkaFetchedRecord[] = [];
  let pos = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  while (pos + 17 <= bytes.length) {
    const magicByte = bytes[pos + 16];
    if (magicByte === 2 && pos + 61 <= bytes.length) {
      // RecordBatch v2
      const baseOffset = Number(view.getBigInt64(pos, false));
      const batchLen = view.getInt32(pos + 8, false);
      const batchEnd = pos + 12 + batchLen;
      if (batchLen <= 0 || batchEnd > bytes.length) break;
      const firstTimestamp = Number(view.getBigInt64(pos + 27, false));
      const recCount = view.getInt32(pos + 57, false);
      const r = new KafkaReader(bytes.subarray(pos + 61, batchEnd));
      for (let i = 0; i < recCount && r.remaining > 0; i++) {
        const recLen = r.readZigZagVarint();
        if (recLen <= 0 || recLen > r.remaining) break;
        const recEnd = r.offset + recLen;
        r.readInt8(); // attributes
        const tsDelta = Number(r.readZigZagVarlong());
        const offsetDelta = r.readZigZagVarint();
        const keyLen = r.readZigZagVarint();
        let key: string | undefined;
        if (keyLen >= 0) {
          key = td.decode(bytes.subarray(pos + 61 + r.offset, pos + 61 + r.offset + keyLen));
          r.offset += keyLen;
        }
        const valLen = r.readZigZagVarint();
        let value = '';
        if (valLen >= 0) {
          value = td.decode(bytes.subarray(pos + 61 + r.offset, pos + 61 + r.offset + valLen));
          r.offset += valLen;
        }
        r.offset = recEnd;
        records.push({
          offset: baseOffset + offsetDelta,
          timestamp: firstTimestamp + tsDelta,
          key,
          value,
        });
      }
      pos = batchEnd;
    } else if (pos + 12 <= bytes.length) {
      // Legacy MessageSet v0 / v1
      const offset = Number(view.getBigInt64(pos, false));
      const msgSize = view.getInt32(pos + 8, false);
      const msgEnd = pos + 12 + msgSize;
      if (msgSize <= 0 || msgEnd > bytes.length) break;
      const r = new KafkaReader(bytes.subarray(pos + 12, msgEnd));
      r.readInt32(); // crc
      const magic = r.readInt8();
      r.readInt8(); // attributes
      const timestamp = magic >= 1 ? Number(r.readInt64()) : undefined;
      const keyBytes = r.readBytes();
      const valBytes = r.readBytes();
      records.push({
        offset,
        timestamp,
        key: keyBytes ? td.decode(keyBytes) : undefined,
        value: valBytes ? td.decode(valBytes) : '',
      });
      pos = msgEnd;
    } else {
      break;
    }
  }
  return records;
}

export function decodeKafkaFetchResponse(
  body: Uint8Array,
  apiVersion: 2 | 4 = 2,
): Array<{ topic: string; partition: number; errorCode: number; highWatermark: number; records: KafkaFetchedRecord[] }> {
  const r = new KafkaReader(body);
  r.readInt32(); // throttle_time_ms
  const topicCount = r.readInt32();
  const out: Array<{
    topic: string;
    partition: number;
    errorCode: number;
    highWatermark: number;
    records: KafkaFetchedRecord[];
  }> = [];

  for (let i = 0; i < topicCount; i++) {
    const topic = r.readString();
    const partCount = r.readInt32();
    for (let p = 0; p < partCount; p++) {
      const partition = r.readInt32();
      const errorCode = r.readInt16();
      const highWatermark = Number(r.readInt64());
      if (apiVersion >= 4) {
        r.readInt64(); // last_stable_offset
        const abortedCount = r.readInt32();
        for (let a = 0; a < abortedCount; a++) {
          r.readInt64(); // producer_id
          r.readInt64(); // first_offset
        }
      }
      const recordBytes = r.readBytes();
      const records = recordBytes ? decodeKafkaRecordSet(recordBytes) : [];
      out.push({ topic, partition, errorCode, highWatermark, records });
    }
  }
  return out;
}

export function encodeKafkaMessageSetV1(
  records: Array<{ key?: string | null; value: string; timestamp?: number }>,
): Uint8Array {
  const entries: Uint8Array[] = [];
  for (let idx = 0; idx < records.length; idx++) {
    const rec = records[idx];
    const keyBytes = rec.key !== undefined && rec.key !== null ? te.encode(rec.key) : null;
    const valBytes = te.encode(rec.value);
    const body = concatBytes(
      i8(1), // magic = 1
      i8(0), // attributes (no compression)
      i64(rec.timestamp ?? Date.now()),
      kBytes(keyBytes),
      kBytes(valBytes),
    );
    const crc = computeCrc32(body);
    const msg = concatBytes(u32(crc), body);
    entries.push(i64(idx), i32(msg.length), msg);
  }
  return concatBytes(...entries);
}

export function encodeKafkaProduceRequest(
  topic: string,
  partition: number,
  records: Array<{ key?: string | null; value: string; timestamp?: number }>,
  apiVersion: 2 | 3 = 2,
): Uint8Array {
  const msgSet = encodeKafkaMessageSetV1(records);
  const parts: Uint8Array[] = [];
  if (apiVersion >= 3) {
    parts.push(kNullableString(null)); // transactional_id
  }
  parts.push(
    i16(1), // acks = 1 (leader)
    i32(10000), // timeout_ms
    i32(1), // 1 topic
    kString(topic),
    i32(1), // 1 partition
    i32(partition),
    kBytes(msgSet),
  );
  return concatBytes(...parts);
}

export function decodeKafkaProduceResponse(
  body: Uint8Array,
): Array<{ topic: string; partition: number; errorCode: number; baseOffset: number }> {
  const r = new KafkaReader(body);
  const out: Array<{ topic: string; partition: number; errorCode: number; baseOffset: number }> = [];
  const topicCount = r.readInt32();
  for (let i = 0; i < topicCount; i++) {
    const topic = r.readString();
    const partCount = r.readInt32();
    for (let p = 0; p < partCount; p++) {
      const partition = r.readInt32();
      const errorCode = r.readInt16();
      const baseOffset = Number(r.readInt64());
      if (r.remaining >= 8) r.readInt64(); // log_append_time_ms (v2+)
      out.push({ topic, partition, errorCode, baseOffset });
    }
  }
  return out;
}

export function encodeKafkaListGroupsRequest(): Uint8Array {
  return new Uint8Array(0);
}

export function decodeKafkaListGroupsResponse(
  body: Uint8Array,
): { errorCode: number; groups: MqConsumerGroupInfo[] } {
  const r = new KafkaReader(body);
  const errorCode = r.readInt16();
  const count = r.readInt32();
  const groups: MqConsumerGroupInfo[] = [];
  for (let i = 0; i < count; i++) {
    groups.push({
      groupId: r.readString(),
      protocolType: r.readString(),
    });
  }
  return { errorCode, groups };
}

export function encodeKafkaSaslHandshakeRequest(mechanism = 'PLAIN'): Uint8Array {
  return kString(mechanism);
}

export function decodeKafkaSaslHandshakeResponse(
  body: Uint8Array,
): { errorCode: number; mechanisms: string[] } {
  const r = new KafkaReader(body);
  const errorCode = r.readInt16();
  const count = r.readInt32();
  const mechanisms: string[] = [];
  for (let i = 0; i < count; i++) mechanisms.push(r.readString());
  return { errorCode, mechanisms };
}

export function encodeKafkaSaslAuthenticateRequest(username: string, password: string): Uint8Array {
  const u = te.encode(username);
  const p = te.encode(password);
  const authBytes = new Uint8Array(1 + u.length + 1 + p.length);
  authBytes[0] = 0;
  authBytes.set(u, 1);
  authBytes[1 + u.length] = 0;
  authBytes.set(p, 2 + u.length);
  return kBytes(authBytes);
}

export function decodeKafkaSaslAuthenticateResponse(
  body: Uint8Array,
): { errorCode: number; errorMessage: string | null } {
  const r = new KafkaReader(body);
  const errorCode = r.readInt16();
  const errorMessage = r.readNullableString();
  return { errorCode, errorMessage };
}

/* ============================================================================
 * KafkaDriver (implements MqBrokerDriver)
 * ============================================================================ */

export class KafkaDriver implements MqBrokerDriver {
  readonly engine = 'kafka' as unknown as DatabaseEngineId;
  readonly family = 'mq' as const;

  private stream: BufferedByteStream | null = null;
  private _connected = false;
  private _serverVersion = 'Apache Kafka';
  private _tlsActive = false;
  private correlationId = 1;
  private clientId = 'netcatty-database';
  private cachedMetadata: KafkaMetadataResult | null = null;

  get connected(): boolean {
    return this._connected;
  }

  get serverVersion(): string {
    return this._serverVersion;
  }

  private requireStream(): BufferedByteStream {
    if (!this._connected || !this.stream) {
      throw new Error('Kafka driver is not connected');
    }
    return this.stream;
  }

  private async rpc(
    apiKey: number,
    apiVersion: number,
    body: Uint8Array,
    flexibleHeader = false,
  ): Promise<Uint8Array> {
    const bs = this.requireStream();
    const corrId = this.correlationId++;
    const frame = encodeKafkaRequestFrame(
      apiKey,
      apiVersion,
      corrId,
      this.clientId,
      body,
      flexibleHeader,
    );
    await bs.write(frame);

    const lenBytes = await bs.readExact(4);
    const totalLen = new DataView(lenBytes.buffer, lenBytes.byteOffset, 4).getInt32(0, false);
    if (totalLen < 4 || totalLen > 64 * 1024 * 1024) {
      throw new Error(`Invalid Kafka response frame length: ${totalLen}`);
    }
    const payload = await bs.readExact(totalLen);
    const respCorr = new DataView(payload.buffer, payload.byteOffset, 4).getInt32(0, false);
    if (respCorr !== corrId) {
      throw new Error(`Kafka correlationId mismatch: expected ${corrId}, got ${respCorr}`);
    }
    return payload.subarray(4);
  }

  async connect(config: ConnectionConfig, transport: ByteStreamTransport): Promise<ConnectionInfo> {
    const started = performance.now();
    const port = config.port ?? 9092;
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
    this._tlsActive = tls;
    this._connected = true;

    try {
      if (config.username && config.password) {
        const hsBody = await this.rpc(
          KAFKA_API_KEY.SASL_HANDSHAKE,
          1,
          encodeKafkaSaslHandshakeRequest('PLAIN'),
        );
        const hs = decodeKafkaSaslHandshakeResponse(hsBody);
        if (hs.errorCode !== 0) {
          throw new Error(`Kafka SASL handshake failed (errorCode=${hs.errorCode})`);
        }
        const authBody = await this.rpc(
          KAFKA_API_KEY.SASL_AUTHENTICATE,
          0,
          encodeKafkaSaslAuthenticateRequest(config.username, config.password),
        );
        const auth = decodeKafkaSaslAuthenticateResponse(authBody);
        if (auth.errorCode !== 0) {
          throw new Error(auth.errorMessage || `Kafka SASL auth failed (errorCode=${auth.errorCode})`);
        }
      }

      const apiResp = await this.rpc(
        KAFKA_API_KEY.API_VERSIONS,
        0,
        encodeKafkaApiVersionsRequest(0),
      );
      const versions = decodeKafkaApiVersionsResponse(apiResp, 0);
      if (versions.errorCode !== 0) {
        throw new Error(`Kafka ApiVersions error ${versions.errorCode}`);
      }

      const meta = await this.fetchMetadata(null);
      this.cachedMetadata = meta;
      this._serverVersion = `Apache Kafka (${meta.brokers.length} broker${meta.brokers.length === 1 ? '' : 's'})`;

      return {
        engine: this.engine,
        family: 'mq',
        serverVersion: this._serverVersion,
        database: meta.clusterId || 'default',
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

  private async fetchMetadata(topics: string[] | null): Promise<KafkaMetadataResult> {
    const body = await this.rpc(
      KAFKA_API_KEY.METADATA,
      1,
      encodeKafkaMetadataRequest(topics, 1),
    );
    return decodeKafkaMetadataResponse(body, 1);
  }

  async testConnection(): Promise<TestConnectionResult> {
    const started = performance.now();
    try {
      const apiResp = await this.rpc(
        KAFKA_API_KEY.API_VERSIONS,
        0,
        encodeKafkaApiVersionsRequest(0),
      );
      const parsed = decodeKafkaApiVersionsResponse(apiResp, 0);
      if (parsed.errorCode !== 0) {
        throw new Error(`Kafka ApiVersions error ${parsed.errorCode}`);
      }
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
    this.cachedMetadata = null;
    if (this.stream) {
      await this.stream.close().catch(() => {});
      this.stream = null;
    }
  }

  async getOverview(): Promise<MqOverview> {
    const meta = await this.fetchMetadata(null);
    this.cachedMetadata = meta;
    const userTopics = meta.topics.filter((t) => !t.isInternal);
    const totalPartitions = userTopics.reduce((sum, t) => sum + t.partitions.length, 0);
    return {
      engine: this.engine,
      clusterName: meta.clusterId || `controller-${meta.controllerId}`,
      serverVersion: this._serverVersion,
      nodeCount: meta.brokers.length,
      queueCount: userTopics.length,
      raw: {
        controllerId: meta.controllerId,
        totalTopics: meta.topics.length,
        userTopics: userTopics.length,
        totalPartitions,
      },
    };
  }

  async listVhosts(): Promise<string[]> {
    this.requireStream();
    return ['default'];
  }

  async listQueues(): Promise<MqQueueInfo[]> {
    const meta = await this.fetchMetadata(null);
    this.cachedMetadata = meta;
    return meta.topics
      .filter((t) => t.errorCode === 0)
      .map((t) => ({
        name: t.name,
        vhost: t.isInternal ? '__internal' : 'default',
        messages: t.partitions.length,
        durable: true,
        state: 'active',
        type: `${t.partitions.length} partition${t.partitions.length === 1 ? '' : 's'}`,
      }));
  }

  async listExchanges(): Promise<MqExchangeInfo[]> {
    this.requireStream();
    return [];
  }

  async listBindings(): Promise<MqBindingInfo[]> {
    const groups = await this.listConsumerGroups().catch(() => []);
    return groups.map((g) => ({
      source: g.protocolType || 'consumer',
      destination: g.groupId,
      destinationType: 'consumer_group',
      routingKey: g.groupId,
      vhost: 'default',
    }));
  }

  async listNodes(): Promise<MqNodeInfo[]> {
    const meta = this.cachedMetadata ?? (await this.fetchMetadata(null));
    return meta.brokers.map((b) => ({
      name: `broker-${b.nodeId} (${b.host}:${b.port})`,
      type: b.nodeId === meta.controllerId ? 'controller' : 'broker',
      running: true,
      host: b.host,
      port: b.port,
      isController: b.nodeId === meta.controllerId,
    }));
  }

  async listPartitions(topic: string): Promise<MqPartitionInfo[]> {
    const meta = await this.fetchMetadata([topic]);
    const found = meta.topics.find((t) => t.name === topic);
    if (!found) return [];
    const partIds = found.partitions.map((p) => p.partitionId);
    let earliestMap = new Map<number, number>();
    let latestMap = new Map<number, number>();
    if (partIds.length > 0) {
      try {
        const earlyBody = await this.rpc(
          KAFKA_API_KEY.LIST_OFFSETS,
          1,
          encodeKafkaListOffsetsRequest(topic, partIds, -2n),
        );
        for (const e of decodeKafkaListOffsetsResponse(earlyBody)) {
          if (e.errorCode === 0) earliestMap.set(e.partition, e.offset);
        }
        const lateBody = await this.rpc(
          KAFKA_API_KEY.LIST_OFFSETS,
          1,
          encodeKafkaListOffsetsRequest(topic, partIds, -1n),
        );
        for (const l of decodeKafkaListOffsetsResponse(lateBody)) {
          if (l.errorCode === 0) latestMap.set(l.partition, l.offset);
        }
      } catch {
        // optional enrichment
      }
    }
    return found.partitions.map((p) => ({
      ...p,
      earliestOffset: earliestMap.get(p.partitionId),
      latestOffset: latestMap.get(p.partitionId),
    }));
  }

  async listConsumerGroups(): Promise<MqConsumerGroupInfo[]> {
    const body = await this.rpc(KAFKA_API_KEY.LIST_GROUPS, 0, encodeKafkaListGroupsRequest());
    const parsed = decodeKafkaListGroupsResponse(body);
    if (parsed.errorCode !== 0) {
      throw new Error(`Kafka ListGroups error ${parsed.errorCode}`);
    }
    return parsed.groups;
  }

  async publishMessage(
    target: string,
    payload: string,
    options?: { vhost?: string; exchange?: string; routingKey?: string },
  ): Promise<{ routed: boolean }> {
    const body = await this.rpc(
      KAFKA_API_KEY.PRODUCE,
      2,
      encodeKafkaProduceRequest(
        target,
        0,
        [{ key: options?.routingKey ?? null, value: payload }],
        2,
      ),
    );
    const results = decodeKafkaProduceResponse(body);
    const first = results[0];
    if (first && first.errorCode !== 0) {
      throw new Error(`Kafka Produce error ${first.errorCode}`);
    }
    return { routed: true };
  }

  async getMessages(
    queueOrTopic: string,
    options?: { vhost?: string; count?: number; timeoutMs?: number },
  ): Promise<MqMessage[]> {
    const count = Math.max(1, Math.min(200, options?.count ?? 20));
    let startOffset = 0;
    try {
      const offBody = await this.rpc(
        KAFKA_API_KEY.LIST_OFFSETS,
        1,
        encodeKafkaListOffsetsRequest(queueOrTopic, [0], -1n),
      );
      const offsets = decodeKafkaListOffsetsResponse(offBody);
      const latest = offsets[0]?.offset ?? 0;
      startOffset = Math.max(0, latest - count);
    } catch {
      startOffset = 0;
    }

    const fetchBody = await this.rpc(
      KAFKA_API_KEY.FETCH,
      2,
      encodeKafkaFetchRequest(
        queueOrTopic,
        0,
        startOffset,
        256 * 1024,
        Math.min(options?.timeoutMs ?? 500, 3000),
        2,
      ),
    );
    const responses = decodeKafkaFetchResponse(fetchBody, 2);
    const messages: MqMessage[] = [];
    for (const part of responses) {
      if (part.errorCode !== 0) continue;
      for (const rec of part.records) {
        if (messages.length >= count) break;
        messages.push({
          id: `${part.partition}:${rec.offset}`,
          topicOrQueue: queueOrTopic,
          routingKey: rec.key,
          payload: rec.value,
          headers: { partition: part.partition, offset: rec.offset },
          timestamp: rec.timestamp,
        });
      }
    }
    return messages;
  }
}

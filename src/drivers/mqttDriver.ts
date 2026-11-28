/**
 * Pure-TS Browser-Sandbox MQTT v3.1.1 / v5.0 Binary TCP Client (`family: 'mq'`).
 * Implements MQTT wire packets over `ByteStream`:
 * - CONNECT, CONNACK
 * - SUBSCRIBE, SUBACK, UNSUBSCRIBE, UNSUBACK
 * - PUBLISH, PUBACK
 * - PINGREQ, PINGRESP
 * - DISCONNECT
 *
 * Implements `MqBrokerDriver` (and `MqDriver`): topics map to queues,
 * subscribe/publish/peek messages cleanly inside the browser sandbox.
 *
 * 100% browser-sandbox compatible (zero `node:*` imports).
 */

import { BufferedByteStream, concatBytes } from './streamBuffer';
import type { MqBrokerDriver } from './mqHttpDriver';
import type {
  ByteStreamTransport,
  ConnectionConfig,
  ConnectionInfo,
  MqBindingInfo,
  MqExchangeInfo,
  MqMessage,
  MqOverview,
  MqQueueInfo,
  TestConnectionResult,
} from './types';

const te = new TextEncoder();
const td = new TextDecoder('utf-8');

export const MQTT_PACKET_TYPE = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PUBACK: 4,
  SUBSCRIBE: 8,
  SUBACK: 9,
  UNSUBSCRIBE: 10,
  UNSUBACK: 11,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
} as const;

export type MqttProtocolVersion = 4 | 5; // 4 = v3.1.1, 5 = v5.0

/* ============================================================================
 * Pure MQTT v3.1.1 / v5.0 Binary Wire Codecs
 * ============================================================================ */

export function encodeMqttRemainingLength(length: number): Uint8Array {
  const out: number[] = [];
  let x = Math.max(0, Math.floor(length));
  do {
    let encodedByte = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) encodedByte |= 0x80;
    out.push(encodedByte);
  } while (x > 0);
  return new Uint8Array(out);
}

export function decodeMqttRemainingLength(
  bytes: Uint8Array,
  offset = 0,
): { value: number; bytesRead: number } {
  let multiplier = 1;
  let value = 0;
  let bytesRead = 0;
  while (offset + bytesRead < bytes.length) {
    const encodedByte = bytes[offset + bytesRead];
    bytesRead++;
    value += (encodedByte & 0x7f) * multiplier;
    if ((encodedByte & 0x80) === 0) {
      return { value, bytesRead };
    }
    multiplier *= 128;
    if (bytesRead >= 4) {
      throw new Error('Malformed MQTT remaining length');
    }
  }
  throw new Error('Truncated MQTT remaining length');
}

export function encodeMqttString(text: string): Uint8Array {
  const raw = te.encode(text);
  const out = new Uint8Array(2 + raw.length);
  out[0] = (raw.length >> 8) & 0xff;
  out[1] = raw.length & 0xff;
  out.set(raw, 2);
  return out;
}

function decodeMqttString(bytes: Uint8Array, offset: number): { value: string; nextOffset: number } {
  if (offset + 2 > bytes.length) throw new Error('Truncated MQTT string length');
  const len = (bytes[offset] << 8) | bytes[offset + 1];
  const start = offset + 2;
  const end = start + len;
  if (end > bytes.length) throw new Error('Truncated MQTT string body');
  return { value: td.decode(bytes.subarray(start, end)), nextOffset: end };
}

function wrapMqttPacket(packetType: number, flags: number, body: Uint8Array): Uint8Array {
  const firstByte = ((packetType & 0x0f) << 4) | (flags & 0x0f);
  return concatBytes(new Uint8Array([firstByte]), encodeMqttRemainingLength(body.length), body);
}

export function encodeMqttConnect(options: {
  clientId: string;
  username?: string;
  password?: string;
  keepAliveSec?: number;
  cleanSession?: boolean;
  protocolVersion?: MqttProtocolVersion;
}): Uint8Array {
  const protoVer: MqttProtocolVersion = options.protocolVersion ?? 4;
  const keepAlive = options.keepAliveSec ?? 60;
  let connectFlags = options.cleanSession !== false ? 0x02 : 0x00;
  if (options.username) connectFlags |= 0x80;
  if (options.password) connectFlags |= 0x40;

  const varHeaderParts: Uint8Array[] = [
    encodeMqttString('MQTT'),
    new Uint8Array([protoVer, connectFlags, (keepAlive >> 8) & 0xff, keepAlive & 0xff]),
  ];
  if (protoVer === 5) {
    varHeaderParts.push(new Uint8Array([0x00])); // MQTT 5.0 empty properties
  }

  const payloadParts: Uint8Array[] = [encodeMqttString(options.clientId)];
  if (options.username) payloadParts.push(encodeMqttString(options.username));
  if (options.password) payloadParts.push(encodeMqttString(options.password));

  return wrapMqttPacket(MQTT_PACKET_TYPE.CONNECT, 0, concatBytes(...varHeaderParts, ...payloadParts));
}

export function decodeMqttConnack(
  payload: Uint8Array,
  protocolVersion: MqttProtocolVersion = 4,
): { sessionPresent: boolean; returnCode: number; ok: boolean; reason: string } {
  if (payload.length < 2) {
    throw new Error(`Invalid MQTT CONNACK payload length: ${payload.length}`);
  }
  const sessionPresent = (payload[0] & 0x01) !== 0;
  const returnCode = payload[1];
  const ok = returnCode === 0;
  const v3Reasons: Record<number, string> = {
    0: 'Connection Accepted',
    1: 'Unacceptable protocol version',
    2: 'Identifier rejected',
    3: 'Server unavailable',
    4: 'Bad username or password',
    5: 'Not authorized',
  };
  const reason =
    protocolVersion === 5
      ? returnCode === 0
        ? 'Success'
        : `MQTT 5.0 reason code 0x${returnCode.toString(16)}`
      : v3Reasons[returnCode] || `CONNACK code ${returnCode}`;
  return { sessionPresent, returnCode, ok, reason };
}

export function encodeMqttSubscribe(
  packetId: number,
  topics: Array<{ topic: string; qos?: 0 | 1 }>,
  protocolVersion: MqttProtocolVersion = 4,
): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff])];
  if (protocolVersion === 5) {
    parts.push(new Uint8Array([0x00])); // empty properties
  }
  for (const t of topics) {
    parts.push(encodeMqttString(t.topic), new Uint8Array([t.qos ?? 0]));
  }
  // MQTT SUBSCRIBE fixed header flags MUST be 0x02
  return wrapMqttPacket(MQTT_PACKET_TYPE.SUBSCRIBE, 0x02, concatBytes(...parts));
}

export function decodeMqttSuback(
  payload: Uint8Array,
  protocolVersion: MqttProtocolVersion = 4,
): { packetId: number; returnCodes: number[] } {
  if (payload.length < 2) throw new Error('Invalid MQTT SUBACK payload');
  const packetId = (payload[0] << 8) | payload[1];
  let offset = 2;
  if (protocolVersion === 5 && offset < payload.length) {
    const propLen = decodeMqttRemainingLength(payload, offset);
    offset += propLen.bytesRead + propLen.value;
  }
  const returnCodes = Array.from(payload.subarray(offset));
  return { packetId, returnCodes };
}

export function encodeMqttUnsubscribe(
  packetId: number,
  topics: string[],
  protocolVersion: MqttProtocolVersion = 4,
): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff])];
  if (protocolVersion === 5) {
    parts.push(new Uint8Array([0x00]));
  }
  for (const topic of topics) {
    parts.push(encodeMqttString(topic));
  }
  return wrapMqttPacket(MQTT_PACKET_TYPE.UNSUBSCRIBE, 0x02, concatBytes(...parts));
}

export function encodeMqttPublish(
  options: {
    topic: string;
    payload: string | Uint8Array;
    qos?: 0 | 1;
    retain?: boolean;
    packetId?: number;
  },
  protocolVersion: MqttProtocolVersion = 4,
): Uint8Array {
  const qos = options.qos ?? 0;
  const retain = options.retain ? 1 : 0;
  const flags = ((qos & 0x03) << 1) | retain;
  const parts: Uint8Array[] = [encodeMqttString(options.topic)];
  if (qos > 0) {
    const pid = options.packetId ?? 1;
    parts.push(new Uint8Array([(pid >> 8) & 0xff, pid & 0xff]));
  }
  if (protocolVersion === 5) {
    parts.push(new Uint8Array([0x00])); // empty properties
  }
  const payloadBytes =
    typeof options.payload === 'string' ? te.encode(options.payload) : options.payload;
  parts.push(payloadBytes);
  return wrapMqttPacket(MQTT_PACKET_TYPE.PUBLISH, flags, concatBytes(...parts));
}

export function decodeMqttPublish(
  flags: number,
  payload: Uint8Array,
  protocolVersion: MqttProtocolVersion = 4,
): {
  topic: string;
  payload: string;
  qos: number;
  retain: boolean;
  dup: boolean;
  packetId?: number;
} {
  const dup = (flags & 0x08) !== 0;
  const qos = (flags >> 1) & 0x03;
  const retain = (flags & 0x01) !== 0;

  const topicRes = decodeMqttString(payload, 0);
  let offset = topicRes.nextOffset;
  let packetId: number | undefined;
  if (qos > 0) {
    if (offset + 2 > payload.length) throw new Error('Truncated MQTT PUBLISH packetId');
    packetId = (payload[offset] << 8) | payload[offset + 1];
    offset += 2;
  }
  if (protocolVersion === 5 && offset < payload.length) {
    const propLen = decodeMqttRemainingLength(payload, offset);
    offset += propLen.bytesRead + propLen.value;
  }
  const text = td.decode(payload.subarray(offset));
  return { topic: topicRes.value, payload: text, qos, retain, dup, packetId };
}

export function encodeMqttPuback(packetId: number): Uint8Array {
  return wrapMqttPacket(
    MQTT_PACKET_TYPE.PUBACK,
    0,
    new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff]),
  );
}

export function encodeMqttPingreq(): Uint8Array {
  return new Uint8Array([MQTT_PACKET_TYPE.PINGREQ << 4, 0x00]);
}

export function encodeMqttDisconnect(protocolVersion: MqttProtocolVersion = 4): Uint8Array {
  if (protocolVersion === 5) {
    return new Uint8Array([MQTT_PACKET_TYPE.DISCONNECT << 4, 0x01, 0x00]);
  }
  return new Uint8Array([MQTT_PACKET_TYPE.DISCONNECT << 4, 0x00]);
}

function mqttTopicMatches(filter: string, topic: string): boolean {
  if (filter === '#' || filter === topic) return true;
  const filterParts = filter.split('/');
  const topicParts = topic.split('/');
  for (let i = 0; i < filterParts.length; i++) {
    if (filterParts[i] === '#') return true;
    if (i >= topicParts.length) return false;
    if (filterParts[i] !== '+' && filterParts[i] !== topicParts[i]) return false;
  }
  return filterParts.length === topicParts.length;
}

/* ============================================================================
 * MqttDriver (implements MqBrokerDriver)
 * ============================================================================ */

export class MqttDriver implements MqBrokerDriver {
  readonly engine = 'mqtt' as const;
  readonly family = 'mq' as const;

  private stream: BufferedByteStream | null = null;
  private config: ConnectionConfig | null = null;
  private _connected = false;
  private _serverVersion = 'MQTT v3.1.1';
  private _tlsActive = false;
  private protocolVersion: MqttProtocolVersion = 4;
  private nextPacketId = 1;
  private subscribedTopics = new Map<string, { qos: 0 | 1; messageCount: number }>();
  private messageBuffer: MqMessage[] = [];

  get connected(): boolean {
    return this._connected;
  }

  get serverVersion(): string {
    return this._serverVersion;
  }

  private requireStream(): BufferedByteStream {
    if (!this._connected || !this.stream) {
      throw new Error('MQTT driver is not connected');
    }
    return this.stream;
  }

  private allocPacketId(): number {
    const id = this.nextPacketId;
    this.nextPacketId = this.nextPacketId >= 65535 ? 1 : this.nextPacketId + 1;
    return id;
  }

  private async readPacket(): Promise<{ packetType: number; flags: number; payload: Uint8Array }> {
    const bs = this.requireStream();
    const first = await bs.readByte();
    const packetType = (first >> 4) & 0x0f;
    const flags = first & 0x0f;

    let multiplier = 1;
    let remainingLength = 0;
    let count = 0;
    while (true) {
      const encodedByte = await bs.readByte();
      remainingLength += (encodedByte & 0x7f) * multiplier;
      count++;
      if ((encodedByte & 0x80) === 0) break;
      multiplier *= 128;
      if (count >= 4) throw new Error('Malformed MQTT remaining length');
    }

    const payload = remainingLength > 0 ? await bs.readExact(remainingLength) : new Uint8Array(0);
    return { packetType, flags, payload };
  }

  private recordIncomingPublish(flags: number, payload: Uint8Array): MqMessage {
    const decoded = decodeMqttPublish(flags, payload, this.protocolVersion);
    const msg: MqMessage = {
      id: decoded.packetId !== undefined ? String(decoded.packetId) : `${Date.now()}-${this.messageBuffer.length}`,
      topicOrQueue: decoded.topic,
      routingKey: decoded.topic,
      payload: decoded.payload,
      headers: { qos: decoded.qos, retain: decoded.retain, dup: decoded.dup },
      timestamp: Date.now(),
      redelivered: decoded.dup,
    };
    this.messageBuffer.push(msg);
    if (this.messageBuffer.length > 500) {
      this.messageBuffer.shift();
    }
    const existing = this.subscribedTopics.get(decoded.topic);
    if (existing) {
      existing.messageCount++;
    } else {
      this.subscribedTopics.set(decoded.topic, { qos: decoded.qos === 1 ? 1 : 0, messageCount: 1 });
    }
    return msg;
  }

  async connect(config: ConnectionConfig, transport: ByteStreamTransport): Promise<ConnectionInfo> {
    const started = performance.now();
    const port = config.port ?? 1883;
    const tls = config.tlsMode === 'require' || config.tlsMode === 'verify-full' || port === 8883;
    this.protocolVersion = config.httpPath === '5' || config.httpPath === 'v5' ? 5 : 4;

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
    this._connected = true;
    this.subscribedTopics.clear();
    this.messageBuffer = [];

    try {
      const clientId = config.database || `netcatty-${Math.random().toString(36).slice(2, 10)}`;
      const connectPkt = encodeMqttConnect({
        clientId,
        username: config.username,
        password: config.password,
        keepAliveSec: 60,
        cleanSession: true,
        protocolVersion: this.protocolVersion,
      });
      await this.stream.write(connectPkt);

      const resp = await this.readPacket();
      if (resp.packetType !== MQTT_PACKET_TYPE.CONNACK) {
        throw new Error(`Expected MQTT CONNACK, got packet type ${resp.packetType}`);
      }
      const connack = decodeMqttConnack(resp.payload, this.protocolVersion);
      if (!connack.ok) {
        throw new Error(`MQTT connection refused: ${connack.reason}`);
      }

      this._serverVersion = this.protocolVersion === 5 ? 'MQTT v5.0' : 'MQTT v3.1.1';
      return {
        engine: 'mqtt',
        family: 'mq',
        serverVersion: this._serverVersion,
        database: '/',
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

  async testConnection(): Promise<TestConnectionResult> {
    const started = performance.now();
    try {
      const bs = this.requireStream();
      await bs.write(encodeMqttPingreq());
      for (let i = 0; i < 8; i++) {
        const pkt = await this.readPacket();
        if (pkt.packetType === MQTT_PACKET_TYPE.PINGRESP) {
          return {
            ok: true,
            serverVersion: this._serverVersion,
            latencyMs: Math.round(performance.now() - started),
            tlsActive: this._tlsActive,
          };
        }
        if (pkt.packetType === MQTT_PACKET_TYPE.PUBLISH) {
          this.recordIncomingPublish(pkt.flags, pkt.payload);
        }
      }
      throw new Error('Did not receive MQTT PINGRESP');
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
    if (this._connected && this.stream) {
      await this.stream.write(encodeMqttDisconnect(this.protocolVersion)).catch(() => {});
      await this.stream.close().catch(() => {});
    }
    this._connected = false;
    this.stream = null;
  }

  async getOverview(): Promise<MqOverview> {
    this.requireStream();
    return {
      engine: 'mqtt',
      clusterName: `${this.config?.host ?? '127.0.0.1'}:${this.config?.port ?? 1883}`,
      serverVersion: this._serverVersion,
      nodeCount: 1,
      queueCount: this.subscribedTopics.size,
      connectionCount: 1,
      messagesReady: this.messageBuffer.length,
      raw: {
        protocolVersion: this.protocolVersion === 5 ? '5.0' : '3.1.1',
        subscribedTopics: Array.from(this.subscribedTopics.keys()),
        bufferedMessages: this.messageBuffer.length,
      },
    };
  }

  async listVhosts(): Promise<string[]> {
    this.requireStream();
    return ['/'];
  }

  async listQueues(): Promise<MqQueueInfo[]> {
    this.requireStream();
    return Array.from(this.subscribedTopics.entries()).map(([topic, meta]) => ({
      name: topic,
      vhost: '/',
      messages: meta.messageCount,
      messagesReady: meta.messageCount,
      consumers: 1,
      durable: false,
      state: 'subscribed',
      type: `QoS ${meta.qos}`,
    }));
  }

  async listExchanges(): Promise<MqExchangeInfo[]> {
    this.requireStream();
    return [];
  }

  async listBindings(): Promise<MqBindingInfo[]> {
    this.requireStream();
    return Array.from(this.subscribedTopics.keys()).map((topic) => ({
      source: 'broker',
      destination: topic,
      destinationType: 'subscription',
      routingKey: topic,
      vhost: '/',
    }));
  }

  async subscribeTopic(topic: string, qos: 0 | 1 = 0): Promise<void> {
    const bs = this.requireStream();
    const packetId = this.allocPacketId();
    await bs.write(encodeMqttSubscribe(packetId, [{ topic, qos }], this.protocolVersion));
    for (let i = 0; i < 8; i++) {
      const pkt = await this.readPacket();
      if (pkt.packetType === MQTT_PACKET_TYPE.SUBACK) {
        const suback = decodeMqttSuback(pkt.payload, this.protocolVersion);
        if (suback.returnCodes.some((c) => c >= 0x80)) {
          throw new Error(`MQTT broker rejected subscription to ${topic}`);
        }
        const existing = this.subscribedTopics.get(topic);
        this.subscribedTopics.set(topic, { qos, messageCount: existing?.messageCount ?? 0 });
        return;
      }
      if (pkt.packetType === MQTT_PACKET_TYPE.PUBLISH) {
        this.recordIncomingPublish(pkt.flags, pkt.payload);
      }
    }
    throw new Error(`Did not receive MQTT SUBACK for ${topic}`);
  }

  async createQueue(name: string): Promise<void> {
    await this.subscribeTopic(name, 0);
  }

  async deleteQueue(name: string): Promise<void> {
    const bs = this.requireStream();
    const packetId = this.allocPacketId();
    await bs.write(encodeMqttUnsubscribe(packetId, [name], this.protocolVersion));
    for (let i = 0; i < 4; i++) {
      const pkt = await this.readPacket();
      if (pkt.packetType === MQTT_PACKET_TYPE.UNSUBACK) break;
      if (pkt.packetType === MQTT_PACKET_TYPE.PUBLISH) {
        this.recordIncomingPublish(pkt.flags, pkt.payload);
      }
    }
    this.subscribedTopics.delete(name);
  }

  async publishMessage(
    target: string,
    payload: string,
    options?: { vhost?: string; exchange?: string; routingKey?: string; qos?: 0 | 1; retain?: boolean },
  ): Promise<{ routed: boolean }> {
    const bs = this.requireStream();
    const topic = options?.routingKey || target;
    const qos = options?.qos ?? 0;
    const packetId = qos > 0 ? this.allocPacketId() : undefined;
    const pkt = encodeMqttPublish(
      { topic, payload, qos, retain: options?.retain, packetId },
      this.protocolVersion,
    );
    await bs.write(pkt);

    if (qos === 1) {
      for (let i = 0; i < 8; i++) {
        const resp = await this.readPacket();
        if (resp.packetType === MQTT_PACKET_TYPE.PUBACK) break;
        if (resp.packetType === MQTT_PACKET_TYPE.PUBLISH) {
          this.recordIncomingPublish(resp.flags, resp.payload);
        }
      }
    }

    if (!this.subscribedTopics.has(topic)) {
      this.subscribedTopics.set(topic, { qos, messageCount: 0 });
    }
    return { routed: true };
  }

  async getMessages(
    queueOrTopic: string,
    options?: { vhost?: string; count?: number; requeue?: boolean; timeoutMs?: number },
  ): Promise<MqMessage[]> {
    this.requireStream();
    const limit = Math.max(1, options?.count ?? 20);
    if (!this.subscribedTopics.has(queueOrTopic)) {
      await this.subscribeTopic(queueOrTopic, 0);
    }

    // Drain any immediately buffered or available packets within timeoutMs
    const waitMs = Math.min(options?.timeoutMs ?? 500, 3000);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const matching = this.messageBuffer.filter((m) => mqttTopicMatches(queueOrTopic, m.topicOrQueue));
      if (matching.length >= limit) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const pkt = await Promise.race([
        this.readPacket().catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
      ]);
      if (!pkt) break;
      if (pkt.packetType === MQTT_PACKET_TYPE.PUBLISH) {
        const msg = this.recordIncomingPublish(pkt.flags, pkt.payload);
        const qos = (pkt.flags >> 1) & 0x03;
        if (qos === 1 && msg.id && this.stream) {
          const pid = Number(msg.id);
          if (Number.isInteger(pid)) {
            await this.stream.write(encodeMqttPuback(pid)).catch(() => {});
          }
        }
      }
    }

    return this.messageBuffer
      .filter((m) => mqttTopicMatches(queueOrTopic, m.topicOrQueue))
      .slice(-limit);
  }
}

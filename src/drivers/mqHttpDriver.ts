/**
 * Pure-TS Browser-Sandbox HTTP Message Queue / Broker Driver (`family: 'mq'`).
 * Supports:
 * - **RabbitMQ Management HTTP API**:
 *   `/api/{overview,nodes,vhosts,queues,exchanges,bindings,connections,channels,users,permissions,policies}`
 *   plus queue create/delete/purge, exchange publish, and queue get/peek.
 * - **Apache Pulsar Admin HTTP API**:
 *   `/admin/v2/{tenants,namespaces,persistent,brokers/health,brokers/active}`
 *   plus topic create/delete, stats/subscriptions, publish, and examine/peek.
 *
 * Also exports the unified `MqBrokerDriver` interface (extending `MqDriver`) shared by
 * `MqHttpDriver`, `MqttDriver`, and `KafkaDriver`.
 *
 * 100% browser-sandbox compatible (zero `node:*` imports).
 */

import {
  decodeResponseJson,
  decodeResponseText,
  encodeBasicAuth,
  resolveHttpTls,
  sendHttpRequest,
  type HttpEndpointConfig,
} from './httpClient';
import type {
  ByteStreamTransport,
  ConnectionConfig,
  ConnectionInfo,
  DatabaseEngineId,
  MqBindingInfo,
  MqDriver,
  MqExchangeInfo,
  MqMessage,
  MqOverview,
  MqQueueInfo,
  TestConnectionResult,
} from './types';

export interface MqNodeInfo {
  name: string;
  type?: string;
  running: boolean;
  host?: string;
  port?: number;
  memUsedBytes?: number;
  fdUsed?: number;
  uptimeMs?: number;
  isController?: boolean;
}

export interface MqConnectionInfo {
  name: string;
  user?: string;
  vhost?: string;
  state?: string;
  protocol?: string;
  peerHost?: string;
  channels?: number;
}

export interface MqChannelInfo {
  name: string;
  connectionName?: string;
  user?: string;
  vhost?: string;
  state?: string;
  consumerCount?: number;
  unackedCount?: number;
}

export interface MqUserInfo {
  name: string;
  tags: string[];
  permissions?: Array<{ vhost: string; configure: string; write: string; read: string }>;
}

export interface MqPolicyInfo {
  name: string;
  vhost: string;
  pattern: string;
  applyTo?: string;
  priority?: number;
  definition?: Record<string, unknown>;
}

export interface MqPartitionInfo {
  topic: string;
  partitionId: number;
  leader: number;
  replicas: number[];
  isr: number[];
  earliestOffset?: number;
  latestOffset?: number;
}

export interface MqConsumerGroupInfo {
  groupId: string;
  protocolType?: string;
  state?: string;
}

/**
 * Unified Message Broker interface extending `MqDriver` with rich broker-specific
 * inspection methods used by `MqWorkbenchTab`.
 */
export interface MqBrokerDriver extends MqDriver {
  listNodes?(): Promise<MqNodeInfo[]>;
  listConnections?(): Promise<MqConnectionInfo[]>;
  listChannels?(): Promise<MqChannelInfo[]>;
  listUsers?(): Promise<MqUserInfo[]>;
  listPolicies?(vhost?: string): Promise<MqPolicyInfo[]>;
  listPartitions?(topic: string): Promise<MqPartitionInfo[]>;
  listConsumerGroups?(): Promise<MqConsumerGroupInfo[]>;
  purgeQueue?(name: string, vhost?: string): Promise<void>;
}

export type MqHttpEngineId = 'rabbitmq' | 'pulsar';

const DEFAULT_PORTS: Record<MqHttpEngineId, number> = {
  rabbitmq: 15672,
  pulsar: 8080,
};

function normalizeMqHttpEngine(engine: string): MqHttpEngineId {
  if (engine === 'rabbitmq') return 'rabbitmq';
  if (engine === 'pulsar' || engine === 'mq') return 'pulsar';
  throw new Error(`Unsupported HTTP MQ engine: ${engine}`);
}

function parsePulsarNamespace(vhost?: string, fallbackTenant = 'public', fallbackNs = 'default'): {
  tenant: string;
  namespace: string;
} {
  const raw = (vhost || '').trim().replace(/^\/+|\/+$/g, '');
  if (!raw) return { tenant: fallbackTenant, namespace: fallbackNs };
  const parts = raw.split('/').filter(Boolean);
  if (parts.length >= 2) return { tenant: parts[0], namespace: parts[1] };
  return { tenant: fallbackTenant, namespace: parts[0] };
}

function extractPulsarShortTopic(fullTopic: string): { tenant?: string; namespace?: string; topic: string } {
  const m = /^(?:persistent|non-persistent):\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(fullTopic);
  if (m) {
    return { tenant: m[1], namespace: m[2], topic: m[3] };
  }
  return { topic: fullTopic };
}

export class MqHttpDriver implements MqBrokerDriver {
  private _engine: MqHttpEngineId;
  readonly family = 'mq' as const;

  private transport: ByteStreamTransport | null = null;
  private config: ConnectionConfig | null = null;
  private endpoint: HttpEndpointConfig | null = null;
  private _connected = false;
  private _serverVersion = '';
  private _tlsActive = false;

  constructor(engine: DatabaseEngineId = 'rabbitmq') {
    this._engine = normalizeMqHttpEngine(engine);
  }

  get engine(): DatabaseEngineId {
    return this._engine;
  }

  get connected(): boolean {
    return this._connected;
  }

  get serverVersion(): string {
    return this._serverVersion;
  }

  private requireConnected(): {
    transport: ByteStreamTransport;
    config: ConnectionConfig;
    endpoint: HttpEndpointConfig;
  } {
    if (!this._connected || !this.transport || !this.config || !this.endpoint) {
      throw new Error(`${this._engine} driver is not connected`);
    }
    return {
      transport: this.transport,
      config: this.config,
      endpoint: this.endpoint,
    };
  }

  private buildHeaders(withJson = false): Record<string, string> {
    const config = this.config!;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (withJson) headers['Content-Type'] = 'application/json';
    if (this._engine === 'rabbitmq') {
      if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
      } else {
        headers['Authorization'] = encodeBasicAuth(config.username || 'guest', config.password ?? 'guest');
      }
    } else {
      const token = config.apiKey || config.password;
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }
    return headers;
  }

  private async requestJson<T>(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
    body?: unknown,
  ): Promise<T> {
    const { transport, config, endpoint } = this.requireConnected();
    const resp = await sendHttpRequest(transport, endpoint, path, {
      method,
      headers: this.buildHeaders(body !== undefined),
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      timeoutMs: config.timeoutMs ?? 15000,
    });
    if (resp.status >= 400) {
      throw new Error(decodeResponseText(resp).trim() || `${this._engine} HTTP ${resp.status}`);
    }
    return decodeResponseJson<T>(resp);
  }

  async connect(config: ConnectionConfig, transport: ByteStreamTransport): Promise<ConnectionInfo> {
    const started = performance.now();
    this._engine = normalizeMqHttpEngine(config.engine);
    const port = config.port ?? DEFAULT_PORTS[this._engine];
    const tls = resolveHttpTls(config.tlsMode, port);

    this.config = { ...config, port };
    this.transport = transport;
    this._tlsActive = tls;
    this.endpoint = {
      host: config.host || '127.0.0.1',
      port,
      tls,
      allowSelfSigned: config.allowSelfSigned,
      caPem: config.caPem,
      basePath: config.httpPath,
      sshTunnel: config.sshTunnel,
    };
    this._connected = true;

    try {
      const overview = await this.getOverview();
      this._serverVersion = overview.serverVersion;
      return {
        engine: this._engine,
        family: 'mq',
        serverVersion: this._serverVersion,
        database: config.vhost || config.namespace || (this._engine === 'rabbitmq' ? '/' : 'public/default'),
        tlsActive: this._tlsActive,
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      this._connected = false;
      throw err;
    }
  }

  async testConnection(): Promise<TestConnectionResult> {
    const started = performance.now();
    try {
      const overview = await this.getOverview();
      this._serverVersion = overview.serverVersion;
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
  }

  /* --------------------------------------------------------------------------
   * Overview & Topology
   * -------------------------------------------------------------------------- */

  async getOverview(): Promise<MqOverview> {
    if (this._engine === 'rabbitmq') {
      const data = await this.requestJson<{
        cluster_name?: string;
        rabbitmq_version?: string;
        erlang_version?: string;
        object_totals?: {
          queues?: number;
          exchanges?: number;
          connections?: number;
          channels?: number;
          consumers?: number;
        };
        queue_totals?: {
          messages?: number;
          messages_ready?: number;
          messages_unacknowledged?: number;
        };
      }>('/api/overview');
      const ver = data.rabbitmq_version ? `RabbitMQ ${data.rabbitmq_version}` : 'RabbitMQ';
      return {
        engine: 'rabbitmq',
        clusterName: data.cluster_name,
        serverVersion: ver,
        queueCount: data.object_totals?.queues,
        exchangeCount: data.object_totals?.exchanges,
        connectionCount: data.object_totals?.connections,
        messagesReady: data.queue_totals?.messages_ready,
        messagesUnacked: data.queue_totals?.messages_unacknowledged,
        raw: data as unknown as Record<string, unknown>,
      };
    }

    // Apache Pulsar Admin HTTP
    const { transport, config, endpoint } = this.requireConnected();
    const healthResp = await sendHttpRequest(transport, endpoint, '/admin/v2/brokers/health', {
      method: 'GET',
      headers: this.buildHeaders(),
      timeoutMs: config.timeoutMs ?? 15000,
    });
    if (healthResp.status >= 400) {
      throw new Error(decodeResponseText(healthResp).trim() || `Pulsar health HTTP ${healthResp.status}`);
    }
    const healthText = decodeResponseText(healthResp).trim();
    const tenants = await this.requestJson<string[]>('/admin/v2/tenants').catch(() => []);
    const brokers = await this.requestJson<string[]>('/admin/v2/brokers/active').catch(() => []);

    return {
      engine: 'pulsar',
      clusterName: tenants[0] || 'pulsar',
      serverVersion: 'Apache Pulsar Admin v2',
      nodeCount: brokers.length || 1,
      raw: { health: healthText || 'ok', tenants, activeBrokers: brokers },
    };
  }

  async listVhosts(): Promise<string[]> {
    if (this._engine === 'rabbitmq') {
      const vhosts = await this.requestJson<Array<{ name: string }>>('/api/vhosts');
      return Array.isArray(vhosts) ? vhosts.map((v) => v.name) : ['/'];
    }

    const tenants = await this.requestJson<string[]>('/admin/v2/tenants').catch(() => ['public']);
    const namespaces: string[] = [];
    for (const tenant of tenants) {
      const nsList = await this.requestJson<string[]>(
        `/admin/v2/namespaces/${encodeURIComponent(tenant)}`,
      ).catch(() => []);
      for (const ns of nsList) {
        namespaces.push(ns.includes('/') ? ns : `${tenant}/${ns}`);
      }
    }
    return namespaces.length > 0 ? namespaces : ['public/default'];
  }

  async listQueues(vhost?: string): Promise<MqQueueInfo[]> {
    if (this._engine === 'rabbitmq') {
      const targetVhost = vhost ?? this.config?.vhost;
      const path = targetVhost ? `/api/queues/${encodeURIComponent(targetVhost)}` : '/api/queues';
      const rows = await this.requestJson<
        Array<{
          name: string;
          vhost: string;
          messages?: number;
          messages_ready?: number;
          messages_unacknowledged?: number;
          consumers?: number;
          durable?: boolean;
          state?: string;
          type?: string;
        }>
      >(path);
      return (Array.isArray(rows) ? rows : []).map((q) => ({
        name: q.name,
        vhost: q.vhost,
        messages: q.messages,
        messagesReady: q.messages_ready,
        messagesUnacked: q.messages_unacknowledged,
        consumers: q.consumers,
        durable: q.durable,
        state: q.state,
        type: q.type,
      }));
    }

    const { tenant, namespace } = parsePulsarNamespace(
      vhost || this.config?.namespace,
      this.config?.org || 'public',
      'default',
    );
    const topics = await this.requestJson<string[]>(
      `/admin/v2/persistent/${encodeURIComponent(tenant)}/${encodeURIComponent(namespace)}`,
    );
    return (Array.isArray(topics) ? topics : []).map((full) => {
      const parsed = extractPulsarShortTopic(full);
      return {
        name: parsed.topic,
        vhost: `${parsed.tenant || tenant}/${parsed.namespace || namespace}`,
        durable: true,
        state: 'running',
        type: 'persistent',
      };
    });
  }

  async listExchanges(vhost?: string): Promise<MqExchangeInfo[]> {
    if (this._engine === 'rabbitmq') {
      const targetVhost = vhost ?? this.config?.vhost;
      const path = targetVhost ? `/api/exchanges/${encodeURIComponent(targetVhost)}` : '/api/exchanges';
      const rows = await this.requestJson<
        Array<{
          name: string;
          vhost: string;
          type: string;
          durable?: boolean;
          auto_delete?: boolean;
        }>
      >(path);
      return (Array.isArray(rows) ? rows : []).map((e) => ({
        name: e.name || '(AMQP default)',
        vhost: e.vhost,
        type: e.type,
        durable: e.durable,
        autoDelete: e.auto_delete,
      }));
    }
    return [];
  }

  async listBindings(vhost?: string): Promise<MqBindingInfo[]> {
    if (this._engine === 'rabbitmq') {
      const targetVhost = vhost ?? this.config?.vhost;
      const path = targetVhost ? `/api/bindings/${encodeURIComponent(targetVhost)}` : '/api/bindings';
      const rows = await this.requestJson<
        Array<{
          source: string;
          destination: string;
          destination_type?: string;
          routing_key: string;
          vhost?: string;
        }>
      >(path);
      return (Array.isArray(rows) ? rows : []).map((b) => ({
        source: b.source || '(AMQP default)',
        destination: b.destination,
        destinationType: b.destination_type,
        routingKey: b.routing_key,
        vhost: b.vhost,
      }));
    }

    // Pulsar: expose subscriptions on topics as bindings
    const { tenant, namespace } = parsePulsarNamespace(
      vhost || this.config?.namespace,
      this.config?.org || 'public',
      'default',
    );
    const topics = await this.listQueues(`${tenant}/${namespace}`).catch(() => []);
    const bindings: MqBindingInfo[] = [];
    for (const t of topics.slice(0, 20)) {
      const subs = await this.requestJson<string[]>(
        `/admin/v2/persistent/${encodeURIComponent(tenant)}/${encodeURIComponent(namespace)}/${encodeURIComponent(t.name)}/subscriptions`,
      ).catch(() => []);
      for (const sub of Array.isArray(subs) ? subs : []) {
        bindings.push({
          source: t.name,
          destination: sub,
          destinationType: 'subscription',
          routingKey: sub,
          vhost: `${tenant}/${namespace}`,
        });
      }
    }
    return bindings;
  }

  async listNodes(): Promise<MqNodeInfo[]> {
    if (this._engine === 'rabbitmq') {
      const rows = await this.requestJson<
        Array<{
          name: string;
          type?: string;
          running?: boolean;
          mem_used?: number;
          fd_used?: number;
          uptime?: number;
        }>
      >('/api/nodes');
      return (Array.isArray(rows) ? rows : []).map((n) => ({
        name: n.name,
        type: n.type,
        running: n.running !== false,
        memUsedBytes: n.mem_used,
        fdUsed: n.fd_used,
        uptimeMs: n.uptime,
      }));
    }

    const brokers = await this.requestJson<string[]>('/admin/v2/brokers/active').catch(() => []);
    return (Array.isArray(brokers) ? brokers : []).map((b) => {
      const [host, portStr] = b.split(':');
      return {
        name: b,
        type: 'broker',
        running: true,
        host,
        port: portStr ? Number(portStr) : undefined,
      };
    });
  }

  async listConnections(): Promise<MqConnectionInfo[]> {
    if (this._engine !== 'rabbitmq') return [];
    const rows = await this.requestJson<
      Array<{
        name: string;
        user?: string;
        vhost?: string;
        state?: string;
        protocol?: string;
        peer_host?: string;
        channels?: number;
      }>
    >('/api/connections');
    return (Array.isArray(rows) ? rows : []).map((c) => ({
      name: c.name,
      user: c.user,
      vhost: c.vhost,
      state: c.state,
      protocol: c.protocol,
      peerHost: c.peer_host,
      channels: c.channels,
    }));
  }

  async listChannels(): Promise<MqChannelInfo[]> {
    if (this._engine !== 'rabbitmq') return [];
    const rows = await this.requestJson<
      Array<{
        name: string;
        connection_details?: { name?: string };
        user?: string;
        vhost?: string;
        state?: string;
        consumer_count?: number;
        messages_unacknowledged?: number;
      }>
    >('/api/channels');
    return (Array.isArray(rows) ? rows : []).map((ch) => ({
      name: ch.name,
      connectionName: ch.connection_details?.name,
      user: ch.user,
      vhost: ch.vhost,
      state: ch.state,
      consumerCount: ch.consumer_count,
      unackedCount: ch.messages_unacknowledged,
    }));
  }

  async listUsers(): Promise<MqUserInfo[]> {
    if (this._engine !== 'rabbitmq') return [];
    const [users, perms] = await Promise.all([
      this.requestJson<Array<{ name: string; tags?: string | string[] }>>('/api/users'),
      this.requestJson<
        Array<{ user: string; vhost: string; configure: string; write: string; read: string }>
      >('/api/permissions').catch(() => []),
    ]);
    return (Array.isArray(users) ? users : []).map((u) => {
      const tags = Array.isArray(u.tags)
        ? u.tags
        : typeof u.tags === 'string' && u.tags
          ? u.tags.split(',').map((s) => s.trim())
          : [];
      return {
        name: u.name,
        tags,
        permissions: (Array.isArray(perms) ? perms : [])
          .filter((p) => p.user === u.name)
          .map((p) => ({
            vhost: p.vhost,
            configure: p.configure,
            write: p.write,
            read: p.read,
          })),
      };
    });
  }

  async listPolicies(vhost?: string): Promise<MqPolicyInfo[]> {
    if (this._engine !== 'rabbitmq') return [];
    const path = vhost ? `/api/policies/${encodeURIComponent(vhost)}` : '/api/policies';
    const rows = await this.requestJson<
      Array<{
        name: string;
        vhost: string;
        pattern: string;
        'apply-to'?: string;
        priority?: number;
        definition?: Record<string, unknown>;
      }>
    >(path);
    return (Array.isArray(rows) ? rows : []).map((p) => ({
      name: p.name,
      vhost: p.vhost,
      pattern: p.pattern,
      applyTo: p['apply-to'],
      priority: p.priority,
      definition: p.definition,
    }));
  }

  /* --------------------------------------------------------------------------
   * Queue / Topic Lifecycle & Messaging
   * -------------------------------------------------------------------------- */

  async createQueue(name: string, options?: { vhost?: string; durable?: boolean }): Promise<void> {
    if (this._engine === 'rabbitmq') {
      const vhost = options?.vhost ?? this.config?.vhost ?? '/';
      await this.requestJson(
        `/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(name)}`,
        'PUT',
        { durable: options?.durable ?? true, auto_delete: false, arguments: {} },
      );
      return;
    }

    const { tenant, namespace } = parsePulsarNamespace(
      options?.vhost || this.config?.namespace,
      this.config?.org || 'public',
      'default',
    );
    await this.requestJson(
      `/admin/v2/persistent/${encodeURIComponent(tenant)}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
      'PUT',
    );
  }

  async deleteQueue(name: string, vhost?: string): Promise<void> {
    if (this._engine === 'rabbitmq') {
      const targetVhost = vhost ?? this.config?.vhost ?? '/';
      await this.requestJson(
        `/api/queues/${encodeURIComponent(targetVhost)}/${encodeURIComponent(name)}`,
        'DELETE',
      );
      return;
    }

    const { tenant, namespace } = parsePulsarNamespace(
      vhost || this.config?.namespace,
      this.config?.org || 'public',
      'default',
    );
    await this.requestJson(
      `/admin/v2/persistent/${encodeURIComponent(tenant)}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
      'DELETE',
    );
  }

  async purgeQueue(name: string, vhost?: string): Promise<void> {
    if (this._engine === 'rabbitmq') {
      const targetVhost = vhost ?? this.config?.vhost ?? '/';
      await this.requestJson(
        `/api/queues/${encodeURIComponent(targetVhost)}/${encodeURIComponent(name)}/contents`,
        'DELETE',
      );
    }
  }

  async publishMessage(
    target: string,
    payload: string,
    options?: { vhost?: string; exchange?: string; routingKey?: string; qos?: 0 | 1; retain?: boolean },
  ): Promise<{ routed: boolean }> {
    if (this._engine === 'rabbitmq') {
      const vhost = options?.vhost ?? this.config?.vhost ?? '/';
      const exchange = options?.exchange || 'amq.default';
      const routingKey = options?.routingKey ?? target;
      const res = await this.requestJson<{ routed?: boolean }>(
        `/api/exchanges/${encodeURIComponent(vhost)}/${encodeURIComponent(exchange)}/publish`,
        'POST',
        {
          properties: {},
          routing_key: routingKey,
          payload,
          payload_encoding: 'string',
        },
      );
      return { routed: res.routed !== false };
    }

    const { tenant, namespace } = parsePulsarNamespace(
      options?.vhost || this.config?.namespace,
      this.config?.org || 'public',
      'default',
    );
    await this.requestJson(
      `/topics/persistent/${encodeURIComponent(tenant)}/${encodeURIComponent(namespace)}/${encodeURIComponent(target)}`,
      'POST',
      { payload, key: options?.routingKey },
    );
    return { routed: true };
  }

  async getMessages(
    queueOrTopic: string,
    options?: { vhost?: string; count?: number; requeue?: boolean; timeoutMs?: number },
  ): Promise<MqMessage[]> {
    const count = Math.max(1, Math.min(200, options?.count ?? 10));

    if (this._engine === 'rabbitmq') {
      const vhost = options?.vhost ?? this.config?.vhost ?? '/';
      const ackmode = options?.requeue === false ? 'ack_requeue_false' : 'ack_requeue_true';
      const rows = await this.requestJson<
        Array<{
          payload?: string;
          routing_key?: string;
          exchange?: string;
          redelivered?: boolean;
          properties?: Record<string, unknown>;
        }>
      >(`/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(queueOrTopic)}/get`, 'POST', {
        count,
        ackmode,
        encoding: 'auto',
      });
      return (Array.isArray(rows) ? rows : []).map((m, idx) => ({
        id: String(m.properties?.message_id ?? idx + 1),
        topicOrQueue: queueOrTopic,
        routingKey: m.routing_key,
        payload: m.payload ?? '',
        headers: (m.properties?.headers as Record<string, unknown> | undefined) ?? m.properties,
        timestamp: typeof m.properties?.timestamp === 'number' ? m.properties.timestamp * 1000 : undefined,
        redelivered: Boolean(m.redelivered),
      }));
    }

    const { transport, config, endpoint } = this.requireConnected();
    const { tenant, namespace } = parsePulsarNamespace(
      options?.vhost || this.config?.namespace,
      this.config?.org || 'public',
      'default',
    );
    const messages: MqMessage[] = [];
    for (let pos = 1; pos <= Math.min(count, 10); pos++) {
      const resp = await sendHttpRequest(
        transport,
        endpoint,
        `/admin/v2/persistent/${encodeURIComponent(tenant)}/${encodeURIComponent(namespace)}/${encodeURIComponent(queueOrTopic)}/examinemessage?initialPosition=latest&messagePosition=${pos}`,
        {
          method: 'GET',
          headers: this.buildHeaders(),
          timeoutMs: options?.timeoutMs ?? config.timeoutMs ?? 15000,
        },
      );
      if (resp.status === 404 || resp.status === 204) break;
      if (resp.status >= 400) break;
      messages.push({
        id: resp.headers['x-pulsar-message-id'] || String(pos),
        topicOrQueue: queueOrTopic,
        payload: decodeResponseText(resp),
        headers: { ...resp.headers },
      });
    }
    return messages;
  }
}

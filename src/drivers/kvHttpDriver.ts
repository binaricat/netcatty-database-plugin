/**
 * Pure-TS Browser-Sandbox Registry / Config KV HTTP Driver (`family: 'kv'`).
 * Supports:
 * - etcd: v3 gRPC-Gateway HTTP JSON (KV, Members, Leases/Revoke, Maintenance Status, RBAC)
 * - etcd-v2: /v2/keys HTTP REST + /v2/members + /v2/stats/self
 * - consul: /v1/kv, /v1/catalog/services, /v1/health/state/any, /v1/session/list & destroy, /v1/acl/*
 * - nacos: /nacos/v1/auth/login, /nacos/v1/console/namespaces CRUD, /nacos/v1/cs/configs,
 *   /nacos/v1/cs/history, /nacos/v1/ns/service/list
 *
 * 100% browser-sandbox compatible (no Node imports, no dynamic code execution).
 */

import {
  decodeResponseJson,
  decodeResponseText,
  resolveHttpTls,
  sendHttpRequest,
  type HttpEndpointConfig,
} from './httpClient';
import {
  base64ToBytes,
  bytesToBase64,
  type ByteStreamTransport,
  type ConnectionConfig,
  type ConnectionInfo,
  type DatabaseEngineId,
  type KvConfigHistoryEntry,
  type KvDriver,
  type KvEntry,
  type KvLeaseInfo,
  type KvMemberInfo,
  type KvNamespaceInfo,
  type KvServiceInfo,
  type TestConnectionResult,
} from './types';

export type KvEngineId = 'etcd' | 'etcd-v2' | 'consul' | 'nacos';

export interface ConsulHealthCheckInfo {
  checkId: string;
  name: string;
  status: string;
  node: string;
  serviceName?: string;
  output?: string;
}

export interface ConsulSessionInfo {
  id: string;
  name?: string;
  node?: string;
  behavior?: string;
  ttl?: string;
  createIndex?: number;
}

export interface KvDiffLine {
  kind: 'same' | 'add' | 'remove';
  text: string;
}

export interface EtcdV2Node {
  key?: string;
  value?: string;
  dir?: boolean;
  modifiedIndex?: number;
  createdIndex?: number;
  ttl?: number;
  nodes?: EtcdV2Node[];
}

/**
 * Simple line-level diff helper for Nacos config history comparison.
 */
export function computeSimpleLineDiff(beforeText: string, afterText: string): KvDiffLine[] {
  const a = beforeText.split(/\r?\n/);
  const b = afterText.split(/\r?\n/);
  const out: KvDiffLine[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const left = a[i];
    const right = b[i];
    if (left === right && left !== undefined) {
      out.push({ kind: 'same', text: left });
    } else {
      if (left !== undefined) out.push({ kind: 'remove', text: left });
      if (right !== undefined) out.push({ kind: 'add', text: right });
    }
  }
  return out;
}

export function flattenEtcdV2Nodes(node: EtcdV2Node | undefined, out: KvEntry[] = []): KvEntry[] {
  if (!node) return out;
  if (!node.dir && node.key !== undefined) {
    out.push({
      key: node.key,
      value: node.value ?? '',
      revision: node.modifiedIndex,
    });
  }
  if (Array.isArray(node.nodes)) {
    for (const child of node.nodes) {
      flattenEtcdV2Nodes(child, out);
    }
  }
  return out;
}

const te = new TextEncoder();
const td = new TextDecoder('utf-8');

const DEFAULT_PORTS: Record<KvEngineId, number> = {
  etcd: 2379,
  'etcd-v2': 2379,
  consul: 8500,
  nacos: 8848,
};

function normalizeKvEngine(engine: string): KvEngineId {
  switch (engine) {
    case 'etcd':
    case 'etcd-v2':
    case 'consul':
    case 'nacos':
      return engine;
    default:
      throw new Error(`Unsupported KV engine: ${engine}`);
  }
}

function utf8ToBase64(text: string): string {
  return bytesToBase64(te.encode(text));
}

function base64ToUtf8(b64: string): string {
  if (!b64) return '';
  return td.decode(base64ToBytes(b64));
}

/**
 * Compute etcd v3 prefix range_end bytes (increment last byte < 0xff; if all 0xff return [0]).
 */
export function computeEtcdPrefixRangeEnd(prefix: string): string {
  if (!prefix) {
    return bytesToBase64(new Uint8Array([0]));
  }
  const bytes = te.encode(prefix);
  const end = new Uint8Array(bytes);
  for (let i = end.length - 1; i >= 0; i--) {
    if (end[i] < 0xff) {
      end[i] += 1;
      return bytesToBase64(end.subarray(0, i + 1));
    }
  }
  return bytesToBase64(new Uint8Array([0]));
}

function encodeKeyPath(key: string): string {
  return key
    .replace(/^\/+/, '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

export class KvHttpDriver implements KvDriver {
  private _engine: KvEngineId;
  readonly family = 'kv' as const;

  private transport: ByteStreamTransport | null = null;
  private config: ConnectionConfig | null = null;
  private endpoint: HttpEndpointConfig | null = null;
  private _connected = false;
  private _serverVersion = '';
  private _tlsActive = false;
  private etcdAuthToken: string | null = null;
  private nacosAccessToken: string | null = null;

  constructor(engine: DatabaseEngineId = 'etcd') {
    this._engine = normalizeKvEngine(engine);
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

  private buildEtcdHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const token = this.etcdAuthToken || this.config?.apiKey;
    if (token) {
      headers['Authorization'] = token;
    }
    return headers;
  }

  private buildConsulHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const token = this.config?.apiKey || this.config?.password;
    if (token) {
      headers['X-Consul-Token'] = token;
    }
    return headers;
  }

  private nacosTokenQuery(params: URLSearchParams): void {
    const token = this.nacosAccessToken || this.config?.apiKey;
    if (token) {
      params.set('accessToken', token);
    }
  }

  async connect(config: ConnectionConfig, transport: ByteStreamTransport): Promise<ConnectionInfo> {
    const started = performance.now();
    this._engine = normalizeKvEngine(config.engine);
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
    this.etcdAuthToken = null;
    this.nacosAccessToken = null;
    this._connected = true;

    try {
      await this.authenticateIfNeeded();
      this._serverVersion = await this.probeVersion();
      return {
        engine: this._engine,
        family: 'kv',
        serverVersion: this._serverVersion,
        database: config.namespace || config.database || 'default',
        tlsActive: this._tlsActive,
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      this._connected = false;
      throw err;
    }
  }

  private async authenticateIfNeeded(): Promise<void> {
    const { transport, config, endpoint } = this.requireConnected();

    if (this._engine === 'etcd' && config.username && config.password) {
      const resp = await sendHttpRequest(transport, endpoint, '/v3/auth/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: config.username, password: config.password }),
        timeoutMs: config.timeoutMs ?? 15000,
      });
      if (resp.status >= 200 && resp.status < 300) {
        const parsed = decodeResponseJson<{ token?: string }>(resp);
        if (parsed.token) this.etcdAuthToken = parsed.token;
      }
    }

    if (this._engine === 'nacos' && config.username && config.password) {
      const form = new URLSearchParams();
      form.set('username', config.username);
      form.set('password', config.password);
      const resp = await sendHttpRequest(transport, endpoint, '/nacos/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        timeoutMs: config.timeoutMs ?? 15000,
      });
      if (resp.status >= 400) {
        throw new Error(decodeResponseText(resp).trim() || `Nacos login HTTP ${resp.status}`);
      }
      const parsed = decodeResponseJson<{ accessToken?: string }>(resp);
      if (parsed.accessToken) this.nacosAccessToken = parsed.accessToken;
    }
  }

  private async probeVersion(): Promise<string> {
    const { transport, config, endpoint } = this.requireConnected();

    switch (this._engine) {
      case 'etcd': {
        const verResp = await sendHttpRequest(transport, endpoint, '/version', {
          method: 'GET',
          headers: this.buildEtcdHeaders(),
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (verResp.status >= 200 && verResp.status < 300) {
          const data = decodeResponseJson<{ etcdserver?: string; etcdcluster?: string }>(verResp);
          if (data.etcdserver) return `etcd ${data.etcdserver}`;
        }
        const statusResp = await sendHttpRequest(transport, endpoint, '/v3/maintenance/status', {
          method: 'POST',
          headers: this.buildEtcdHeaders(),
          body: '{}',
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (statusResp.status >= 400) {
          throw new Error(decodeResponseText(statusResp).trim() || `etcd HTTP ${statusResp.status}`);
        }
        const statusData = decodeResponseJson<{ version?: string }>(statusResp);
        return statusData.version ? `etcd ${statusData.version}` : 'etcd v3';
      }

      case 'etcd-v2': {
        const verResp = await sendHttpRequest(transport, endpoint, '/version', {
          method: 'GET',
          headers: this.buildEtcdHeaders(),
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (verResp.status >= 200 && verResp.status < 300) {
          const data = decodeResponseJson<{ etcdserver?: string }>(verResp);
          return data.etcdserver ? `etcd v2 (${data.etcdserver})` : 'etcd v2';
        }
        const keysResp = await sendHttpRequest(transport, endpoint, '/v2/keys/', {
          method: 'GET',
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (keysResp.status >= 400) {
          throw new Error(decodeResponseText(keysResp).trim() || `etcd v2 HTTP ${keysResp.status}`);
        }
        return 'etcd v2';
      }

      case 'consul': {
        const selfResp = await sendHttpRequest(transport, endpoint, '/v1/agent/self', {
          method: 'GET',
          headers: this.buildConsulHeaders(),
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (selfResp.status >= 200 && selfResp.status < 300) {
          const data = decodeResponseJson<{
            Config?: { Version?: string };
            Member?: { Tags?: { build?: string } };
          }>(selfResp);
          const v = data.Config?.Version || data.Member?.Tags?.build;
          return v ? `Consul ${v}` : 'Consul';
        }
        const leaderResp = await sendHttpRequest(transport, endpoint, '/v1/status/leader', {
          method: 'GET',
          headers: this.buildConsulHeaders(),
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (leaderResp.status >= 400) {
          throw new Error(
            decodeResponseText(leaderResp).trim() || `Consul HTTP ${leaderResp.status}`,
          );
        }
        return 'Consul';
      }

      case 'nacos': {
        const params = new URLSearchParams();
        this.nacosTokenQuery(params);
        const q = params.toString() ? `?${params.toString()}` : '';
        const stateResp = await sendHttpRequest(
          transport,
          endpoint,
          `/nacos/v1/console/server/state${q}`,
          {
            method: 'GET',
            timeoutMs: config.timeoutMs ?? 15000,
          },
        );
        if (stateResp.status >= 200 && stateResp.status < 300) {
          const data = decodeResponseJson<{ version?: string }>(stateResp);
          if (data.version) return `Nacos ${data.version}`;
        }
        const nsResp = await sendHttpRequest(
          transport,
          endpoint,
          `/nacos/v1/console/namespaces${q}`,
          {
            method: 'GET',
            timeoutMs: config.timeoutMs ?? 15000,
          },
        );
        if (nsResp.status >= 400) {
          throw new Error(decodeResponseText(nsResp).trim() || `Nacos HTTP ${nsResp.status}`);
        }
        return 'Nacos';
      }
    }
  }

  async testConnection(): Promise<TestConnectionResult> {
    const started = performance.now();
    try {
      const ver = await this.probeVersion();
      this._serverVersion = ver;
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
    this.etcdAuthToken = null;
    this.nacosAccessToken = null;
  }

  /* --------------------------------------------------------------------------
   * Namespaces & Keys Operations
   * -------------------------------------------------------------------------- */

  async listNamespaces(): Promise<KvNamespaceInfo[]> {
    const { transport, config, endpoint } = this.requireConnected();

    switch (this._engine) {
      case 'etcd':
      case 'etcd-v2':
        return [{ id: 'default', name: 'default' }];

      case 'consul': {
        const resp = await sendHttpRequest(transport, endpoint, '/v1/namespaces', {
          method: 'GET',
          headers: this.buildConsulHeaders(),
          timeoutMs: config.timeoutMs ?? 15000,
        }).catch(() => null);
        if (resp && resp.status >= 200 && resp.status < 300) {
          const parsed = decodeResponseJson<Array<{ Name: string }>>(resp);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed.map((n) => ({ id: n.Name, name: n.Name }));
          }
        }
        const defNs = config.namespace || 'default';
        return [{ id: defNs, name: defNs }];
      }

      case 'nacos': {
        const params = new URLSearchParams();
        this.nacosTokenQuery(params);
        const q = params.toString() ? `?${params.toString()}` : '';
        const resp = await sendHttpRequest(
          transport,
          endpoint,
          `/nacos/v1/console/namespaces${q}`,
          {
            method: 'GET',
            timeoutMs: config.timeoutMs ?? 15000,
          },
        );
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `Nacos HTTP ${resp.status}`);
        }
        const parsed = decodeResponseJson<{
          data?: Array<{
            namespace?: string;
            namespaceShowName?: string;
            configCount?: number;
          }>;
        }>(resp);
        return (parsed.data ?? []).map((ns) => ({
          id: ns.namespace ?? '',
          name: ns.namespaceShowName || ns.namespace || 'public',
          count: ns.configCount,
        }));
      }
    }
  }

  async listKeys(
    prefix = '',
    options?: { namespace?: string; group?: string; limit?: number },
  ): Promise<KvEntry[]> {
    const { transport, config, endpoint } = this.requireConnected();

    switch (this._engine) {
      case 'etcd': {
        const body: Record<string, unknown> = {
          key: prefix ? utf8ToBase64(prefix) : bytesToBase64(new Uint8Array([0])),
          range_end: computeEtcdPrefixRangeEnd(prefix),
        };
        if (options?.limit) body.limit = options.limit;

        const resp = await sendHttpRequest(transport, endpoint, '/v3/kv/range', {
          method: 'POST',
          headers: this.buildEtcdHeaders(),
          body: JSON.stringify(body),
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `etcd range HTTP ${resp.status}`);
        }
        const parsed = decodeResponseJson<{
          kvs?: Array<{
            key: string;
            value?: string;
            version?: string | number;
            mod_revision?: string | number;
            lease?: string;
          }>;
        }>(resp);
        return (parsed.kvs ?? []).map((kv) => ({
          key: base64ToUtf8(kv.key),
          value: kv.value ? base64ToUtf8(kv.value) : '',
          version: kv.version !== undefined ? Number(kv.version) : undefined,
          revision: kv.mod_revision !== undefined ? Number(kv.mod_revision) : undefined,
          lease: kv.lease,
        }));
      }

      case 'etcd-v2': {
        const cleanPrefix = prefix ? encodeKeyPath(prefix) : '';
        const path = cleanPrefix ? `/v2/keys/${cleanPrefix}?recursive=true` : '/v2/keys/?recursive=true';
        const resp = await sendHttpRequest(transport, endpoint, path, {
          method: 'GET',
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (resp.status === 404) return [];
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `etcd v2 list HTTP ${resp.status}`);
        }
        const parsed = decodeResponseJson<{ node?: EtcdV2Node }>(resp);
        const all = flattenEtcdV2Nodes(parsed.node);
        return options?.limit ? all.slice(0, options.limit) : all;
      }

      case 'consul': {
        const encodedPrefix = prefix ? encodeKeyPath(prefix) : '';
        const params = new URLSearchParams();
        params.set('keys', '');
        const ns = options?.namespace || config.namespace;
        if (ns) params.set('ns', ns);
        const query = params.toString().replace('keys=', 'keys');
        const path = `/v1/kv/${encodedPrefix}?${query}`;

        const resp = await sendHttpRequest(transport, endpoint, path, {
          method: 'GET',
          headers: this.buildConsulHeaders(),
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (resp.status === 404) return [];
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `Consul list HTTP ${resp.status}`);
        }
        const parsed = decodeResponseJson<
          Array<string | { Key: string; Value?: string | null; ModifyIndex?: number; Flags?: number }>
        >(resp);
        const list = Array.isArray(parsed) ? parsed : [];
        const limited = options?.limit ? list.slice(0, options.limit) : list;
        return limited.map((item) => {
          if (typeof item === 'string') {
            return { key: item, value: '' };
          }
          return {
            key: item.Key,
            value: item.Value ? base64ToUtf8(item.Value) : '',
            revision: item.ModifyIndex,
            flags: item.Flags,
          };
        });
      }

      case 'nacos': {
        const params = new URLSearchParams();
        params.set('dataId', prefix ? `*${prefix}*` : '');
        params.set('group', options?.group || '');
        params.set('search', 'blur');
        params.set('pageNo', '1');
        params.set('pageSize', String(options?.limit ?? 100));
        const ns = options?.namespace ?? config.namespace ?? '';
        if (ns) params.set('tenant', ns);
        this.nacosTokenQuery(params);

        const resp = await sendHttpRequest(
          transport,
          endpoint,
          `/nacos/v1/cs/configs?${params.toString()}`,
          {
            method: 'GET',
            timeoutMs: config.timeoutMs ?? 15000,
          },
        );
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `Nacos list HTTP ${resp.status}`);
        }
        const parsed = decodeResponseJson<{
          pageItems?: Array<{
            dataId: string;
            group?: string;
            content?: string;
            type?: string;
          }>;
        }>(resp);
        return (parsed.pageItems ?? []).map((item) => ({
          key: item.dataId,
          value: item.content ?? '',
          group: item.group || 'DEFAULT_GROUP',
          format: item.type,
        }));
      }
    }
  }

  async getKey(
    key: string,
    options?: { namespace?: string; group?: string },
  ): Promise<KvEntry | null> {
    const { transport, config, endpoint } = this.requireConnected();

    switch (this._engine) {
      case 'etcd': {
        const resp = await sendHttpRequest(transport, endpoint, '/v3/kv/range', {
          method: 'POST',
          headers: this.buildEtcdHeaders(),
          body: JSON.stringify({ key: utf8ToBase64(key) }),
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `etcd get HTTP ${resp.status}`);
        }
        const parsed = decodeResponseJson<{
          kvs?: Array<{
            key: string;
            value?: string;
            version?: string | number;
            mod_revision?: string | number;
            lease?: string;
          }>;
        }>(resp);
        const first = parsed.kvs?.[0];
        if (!first) return null;
        return {
          key: base64ToUtf8(first.key),
          value: first.value ? base64ToUtf8(first.value) : '',
          version: first.version !== undefined ? Number(first.version) : undefined,
          revision: first.mod_revision !== undefined ? Number(first.mod_revision) : undefined,
          lease: first.lease,
        };
      }

      case 'etcd-v2': {
        const resp = await sendHttpRequest(
          transport,
          endpoint,
          `/v2/keys/${encodeKeyPath(key)}`,
          {
            method: 'GET',
            timeoutMs: config.timeoutMs ?? 15000,
          },
        );
        if (resp.status === 404) return null;
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `etcd v2 get HTTP ${resp.status}`);
        }
        const parsed = decodeResponseJson<{ node?: EtcdV2Node }>(resp);
        if (!parsed.node || parsed.node.dir) return null;
        return {
          key: parsed.node.key ?? key,
          value: parsed.node.value ?? '',
          revision: parsed.node.modifiedIndex,
        };
      }

      case 'consul': {
        const ns = options?.namespace || config.namespace;
        const query = ns ? `?ns=${encodeURIComponent(ns)}` : '';
        const resp = await sendHttpRequest(
          transport,
          endpoint,
          `/v1/kv/${encodeKeyPath(key)}${query}`,
          {
            method: 'GET',
            headers: this.buildConsulHeaders(),
            timeoutMs: config.timeoutMs ?? 15000,
          },
        );
        if (resp.status === 404) return null;
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `Consul get HTTP ${resp.status}`);
        }
        const parsed = decodeResponseJson<
          Array<{ Key: string; Value?: string | null; ModifyIndex?: number; Flags?: number }>
        >(resp);
        const first = Array.isArray(parsed) ? parsed[0] : undefined;
        if (!first) return null;
        return {
          key: first.Key,
          value: first.Value ? base64ToUtf8(first.Value) : '',
          revision: first.ModifyIndex,
          flags: first.Flags,
        };
      }

      case 'nacos': {
        const group = options?.group || 'DEFAULT_GROUP';
        const params = new URLSearchParams();
        params.set('dataId', key);
        params.set('group', group);
        const ns = options?.namespace ?? config.namespace ?? '';
        if (ns) params.set('tenant', ns);
        this.nacosTokenQuery(params);

        const resp = await sendHttpRequest(
          transport,
          endpoint,
          `/nacos/v1/cs/configs?${params.toString()}`,
          {
            method: 'GET',
            timeoutMs: config.timeoutMs ?? 15000,
          },
        );
        if (resp.status === 404) return null;
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `Nacos get HTTP ${resp.status}`);
        }
        return {
          key,
          value: decodeResponseText(resp),
          group,
          format: resp.headers['config-type'] || undefined,
        };
      }
    }
  }

  async putKey(
    key: string,
    value: string,
    options?: { namespace?: string; group?: string; format?: string },
  ): Promise<void> {
    const { transport, config, endpoint } = this.requireConnected();

    switch (this._engine) {
      case 'etcd': {
        const resp = await sendHttpRequest(transport, endpoint, '/v3/kv/put', {
          method: 'POST',
          headers: this.buildEtcdHeaders(),
          body: JSON.stringify({
            key: utf8ToBase64(key),
            value: utf8ToBase64(value),
          }),
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `etcd put HTTP ${resp.status}`);
        }
        return;
      }

      case 'etcd-v2': {
        const form = new URLSearchParams();
        form.set('value', value);
        const resp = await sendHttpRequest(
          transport,
          endpoint,
          `/v2/keys/${encodeKeyPath(key)}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
            timeoutMs: config.timeoutMs ?? 15000,
          },
        );
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `etcd v2 put HTTP ${resp.status}`);
        }
        return;
      }

      case 'consul': {
        const ns = options?.namespace || config.namespace;
        const query = ns ? `?ns=${encodeURIComponent(ns)}` : '';
        const resp = await sendHttpRequest(
          transport,
          endpoint,
          `/v1/kv/${encodeKeyPath(key)}${query}`,
          {
            method: 'PUT',
            headers: {
              ...this.buildConsulHeaders(),
              'Content-Type': 'text/plain; charset=utf-8',
            },
            body: value,
            timeoutMs: config.timeoutMs ?? 15000,
          },
        );
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `Consul put HTTP ${resp.status}`);
        }
        return;
      }

      case 'nacos': {
        const form = new URLSearchParams();
        form.set('dataId', key);
        form.set('group', options?.group || 'DEFAULT_GROUP');
        form.set('content', value);
        const ns = options?.namespace ?? config.namespace ?? '';
        if (ns) form.set('tenant', ns);
        if (options?.format) form.set('type', options.format);
        this.nacosTokenQuery(form);

        const resp = await sendHttpRequest(transport, endpoint, '/nacos/v1/cs/configs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `Nacos publish HTTP ${resp.status}`);
        }
        return;
      }
    }
  }

  async deleteKey(
    key: string,
    options?: { namespace?: string; group?: string },
  ): Promise<void> {
    const { transport, config, endpoint } = this.requireConnected();

    switch (this._engine) {
      case 'etcd': {
        const resp = await sendHttpRequest(transport, endpoint, '/v3/kv/deleterange', {
          method: 'POST',
          headers: this.buildEtcdHeaders(),
          body: JSON.stringify({ key: utf8ToBase64(key) }),
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `etcd delete HTTP ${resp.status}`);
        }
        return;
      }

      case 'etcd-v2': {
        const resp = await sendHttpRequest(
          transport,
          endpoint,
          `/v2/keys/${encodeKeyPath(key)}`,
          {
            method: 'DELETE',
            timeoutMs: config.timeoutMs ?? 15000,
          },
        );
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `etcd v2 delete HTTP ${resp.status}`);
        }
        return;
      }

      case 'consul': {
        const ns = options?.namespace || config.namespace;
        const query = ns ? `?ns=${encodeURIComponent(ns)}` : '';
        const resp = await sendHttpRequest(
          transport,
          endpoint,
          `/v1/kv/${encodeKeyPath(key)}${query}`,
          {
            method: 'DELETE',
            headers: this.buildConsulHeaders(),
            timeoutMs: config.timeoutMs ?? 15000,
          },
        );
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `Consul delete HTTP ${resp.status}`);
        }
        return;
      }

      case 'nacos': {
        const params = new URLSearchParams();
        params.set('dataId', key);
        params.set('group', options?.group || 'DEFAULT_GROUP');
        const ns = options?.namespace ?? config.namespace ?? '';
        if (ns) params.set('tenant', ns);
        this.nacosTokenQuery(params);

        const resp = await sendHttpRequest(
          transport,
          endpoint,
          `/nacos/v1/cs/configs?${params.toString()}`,
          {
            method: 'DELETE',
            timeoutMs: config.timeoutMs ?? 15000,
          },
        );
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `Nacos delete HTTP ${resp.status}`);
        }
        return;
      }
    }
  }

  /* --------------------------------------------------------------------------
   * Specialist Admin Operations (etcd v3/v2, Consul, Nacos)
   * -------------------------------------------------------------------------- */

  async getClusterStatus(): Promise<Record<string, unknown>> {
    const { transport, config, endpoint } = this.requireConnected();
    if (this._engine === 'etcd') {
      const resp = await sendHttpRequest(transport, endpoint, '/v3/maintenance/status', {
        method: 'POST',
        headers: this.buildEtcdHeaders(),
        body: '{}',
        timeoutMs: config.timeoutMs ?? 15000,
      });
      if (resp.status >= 400) {
        throw new Error(decodeResponseText(resp).trim() || `etcd status HTTP ${resp.status}`);
      }
      return decodeResponseJson<Record<string, unknown>>(resp);
    }
    if (this._engine === 'etcd-v2') {
      const resp = await sendHttpRequest(transport, endpoint, '/v2/stats/self', {
        method: 'GET',
        timeoutMs: config.timeoutMs ?? 15000,
      });
      if (resp.status >= 400) return { engine: 'etcd-v2', status: 'ok' };
      return decodeResponseJson<Record<string, unknown>>(resp);
    }
    if (this._engine === 'consul') {
      const [leaderResp, peersResp] = await Promise.all([
        sendHttpRequest(transport, endpoint, '/v1/status/leader', {
          method: 'GET',
          headers: this.buildConsulHeaders(),
          timeoutMs: config.timeoutMs ?? 15000,
        }),
        sendHttpRequest(transport, endpoint, '/v1/status/peers', {
          method: 'GET',
          headers: this.buildConsulHeaders(),
          timeoutMs: config.timeoutMs ?? 15000,
        }).catch(() => null),
      ]);
      const leader = decodeResponseText(leaderResp).trim().replace(/^"|"$/g, '');
      const peers =
        peersResp && peersResp.status < 400 ? decodeResponseJson<string[]>(peersResp) : [];
      return { leader, peers };
    }
    const params = new URLSearchParams();
    this.nacosTokenQuery(params);
    const q = params.toString() ? `?${params.toString()}` : '';
    const resp = await sendHttpRequest(transport, endpoint, `/nacos/v1/console/server/state${q}`, {
      method: 'GET',
      timeoutMs: config.timeoutMs ?? 15000,
    });
    if (resp.status >= 400) return { engine: 'nacos', status: 'ok' };
    return decodeResponseJson<Record<string, unknown>>(resp);
  }

  async listMembers(): Promise<KvMemberInfo[]> {
    const { transport, config, endpoint } = this.requireConnected();
    if (this._engine === 'etcd') {
      const resp = await sendHttpRequest(transport, endpoint, '/v3/cluster/member/list', {
        method: 'POST',
        headers: this.buildEtcdHeaders(),
        body: '{}',
        timeoutMs: config.timeoutMs ?? 15000,
      });
      if (resp.status >= 400) {
        throw new Error(decodeResponseText(resp).trim() || `etcd members HTTP ${resp.status}`);
      }
      const parsed = decodeResponseJson<{
        members?: Array<{
          ID?: string;
          name?: string;
          peerURLs?: string[];
          clientURLs?: string[];
          isLearner?: boolean;
        }>;
      }>(resp);
      return (parsed.members ?? []).map((m) => ({
        id: String(m.ID ?? ''),
        name: m.name || String(m.ID ?? ''),
        peerUrls: m.peerURLs,
        clientUrls: m.clientURLs,
        status: m.isLearner ? 'learner' : 'voter',
      }));
    }
    if (this._engine === 'etcd-v2') {
      const resp = await sendHttpRequest(transport, endpoint, '/v2/members', {
        method: 'GET',
        timeoutMs: config.timeoutMs ?? 15000,
      });
      if (resp.status >= 400) {
        throw new Error(decodeResponseText(resp).trim() || `etcd v2 members HTTP ${resp.status}`);
      }
      const parsed = decodeResponseJson<{
        members?: Array<{ id: string; name: string; peerURLs?: string[]; clientURLs?: string[] }>;
      }>(resp);
      return (parsed.members ?? []).map((m) => ({
        id: m.id,
        name: m.name || m.id,
        peerUrls: m.peerURLs,
        clientUrls: m.clientURLs,
      }));
    }
    if (this._engine === 'consul') {
      const resp = await sendHttpRequest(transport, endpoint, '/v1/agent/members', {
        method: 'GET',
        headers: this.buildConsulHeaders(),
        timeoutMs: config.timeoutMs ?? 15000,
      });
      if (resp.status >= 400) return [];
      const list = decodeResponseJson<
        Array<{ Name: string; Addr?: string; Port?: number; Status?: number }>
      >(resp);
      return (Array.isArray(list) ? list : []).map((m) => ({
        id: m.Name,
        name: m.Name,
        clientUrls: m.Addr ? [`${m.Addr}:${m.Port ?? 8301}`] : undefined,
        status: m.Status === 1 ? 'alive' : String(m.Status ?? ''),
      }));
    }
    return [];
  }

  async listLeases(): Promise<KvLeaseInfo[]> {
    const { transport, config, endpoint } = this.requireConnected();
    if (this._engine !== 'etcd') return [];
    const resp = await sendHttpRequest(transport, endpoint, '/v3/lease/leases', {
      method: 'POST',
      headers: this.buildEtcdHeaders(),
      body: '{}',
      timeoutMs: config.timeoutMs ?? 15000,
    });
    if (resp.status >= 400) {
      throw new Error(decodeResponseText(resp).trim() || `etcd leases HTTP ${resp.status}`);
    }
    const parsed = decodeResponseJson<{ leases?: Array<{ ID?: string | number }> }>(resp);
    const leases = parsed.leases ?? [];
    const detailed: KvLeaseInfo[] = [];
    for (const item of leases.slice(0, 50)) {
      const id = String(item.ID ?? '');
      if (!id) continue;
      try {
        const ttlResp = await sendHttpRequest(transport, endpoint, '/v3/lease/timetolive', {
          method: 'POST',
          headers: this.buildEtcdHeaders(),
          body: JSON.stringify({ ID: id, keys: true }),
          timeoutMs: config.timeoutMs ?? 10000,
        });
        if (ttlResp.status < 400) {
          const ttlData = decodeResponseJson<{
            TTL?: string | number;
            grantedTTL?: string | number;
            keys?: string[];
          }>(ttlResp);
          detailed.push({
            id,
            ttlSeconds: ttlData.TTL !== undefined ? Number(ttlData.TTL) : undefined,
            grantedTtlSeconds:
              ttlData.grantedTTL !== undefined ? Number(ttlData.grantedTTL) : undefined,
            keys: Array.isArray(ttlData.keys) ? ttlData.keys.map((k) => base64ToUtf8(k)) : [],
          });
          continue;
        }
      } catch {
        // fallback to ID only
      }
      detailed.push({ id });
    }
    return detailed;
  }

  async revokeLease(id: string): Promise<void> {
    const { transport, config, endpoint } = this.requireConnected();
    if (this._engine !== 'etcd') {
      throw new Error('Lease revocation is only supported on etcd v3');
    }
    const resp = await sendHttpRequest(transport, endpoint, '/v3/lease/revoke', {
      method: 'POST',
      headers: this.buildEtcdHeaders(),
      body: JSON.stringify({ ID: id }),
      timeoutMs: config.timeoutMs ?? 15000,
    });
    if (resp.status >= 400) {
      throw new Error(decodeResponseText(resp).trim() || `etcd revoke HTTP ${resp.status}`);
    }
  }

  async listEtcdRbac(): Promise<{ users: string[]; roles: string[] }> {
    const { transport, config, endpoint } = this.requireConnected();
    if (this._engine !== 'etcd') return { users: [], roles: [] };
    const [uResp, rResp] = await Promise.all([
      sendHttpRequest(transport, endpoint, '/v3/auth/user/list', {
        method: 'POST',
        headers: this.buildEtcdHeaders(),
        body: '{}',
        timeoutMs: config.timeoutMs ?? 15000,
      }),
      sendHttpRequest(transport, endpoint, '/v3/auth/role/list', {
        method: 'POST',
        headers: this.buildEtcdHeaders(),
        body: '{}',
        timeoutMs: config.timeoutMs ?? 15000,
      }),
    ]);
    const users =
      uResp.status < 400 ? decodeResponseJson<{ users?: string[] }>(uResp).users ?? [] : [];
    const roles =
      rResp.status < 400 ? decodeResponseJson<{ roles?: string[] }>(rResp).roles ?? [] : [];
    return { users, roles };
  }

  async manageEtcdRbac(
    action: 'user_add' | 'user_delete' | 'role_add' | 'role_delete',
    name: string,
    password?: string,
  ): Promise<void> {
    const { transport, config, endpoint } = this.requireConnected();
    if (this._engine !== 'etcd') throw new Error('RBAC management requires etcd v3');
    const pathMap = {
      user_add: '/v3/auth/user/add',
      user_delete: '/v3/auth/user/delete',
      role_add: '/v3/auth/role/add',
      role_delete: '/v3/auth/role/delete',
    };
    const body = action === 'user_add' ? { name, password: password ?? '' } : { name };
    const resp = await sendHttpRequest(transport, endpoint, pathMap[action], {
      method: 'POST',
      headers: this.buildEtcdHeaders(),
      body: JSON.stringify(body),
      timeoutMs: config.timeoutMs ?? 15000,
    });
    if (resp.status >= 400) {
      throw new Error(decodeResponseText(resp).trim() || `etcd RBAC ${action} HTTP ${resp.status}`);
    }
  }

  async listServices(options?: { namespace?: string; group?: string }): Promise<KvServiceInfo[]> {
    const { transport, config, endpoint } = this.requireConnected();
    if (this._engine === 'consul') {
      const ns = options?.namespace || config.namespace;
      const query = ns ? `?ns=${encodeURIComponent(ns)}` : '';
      const resp = await sendHttpRequest(transport, endpoint, `/v1/catalog/services${query}`, {
        method: 'GET',
        headers: this.buildConsulHeaders(),
        timeoutMs: config.timeoutMs ?? 15000,
      });
      if (resp.status >= 400) {
        throw new Error(decodeResponseText(resp).trim() || `Consul services HTTP ${resp.status}`);
      }
      const parsed = decodeResponseJson<Record<string, string[]>>(resp);
      return Object.entries(parsed).map(([name, tags]) => ({
        name,
        namespace: ns,
        tags: Array.isArray(tags) ? tags : [],
        status: 'registered',
      }));
    }
    if (this._engine === 'nacos') {
      const params = new URLSearchParams();
      params.set('pageNo', '1');
      params.set('pageSize', '100');
      const ns = options?.namespace ?? config.namespace ?? '';
      if (ns) params.set('namespaceId', ns);
      if (options?.group) params.set('groupName', options.group);
      this.nacosTokenQuery(params);
      const resp = await sendHttpRequest(
        transport,
        endpoint,
        `/nacos/v1/ns/service/list?${params.toString()}`,
        {
          method: 'GET',
          timeoutMs: config.timeoutMs ?? 15000,
        },
      );
      if (resp.status >= 400) {
        throw new Error(decodeResponseText(resp).trim() || `Nacos services HTTP ${resp.status}`);
      }
      const parsed = decodeResponseJson<{ doms?: string[]; count?: number }>(resp);
      return (parsed.doms ?? []).map((name) => ({
        name,
        namespace: ns || 'public',
        group: options?.group || 'DEFAULT_GROUP',
      }));
    }
    return [];
  }

  async listConsulHealthChecks(): Promise<ConsulHealthCheckInfo[]> {
    const { transport, config, endpoint } = this.requireConnected();
    if (this._engine !== 'consul') return [];
    const resp = await sendHttpRequest(transport, endpoint, '/v1/health/state/any', {
      method: 'GET',
      headers: this.buildConsulHeaders(),
      timeoutMs: config.timeoutMs ?? 15000,
    });
    if (resp.status >= 400) {
      throw new Error(decodeResponseText(resp).trim() || `Consul health HTTP ${resp.status}`);
    }
    const list = decodeResponseJson<
      Array<{
        CheckID: string;
        Name: string;
        Status: string;
        Node: string;
        ServiceName?: string;
        Output?: string;
      }>
    >(resp);
    return (Array.isArray(list) ? list : []).map((c) => ({
      checkId: c.CheckID,
      name: c.Name,
      status: c.Status,
      node: c.Node,
      serviceName: c.ServiceName,
      output: c.Output,
    }));
  }

  async listConsulSessions(): Promise<ConsulSessionInfo[]> {
    const { transport, config, endpoint } = this.requireConnected();
    if (this._engine !== 'consul') return [];
    const resp = await sendHttpRequest(transport, endpoint, '/v1/session/list', {
      method: 'GET',
      headers: this.buildConsulHeaders(),
      timeoutMs: config.timeoutMs ?? 15000,
    });
    if (resp.status >= 400) {
      throw new Error(decodeResponseText(resp).trim() || `Consul sessions HTTP ${resp.status}`);
    }
    const list = decodeResponseJson<
      Array<{
        ID: string;
        Name?: string;
        Node?: string;
        Behavior?: string;
        TTL?: string;
        CreateIndex?: number;
      }>
    >(resp);
    return (Array.isArray(list) ? list : []).map((s) => ({
      id: s.ID,
      name: s.Name,
      node: s.Node,
      behavior: s.Behavior,
      ttl: s.TTL,
      createIndex: s.CreateIndex,
    }));
  }

  async destroyConsulSession(sessionId: string): Promise<void> {
    const { transport, config, endpoint } = this.requireConnected();
    if (this._engine !== 'consul') throw new Error('Session destroy requires Consul');
    const resp = await sendHttpRequest(
      transport,
      endpoint,
      `/v1/session/destroy/${encodeURIComponent(sessionId)}`,
      {
        method: 'PUT',
        headers: this.buildConsulHeaders(),
        timeoutMs: config.timeoutMs ?? 15000,
      },
    );
    if (resp.status >= 400) {
      throw new Error(decodeResponseText(resp).trim() || `Consul destroy session HTTP ${resp.status}`);
    }
  }

  async getConsulAclOverview(): Promise<{
    enabled: boolean;
    tokens: Array<Record<string, unknown>>;
    policies: Array<Record<string, unknown>>;
    note?: string;
  }> {
    const { transport, config, endpoint } = this.requireConnected();
    if (this._engine !== 'consul') return { enabled: false, tokens: [], policies: [] };
    const [tokResp, polResp] = await Promise.all([
      sendHttpRequest(transport, endpoint, '/v1/acl/tokens', {
        method: 'GET',
        headers: this.buildConsulHeaders(),
        timeoutMs: config.timeoutMs ?? 15000,
      }).catch(() => null),
      sendHttpRequest(transport, endpoint, '/v1/acl/policies', {
        method: 'GET',
        headers: this.buildConsulHeaders(),
        timeoutMs: config.timeoutMs ?? 15000,
      }).catch(() => null),
    ]);
    if (!tokResp || tokResp.status === 401 || tokResp.status === 403) {
      return {
        enabled: true,
        tokens: [],
        policies: [],
        note: tokResp
          ? `ACL access denied (HTTP ${tokResp.status}). Provide X-Consul-Token.`
          : 'ACL endpoint unreachable',
      };
    }
    const tokens =
      tokResp.status < 400 ? decodeResponseJson<Array<Record<string, unknown>>>(tokResp) : [];
    const policies =
      polResp && polResp.status < 400
        ? decodeResponseJson<Array<Record<string, unknown>>>(polResp)
        : [];
    return {
      enabled: true,
      tokens: Array.isArray(tokens) ? tokens : [],
      policies: Array.isArray(policies) ? policies : [],
    };
  }

  async getConfigHistory(
    key: string,
    options?: { namespace?: string; group?: string },
  ): Promise<KvConfigHistoryEntry[]> {
    const { transport, config, endpoint } = this.requireConnected();
    if (this._engine !== 'nacos') return [];
    const params = new URLSearchParams();
    params.set('search', 'accurate');
    params.set('dataId', key);
    params.set('group', options?.group || 'DEFAULT_GROUP');
    params.set('pageNo', '1');
    params.set('pageSize', '50');
    const ns = options?.namespace ?? config.namespace ?? '';
    if (ns) params.set('tenant', ns);
    this.nacosTokenQuery(params);

    const resp = await sendHttpRequest(
      transport,
      endpoint,
      `/nacos/v1/cs/history?${params.toString()}`,
      {
        method: 'GET',
        timeoutMs: config.timeoutMs ?? 15000,
      },
    );
    if (resp.status >= 400) {
      throw new Error(decodeResponseText(resp).trim() || `Nacos history HTTP ${resp.status}`);
    }
    const parsed = decodeResponseJson<{
      pageItems?: Array<{
        id?: string | number;
        dataId?: string;
        group?: string;
        content?: string;
        opType?: string;
        lastModifiedTime?: string;
        md5?: string;
      }>;
    }>(resp);
    return (parsed.pageItems ?? []).map((item) => ({
      id: String(item.id ?? ''),
      key: item.dataId ?? key,
      value: item.content ?? '',
      group: item.group || options?.group || 'DEFAULT_GROUP',
      opType: item.opType,
      updatedAt: item.lastModifiedTime,
      md5: item.md5,
    }));
  }

  async createNamespace(
    namespaceId: string,
    namespaceName: string,
    description = '',
  ): Promise<void> {
    const { transport, config, endpoint } = this.requireConnected();
    if (this._engine !== 'nacos') throw new Error('Namespace creation requires Nacos');
    const form = new URLSearchParams();
    form.set('customNamespaceId', namespaceId);
    form.set('namespaceName', namespaceName);
    form.set('namespaceDesc', description);
    this.nacosTokenQuery(form);
    const resp = await sendHttpRequest(transport, endpoint, '/nacos/v1/console/namespaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      timeoutMs: config.timeoutMs ?? 15000,
    });
    if (resp.status >= 400) {
      throw new Error(decodeResponseText(resp).trim() || `Nacos create namespace HTTP ${resp.status}`);
    }
  }

  async deleteNamespace(namespaceId: string): Promise<void> {
    const { transport, config, endpoint } = this.requireConnected();
    if (this._engine !== 'nacos') throw new Error('Namespace deletion requires Nacos');
    const params = new URLSearchParams();
    params.set('namespaceId', namespaceId);
    this.nacosTokenQuery(params);
    const resp = await sendHttpRequest(
      transport,
      endpoint,
      `/nacos/v1/console/namespaces?${params.toString()}`,
      {
        method: 'DELETE',
        timeoutMs: config.timeoutMs ?? 15000,
      },
    );
    if (resp.status >= 400) {
      throw new Error(decodeResponseText(resp).trim() || `Nacos delete namespace HTTP ${resp.status}`);
    }
  }
}

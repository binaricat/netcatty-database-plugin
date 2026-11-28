/**
 * Pure-TS Browser-Sandbox Search / Document / Vector HTTP Driver (`family: 'search'`).
 * Supports:
 * - elasticsearch & easysearch (GET /, /_cat/indices, /_mapping, /_search, docs CRUD, Basic or ApiKey)
 * - meilisearch (GET /version, /indexes, /indexes/{uid}/search, docs CRUD, Bearer token)
 * - couchdb (GET /, /_all_dbs, /{db}/_find & /_all_docs?include_docs=true, doc CRUD, Basic Auth)
 * - qdrant (GET /, /collections, /points/scroll & /points/search, upsert/delete points, api-key)
 * - chromadb (/api/v2/version fallback /api/v1/version, collections CRUD, get/query/add/delete)
 * - weaviate (GET /v1/meta, /v1/schema, POST /v1/graphql, /v1/objects CRUD, Bearer auth)
 *
 * 100% browser-sandbox compatible (no Node imports, no dynamic code execution).
 */

import { signAwsV4Request } from './awsSigV4';
import {
  buildEndpointUrl,
  decodeResponseJson,
  decodeResponseText,
  encodeBasicAuth,
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
  type SearchDocument,
  type SearchDriver,
  type SearchIndexInfo,
  type SearchQueryResult,
  type TestConnectionResult,
} from './types';

export type SearchEngineId =
  | 'elasticsearch'
  | 'easysearch'
  | 'meilisearch'
  | 'couchdb'
  | 'qdrant'
  | 'chromadb'
  | 'weaviate'
  | 'solr'
  | 'milvus'
  | 'dynamodb'
  | 'hbase';

const DEFAULT_PORTS: Record<SearchEngineId, number> = {
  elasticsearch: 9200,
  easysearch: 9200,
  meilisearch: 7700,
  couchdb: 5984,
  qdrant: 6333,
  chromadb: 8000,
  weaviate: 8080,
  solr: 8983,
  milvus: 19530,
  dynamodb: 443,
  hbase: 8080,
};

const te = new TextEncoder();
const td = new TextDecoder('utf-8');

function utf8ToB64(s: string): string {
  return bytesToBase64(te.encode(s));
}

function b64ToUtf8(b64: string): string {
  if (!b64) return '';
  try {
    return td.decode(base64ToBytes(b64));
  } catch {
    return b64;
  }
}

function normalizeSearchEngine(engine: string): SearchEngineId {
  switch (engine) {
    case 'elasticsearch':
    case 'easysearch':
    case 'meilisearch':
    case 'couchdb':
    case 'qdrant':
    case 'chromadb':
    case 'weaviate':
    case 'solr':
    case 'milvus':
    case 'dynamodb':
    case 'hbase':
      return engine;
    default:
      throw new Error(`Unsupported search/vector engine: ${engine}`);
  }
}

/**
 * Pure-TS DynamoDB AttributeValue marshaller (JS value -> DynamoDB AttributeValue).
 */
export function marshallDynamoValue(val: unknown): Record<string, unknown> {
  if (val === null || val === undefined) return { NULL: true };
  if (typeof val === 'string') return { S: val };
  if (typeof val === 'number') return { N: String(val) };
  if (typeof val === 'boolean') return { BOOL: val };
  if (val instanceof Uint8Array) return { B: bytesToBase64(val) };
  if (Array.isArray(val)) return { L: val.map((item) => marshallDynamoValue(item)) };
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    const keys = Object.keys(obj);
    // Pass through if already a DynamoDB AttributeValue wrapper
    if (
      keys.length === 1 &&
      ['S', 'N', 'B', 'BOOL', 'NULL', 'M', 'L', 'SS', 'NS', 'BS'].includes(keys[0])
    ) {
      return obj;
    }
    const m: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined) m[k] = marshallDynamoValue(v);
    }
    return { M: m };
  }
  return { S: String(val) };
}

export function marshallDynamoItem(doc: Record<string, unknown>): Record<string, unknown> {
  const item: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (v !== undefined) item[k] = marshallDynamoValue(v);
  }
  return item;
}

/**
 * Pure-TS DynamoDB AttributeValue unmarshaller (DynamoDB AttributeValue -> JS value).
 */
export function unmarshallDynamoValue(attr: unknown): unknown {
  if (!attr || typeof attr !== 'object') return attr;
  const obj = attr as Record<string, unknown>;
  if ('S' in obj) return String(obj.S);
  if ('N' in obj) {
    const n = Number(obj.N);
    return Number.isFinite(n) ? n : String(obj.N);
  }
  if ('BOOL' in obj) return Boolean(obj.BOOL);
  if ('NULL' in obj) return null;
  if ('B' in obj) return String(obj.B);
  if ('SS' in obj && Array.isArray(obj.SS)) return obj.SS.map(String);
  if ('NS' in obj && Array.isArray(obj.NS)) return obj.NS.map((v) => Number(v));
  if ('BS' in obj && Array.isArray(obj.BS)) return obj.BS.map(String);
  if ('L' in obj && Array.isArray(obj.L)) return obj.L.map((v) => unmarshallDynamoValue(v));
  if ('M' in obj && obj.M && typeof obj.M === 'object') {
    return unmarshallDynamoItem(obj.M as Record<string, unknown>);
  }
  return obj;
}

export function unmarshallDynamoItem(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    out[k] = unmarshallDynamoValue(v);
  }
  return out;
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return { vector: parsed };
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // not JSON
  }
  return null;
}

function generateLocalId(): string {
  return `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export class SearchVectorDriver implements SearchDriver {
  private _engine: SearchEngineId;
  readonly family = 'search' as const;

  private transport: ByteStreamTransport | null = null;
  private config: ConnectionConfig | null = null;
  private endpoint: HttpEndpointConfig | null = null;
  private _connected = false;
  private _serverVersion = '';
  private _tlsActive = false;

  // ChromaDB v2 vs v1 negotiation + collection name -> id cache
  private chromaApiVersion: 1 | 2 = 2;
  private chromaCollectionIds = new Map<string, string>();
  // Weaviate class -> property names cache
  private weaviateClassProps = new Map<string, string[]>();
  // DynamoDB table -> primary key attribute names cache
  private dynamoKeySchemas = new Map<string, Array<{ name: string; type: 'S' | 'N' | 'B' }>>();

  constructor(engine: DatabaseEngineId = 'elasticsearch') {
    this._engine = normalizeSearchEngine(engine);
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

  private buildHeaders(contentType?: string): Record<string, string> {
    const config = this.config!;
    const headers: Record<string, string> = {};
    if (contentType) headers['Content-Type'] = contentType;

    switch (this._engine) {
      case 'elasticsearch':
      case 'easysearch':
        if (config.apiKey) {
          headers['Authorization'] = `ApiKey ${config.apiKey}`;
        } else if (config.username) {
          headers['Authorization'] = encodeBasicAuth(config.username, config.password ?? '');
        }
        break;
      case 'meilisearch':
      case 'weaviate': {
        const token = config.apiKey || config.password;
        if (token) headers['Authorization'] = `Bearer ${token}`;
        break;
      }
      case 'couchdb':
        if (config.username) {
          headers['Authorization'] = encodeBasicAuth(config.username, config.password ?? '');
        } else if (config.apiKey) {
          headers['Authorization'] = `Bearer ${config.apiKey}`;
        }
        break;
      case 'qdrant': {
        const key = config.apiKey || config.password;
        if (key) headers['api-key'] = key;
        break;
      }
      case 'chromadb': {
        const token = config.apiKey || config.password;
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
          headers['X-Chroma-Token'] = token;
        }
        break;
      }
      case 'solr': {
        if (config.username) {
          headers['Authorization'] = encodeBasicAuth(config.username, config.password ?? '');
        } else if (config.apiKey) {
          headers['Authorization'] = `Bearer ${config.apiKey}`;
        }
        break;
      }
      case 'milvus': {
        const token =
          config.apiKey ||
          (config.username ? `${config.username}:${config.password ?? ''}` : config.password);
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        break;
      }
      case 'hbase': {
        headers['Accept'] = 'application/json';
        if (config.username) {
          headers['Authorization'] = encodeBasicAuth(config.username, config.password ?? '');
        }
        break;
      }
      case 'dynamodb':
        // DynamoDB headers are signed per-request via AWS SigV4
        break;
    }
    return headers;
  }

  private milvusDbName(): string {
    return this.config?.database?.trim() || 'default';
  }

  private async milvusPost<T = unknown>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const resp = await this.requestJson<{
      code?: number;
      message?: string;
      data?: T;
    }>('POST', path, body);
    if (resp && typeof resp.code === 'number' && resp.code !== 0 && resp.code !== 200) {
      throw new Error(resp.message || `Milvus error code ${resp.code}`);
    }
    return (resp?.data !== undefined ? resp.data : (resp as unknown as T));
  }

  private async dynamoRequest<T = Record<string, unknown>>(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    const { transport, config, endpoint } = this.requireConnected();
    const region = config.region?.trim() || 'us-east-1';
    const bodyText = JSON.stringify(payload);
    const url = buildEndpointUrl(endpoint, '/');
    const signed = await signAwsV4Request({
      method: 'POST',
      url,
      headers: {
        'Content-Type': 'application/x-amz-json-1.0',
        'X-Amz-Target': `DynamoDB_20120810.${action}`,
      },
      body: bodyText,
      region,
      service: 'dynamodb',
      credentials: {
        accessKeyId: config.username || config.apiKey || 'local',
        secretAccessKey: config.password || 'local',
      },
    });
    const resp = await sendHttpRequest(transport, endpoint, '/', {
      method: 'POST',
      headers: signed.headers,
      body: bodyText,
      timeoutMs: config.timeoutMs ?? 30000,
    });
    if (resp.status >= 400) {
      throw new Error(decodeResponseText(resp).trim() || `DynamoDB ${action} HTTP ${resp.status}`);
    }
    return decodeResponseJson<T>(resp);
  }

  private chromaBasePath(): string {
    if (this.chromaApiVersion === 1) return '/api/v1';
    const tenant = this.config?.org || 'default_tenant';
    const database = this.config?.namespace || this.config?.database || 'default_database';
    return `/api/v2/tenants/${enc(tenant)}/databases/${enc(database)}`;
  }

  private async requestJson<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const { transport, config, endpoint } = this.requireConnected();
    const hasBody = body !== undefined;
    const resp = await sendHttpRequest(transport, endpoint, path, {
      method,
      headers: this.buildHeaders(hasBody ? 'application/json' : undefined),
      body: hasBody ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      timeoutMs: config.timeoutMs ?? 30000,
    });
    if (resp.status >= 400) {
      throw new Error(decodeResponseText(resp).trim() || `${this._engine} HTTP ${resp.status}`);
    }
    return decodeResponseJson<T>(resp);
  }

  async connect(config: ConnectionConfig, transport: ByteStreamTransport): Promise<ConnectionInfo> {
    const started = performance.now();
    this._engine = normalizeSearchEngine(config.engine);
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
    this.chromaCollectionIds.clear();
    this.weaviateClassProps.clear();
    this.dynamoKeySchemas.clear();
    this._connected = true;

    try {
      this._serverVersion = await this.probeVersion();
      return {
        engine: this._engine,
        family: 'search',
        serverVersion: this._serverVersion,
        database: config.database || config.namespace || '',
        tlsActive: this._tlsActive,
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      this._connected = false;
      throw err;
    }
  }

  private async probeVersion(): Promise<string> {
    const { transport, config, endpoint } = this.requireConnected();
    switch (this._engine) {
      case 'elasticsearch':
      case 'easysearch': {
        const data = await this.requestJson<{
          version?: { number?: string; distribution?: string };
        }>('GET', '/');
        const dist =
          data.version?.distribution ||
          (this._engine === 'easysearch' ? 'Easysearch' : 'Elasticsearch');
        return data.version?.number ? `${dist} ${data.version.number}` : dist;
      }
      case 'meilisearch': {
        const data = await this.requestJson<{ pkgVersion?: string }>('GET', '/version');
        return data.pkgVersion ? `Meilisearch ${data.pkgVersion}` : 'Meilisearch';
      }
      case 'couchdb': {
        const data = await this.requestJson<{ version?: string; couchdb?: string }>('GET', '/');
        return data.version ? `CouchDB ${data.version}` : 'CouchDB';
      }
      case 'qdrant': {
        const data = await this.requestJson<{ version?: string; title?: string }>('GET', '/');
        return data.version ? `Qdrant ${data.version}` : 'Qdrant';
      }
      case 'chromadb': {
        const v2 = await sendHttpRequest(transport, endpoint, '/api/v2/version', {
          method: 'GET',
          headers: this.buildHeaders(),
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (v2.status >= 200 && v2.status < 300) {
          this.chromaApiVersion = 2;
          const ver = decodeResponseText(v2).trim().replace(/^"|"$/g, '');
          return ver ? `ChromaDB ${ver}` : 'ChromaDB v2';
        }
        const v1 = await sendHttpRequest(transport, endpoint, '/api/v1/version', {
          method: 'GET',
          headers: this.buildHeaders(),
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (v1.status >= 400) {
          throw new Error(decodeResponseText(v1).trim() || `ChromaDB HTTP ${v1.status}`);
        }
        this.chromaApiVersion = 1;
        const ver = decodeResponseText(v1).trim().replace(/^"|"$/g, '');
        return ver ? `ChromaDB ${ver}` : 'ChromaDB v1';
      }
      case 'weaviate': {
        const data = await this.requestJson<{ version?: string }>('GET', '/v1/meta');
        return data.version ? `Weaviate ${data.version}` : 'Weaviate';
      }
      case 'solr': {
        const data = await this.requestJson<{
          lucene?: { 'solr-spec-version'?: string };
        }>('GET', '/solr/admin/info/system?wt=json');
        const ver = data.lucene?.['solr-spec-version'];
        return ver ? `Solr ${ver}` : 'Apache Solr';
      }
      case 'milvus': {
        await this.milvusPost<string[]>('/v2/vectordb/databases/list', {});
        return 'Milvus REST v2';
      }
      case 'dynamodb': {
        await this.dynamoRequest('ListTables', { Limit: 1 });
        const region = config.region?.trim() || 'us-east-1';
        return `DynamoDB (${region})`;
      }
      case 'hbase': {
        const resp = await sendHttpRequest(transport, endpoint, '/', {
          method: 'GET',
          headers: this.buildHeaders(),
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `HBase HTTP ${resp.status}`);
        }
        return 'HBase REST';
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
    this.chromaCollectionIds.clear();
    this.weaviateClassProps.clear();
    this.dynamoKeySchemas.clear();
  }

  async rawRequest(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: string,
  ): Promise<{ status: number; body: string }> {
    const { transport, config, endpoint } = this.requireConnected();
    const resp = await sendHttpRequest(transport, endpoint, path, {
      method,
      headers: this.buildHeaders(body !== undefined ? 'application/json' : undefined),
      body,
      timeoutMs: config.timeoutMs ?? 30000,
    });
    return {
      status: resp.status,
      body: decodeResponseText(resp),
    };
  }

  /* --------------------------------------------------------------------------
   * Indices / Collections Management
   * -------------------------------------------------------------------------- */

  async listIndices(): Promise<SearchIndexInfo[]> {
    this.requireConnected();

    switch (this._engine) {
      case 'elasticsearch':
      case 'easysearch': {
        const rows = await this.requestJson<
          Array<{
            index: string;
            'docs.count'?: string | number;
            'store.size'?: string | number;
            status?: string;
            health?: string;
          }>
        >('GET', '/_cat/indices?format=json&bytes=b');
        return (Array.isArray(rows) ? rows : []).map((r) => ({
          name: r.index,
          docCount: r['docs.count'] !== undefined ? Number(r['docs.count']) : undefined,
          sizeBytes: r['store.size'] !== undefined ? Number(r['store.size']) : undefined,
          status: r.status || r.health,
          extra: r.health ? { health: r.health } : undefined,
        }));
      }

      case 'meilisearch': {
        const data = await this.requestJson<
          { results?: Array<{ uid: string; primaryKey?: string | null }> } | Array<{ uid: string; primaryKey?: string | null }>
        >('GET', '/indexes');
        const list = Array.isArray(data) ? data : data.results ?? [];
        return list.map((idx) => ({
          name: idx.uid,
          extra: idx.primaryKey ? { primaryKey: idx.primaryKey } : undefined,
        }));
      }

      case 'couchdb': {
        const dbs = await this.requestJson<string[]>('GET', '/_all_dbs');
        return (Array.isArray(dbs) ? dbs : []).map((name) => ({
          name,
          status: name.startsWith('_') ? 'system' : 'open',
        }));
      }

      case 'qdrant': {
        const data = await this.requestJson<{
          result?: { collections?: Array<{ name: string }> };
        }>('GET', '/collections');
        const cols = data.result?.collections ?? [];
        return cols.map((c) => ({ name: c.name }));
      }

      case 'chromadb': {
        const cols = await this.requestJson<
          Array<{ id: string; name: string; metadata?: Record<string, unknown> }>
        >('GET', `${this.chromaBasePath()}/collections`);
        const list = Array.isArray(cols) ? cols : [];
        const out: SearchIndexInfo[] = [];
        for (const c of list) {
          this.chromaCollectionIds.set(c.name, c.id);
          out.push({
            name: c.name,
            extra: { id: c.id, ...(c.metadata ?? {}) },
          });
        }
        return out;
      }

      case 'weaviate': {
        const data = await this.requestJson<{
          classes?: Array<{
            class: string;
            description?: string;
            vectorizer?: string;
            properties?: Array<{ name: string }>;
          }>;
        }>('GET', '/v1/schema');
        return (data.classes ?? []).map((cls) => {
          const props = (cls.properties ?? []).map((p) => p.name);
          this.weaviateClassProps.set(cls.class, props);
          return {
            name: cls.class,
            extra: {
              description: cls.description,
              vectorizer: cls.vectorizer,
              properties: props,
            },
          };
        });
      }

      case 'solr': {
        const data = await this.requestJson<{
          status?: Record<
            string,
            {
              name?: string;
              index?: { numDocs?: number; sizeInBytes?: number };
            }
          >;
        }>('GET', '/solr/admin/cores?action=STATUS&wt=json');
        const statusMap = data.status ?? {};
        return Object.entries(statusMap).map(([key, core]) => ({
          name: core.name || key,
          docCount: core.index?.numDocs,
          sizeBytes: core.index?.sizeInBytes,
          status: 'open',
        }));
      }

      case 'milvus': {
        const cols = await this.milvusPost<string[]>('/v2/vectordb/collections/list', {
          dbName: this.milvusDbName(),
        });
        return (Array.isArray(cols) ? cols : []).map((name) => ({ name: String(name) }));
      }

      case 'dynamodb': {
        const res = await this.dynamoRequest<{ TableNames?: string[] }>('ListTables', {});
        return (res.TableNames ?? []).map((name) => ({ name, status: 'ACTIVE' }));
      }

      case 'hbase': {
        const { transport, config, endpoint } = this.requireConnected();
        const resp = await sendHttpRequest(transport, endpoint, '/', {
          method: 'GET',
          headers: this.buildHeaders(),
          timeoutMs: config.timeoutMs ?? 15000,
        });
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `HBase HTTP ${resp.status}`);
        }
        const text = decodeResponseText(resp).trim();
        if (!text) return [];
        if (text.startsWith('{') || text.startsWith('[')) {
          const parsed = JSON.parse(text) as { table?: Array<{ name: string }> } | string[];
          if (Array.isArray(parsed)) return parsed.map((name) => ({ name: String(name) }));
          return (parsed.table ?? []).map((t) => ({ name: t.name }));
        }
        return text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((name) => ({ name }));
      }
    }
  }

  async getIndexSchema(index: string): Promise<Record<string, unknown>> {
    this.requireConnected();

    switch (this._engine) {
      case 'elasticsearch':
      case 'easysearch':
        return this.requestJson<Record<string, unknown>>('GET', `/${enc(index)}/_mapping`);
      case 'meilisearch':
        return this.requestJson<Record<string, unknown>>('GET', `/indexes/${enc(index)}/settings`);
      case 'couchdb':
        return this.requestJson<Record<string, unknown>>('GET', `/${enc(index)}`);
      case 'qdrant': {
        const data = await this.requestJson<{ result?: Record<string, unknown> }>(
          'GET',
          `/collections/${enc(index)}`,
        );
        return data.result ?? (data as Record<string, unknown>);
      }
      case 'chromadb': {
        const col = await this.requestJson<Record<string, unknown>>(
          'GET',
          `${this.chromaBasePath()}/collections/${enc(index)}`,
        );
        if (typeof col.id === 'string') {
          this.chromaCollectionIds.set(index, col.id);
        }
        return col;
      }
      case 'weaviate': {
        const cls = await this.requestJson<Record<string, unknown>>(
          'GET',
          `/v1/schema/${enc(index)}`,
        );
        if (Array.isArray(cls.properties)) {
          this.weaviateClassProps.set(
            index,
            cls.properties
              .map((p) => (p && typeof p === 'object' ? String((p as { name?: string }).name ?? '') : ''))
              .filter(Boolean),
          );
        }
        return cls;
      }

      case 'solr':
        return this.requestJson<Record<string, unknown>>('GET', `/solr/${enc(index)}/schema?wt=json`);

      case 'milvus':
        return this.milvusPost<Record<string, unknown>>('/v2/vectordb/collections/describe', {
          dbName: this.milvusDbName(),
          collectionName: index,
        });

      case 'dynamodb': {
        const res = await this.dynamoRequest<{
          Table?: {
            KeySchema?: Array<{ AttributeName: string; KeyType: string }>;
            AttributeDefinitions?: Array<{ AttributeName: string; AttributeType: 'S' | 'N' | 'B' }>;
            [k: string]: unknown;
          };
        }>('DescribeTable', { TableName: index });
        const table = res.Table;
        if (table?.KeySchema) {
          const attrMap = new Map(
            (table.AttributeDefinitions ?? []).map((a) => [a.AttributeName, a.AttributeType]),
          );
          this.dynamoKeySchemas.set(
            index,
            table.KeySchema.map((k) => ({
              name: k.AttributeName,
              type: attrMap.get(k.AttributeName) ?? 'S',
            })),
          );
        }
        return (res.Table ?? res) as Record<string, unknown>;
      }

      case 'hbase':
        return this.requestJson<Record<string, unknown>>('GET', `/${enc(index)}/schema`);
    }
  }

  async createIndex(index: string, config?: Record<string, unknown>): Promise<void> {
    this.requireConnected();

    switch (this._engine) {
      case 'elasticsearch':
      case 'easysearch':
        await this.requestJson('PUT', `/${enc(index)}`, config ?? {});
        return;
      case 'meilisearch':
        await this.requestJson('POST', '/indexes', { uid: index, ...(config ?? {}) });
        return;
      case 'couchdb':
        await this.requestJson('PUT', `/${enc(index)}`);
        return;
      case 'qdrant':
        await this.requestJson(
          'PUT',
          `/collections/${enc(index)}`,
          config ?? { vectors: { size: 4, distance: 'Cosine' } },
        );
        return;
      case 'chromadb': {
        const created = await this.requestJson<{ id?: string }>(
          'POST',
          `${this.chromaBasePath()}/collections`,
          { name: index, ...(config ?? {}) },
        );
        if (created?.id) this.chromaCollectionIds.set(index, created.id);
        return;
      }
      case 'weaviate':
        await this.requestJson('POST', '/v1/schema', { class: index, ...(config ?? {}) });
        return;
      case 'solr':
        await this.requestJson(
          'GET',
          `/solr/admin/cores?action=CREATE&name=${enc(index)}&instanceDir=${enc(index)}&wt=json`,
        );
        return;
      case 'milvus':
        await this.milvusPost('/v2/vectordb/collections/create', {
          dbName: this.milvusDbName(),
          collectionName: index,
          dimension: 128,
          ...(config ?? {}),
        });
        return;
      case 'dynamodb':
        await this.dynamoRequest('CreateTable', {
          TableName: index,
          KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
          AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
          BillingMode: 'PAY_PER_REQUEST',
          ...(config ?? {}),
        });
        return;
      case 'hbase':
        await this.requestJson('PUT', `/${enc(index)}/schema`, {
          name: index,
          ColumnSchema: [{ name: 'cf' }],
          ...(config ?? {}),
        });
        return;
    }
  }

  async deleteIndex(index: string): Promise<void> {
    this.requireConnected();

    switch (this._engine) {
      case 'elasticsearch':
      case 'easysearch':
      case 'couchdb':
        await this.requestJson('DELETE', `/${enc(index)}`);
        return;
      case 'meilisearch':
        await this.requestJson('DELETE', `/indexes/${enc(index)}`);
        return;
      case 'qdrant':
        await this.requestJson('DELETE', `/collections/${enc(index)}`);
        return;
      case 'chromadb':
        await this.requestJson('DELETE', `${this.chromaBasePath()}/collections/${enc(index)}`);
        this.chromaCollectionIds.delete(index);
        return;
      case 'weaviate':
        await this.requestJson('DELETE', `/v1/schema/${enc(index)}`);
        this.weaviateClassProps.delete(index);
        return;
      case 'solr':
        await this.requestJson(
          'GET',
          `/solr/admin/cores?action=UNLOAD&core=${enc(index)}&wt=json`,
        );
        return;
      case 'milvus':
        await this.milvusPost('/v2/vectordb/collections/drop', {
          dbName: this.milvusDbName(),
          collectionName: index,
        });
        return;
      case 'dynamodb':
        await this.dynamoRequest('DeleteTable', { TableName: index });
        this.dynamoKeySchemas.delete(index);
        return;
      case 'hbase':
        await this.requestJson('DELETE', `/${enc(index)}/schema`);
        return;
    }
  }

  /* --------------------------------------------------------------------------
   * Search / Query
   * -------------------------------------------------------------------------- */

  private async resolveChromaCollectionId(index: string): Promise<string> {
    const cached = this.chromaCollectionIds.get(index);
    if (cached) return cached;
    try {
      const col = await this.requestJson<{ id?: string }>(
        'GET',
        `${this.chromaBasePath()}/collections/${enc(index)}`,
      );
      if (col?.id) {
        this.chromaCollectionIds.set(index, col.id);
        return col.id;
      }
    } catch {
      // fall through and use index directly as id
    }
    return index;
  }

  async search(
    index: string,
    query: string | Record<string, unknown>,
    options?: { from?: number; size?: number },
  ): Promise<SearchQueryResult> {
    this.requireConnected();
    const started = performance.now();
    const from = options?.from ?? 0;
    const size = options?.size ?? 20;

    switch (this._engine) {
      case 'elasticsearch':
      case 'easysearch': {
        let body: Record<string, unknown>;
        if (typeof query === 'string') {
          const parsed = tryParseJsonObject(query);
          if (parsed) {
            body = { from, size, ...parsed };
          } else if (!query.trim() || query.trim() === '*') {
            body = { from, size, query: { match_all: {} } };
          } else {
            body = { from, size, query: { query_string: { query: query.trim() } } };
          }
        } else if ('query' in query || 'knn' in query || 'aggs' in query) {
          body = { from, size, ...query };
        } else {
          body = { from, size, query };
        }

        const raw = await this.requestJson<{
          hits?: {
            total?: number | { value?: number };
            hits?: Array<{
              _id: string;
              _index?: string;
              _score?: number | null;
              _source?: Record<string, unknown>;
            }>;
          };
        }>('POST', `/${enc(index)}/_search`, body);

        const hits = raw.hits?.hits ?? [];
        const totalRaw = raw.hits?.total;
        const totalCount =
          typeof totalRaw === 'number' ? totalRaw : totalRaw?.value ?? hits.length;

        const documents: SearchDocument[] = hits.map((h) => ({
          id: String(h._id),
          index: h._index || index,
          score: h._score ?? undefined,
          source: h._source ?? {},
        }));

        return {
          index,
          documents,
          totalCount,
          executionMs: Math.round(performance.now() - started),
          raw,
        };
      }

      case 'meilisearch': {
        let body: Record<string, unknown>;
        if (typeof query === 'string') {
          const parsed = tryParseJsonObject(query);
          body = parsed
            ? { offset: from, limit: size, ...parsed }
            : { q: query.trim() === '*' ? '' : query, offset: from, limit: size };
        } else {
          body = { offset: from, limit: size, ...query };
        }

        const raw = await this.requestJson<{
          hits?: Array<Record<string, unknown>>;
          estimatedTotalHits?: number;
          totalHits?: number;
        }>('POST', `/indexes/${enc(index)}/search`, body);

        const hits = raw.hits ?? [];
        const documents: SearchDocument[] = hits.map((h, i) => ({
          id: String(h.id ?? h._id ?? h.uid ?? i),
          index,
          score: typeof h._rankingScore === 'number' ? h._rankingScore : undefined,
          source: h,
        }));

        return {
          index,
          documents,
          totalCount: raw.totalHits ?? raw.estimatedTotalHits ?? documents.length,
          executionMs: Math.round(performance.now() - started),
          raw,
        };
      }

      case 'couchdb': {
        const parsedObj = typeof query === 'string' ? tryParseJsonObject(query) : query;
        const isAllDocs =
          typeof query === 'string' && (!query.trim() || query.trim() === '*') && !parsedObj;

        if (isAllDocs) {
          const raw = await this.requestJson<{
            total_rows?: number;
            rows?: Array<{ id: string; doc?: Record<string, unknown>; value?: unknown }>;
          }>('GET', `/${enc(index)}/_all_docs?include_docs=true&skip=${from}&limit=${size}`);

          const documents: SearchDocument[] = (raw.rows ?? []).map((r) => ({
            id: r.id,
            index,
            source: r.doc ?? (typeof r.value === 'object' && r.value !== null ? (r.value as Record<string, unknown>) : { value: r.value }),
          }));

          return {
            index,
            documents,
            totalCount: raw.total_rows ?? documents.length,
            executionMs: Math.round(performance.now() - started),
            raw,
          };
        }

        const findBody: Record<string, unknown> = parsedObj
          ? 'selector' in parsedObj
            ? { skip: from, limit: size, ...parsedObj }
            : { selector: parsedObj, skip: from, limit: size }
          : { selector: { _id: { $regex: String(query).trim() } }, skip: from, limit: size };

        const raw = await this.requestJson<{
          docs?: Array<Record<string, unknown>>;
        }>('POST', `/${enc(index)}/_find`, findBody);

        const docs = raw.docs ?? [];
        const documents: SearchDocument[] = docs.map((d, i) => ({
          id: String(d._id ?? i),
          index,
          source: d,
        }));

        return {
          index,
          documents,
          totalCount: documents.length,
          executionMs: Math.round(performance.now() - started),
          raw,
        };
      }

      case 'qdrant': {
        const obj = typeof query === 'string' ? tryParseJsonObject(query) : query;
        const vector = obj && Array.isArray(obj.vector) ? (obj.vector as number[]) : null;

        if (vector) {
          const searchBody: Record<string, unknown> = {
            vector,
            limit: size,
            offset: from,
            with_payload: true,
            with_vector: true,
          };
          if (obj?.filter) searchBody.filter = obj.filter;

          const raw = await this.requestJson<{
            result?: Array<{
              id: string | number;
              score?: number;
              payload?: Record<string, unknown>;
              vector?: number[];
            }>;
          }>('POST', `/collections/${enc(index)}/points/search`, searchBody);

          const pts = raw.result ?? [];
          const documents: SearchDocument[] = pts.map((p) => ({
            id: String(p.id),
            index,
            score: p.score,
            source: p.payload ?? {},
            vector: Array.isArray(p.vector) ? p.vector : undefined,
          }));

          return {
            index,
            documents,
            totalCount: documents.length,
            executionMs: Math.round(performance.now() - started),
            raw,
          };
        }

        const scrollBody: Record<string, unknown> = {
          limit: size,
          with_payload: true,
          with_vector: true,
        };
        if (obj?.filter) scrollBody.filter = obj.filter;

        const raw = await this.requestJson<{
          result?: {
            points?: Array<{
              id: string | number;
              payload?: Record<string, unknown>;
              vector?: number[];
            }>;
          };
        }>('POST', `/collections/${enc(index)}/points/scroll`, scrollBody);

        const pts = raw.result?.points ?? [];
        const documents: SearchDocument[] = pts.map((p) => ({
          id: String(p.id),
          index,
          source: p.payload ?? {},
          vector: Array.isArray(p.vector) ? p.vector : undefined,
        }));

        return {
          index,
          documents,
          totalCount: documents.length,
          executionMs: Math.round(performance.now() - started),
          raw,
        };
      }

      case 'chromadb': {
        const colId = await this.resolveChromaCollectionId(index);
        const obj = typeof query === 'string' ? tryParseJsonObject(query) : query;
        const hasVectorQuery =
          Boolean(obj?.query_embeddings) ||
          Boolean(obj?.query_texts) ||
          Array.isArray(obj?.vector) ||
          (typeof query === 'string' && query.trim().length > 0 && query.trim() !== '*' && !obj);

        if (hasVectorQuery) {
          const queryBody: Record<string, unknown> = {
            n_results: size,
            include: ['documents', 'metadatas', 'distances', 'embeddings'],
          };
          if (obj?.query_embeddings) {
            queryBody.query_embeddings = obj.query_embeddings;
          } else if (Array.isArray(obj?.vector)) {
            queryBody.query_embeddings = [obj.vector];
          } else if (obj?.query_texts) {
            queryBody.query_texts = obj.query_texts;
          } else if (typeof query === 'string') {
            queryBody.query_texts = [query.trim()];
          }
          if (obj?.where) queryBody.where = obj.where;

          const raw = await this.requestJson<{
            ids?: string[][];
            documents?: Array<Array<string | null>>;
            metadatas?: Array<Array<Record<string, unknown> | null>>;
            distances?: Array<Array<number | null>>;
            embeddings?: Array<Array<number[] | null>>;
          }>('POST', `${this.chromaBasePath()}/collections/${enc(colId)}/query`, queryBody);

          const ids = raw.ids?.[0] ?? [];
          const docs = raw.documents?.[0] ?? [];
          const metas = raw.metadatas?.[0] ?? [];
          const dists = raw.distances?.[0] ?? [];
          const embeds = raw.embeddings?.[0] ?? [];

          const documents: SearchDocument[] = ids.map((id, i) => ({
            id,
            index,
            score: dists[i] !== undefined && dists[i] !== null ? Number(dists[i]) : undefined,
            source: {
              ...(metas[i] ?? {}),
              ...(docs[i] !== undefined && docs[i] !== null ? { document: docs[i] } : {}),
            },
            vector: Array.isArray(embeds[i]) ? (embeds[i] as number[]) : undefined,
          }));

          return {
            index,
            documents,
            totalCount: documents.length,
            executionMs: Math.round(performance.now() - started),
            raw,
          };
        }

        const getBody: Record<string, unknown> = {
          limit: size,
          offset: from,
          include: ['documents', 'metadatas', 'embeddings'],
        };
        if (obj?.where) getBody.where = obj.where;

        const raw = await this.requestJson<{
          ids?: string[];
          documents?: Array<string | null>;
          metadatas?: Array<Record<string, unknown> | null>;
          embeddings?: Array<number[] | null>;
        }>('POST', `${this.chromaBasePath()}/collections/${enc(colId)}/get`, getBody);

        const ids = raw.ids ?? [];
        const docs = raw.documents ?? [];
        const metas = raw.metadatas ?? [];
        const embeds = raw.embeddings ?? [];

        const documents: SearchDocument[] = ids.map((id, i) => ({
          id,
          index,
          source: {
            ...(metas[i] ?? {}),
            ...(docs[i] !== undefined && docs[i] !== null ? { document: docs[i] } : {}),
          },
          vector: Array.isArray(embeds[i]) ? (embeds[i] as number[]) : undefined,
        }));

        return {
          index,
          documents,
          totalCount: documents.length,
          executionMs: Math.round(performance.now() - started),
          raw,
        };
      }

      case 'weaviate': {
        let gql: string;
        if (typeof query === 'object' && typeof query.query === 'string') {
          gql = query.query;
        } else if (typeof query === 'string' && query.trim().startsWith('{') && query.includes('Get')) {
          gql = query.trim();
        } else {
          let props = this.weaviateClassProps.get(index);
          if (!props) {
            try {
              await this.getIndexSchema(index);
              props = this.weaviateClassProps.get(index);
            } catch {
              props = [];
            }
          }
          const propStr = props && props.length > 0 ? ` ${props.join(' ')}` : '';
          const args: string[] = [`limit: ${size}`, `offset: ${from}`];
          if (typeof query === 'string' && query.trim() && query.trim() !== '*') {
            args.push(`nearText: { concepts: [${JSON.stringify(query.trim())}] }`);
          } else if (typeof query === 'object' && Array.isArray(query.vector)) {
            args.push(`nearVector: { vector: ${JSON.stringify(query.vector)} }`);
          }
          gql = `{ Get { ${index}(${args.join(', ')}) { _additional { id certainty distance vector }${propStr} } } }`;
        }

        const raw = await this.requestJson<{
          data?: { Get?: Record<string, Array<Record<string, unknown>>> };
          errors?: Array<{ message?: string }>;
        }>('POST', '/v1/graphql', { query: gql });

        if (raw.errors && raw.errors.length > 0) {
          throw new Error(raw.errors.map((e) => e.message || 'GraphQL error').join('; '));
        }

        const items = raw.data?.Get?.[index] ?? [];
        const documents: SearchDocument[] = items.map((item, i) => {
          const additional = (item._additional ?? {}) as {
            id?: string;
            certainty?: number;
            distance?: number;
            vector?: number[];
          };
          const source: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(item)) {
            if (k !== '_additional') source[k] = v;
          }
          return {
            id: String(additional.id ?? i),
            index,
            score: additional.certainty ?? additional.distance,
            source,
            vector: Array.isArray(additional.vector) ? additional.vector : undefined,
          };
        });

        return {
          index,
          documents,
          totalCount: documents.length,
          executionMs: Math.round(performance.now() - started),
          raw,
        };
      }

      case 'solr': {
        let solrBody: Record<string, unknown>;
        if (typeof query === 'string') {
          const parsed = tryParseJsonObject(query);
          if (parsed) {
            solrBody = { offset: from, limit: size, ...parsed };
          } else {
            const q = !query.trim() || query.trim() === '*' ? '*:*' : query.trim();
            solrBody = { query: q, offset: from, limit: size };
          }
        } else {
          solrBody = { offset: from, limit: size, ...query };
        }
        const raw = await this.requestJson<{
          response?: { numFound?: number; docs?: Array<Record<string, unknown>> };
        }>('POST', `/solr/${enc(index)}/select?wt=json`, solrBody);
        const docs = raw.response?.docs ?? [];
        const documents: SearchDocument[] = docs.map((d, i) => ({
          id: String(d.id ?? d._id ?? i),
          index,
          score: typeof d.score === 'number' ? d.score : undefined,
          source: d,
        }));
        return {
          index,
          documents,
          totalCount: raw.response?.numFound ?? documents.length,
          executionMs: Math.round(performance.now() - started),
          raw,
        };
      }

      case 'milvus': {
        const obj = typeof query === 'string' ? tryParseJsonObject(query) : query;
        const vec = obj && Array.isArray(obj.vector)
          ? (obj.vector as number[])
          : obj && Array.isArray(obj.data)
            ? (obj.data as unknown[])
            : null;
        if (vec && vec.length > 0) {
          const searchPayload: Record<string, unknown> = {
            dbName: this.milvusDbName(),
            collectionName: index,
            data: Array.isArray(vec[0]) ? vec : [vec],
            limit: size,
            offset: from,
            outputFields: ['*'],
          };
          if (obj?.filter) searchPayload.filter = obj.filter;
          if (obj?.annsField) searchPayload.annsField = obj.annsField;
          const rows = await this.milvusPost<Array<Record<string, unknown>>>(
            '/v2/vectordb/entities/search',
            searchPayload,
          );
          const list = Array.isArray(rows) ? rows : [];
          const documents: SearchDocument[] = list.map((row, i) => ({
            id: String(row.id ?? row.pk ?? i),
            index,
            score: typeof row.distance === 'number' ? row.distance : undefined,
            source: row,
          }));
          return {
            index,
            documents,
            totalCount: documents.length,
            executionMs: Math.round(performance.now() - started),
            raw: rows,
          };
        }
        const filterExpr =
          typeof query === 'string'
            ? obj && typeof obj.filter === 'string'
              ? obj.filter
              : query.trim() === '*' || !query.trim()
                ? ''
                : query.trim()
            : typeof query.filter === 'string'
              ? query.filter
              : '';
        const queryPayload: Record<string, unknown> = {
          dbName: this.milvusDbName(),
          collectionName: index,
          filter: filterExpr,
          limit: size,
          offset: from,
          outputFields: ['*'],
        };
        const rows = await this.milvusPost<Array<Record<string, unknown>>>(
          '/v2/vectordb/entities/query',
          queryPayload,
        );
        const list = Array.isArray(rows) ? rows : [];
        const documents: SearchDocument[] = list.map((row, i) => ({
          id: String(row.id ?? row.pk ?? i),
          index,
          source: row,
        }));
        return {
          index,
          documents,
          totalCount: documents.length,
          executionMs: Math.round(performance.now() - started),
          raw: rows,
        };
      }

      case 'dynamodb': {
        const obj = typeof query === 'string' ? tryParseJsonObject(query) : query;
        if (obj && obj.Key && typeof obj.Key === 'object') {
          const raw = await this.dynamoRequest<{ Item?: Record<string, unknown> }>('GetItem', {
            TableName: index,
            Key: marshallDynamoItem(obj.Key as Record<string, unknown>),
          });
          const docs: SearchDocument[] = raw.Item
            ? [
                {
                  id: String(Object.values(unmarshallDynamoItem(raw.Item))[0] ?? 'item'),
                  index,
                  source: unmarshallDynamoItem(raw.Item),
                },
              ]
            : [];
          return {
            index,
            documents: docs,
            totalCount: docs.length,
            executionMs: Math.round(performance.now() - started),
            raw,
          };
        }

        const isQuery = Boolean(obj && obj.KeyConditionExpression);
        const action = isQuery ? 'Query' : 'Scan';
        const reqPayload: Record<string, unknown> = {
          TableName: index,
          Limit: size,
          ...(obj ?? {}),
        };
        const raw = await this.dynamoRequest<{
          Items?: Array<Record<string, unknown>>;
          Count?: number;
          ScannedCount?: number;
        }>(action, reqPayload);
        const items = raw.Items ?? [];
        const keyCols = this.dynamoKeySchemas.get(index);
        const pkName = keyCols?.[0]?.name;
        const documents: SearchDocument[] = items.map((item, i) => {
          const unmarshalled = unmarshallDynamoItem(item);
          const idVal =
            (pkName && unmarshalled[pkName] !== undefined ? unmarshalled[pkName] : undefined) ??
            unmarshalled.id ??
            unmarshalled.pk ??
            i;
          return {
            id: String(idVal),
            index,
            source: unmarshalled,
          };
        });
        return {
          index,
          documents,
          totalCount: raw.Count ?? documents.length,
          executionMs: Math.round(performance.now() - started),
          raw,
        };
      }

      case 'hbase': {
        const { transport, config, endpoint } = this.requireConnected();
        const obj = typeof query === 'string' ? tryParseJsonObject(query) : query;
        const explicitRowKey =
          (obj && typeof obj.rowKey === 'string' ? obj.rowKey : undefined) ??
          (typeof query === 'string' && query.trim().startsWith('row:')
            ? query.trim().slice(4).trim()
            : undefined);

        const parseHBaseRows = (parsed: {
          Row?: Array<{
            key?: string;
            Cell?: Array<{ column?: string; timestamp?: number; $?: string }>;
          }>;
        }): SearchDocument[] => {
          return (parsed.Row ?? []).map((row, idx) => {
            const rowKey = row.key ? b64ToUtf8(row.key) : String(idx);
            const source: Record<string, unknown> = { _rowKey: rowKey };
            for (const cell of row.Cell ?? []) {
              const col = cell.column ? b64ToUtf8(cell.column) : 'col';
              source[col] = cell.$ !== undefined ? b64ToUtf8(cell.$) : null;
            }
            return { id: rowKey, index, source };
          });
        };

        if (explicitRowKey) {
          const raw = await this.requestJson<{
            Row?: Array<{ key?: string; Cell?: Array<{ column?: string; timestamp?: number; $?: string }> }>;
          }>('GET', `/${enc(index)}/${enc(explicitRowKey)}`);
          const documents = parseHBaseRows(raw);
          return {
            index,
            documents,
            totalCount: documents.length,
            executionMs: Math.round(performance.now() - started),
            raw,
          };
        }

        const scannerBody: Record<string, unknown> = { batch: size, ...(obj ?? {}) };
        const createResp = await sendHttpRequest(transport, endpoint, `/${enc(index)}/scanner`, {
          method: 'PUT',
          headers: this.buildHeaders('application/json'),
          body: JSON.stringify(scannerBody),
          timeoutMs: config.timeoutMs ?? 30000,
        });
        if (createResp.status >= 400) {
          throw new Error(decodeResponseText(createResp).trim() || `HBase scanner HTTP ${createResp.status}`);
        }
        const location = createResp.headers['location'];
        if (!location) {
          throw new Error('HBase scanner creation did not return a Location header');
        }
        try {
          const nextResp = await sendHttpRequest(transport, endpoint, location, {
            method: 'GET',
            headers: this.buildHeaders(),
            timeoutMs: config.timeoutMs ?? 30000,
          });
          if (nextResp.status === 204) {
            return {
              index,
              documents: [],
              totalCount: 0,
              executionMs: Math.round(performance.now() - started),
            };
          }
          if (nextResp.status >= 400) {
            throw new Error(decodeResponseText(nextResp).trim() || `HBase scan HTTP ${nextResp.status}`);
          }
          const raw = decodeResponseJson<{
            Row?: Array<{ key?: string; Cell?: Array<{ column?: string; timestamp?: number; $?: string }> }>;
          }>(nextResp);
          const documents = parseHBaseRows(raw);
          return {
            index,
            documents,
            totalCount: documents.length,
            executionMs: Math.round(performance.now() - started),
            raw,
          };
        } finally {
          await sendHttpRequest(transport, endpoint, location, {
            method: 'DELETE',
            headers: this.buildHeaders(),
            timeoutMs: 5000,
          }).catch(() => {});
        }
      }
    }
  }

  /* --------------------------------------------------------------------------
   * Document / Point CRUD
   * -------------------------------------------------------------------------- */

  async upsertDocument(
    index: string,
    document: Record<string, unknown>,
    id?: string,
  ): Promise<{ id: string }> {
    this.requireConnected();

    switch (this._engine) {
      case 'elasticsearch':
      case 'easysearch': {
        if (id) {
          const res = await this.requestJson<{ _id?: string }>(
            'PUT',
            `/${enc(index)}/_doc/${enc(id)}?refresh=wait_for`,
            document,
          );
          return { id: String(res._id ?? id) };
        }
        const res = await this.requestJson<{ _id?: string }>(
          'POST',
          `/${enc(index)}/_doc?refresh=wait_for`,
          document,
        );
        return { id: String(res._id ?? '') };
      }

      case 'meilisearch': {
        const docId = id ?? (document.id !== undefined ? String(document.id) : generateLocalId());
        const payload = { ...document, id: docId };
        await this.requestJson('POST', `/indexes/${enc(index)}/documents`, [payload]);
        return { id: docId };
      }

      case 'couchdb': {
        const docId = id ?? (typeof document._id === 'string' ? document._id : undefined);
        if (docId) {
          const { transport, config, endpoint } = this.requireConnected();
          const resp = await sendHttpRequest(transport, endpoint, `/${enc(index)}/${enc(docId)}`, {
            method: 'PUT',
            headers: this.buildHeaders('application/json'),
            body: JSON.stringify(document),
            timeoutMs: config.timeoutMs ?? 30000,
          });
          if (resp.status === 409 && !document._rev) {
            const existing = await this.requestJson<{ _rev?: string }>(
              'GET',
              `/${enc(index)}/${enc(docId)}`,
            );
            const retry = await this.requestJson<{ id?: string }>(
              'PUT',
              `/${enc(index)}/${enc(docId)}`,
              { ...document, _rev: existing._rev },
            );
            return { id: String(retry.id ?? docId) };
          }
          if (resp.status >= 400) {
            throw new Error(decodeResponseText(resp).trim() || `CouchDB HTTP ${resp.status}`);
          }
          const parsed = decodeResponseJson<{ id?: string }>(resp);
          return { id: String(parsed.id ?? docId) };
        }
        const res = await this.requestJson<{ id?: string }>('POST', `/${enc(index)}`, document);
        return { id: String(res.id ?? '') };
      }

      case 'qdrant': {
        const pointId: string | number =
          id !== undefined
            ? /^\d+$/.test(id)
              ? Number(id)
              : id
            : document.id !== undefined
              ? (document.id as string | number)
              : generateLocalId();
        const vector = Array.isArray(document.vector) ? document.vector : [];
        let payload: Record<string, unknown>;
        if (document.payload && typeof document.payload === 'object' && !Array.isArray(document.payload)) {
          payload = document.payload as Record<string, unknown>;
        } else {
          payload = {};
          for (const [k, v] of Object.entries(document)) {
            if (k !== 'vector' && k !== 'id') payload[k] = v;
          }
        }
        await this.requestJson('PUT', `/collections/${enc(index)}/points?wait=true`, {
          points: [{ id: pointId, vector, payload }],
        });
        return { id: String(pointId) };
      }

      case 'chromadb': {
        const colId = await this.resolveChromaCollectionId(index);
        const docId = id ?? (document.id !== undefined ? String(document.id) : generateLocalId());
        const docText = typeof document.document === 'string' ? document.document : JSON.stringify(document);
        const metadata: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(document)) {
          if (k !== 'document' && k !== 'vector' && k !== 'embedding' && k !== 'id') {
            metadata[k] = v;
          }
        }
        const body: Record<string, unknown> = {
          ids: [docId],
          documents: [docText],
        };
        if (Object.keys(metadata).length > 0) body.metadatas = [metadata];
        const emb = Array.isArray(document.embedding)
          ? document.embedding
          : Array.isArray(document.vector)
            ? document.vector
            : null;
        if (emb) body.embeddings = [emb];

        await this.requestJson(
          'POST',
          `${this.chromaBasePath()}/collections/${enc(colId)}/add`,
          body,
        );
        return { id: docId };
      }

      case 'weaviate': {
        const properties: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(document)) {
          if (k !== 'vector' && k !== 'id' && k !== 'class') properties[k] = v;
        }
        const payload: Record<string, unknown> = {
          class: index,
          properties,
        };
        if (id) payload.id = id;
        if (Array.isArray(document.vector)) payload.vector = document.vector;

        const { transport, config, endpoint } = this.requireConnected();
        const resp = await sendHttpRequest(transport, endpoint, '/v1/objects', {
          method: 'POST',
          headers: this.buildHeaders('application/json'),
          body: JSON.stringify(payload),
          timeoutMs: config.timeoutMs ?? 30000,
        });
        if (resp.status === 422 && id) {
          const updated = await this.requestJson<{ id?: string }>(
            'PUT',
            `/v1/objects/${enc(index)}/${enc(id)}`,
            payload,
          );
          return { id: String(updated.id ?? id) };
        }
        if (resp.status >= 400) {
          throw new Error(decodeResponseText(resp).trim() || `Weaviate HTTP ${resp.status}`);
        }
        const created = decodeResponseJson<{ id?: string }>(resp);
        return { id: String(created.id ?? id ?? '') };
      }

      case 'solr': {
        const docId = id ?? (document.id !== undefined ? String(document.id) : generateLocalId());
        const payload = { ...document, id: docId };
        await this.requestJson(
          'POST',
          `/solr/${enc(index)}/update/json/docs?commit=true&wt=json`,
          payload,
        );
        return { id: docId };
      }

      case 'milvus': {
        const docId = id ?? (document.id !== undefined ? String(document.id) : generateLocalId());
        const payload = document.id !== undefined ? document : { id: /^\d+$/.test(docId) ? Number(docId) : docId, ...document };
        await this.milvusPost('/v2/vectordb/entities/insert', {
          dbName: this.milvusDbName(),
          collectionName: index,
          data: [payload],
        });
        return { id: docId };
      }

      case 'dynamodb': {
        if (typeof document.UpdateExpression === 'string' && document.Key && typeof document.Key === 'object') {
          await this.dynamoRequest('UpdateItem', {
            TableName: index,
            ...document,
            Key: marshallDynamoItem(document.Key as Record<string, unknown>),
          });
          return { id: id ?? JSON.stringify(document.Key) };
        }
        const docWithId =
          id && document.id === undefined ? { id, ...document } : document;
        await this.dynamoRequest('PutItem', {
          TableName: index,
          Item: marshallDynamoItem(docWithId),
        });
        return { id: id ?? String(docWithId.id ?? generateLocalId()) };
      }

      case 'hbase': {
        const rowKey =
          id ??
          (typeof document._rowKey === 'string'
            ? document._rowKey
            : typeof document.id === 'string'
              ? document.id
              : generateLocalId());
        const cells: Array<{ column: string; $: string }> = [];
        for (const [k, v] of Object.entries(document)) {
          if (k === '_rowKey' || v === undefined) continue;
          const colName = k.includes(':') ? k : `cf:${k}`;
          const valStr = typeof v === 'string' ? v : JSON.stringify(v);
          cells.push({ column: utf8ToB64(colName), $: utf8ToB64(valStr) });
        }
        await this.requestJson('PUT', `/${enc(index)}/${enc(rowKey)}`, {
          Row: [{ key: utf8ToB64(rowKey), Cell: cells }],
        });
        return { id: rowKey };
      }
    }
  }

  async deleteDocument(index: string, id: string): Promise<void> {
    this.requireConnected();

    switch (this._engine) {
      case 'elasticsearch':
      case 'easysearch':
        await this.requestJson('DELETE', `/${enc(index)}/_doc/${enc(id)}?refresh=wait_for`);
        return;

      case 'meilisearch':
        await this.requestJson('DELETE', `/indexes/${enc(index)}/documents/${enc(id)}`);
        return;

      case 'couchdb': {
        let rev = '';
        try {
          const existing = await this.requestJson<{ _rev?: string }>(
            'GET',
            `/${enc(index)}/${enc(id)}`,
          );
          rev = existing._rev ?? '';
        } catch {
          // attempt delete directly if GET fails
        }
        const query = rev ? `?rev=${enc(rev)}` : '';
        await this.requestJson('DELETE', `/${enc(index)}/${enc(id)}${query}`);
        return;
      }

      case 'qdrant': {
        const pointId: string | number = /^\d+$/.test(id) ? Number(id) : id;
        await this.requestJson('POST', `/collections/${enc(index)}/points/delete?wait=true`, {
          points: [pointId],
        });
        return;
      }

      case 'chromadb': {
        const colId = await this.resolveChromaCollectionId(index);
        await this.requestJson(
          'POST',
          `${this.chromaBasePath()}/collections/${enc(colId)}/delete`,
          { ids: [id] },
        );
        return;
      }

      case 'weaviate':
        await this.requestJson('DELETE', `/v1/objects/${enc(index)}/${enc(id)}`);
        return;

      case 'solr':
        await this.requestJson('POST', `/solr/${enc(index)}/update?commit=true&wt=json`, {
          delete: { id },
        });
        return;

      case 'milvus': {
        const filter = /^\d+$/.test(id) ? `id in [${id}]` : `id in ["${id.replaceAll('"', '\\"')}"]`;
        await this.milvusPost('/v2/vectordb/entities/delete', {
          dbName: this.milvusDbName(),
          collectionName: index,
          filter,
        });
        return;
      }

      case 'dynamodb': {
        const parsedKey = tryParseJsonObject(id);
        let keyObj: Record<string, unknown>;
        if (parsedKey) {
          keyObj = marshallDynamoItem(parsedKey);
        } else {
          const schema = this.dynamoKeySchemas.get(index);
          const pk = schema?.[0];
          const pkName = pk?.name ?? 'id';
          keyObj = { [pkName]: pk?.type === 'N' ? { N: id } : { S: id } };
        }
        await this.dynamoRequest('DeleteItem', {
          TableName: index,
          Key: keyObj,
        });
        return;
      }

      case 'hbase':
        await this.requestJson('DELETE', `/${enc(index)}/${enc(id)}`);
        return;
    }
  }

  /* --------------------------------------------------------------------------
   * Specialist Admin / Introspection Methods (ES/OS, Meilisearch, Milvus, Solr)
   * -------------------------------------------------------------------------- */

  async getClusterHealth(): Promise<Record<string, unknown>> {
    this.requireConnected();
    if (this._engine === 'elasticsearch' || this._engine === 'easysearch') {
      return this.requestJson<Record<string, unknown>>('GET', '/_cluster/health');
    }
    if (this._engine === 'meilisearch') {
      return this.requestJson<Record<string, unknown>>('GET', '/health');
    }
    if (this._engine === 'solr') {
      return this.requestJson<Record<string, unknown>>('GET', '/solr/admin/info/system?wt=json');
    }
    return { status: 'ok', engine: this._engine, version: this._serverVersion };
  }

  async getClusterNodes(): Promise<Array<Record<string, unknown>>> {
    this.requireConnected();
    if (this._engine === 'elasticsearch' || this._engine === 'easysearch') {
      const rows = await this.requestJson<Array<Record<string, unknown>>>(
        'GET',
        '/_cat/nodes?format=json&v=true',
      );
      return Array.isArray(rows) ? rows : [];
    }
    return [];
  }

  async getIndexSettings(index: string): Promise<Record<string, unknown>> {
    this.requireConnected();
    if (this._engine === 'elasticsearch' || this._engine === 'easysearch') {
      return this.requestJson<Record<string, unknown>>('GET', `/${enc(index)}/_settings`);
    }
    if (this._engine === 'meilisearch') {
      return this.requestJson<Record<string, unknown>>('GET', `/indexes/${enc(index)}/settings`);
    }
    return this.getIndexSchema(index);
  }

  async updateIndexSettings(
    index: string,
    settings: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.requireConnected();
    if (this._engine === 'elasticsearch' || this._engine === 'easysearch') {
      return this.requestJson<Record<string, unknown>>('PUT', `/${enc(index)}/_settings`, settings);
    }
    if (this._engine === 'meilisearch') {
      return this.requestJson<Record<string, unknown>>(
        'PUT',
        `/indexes/${enc(index)}/settings`,
        settings,
      );
    }
    throw new Error(`Updating index settings is not supported for ${this._engine}`);
  }

  async getIndexStats(index: string): Promise<Record<string, unknown>> {
    this.requireConnected();
    if (this._engine === 'elasticsearch' || this._engine === 'easysearch') {
      return this.requestJson<Record<string, unknown>>('GET', `/${enc(index)}/_stats`);
    }
    if (this._engine === 'meilisearch') {
      return this.requestJson<Record<string, unknown>>('GET', `/indexes/${enc(index)}/stats`);
    }
    return this.getIndexSchema(index);
  }

  async getIndexAliases(index: string): Promise<Record<string, unknown>> {
    this.requireConnected();
    if (this._engine === 'elasticsearch' || this._engine === 'easysearch') {
      return this.requestJson<Record<string, unknown>>('GET', `/${enc(index)}/_alias`);
    }
    return {};
  }

  async updateIndexAliases(
    actions: Array<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    this.requireConnected();
    if (this._engine === 'elasticsearch' || this._engine === 'easysearch') {
      return this.requestJson<Record<string, unknown>>('POST', '/_aliases', { actions });
    }
    throw new Error(`Index aliases are not supported for ${this._engine}`);
  }

  async deleteByQuery(
    index: string,
    query: Record<string, unknown>,
  ): Promise<{ deleted: number }> {
    this.requireConnected();
    if (this._engine === 'elasticsearch' || this._engine === 'easysearch') {
      const body = 'query' in query ? query : { query };
      const res = await this.requestJson<{ deleted?: number }>(
        'POST',
        `/${enc(index)}/_delete_by_query?refresh=true`,
        body,
      );
      return { deleted: Number(res.deleted ?? 0) };
    }
    if (this._engine === 'solr') {
      const q = typeof query.query === 'string' ? query.query : '*:*';
      await this.requestJson('POST', `/solr/${enc(index)}/update?commit=true&wt=json`, {
        delete: { query: q },
      });
      return { deleted: 0 };
    }
    if (this._engine === 'meilisearch') {
      await this.requestJson('DELETE', `/indexes/${enc(index)}/documents`);
      return { deleted: 0 };
    }
    throw new Error(`deleteByQuery is not supported for ${this._engine}`);
  }

  async profileSearch(
    index: string,
    query: string | Record<string, unknown>,
    options?: { from?: number; size?: number },
  ): Promise<SearchQueryResult & { profile?: unknown }> {
    this.requireConnected();
    if (this._engine !== 'elasticsearch' && this._engine !== 'easysearch') {
      throw new Error(`Query profiling is only supported on Elasticsearch/OpenSearch`);
    }
    let body: Record<string, unknown>;
    if (typeof query === 'string') {
      const parsed = tryParseJsonObject(query);
      if (parsed) {
        body = { ...parsed, profile: true };
      } else if (!query.trim() || query.trim() === '*') {
        body = { query: { match_all: {} }, profile: true };
      } else {
        body = { query: { query_string: { query: query.trim() } }, profile: true };
      }
    } else if ('query' in query || 'aggs' in query) {
      body = { ...query, profile: true };
    } else {
      body = { query, profile: true };
    }
    const res = await this.search(index, body, options);
    const rawObj = res.raw as { profile?: unknown } | undefined;
    return { ...res, profile: rawObj?.profile };
  }

  async listMeiliTasks(limit = 50): Promise<Array<Record<string, unknown>>> {
    this.requireConnected();
    const res = await this.requestJson<
      { results?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
    >('GET', `/tasks?limit=${Math.max(1, Math.min(500, limit))}`);
    return Array.isArray(res) ? res : res.results ?? [];
  }

  async listMeiliKeys(limit = 50): Promise<Array<Record<string, unknown>>> {
    this.requireConnected();
    const res = await this.requestJson<
      { results?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
    >('GET', `/keys?limit=${Math.max(1, Math.min(200, limit))}`);
    return Array.isArray(res) ? res : res.results ?? [];
  }

  async renameIndex(index: string, newName: string): Promise<void> {
    this.requireConnected();
    if (this._engine === 'milvus') {
      await this.milvusPost('/v2/vectordb/collections/rename', {
        dbName: this.milvusDbName(),
        collectionName: index,
        newCollectionName: newName,
      });
      return;
    }
    throw new Error(`Rename index is not supported for ${this._engine}`);
  }
}

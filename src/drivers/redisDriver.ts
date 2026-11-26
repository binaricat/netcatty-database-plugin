/**
 * Pure-TS Redis RESP2 / RESP3 Driver (100% browser-sandbox compatible).
 * Supports AUTH (ACL user+pass or pass), SELECT (0..15), INFO parsing,
 * SCAN + namespace tree builder, full CRUD for String/Hash/List/Set/ZSet/Stream,
 * TTL/RENAME/DEL, pipelined metadata fetching, and full CLI command tokenizer/runner.
 */

import { BufferedByteStream, concatBytes } from './streamBuffer';
import type {
  ByteStreamTransport,
  ConnectionConfig,
  ConnectionInfo,
  RedisCliResult,
  RedisDriver,
  RedisInfoParsed,
  RedisKeyDetail,
  RedisKeyEntry,
  RedisKeyType,
  RedisNamespaceNode,
  RedisStreamEntry,
  TestConnectionResult,
} from './types';

const te = new TextEncoder();
const td = new TextDecoder('utf-8');
const CRLF = new Uint8Array([13, 10]);

export class RedisServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisServerError';
  }
}

export function encodeRespCommand(args: readonly (string | Uint8Array)[]): Uint8Array {
  const parts: Uint8Array[] = [te.encode(`*${args.length}\r\n`)];
  for (const arg of args) {
    const bytes = typeof arg === 'string' ? te.encode(arg) : arg;
    parts.push(te.encode(`$${bytes.length}\r\n`), bytes, CRLF);
  }
  return concatBytes(...parts);
}

/**
 * Tokenizes a Redis CLI command line supporting single quotes, double quotes with escapes,
 * and unquoted whitespace-delimited tokens.
 */
export function tokenizeRedisCli(commandLine: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = commandLine.length;

  while (i < n) {
    while (i < n && /\s/.test(commandLine[i])) i++;
    if (i >= n) break;

    const ch = commandLine[i];
    if (ch === '"') {
      i++;
      let buf = '';
      while (i < n && commandLine[i] !== '"') {
        if (commandLine[i] === '\\' && i + 1 < n) {
          const next = commandLine[i + 1];
          if (next === 'n') buf += '\n';
          else if (next === 'r') buf += '\r';
          else if (next === 't') buf += '\t';
          else if (next === 'x' && i + 3 < n) {
            const code = parseInt(commandLine.slice(i + 2, i + 4), 16);
            if (!Number.isNaN(code)) {
              buf += String.fromCharCode(code);
              i += 4;
              continue;
            }
            buf += next;
          } else {
            buf += next;
          }
          i += 2;
        } else {
          buf += commandLine[i++];
        }
      }
      if (i >= n) throw new Error('Unclosed double quote in Redis CLI command');
      i++; // closing "
      tokens.push(buf);
    } else if (ch === "'") {
      i++;
      let buf = '';
      while (i < n && commandLine[i] !== "'") {
        if (commandLine[i] === '\\' && commandLine[i + 1] === "'") {
          buf += "'";
          i += 2;
        } else {
          buf += commandLine[i++];
        }
      }
      if (i >= n) throw new Error('Unclosed single quote in Redis CLI command');
      i++; // closing '
      tokens.push(buf);
    } else {
      let buf = '';
      while (i < n && !/\s/.test(commandLine[i])) {
        buf += commandLine[i++];
      }
      tokens.push(buf);
    }
  }
  return tokens;
}

export function parseRedisInfo(raw: string): RedisInfoParsed {
  const sections: Record<string, Record<string, string>> = {};
  let currentSection = 'default';
  sections[currentSection] = {};

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      currentSection = line.slice(1).trim().toLowerCase();
      if (!sections[currentSection]) sections[currentSection] = {};
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0) {
      const k = line.slice(0, colon).trim();
      const v = line.slice(colon + 1).trim();
      sections[currentSection][k] = v;
    }
  }

  const keyspace: RedisInfoParsed['keyspace'] = [];
  const ks = sections.keyspace ?? {};
  for (const [k, v] of Object.entries(ks)) {
    const dbMatch = /^db(\d+)$/.exec(k);
    if (!dbMatch) continue;
    const db = Number(dbMatch[1]);
    const parts: Record<string, number> = {};
    for (const seg of v.split(',')) {
      const [pk, pv] = seg.split('=');
      if (pk && pv) parts[pk.trim()] = Number(pv.trim());
    }
    keyspace.push({
      db,
      keys: parts.keys ?? 0,
      expires: parts.expires ?? 0,
      avgTtl: parts.avg_ttl ?? 0,
    });
  }
  keyspace.sort((a, b) => a.db - b.db);

  return {
    raw,
    sections,
    serverVersion: sections.server?.redis_version ?? '',
    usedMemoryHuman: sections.memory?.used_memory_human ?? '0B',
    usedMemoryBytes: Number(sections.memory?.used_memory ?? 0),
    connectedClients: Number(sections.clients?.connected_clients ?? 0),
    uptimeSeconds: Number(sections.server?.uptime_in_seconds ?? 0),
    keyspace,
  };
}

export function buildRedisNamespaceTree(
  keys: readonly RedisKeyEntry[],
  delimiter = ':',
): RedisNamespaceNode[] {
  interface MutableNode {
    name: string;
    fullPath: string;
    isLeaf: boolean;
    key?: RedisKeyEntry;
    keyCount: number;
    childrenMap: Map<string, MutableNode>;
  }

  const root = new Map<string, MutableNode>();

  for (const entry of keys) {
    const parts = delimiter ? entry.key.split(delimiter) : [entry.key];
    let currentMap = root;
    let prefix = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      prefix = i === 0 ? part : `${prefix}${delimiter}${part}`;
      const mapKey = isLast ? `\0leaf:${part}` : `folder:${part}`;
      let node = currentMap.get(mapKey);
      if (!node) {
        node = {
          name: part,
          fullPath: prefix,
          isLeaf: isLast,
          key: isLast ? entry : undefined,
          keyCount: 0,
          childrenMap: new Map(),
        };
        currentMap.set(mapKey, node);
      }
      node.keyCount++;
      if (!isLast) {
        currentMap = node.childrenMap;
      }
    }
  }

  const finalize = (map: Map<string, MutableNode>): RedisNamespaceNode[] => {
    const list: RedisNamespaceNode[] = [];
    for (const node of map.values()) {
      list.push({
        name: node.name,
        fullPath: node.fullPath,
        isLeaf: node.isLeaf,
        key: node.key,
        keyCount: node.keyCount,
        children: finalize(node.childrenMap),
      });
    }
    return list.sort((a, b) => {
      if (a.isLeaf !== b.isLeaf) return a.isLeaf ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  };

  return finalize(root);
}

function formatRedisOutput(val: unknown, indent = ''): string {
  if (val === null || val === undefined) return '(nil)';
  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
    return String(val);
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return '(empty array)';
    return val
      .map((item, idx) => `${indent}${idx + 1}) ${formatRedisOutput(item, indent + '   ')}`)
      .join('\n');
  }
  if (typeof val === 'object') {
    return JSON.stringify(val, null, 2);
  }
  return String(val);
}

export class PureRedisDriver implements RedisDriver {
  readonly engine = 'redis' as const;
  readonly family = 'redis' as const;

  private stream: BufferedByteStream | null = null;
  private _connected = false;
  private _currentDb = 0;
  private _serverVersion = '';
  private _tlsActive = false;
  private busy: Promise<unknown> = Promise.resolve();

  get connected(): boolean {
    return this._connected;
  }
  get currentDb(): number {
    return this._currentDb;
  }
  get serverVersion(): string {
    return this._serverVersion;
  }

  private async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => {});
    return run;
  }

  private async readRespValue(): Promise<unknown> {
    const bs = this.stream;
    if (!bs) throw new Error('Redis connection is closed');
    const lineBytes = await bs.readLineCRLF();
    if (lineBytes.length === 0) throw new Error('Empty RESP frame');
    const prefix = String.fromCharCode(lineBytes[0]);
    const body = td.decode(lineBytes.subarray(1));

    switch (prefix) {
      case '+': // Simple String
        return body;
      case '-': // Simple Error
        throw new RedisServerError(body);
      case ':': // Integer
        return Number(body);
      case '_': // RESP3 Null
        return null;
      case '#': // RESP3 Boolean
        return body === 't';
      case ',': // RESP3 Double
        return body === 'inf' ? Infinity : body === '-inf' ? -Infinity : Number(body);
      case '(': // RESP3 BigNumber
        return body;
      case '$': { // Bulk String
        const len = Number(body);
        if (len < 0) return null;
        const data = await bs.readExact(len);
        await bs.readExact(2); // \r\n
        return td.decode(data);
      }
      case '!': { // RESP3 Blob Error
        const len = Number(body);
        const data = await bs.readExact(Math.max(0, len));
        await bs.readExact(2);
        throw new RedisServerError(td.decode(data));
      }
      case '=': { // RESP3 Verbatim String
        const len = Number(body);
        const data = await bs.readExact(Math.max(0, len));
        await bs.readExact(2);
        const text = td.decode(data);
        return text.length >= 4 && text[3] === ':' ? text.slice(4) : text;
      }
      case '*':
      case '~':
      case '>': { // Array / RESP3 Set / Push
        const count = Number(body);
        if (count < 0) return null;
        const arr: unknown[] = new Array(count);
        for (let i = 0; i < count; i++) {
          arr[i] = await this.readRespValue();
        }
        return arr;
      }
      case '%': { // RESP3 Map
        const pairs = Number(body);
        if (pairs < 0) return null;
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < pairs; i++) {
          const k = String(await this.readRespValue());
          obj[k] = await this.readRespValue();
        }
        return obj;
      }
      default:
        throw new Error(`Unsupported RESP type prefix: ${prefix}`);
    }
  }

  private async runPipeline(commands: readonly (readonly (string | Uint8Array)[])[]): Promise<unknown[]> {
    return this.enqueue(async () => {
      if (!this.stream) throw new Error('Redis connection is closed');
      const encoded = commands.map((cmd) => encodeRespCommand(cmd));
      await this.stream.write(concatBytes(...encoded));
      const results: unknown[] = [];
      let firstError: Error | null = null;
      for (let i = 0; i < commands.length; i++) {
        try {
          results.push(await this.readRespValue());
        } catch (err) {
          if (commands.length === 1) throw err;
          results.push(err);
          if (!firstError && err instanceof Error) firstError = err;
        }
      }
      if (commands.length === 1 && firstError) throw firstError;
      return results;
    });
  }

  async executeCommand(args: readonly (string | Uint8Array)[]): Promise<unknown> {
    if (!this._connected) throw new Error('Redis is not connected');
    const [result] = await this.runPipeline([args]);
    return result;
  }

  async connect(config: ConnectionConfig, transport: ByteStreamTransport): Promise<ConnectionInfo> {
    const started = performance.now();
    const host = config.host ?? '127.0.0.1';
    const port = config.port ?? 6379;
    const useTls = (config.tlsMode ?? 'disable') !== 'disable';

    const rawStream = await transport.connect({
      host,
      port,
      tls: useTls,
      servername: host,
      allowSelfSigned: config.allowSelfSigned ?? config.tlsMode !== 'verify-full',
      caPem: config.caPem,
      timeoutMs: config.timeoutMs ?? 15000,
    });
    const bs = new BufferedByteStream(rawStream);
    this.stream = bs;
    this._tlsActive = useTls;
    this._connected = true;

    try {
      if (config.password) {
        if (config.username && config.username !== 'default') {
          await this.executeCommand(['AUTH', config.username, config.password]);
        } else {
          await this.executeCommand(['AUTH', config.password]);
        }
      }

      const dbIdx = config.redisDb ?? (config.database ? Number(config.database) : 0);
      if (Number.isInteger(dbIdx) && dbIdx > 0 && dbIdx <= 15) {
        await this.selectDb(dbIdx);
      } else {
        this._currentDb = 0;
      }

      const infoRaw = String(await this.executeCommand(['INFO', 'server']));
      const parsed = parseRedisInfo(infoRaw);
      this._serverVersion = parsed.serverVersion || 'Redis';

      return {
        engine: 'redis',
        family: 'redis',
        serverVersion: this._serverVersion,
        database: `db${this._currentDb}`,
        tlsActive: this._tlsActive,
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      this._connected = false;
      await bs.close().catch(() => {});
      this.stream = null;
      throw err;
    }
  }

  async testConnection(): Promise<TestConnectionResult> {
    const started = performance.now();
    try {
      const pong = await this.executeCommand(['PING']);
      return {
        ok: String(pong).toUpperCase() === 'PONG',
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
    const bs = this.stream;
    this.stream = null;
    if (bs) {
      try {
        await bs.write(encodeRespCommand(['QUIT']));
      } catch {
        // ignore
      }
      await bs.close().catch(() => {});
    }
  }

  async selectDb(db: number): Promise<void> {
    if (!Number.isInteger(db) || db < 0 || db > 15) {
      throw new Error(`Redis database index must be 0..15, got ${db}`);
    }
    await this.executeCommand(['SELECT', String(db)]);
    this._currentDb = db;
  }

  async getInfo(section?: string): Promise<RedisInfoParsed> {
    const raw = String(
      await this.executeCommand(section ? ['INFO', section] : ['INFO']),
    );
    return parseRedisInfo(raw);
  }

  async scanKeys(options?: {
    cursor?: string;
    match?: string;
    count?: number;
    maxKeys?: number;
    includeMeta?: boolean;
  }): Promise<{ cursor: string; keys: RedisKeyEntry[] }> {
    let cursor = options?.cursor ?? '0';
    const match = options?.match || '*';
    const count = options?.count ?? 200;
    const maxKeys = options?.maxKeys ?? 1000;
    const includeMeta = options?.includeMeta ?? true;
    const seen = new Set<string>();
    const rawKeys: string[] = [];

    do {
      const resp = (await this.executeCommand([
        'SCAN',
        cursor,
        'MATCH',
        match,
        'COUNT',
        String(count),
      ])) as [string, string[]];
      cursor = String(resp[0] ?? '0');
      const batch = Array.isArray(resp[1]) ? resp[1] : [];
      for (const k of batch) {
        const ks = String(k);
        if (!seen.has(ks)) {
          seen.add(ks);
          rawKeys.push(ks);
          if (rawKeys.length >= maxKeys) break;
        }
      }
    } while (cursor !== '0' && rawKeys.length < maxKeys);

    if (!includeMeta || rawKeys.length === 0) {
      return {
        cursor,
        keys: rawKeys.map((key) => ({ key, type: 'unknown' as RedisKeyType, ttlMs: -1 })),
      };
    }

    // Pipeline TYPE + PTTL for all scanned keys
    const cmds: string[][] = [];
    for (const k of rawKeys) {
      cmds.push(['TYPE', k], ['PTTL', k]);
    }
    const metaResp = await this.runPipeline(cmds);
    const keys: RedisKeyEntry[] = rawKeys.map((key, idx) => {
      const rawType = String(metaResp[idx * 2] ?? 'unknown').toLowerCase();
      const validTypes: RedisKeyType[] = ['string', 'hash', 'list', 'set', 'zset', 'stream', 'none'];
      const type: RedisKeyType = validTypes.includes(rawType as RedisKeyType)
        ? (rawType as RedisKeyType)
        : 'unknown';
      const ttlMs = typeof metaResp[idx * 2 + 1] === 'number' ? (metaResp[idx * 2 + 1] as number) : -1;
      return { key, type, ttlMs };
    });

    return { cursor, keys };
  }

  buildNamespaceTree(keys: readonly RedisKeyEntry[], delimiter = ':'): RedisNamespaceNode[] {
    return buildRedisNamespaceTree(keys, delimiter);
  }

  async getKeyDetail(key: string): Promise<RedisKeyDetail> {
    const [rawType, rawTtl] = await this.runPipeline([
      ['TYPE', key],
      ['PTTL', key],
    ]);
    const typeStr = String(rawType ?? 'none').toLowerCase();
    const validTypes: RedisKeyType[] = ['string', 'hash', 'list', 'set', 'zset', 'stream', 'none'];
    const type: RedisKeyType = validTypes.includes(typeStr as RedisKeyType)
      ? (typeStr as RedisKeyType)
      : 'unknown';
    const ttlMs = typeof rawTtl === 'number' ? rawTtl : -1;

    switch (type) {
      case 'string': {
        const value = await this.getString(key);
        return { key, type, ttlMs, size: value?.length ?? 0, value };
      }
      case 'hash': {
        const value = await this.getHash(key);
        return { key, type, ttlMs, size: Object.keys(value).length, value };
      }
      case 'list': {
        const value = await this.getList(key, 0, 999);
        const len = Number(await this.executeCommand(['LLEN', key]));
        return { key, type, ttlMs, size: len, value };
      }
      case 'set': {
        const value = await this.getSet(key);
        return { key, type, ttlMs, size: value.length, value };
      }
      case 'zset': {
        const value = await this.getZSet(key, 0, 999);
        const card = Number(await this.executeCommand(['ZCARD', key]));
        return { key, type, ttlMs, size: card, value };
      }
      case 'stream': {
        const value = await this.getStream(key, '-', '+', 200);
        const len = Number(await this.executeCommand(['XLEN', key]));
        return { key, type, ttlMs, size: len, value };
      }
      default:
        return { key, type, ttlMs, value: null };
    }
  }

  async getString(key: string): Promise<string | null> {
    const val = await this.executeCommand(['GET', key]);
    return val === null ? null : String(val);
  }

  async setString(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      await this.executeCommand(['SET', key, value, 'EX', String(Math.floor(ttlSeconds))]);
    } else {
      await this.executeCommand(['SET', key, value]);
    }
  }

  async getHash(key: string): Promise<Record<string, string>> {
    const res = await this.executeCommand(['HGETALL', key]);
    const out: Record<string, string> = {};
    if (Array.isArray(res)) {
      for (let i = 0; i + 1 < res.length; i += 2) {
        out[String(res[i])] = String(res[i + 1]);
      }
    } else if (res && typeof res === 'object') {
      for (const [k, v] of Object.entries(res as Record<string, unknown>)) {
        out[k] = String(v);
      }
    }
    return out;
  }

  async setHashField(key: string, field: string, value: string): Promise<void> {
    await this.executeCommand(['HSET', key, field, value]);
  }

  async deleteHashField(key: string, fields: string | string[]): Promise<number> {
    const list = Array.isArray(fields) ? fields : [fields];
    if (list.length === 0) return 0;
    return Number(await this.executeCommand(['HDEL', key, ...list]));
  }

  async getList(key: string, start = 0, stop = -1): Promise<string[]> {
    const res = (await this.executeCommand(['LRANGE', key, String(start), String(stop)])) as unknown[];
    return Array.isArray(res) ? res.map(String) : [];
  }

  async pushList(
    key: string,
    values: string | string[],
    direction: 'left' | 'right' = 'right',
  ): Promise<number> {
    const list = Array.isArray(values) ? values : [values];
    if (list.length === 0) return 0;
    const cmd = direction === 'left' ? 'LPUSH' : 'RPUSH';
    return Number(await this.executeCommand([cmd, key, ...list]));
  }

  async setListIndex(key: string, index: number, value: string): Promise<void> {
    await this.executeCommand(['LSET', key, String(index), value]);
  }

  async removeListValue(key: string, value: string, count = 1): Promise<number> {
    return Number(await this.executeCommand(['LREM', key, String(count), value]));
  }

  async getSet(key: string): Promise<string[]> {
    const res = (await this.executeCommand(['SMEMBERS', key])) as unknown[];
    return Array.isArray(res) ? res.map(String) : [];
  }

  async addSetMembers(key: string, members: string | string[]): Promise<number> {
    const list = Array.isArray(members) ? members : [members];
    if (list.length === 0) return 0;
    return Number(await this.executeCommand(['SADD', key, ...list]));
  }

  async removeSetMembers(key: string, members: string | string[]): Promise<number> {
    const list = Array.isArray(members) ? members : [members];
    if (list.length === 0) return 0;
    return Number(await this.executeCommand(['SREM', key, ...list]));
  }

  async getZSet(
    key: string,
    start = 0,
    stop = -1,
  ): Promise<Array<{ member: string; score: number }>> {
    const res = (await this.executeCommand([
      'ZRANGE',
      key,
      String(start),
      String(stop),
      'WITHSCORES',
    ])) as unknown[];
    const items: Array<{ member: string; score: number }> = [];
    if (Array.isArray(res)) {
      for (let i = 0; i + 1 < res.length; i += 2) {
        items.push({ member: String(res[i]), score: Number(res[i + 1]) });
      }
    }
    return items;
  }

  async addZSetMember(key: string, score: number, member: string): Promise<number> {
    return Number(await this.executeCommand(['ZADD', key, String(score), member]));
  }

  async removeZSetMembers(key: string, members: string | string[]): Promise<number> {
    const list = Array.isArray(members) ? members : [members];
    if (list.length === 0) return 0;
    return Number(await this.executeCommand(['ZREM', key, ...list]));
  }

  async getStream(
    key: string,
    start = '-',
    end = '+',
    count = 100,
  ): Promise<RedisStreamEntry[]> {
    const res = (await this.executeCommand([
      'XRANGE',
      key,
      start,
      end,
      'COUNT',
      String(count),
    ])) as unknown[];
    const entries: RedisStreamEntry[] = [];
    if (Array.isArray(res)) {
      for (const item of res) {
        if (!Array.isArray(item) || item.length < 2) continue;
        const id = String(item[0]);
        const fieldArr = Array.isArray(item[1]) ? item[1] : [];
        const fields: Record<string, string> = {};
        for (let i = 0; i + 1 < fieldArr.length; i += 2) {
          fields[String(fieldArr[i])] = String(fieldArr[i + 1]);
        }
        entries.push({ id, fields });
      }
    }
    return entries;
  }

  async addStreamEntry(
    key: string,
    fields: Record<string, string>,
    id = '*',
  ): Promise<string> {
    const args: string[] = ['XADD', key, id];
    for (const [k, v] of Object.entries(fields)) {
      args.push(k, v);
    }
    return String(await this.executeCommand(args));
  }

  async deleteStreamEntries(key: string, ids: string | string[]): Promise<number> {
    const list = Array.isArray(ids) ? ids : [ids];
    if (list.length === 0) return 0;
    return Number(await this.executeCommand(['XDEL', key, ...list]));
  }

  async setTtl(key: string, ttlSeconds: number): Promise<boolean> {
    return Number(await this.executeCommand(['EXPIRE', key, String(Math.floor(ttlSeconds))])) === 1;
  }

  async persistKey(key: string): Promise<boolean> {
    return Number(await this.executeCommand(['PERSIST', key])) === 1;
  }

  async renameKey(oldKey: string, newKey: string): Promise<void> {
    await this.executeCommand(['RENAME', oldKey, newKey]);
  }

  async deleteKeys(keys: string | string[]): Promise<number> {
    const list = Array.isArray(keys) ? keys : [keys];
    if (list.length === 0) return 0;
    return Number(await this.executeCommand(['DEL', ...list]));
  }

  async executeCli(commandLine: string): Promise<RedisCliResult> {
    const started = performance.now();
    const tokens = tokenizeRedisCli(commandLine);
    if (tokens.length === 0) {
      return {
        command: '',
        args: [],
        output: null,
        formatted: '',
        executionMs: 0,
        isError: false,
      };
    }
    const [cmd, ...args] = tokens;
    try {
      const output = await this.executeCommand(tokens);
      if (cmd.toUpperCase() === 'SELECT' && args[0] !== undefined) {
        const db = Number(args[0]);
        if (Number.isInteger(db) && db >= 0 && db <= 15) this._currentDb = db;
      }
      return {
        command: cmd.toUpperCase(),
        args,
        output,
        formatted: formatRedisOutput(output),
        executionMs: Math.round(performance.now() - started),
        isError: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        command: cmd.toUpperCase(),
        args,
        output: msg,
        formatted: `(error) ${msg}`,
        executionMs: Math.round(performance.now() - started),
        isError: true,
      };
    }
  }
}

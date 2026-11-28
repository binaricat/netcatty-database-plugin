/**
 * Pure-TS Browser-Sandbox Apache ZooKeeper Jute Binary TCP + 4-Letter Word Driver (`family: 'kv'`).
 * Implements ZooKeeper Jute binary protocol over `ByteStream` (port 2181):
 * - ConnectRequest / ConnectResponse handshake
 * - OpCodes: Create (1), Delete (2), Exists (3), GetData (4), SetData (5),
 *   GetChildren (8), Ping (11), CloseSession (-11)
 * - 4-Letter Words (`mntr` / `stat`) parser for version & cluster health metrics
 *
 * Implements the exact `KvDriver` interface as `kvHttpDriver.ts`.
 * 100% browser-sandbox compatible (zero `node:*` imports).
 */

import { BufferedByteStream, concatBytes } from './streamBuffer';
import type {
  ByteStreamTransport,
  ConnectionConfig,
  ConnectionInfo,
  KvDriver,
  KvEntry,
  KvNamespaceInfo,
  TestConnectionResult,
} from './types';

const te = new TextEncoder();
const td = new TextDecoder('utf-8');

export const ZK_OPCODE = {
  CREATE: 1,
  DELETE: 2,
  EXISTS: 3,
  GET_DATA: 4,
  SET_DATA: 5,
  GET_CHILDREN: 8,
  PING: 11,
  CLOSE_SESSION: -11,
} as const;

export const ZK_ERR = {
  OK: 0,
  NO_NODE: -101,
  NO_AUTH: -102,
  BAD_VERSION: -103,
  NODE_EXISTS: -110,
  NOT_EMPTY: -111,
} as const;

export interface ZkStat {
  czxid: number;
  mzxid: number;
  ctime: number;
  mtime: number;
  version: number;
  cversion: number;
  aversion: number;
  ephemeralOwner: number;
  dataLength: number;
  numChildren: number;
  pzxid: number;
}

/* ============================================================================
 * Pure Jute Binary Codecs & 4-Letter Word Parsers
 * ============================================================================ */

function writeInt32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v, false);
  return b;
}

function writeInt64(v: bigint | number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(v), false);
  return b;
}

function encodeJuteString(s: string): Uint8Array {
  const raw = te.encode(s);
  return concatBytes(writeInt32(raw.length), raw);
}

function encodeJuteBuffer(data: Uint8Array | null): Uint8Array {
  if (data === null) return writeInt32(-1);
  return concatBytes(writeInt32(data.length), data);
}

export function frameJutePacket(payload: Uint8Array): Uint8Array {
  return concatBytes(writeInt32(payload.length), payload);
}

export function encodeZkConnectRequest(options?: {
  protocolVersion?: number;
  lastZxidSeen?: bigint;
  timeoutMs?: number;
  sessionId?: bigint;
  passwd?: Uint8Array;
  readOnly?: boolean;
}): Uint8Array {
  const passwd = options?.passwd ?? new Uint8Array(16);
  const body = concatBytes(
    writeInt32(options?.protocolVersion ?? 0),
    writeInt64(options?.lastZxidSeen ?? 0n),
    writeInt32(options?.timeoutMs ?? 30000),
    writeInt64(options?.sessionId ?? 0n),
    encodeJuteBuffer(passwd),
    new Uint8Array([options?.readOnly ? 1 : 0]),
  );
  return frameJutePacket(body);
}

export function decodeZkConnectResponse(body: Uint8Array): {
  protocolVersion: number;
  timeoutMs: number;
  sessionId: bigint;
  passwd: Uint8Array;
  readOnly: boolean;
} {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let off = 0;
  const protocolVersion = view.getInt32(off, false);
  off += 4;
  const timeoutMs = view.getInt32(off, false);
  off += 4;
  const sessionId = view.getBigInt64(off, false);
  off += 8;
  const passwdLen = view.getInt32(off, false);
  off += 4;
  const passwd = passwdLen > 0 ? body.slice(off, off + passwdLen) : new Uint8Array(0);
  off += Math.max(0, passwdLen);
  const readOnly = off < body.length ? body[off] !== 0 : false;
  return { protocolVersion, timeoutMs, sessionId, passwd, readOnly };
}

export function encodeZkRequest(
  xid: number,
  opcode: number,
  body: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const payload = concatBytes(writeInt32(xid), writeInt32(opcode), body);
  return frameJutePacket(payload);
}

export function encodeZkGetChildrenBody(path: string, watch = false): Uint8Array {
  return concatBytes(encodeJuteString(path), new Uint8Array([watch ? 1 : 0]));
}

export function encodeZkGetDataBody(path: string, watch = false): Uint8Array {
  return concatBytes(encodeJuteString(path), new Uint8Array([watch ? 1 : 0]));
}

export function encodeZkSetDataBody(path: string, data: Uint8Array, version = -1): Uint8Array {
  return concatBytes(encodeJuteString(path), encodeJuteBuffer(data), writeInt32(version));
}

export function encodeZkCreateBody(path: string, data: Uint8Array, flags = 0): Uint8Array {
  // ACL vector: 1 entry -> perms=0x1f (ALL), scheme="world", id="anyone"
  const aclVector = concatBytes(
    writeInt32(1),
    writeInt32(0x1f),
    encodeJuteString('world'),
    encodeJuteString('anyone'),
  );
  return concatBytes(encodeJuteString(path), encodeJuteBuffer(data), aclVector, writeInt32(flags));
}

export function encodeZkDeleteBody(path: string, version = -1): Uint8Array {
  return concatBytes(encodeJuteString(path), writeInt32(version));
}

export function decodeZkReplyHeader(body: Uint8Array): {
  xid: number;
  zxid: bigint;
  err: number;
  offset: number;
} {
  if (body.length < 16) {
    throw new Error(`Invalid ZooKeeper ReplyHeader length: ${body.length}`);
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  return {
    xid: view.getInt32(0, false),
    zxid: view.getBigInt64(4, false),
    err: view.getInt32(12, false),
    offset: 16,
  };
}

export function decodeZkStat(body: Uint8Array, offset: number): { stat: ZkStat; nextOffset: number } {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let off = offset;
  const czxid = Number(view.getBigInt64(off, false)); off += 8;
  const mzxid = Number(view.getBigInt64(off, false)); off += 8;
  const ctime = Number(view.getBigInt64(off, false)); off += 8;
  const mtime = Number(view.getBigInt64(off, false)); off += 8;
  const version = view.getInt32(off, false); off += 4;
  const cversion = view.getInt32(off, false); off += 4;
  const aversion = view.getInt32(off, false); off += 4;
  const ephemeralOwner = Number(view.getBigInt64(off, false)); off += 8;
  const dataLength = view.getInt32(off, false); off += 4;
  const numChildren = view.getInt32(off, false); off += 4;
  const pzxid = Number(view.getBigInt64(off, false)); off += 8;
  return {
    stat: { czxid, mzxid, ctime, mtime, version, cversion, aversion, ephemeralOwner, dataLength, numChildren, pzxid },
    nextOffset: off,
  };
}

export function decodeZkGetChildrenResponse(body: Uint8Array, offset = 16): string[] {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let off = offset;
  const count = view.getInt32(off, false);
  off += 4;
  const children: string[] = [];
  for (let i = 0; i < count; i++) {
    const len = view.getInt32(off, false);
    off += 4;
    children.push(td.decode(body.subarray(off, off + len)));
    off += len;
  }
  return children;
}

export function decodeZkGetDataResponse(
  body: Uint8Array,
  offset = 16,
): { data: Uint8Array; stat: ZkStat } {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let off = offset;
  const len = view.getInt32(off, false);
  off += 4;
  const data = len > 0 ? body.slice(off, off + len) : new Uint8Array(0);
  off += Math.max(0, len);
  const { stat } = decodeZkStat(body, off);
  return { data, stat };
}

export function decodeZkCreateResponse(body: Uint8Array, offset = 16): string {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const len = view.getInt32(offset, false);
  if (len <= 0) return '';
  return td.decode(body.subarray(offset + 4, offset + 4 + len));
}

export function parseZkMntrResponse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab > 0) {
      out[line.slice(0, tab).trim()] = line.slice(tab + 1).trim();
    } else {
      const sp = line.indexOf(' ');
      if (sp > 0) {
        out[line.slice(0, sp).trim()] = line.slice(sp + 1).trim();
      }
    }
  }
  return out;
}

export function parseZkStatResponse(text: string): {
  version?: string;
  mode?: string;
  nodeCount?: number;
  connections?: number;
  raw: string;
} {
  const verMatch = /Zookeeper version:\s*([^\r\n,]+)/i.exec(text);
  const modeMatch = /Mode:\s*([^\r\n]+)/i.exec(text);
  const nodeMatch = /Node count:\s*(\d+)/i.exec(text);
  const clientLines = text
    .split(/\r?\n/)
    .filter((l) => /^\s*\/[\d.:]+:\d+\[\d+\]/.test(l));
  return {
    version: verMatch?.[1]?.trim(),
    mode: modeMatch?.[1]?.trim(),
    nodeCount: nodeMatch ? Number(nodeMatch[1]) : undefined,
    connections: clientLines.length > 0 ? clientLines.length : undefined,
    raw: text,
  };
}

function normalizeZkPath(path: string): string {
  let p = (path || '/').trim();
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p;
}

/* ============================================================================
 * ZookeeperDriver (implements KvDriver)
 * ============================================================================ */

export class ZookeeperDriver implements KvDriver {
  readonly engine = 'zookeeper' as const;
  readonly family = 'kv' as const;

  private transport: ByteStreamTransport | null = null;
  private config: ConnectionConfig | null = null;
  private stream: BufferedByteStream | null = null;
  private _connected = false;
  private _serverVersion = 'ZooKeeper';
  private _tlsActive = false;
  private nextXid = 1;
  private sessionId = 0n;

  get connected(): boolean {
    return this._connected;
  }

  get serverVersion(): string {
    return this._serverVersion;
  }

  private requireStream(): BufferedByteStream {
    if (!this._connected || !this.stream) {
      throw new Error('ZooKeeper driver is not connected');
    }
    return this.stream;
  }

  private async readJutePacket(bs: BufferedByteStream): Promise<Uint8Array> {
    const lenBytes = await bs.readExact(4);
    const len = new DataView(lenBytes.buffer, lenBytes.byteOffset, 4).getInt32(0, false);
    if (len < 0 || len > 32 * 1024 * 1024) {
      throw new Error(`Invalid ZooKeeper packet length: ${len}`);
    }
    return len > 0 ? bs.readExact(len) : new Uint8Array(0);
  }

  private async sendOp(
    opcode: number,
    body: Uint8Array = new Uint8Array(0),
    explicitXid?: number,
  ): Promise<{ header: { xid: number; zxid: bigint; err: number; offset: number }; body: Uint8Array }> {
    const bs = this.requireStream();
    const xid = explicitXid ?? this.nextXid++;
    await bs.write(encodeZkRequest(xid, opcode, body));

    // Skip asynchronous watch notifications (xid === -1)
    for (let i = 0; i < 16; i++) {
      const resp = await this.readJutePacket(bs);
      const header = decodeZkReplyHeader(resp);
      if (header.xid === -1) continue;
      return { header, body: resp };
    }
    throw new Error('ZooKeeper reply timeout waiting for matching xid');
  }

  private async runFourLetterWord(cmd: 'mntr' | 'stat'): Promise<string> {
    if (!this.transport || !this.config) return '';
    const raw = await this.transport.connect({
      host: this.config.host || '127.0.0.1',
      port: this.config.port ?? 2181,
      tls: this._tlsActive,
      servername: this.config.host || '127.0.0.1',
      allowSelfSigned: this.config.allowSelfSigned,
      caPem: this.config.caPem,
      timeoutMs: Math.min(this.config.timeoutMs ?? 5000, 5000),
    });
    const bs = new BufferedByteStream(raw);
    try {
      await bs.write(te.encode(cmd));
      const out = await bs.readAllToEof(1024 * 1024);
      return td.decode(out);
    } finally {
      await bs.close().catch(() => {});
    }
  }

  async connect(config: ConnectionConfig, transport: ByteStreamTransport): Promise<ConnectionInfo> {
    const started = performance.now();
    const port = config.port ?? 2181;
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

    this.transport = transport;
    this.config = { ...config, port };
    this.stream = new BufferedByteStream(raw);
    this._tlsActive = tls;
    this._connected = true;

    try {
      await this.stream.write(encodeZkConnectRequest({ timeoutMs: config.timeoutMs ?? 30000 }));
      const respBytes = await this.readJutePacket(this.stream);
      const connResp = decodeZkConnectResponse(respBytes);
      this.sessionId = connResp.sessionId;

      // Best-effort 4LW version probe (mntr -> stat)
      try {
        const mntrText = await this.runFourLetterWord('mntr');
        const mntr = parseZkMntrResponse(mntrText);
        if (mntr.zk_version) {
          this._serverVersion = `ZooKeeper ${mntr.zk_version.split(',')[0].trim()}`;
        } else {
          const statText = await this.runFourLetterWord('stat');
          const stat = parseZkStatResponse(statText);
          this._serverVersion = stat.version ? `ZooKeeper ${stat.version}` : 'ZooKeeper';
        }
      } catch {
        this._serverVersion = 'ZooKeeper';
      }

      return {
        engine: 'zookeeper',
        family: 'kv',
        serverVersion: this._serverVersion,
        database: config.namespace || '/',
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
      const { header } = await this.sendOp(ZK_OPCODE.PING, new Uint8Array(0), -2);
      if (header.err !== ZK_ERR.OK) {
        throw new Error(`ZooKeeper ping error ${header.err}`);
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
    if (this._connected && this.stream) {
      await this.stream
        .write(encodeZkRequest(this.nextXid++, ZK_OPCODE.CLOSE_SESSION))
        .catch(() => {});
      await this.stream.close().catch(() => {});
    }
    this._connected = false;
    this.stream = null;
    this.sessionId = 0n;
  }

  private async getChildrenPaths(path: string): Promise<string[]> {
    const norm = normalizeZkPath(path);
    const { header, body } = await this.sendOp(
      ZK_OPCODE.GET_CHILDREN,
      encodeZkGetChildrenBody(norm, false),
    );
    if (header.err === ZK_ERR.NO_NODE) return [];
    if (header.err !== ZK_ERR.OK) {
      throw new Error(`ZooKeeper GetChildren(${norm}) failed with error ${header.err}`);
    }
    return decodeZkGetChildrenResponse(body, header.offset);
  }

  async listNamespaces(): Promise<KvNamespaceInfo[]> {
    this.requireStream();
    const rootChildren = await this.getChildrenPaths('/').catch(() => []);
    return [
      { id: '/', name: '/', count: rootChildren.length },
      ...rootChildren.map((child) => ({ id: `/${child}`, name: `/${child}` })),
    ];
  }

  async listKeys(
    prefix = '/',
    options?: { namespace?: string; group?: string; limit?: number },
  ): Promise<KvEntry[]> {
    this.requireStream();
    const limit = Math.max(1, options?.limit ?? 200);
    const startPath = normalizeZkPath(prefix || options?.namespace || '/');
    const entries: KvEntry[] = [];
    const queue: string[] = [startPath];

    while (queue.length > 0 && entries.length < limit) {
      const cur = queue.shift()!;
      const children = await this.getChildrenPaths(cur);
      for (const child of children) {
        if (entries.length >= limit) break;
        const fullPath = cur === '/' ? `/${child}` : `${cur}/${child}`;
        const detail = await this.getKey(fullPath).catch(() => null);
        entries.push(
          detail ?? {
            key: fullPath,
            value: '',
          },
        );
        if (entries.length < limit && queue.length < limit) {
          queue.push(fullPath);
        }
      }
    }
    return entries;
  }

  async getKey(key: string): Promise<KvEntry | null> {
    this.requireStream();
    const norm = normalizeZkPath(key);
    const { header, body } = await this.sendOp(
      ZK_OPCODE.GET_DATA,
      encodeZkGetDataBody(norm, false),
    );
    if (header.err === ZK_ERR.NO_NODE) return null;
    if (header.err !== ZK_ERR.OK) {
      throw new Error(`ZooKeeper GetData(${norm}) failed with error ${header.err}`);
    }
    const { data, stat } = decodeZkGetDataResponse(body, header.offset);
    return {
      key: norm,
      value: td.decode(data),
      version: stat.version,
      revision: stat.mzxid,
    };
  }

  async putKey(key: string, value: string): Promise<void> {
    this.requireStream();
    const norm = normalizeZkPath(key);
    const dataBytes = te.encode(value);

    const setRes = await this.sendOp(
      ZK_OPCODE.SET_DATA,
      encodeZkSetDataBody(norm, dataBytes, -1),
    );
    if (setRes.header.err === ZK_ERR.OK) return;
    if (setRes.header.err !== ZK_ERR.NO_NODE) {
      throw new Error(`ZooKeeper SetData(${norm}) failed with error ${setRes.header.err}`);
    }

    // Auto-create missing parent paths
    const segments = norm.split('/').filter(Boolean);
    let parent = '';
    for (let i = 0; i < segments.length - 1; i++) {
      parent += `/${segments[i]}`;
      await this.sendOp(
        ZK_OPCODE.CREATE,
        encodeZkCreateBody(parent, new Uint8Array(0), 0),
      ).catch(() => {});
    }

    const createRes = await this.sendOp(
      ZK_OPCODE.CREATE,
      encodeZkCreateBody(norm, dataBytes, 0),
    );
    if (createRes.header.err !== ZK_ERR.OK && createRes.header.err !== ZK_ERR.NODE_EXISTS) {
      throw new Error(`ZooKeeper Create(${norm}) failed with error ${createRes.header.err}`);
    }
  }

  async deleteKey(key: string): Promise<void> {
    this.requireStream();
    const norm = normalizeZkPath(key);
    const { header } = await this.sendOp(ZK_OPCODE.DELETE, encodeZkDeleteBody(norm, -1));
    if (header.err !== ZK_ERR.OK && header.err !== ZK_ERR.NO_NODE) {
      throw new Error(`ZooKeeper Delete(${norm}) failed with error ${header.err}`);
    }
  }

  async getClusterStatus(): Promise<Record<string, unknown>> {
    this.requireStream();
    try {
      const mntrText = await this.runFourLetterWord('mntr');
      const mntr = parseZkMntrResponse(mntrText);
      if (Object.keys(mntr).length > 0) {
        return { sessionId: this.sessionId.toString(), ...mntr };
      }
    } catch {
      // fallback to stat
    }
    try {
      const statText = await this.runFourLetterWord('stat');
      const stat = parseZkStatResponse(statText);
      return { sessionId: this.sessionId.toString(), ...stat };
    } catch {
      return { sessionId: this.sessionId.toString(), serverVersion: this._serverVersion };
    }
  }
}

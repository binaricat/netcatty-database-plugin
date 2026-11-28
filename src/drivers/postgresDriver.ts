/**
 * Pure-TS PostgreSQL Wire Protocol v3 Driver (100% browser-sandbox compatible).
 * Powers PostgreSQL and PG-family aliases: opengauss, gaussdb, kingbase, highgo, vastbase, uxdb.
 *
 * Features:
 * - STARTTLS (SSLRequest -> upgradeTls) with disable / prefer / require / verify-full modes
 * - SCRAM-SHA-256, MD5, Cleartext, Trust authentication
 * - Simple Query (multi-statement) & Extended Query (parameterized)
 * - Real CancelRequest over side connection using BackendKeyData (pid + secretKey)
 * - Rich PostgreSQL OID decoding (bool, int2/4/8, float4/8, numeric, json/jsonb, bytea, uuid, dates, arrays)
 * - Full catalog introspection, ER graph, EXPLAIN (FORMAT JSON), DDL builder, dump & diff
 */

import { md5Hex, ScramSha256Session } from './crypto';
import {
  buildAlterTableDdl,
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
  type ColumnMeta,
  type ColumnStructure,
  type ConnectionConfig,
  type ConnectionInfo,
  type CreateTableSpec,
  type CustomTypeSummary,
  type DatabaseEngineId,
  type DatabaseInfo,
  type DatabaseUserSummary,
  type DropObjectKind,
  type EventTriggerSummary,
  type ExplainResult,
  type ExtensionSummary,
  type ForeignKeyStructure,
  type IndexStructure,
  type MultiQueryResult,
  type ObjectDependency,
  type PartitionSummary,
  type ProcessEntry,
  type RuleSummary,
  type SequenceSummary,
  type ServerStatusSnapshot,
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
import { parsePostgresExplainJson } from '../sql/explainParser';
import { offsetToLineColumn } from '../sql/parameters';
import { diffSchemas as runSchemaDiff, generateSqlDump } from '../sql/schemaDiff';
import { splitSqlStatements } from '../sql/splitter';

const te = new TextEncoder();
const td = new TextDecoder('utf-8');

const PG_OID_NAMES: Record<number, string> = {
  16: 'bool',
  17: 'bytea',
  19: 'name',
  20: 'int8',
  21: 'int2',
  23: 'int4',
  25: 'text',
  26: 'oid',
  114: 'json',
  142: 'xml',
  700: 'float4',
  701: 'float8',
  1000: 'bool[]',
  1003: 'name[]',
  1005: 'int2[]',
  1007: 'int4[]',
  1009: 'text[]',
  1015: 'varchar[]',
  1016: 'int8[]',
  1021: 'float4[]',
  1022: 'float8[]',
  1042: 'bpchar',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1186: 'interval',
  1266: 'timetz',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
};

function i32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, false);
  return b;
}

function i16be(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setInt16(0, n, false);
  return b;
}

function cstr(s: string): Uint8Array {
  return concatBytes(te.encode(s), new Uint8Array([0]));
}

function pgFrame(tag: string, bodyParts: Uint8Array[]): Uint8Array {
  const body = concatBytes(...bodyParts);
  return concatBytes(te.encode(tag), i32be(body.length + 4), body);
}

function parsePgArray(raw: string, elemParser: (s: string) => unknown): unknown[] {
  if (!raw.startsWith('{') || !raw.endsWith('}')) return [raw];
  const inner = raw.slice(1, -1);
  if (inner.length === 0) return [];
  const items: unknown[] = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === '"') {
      i++;
      let buf = '';
      while (i < inner.length) {
        if (inner[i] === '\\' && i + 1 < inner.length) {
          buf += inner[i + 1];
          i += 2;
        } else if (inner[i] === '"') {
          i++;
          break;
        } else {
          buf += inner[i++];
        }
      }
      items.push(elemParser(buf));
      if (inner[i] === ',') i++;
    } else if (inner[i] === '{') {
      let depth = 0;
      const start = i;
      while (i < inner.length) {
        if (inner[i] === '{') depth++;
        else if (inner[i] === '}') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        i++;
      }
      items.push(parsePgArray(inner.slice(start, i), elemParser));
      if (inner[i] === ',') i++;
    } else {
      const comma = inner.indexOf(',', i);
      const token = comma < 0 ? inner.slice(i) : inner.slice(i, comma);
      items.push(token === 'NULL' ? null : elemParser(token));
      if (comma < 0) break;
      i = comma + 1;
    }
  }
  return items;
}

function decodePgBytea(text: string): Uint8Array {
  if (text.startsWith('\\x') || text.startsWith('\\X')) {
    const hex = text.slice(2);
    const out = new Uint8Array(Math.floor(hex.length / 2));
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  return te.encode(text);
}

export function decodePgValue(oid: number, rawBytes: Uint8Array | null): CellValue {
  if (rawBytes === null) return null;
  const text = td.decode(rawBytes);
  switch (oid) {
    case 16: // bool
      return text === 't' || text === 'true' || text === '1';
    case 17: // bytea
      return decodePgBytea(text);
    case 21: // int2
    case 23: // int4
    case 26: // oid
      return Number(text);
    case 20: { // int8
      const n = Number(text);
      return Number.isSafeInteger(n) ? n : text;
    }
    case 700: // float4
    case 701: // float8
      return Number(text);
    case 114: // json
    case 3802: // jsonb
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    case 1000:
      return parsePgArray(text, (s) => s === 't' || s === 'true');
    case 1005:
    case 1007:
      return parsePgArray(text, (s) => Number(s));
    case 1016:
      return parsePgArray(text, (s) => (Number.isSafeInteger(Number(s)) ? Number(s) : s));
    case 1021:
    case 1022:
      return parsePgArray(text, (s) => Number(s));
    case 1003: // name[]
    case 1009: // text[]
    case 1015: // varchar[]
      return parsePgArray(text, (s) => s);
    default:
      // Keep numeric (1700), date, timestamp, timestamptz, uuid, text as exact string
      return text;
  }
}

function normalizePgStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === 'string' && val.startsWith('{') && val.endsWith('}')) {
    return parsePgArray(val, (s) => s).map(String);
  }
  return [];
}

function parseErrorFields(
  payload: Uint8Array,
  sql?: string,
): QueryError {
  const fields: Record<string, string> = {};
  let p = 0;
  while (p < payload.length) {
    const code = payload[p++];
    if (code === 0) break;
    const end = payload.indexOf(0, p);
    if (end < 0) break;
    fields[String.fromCharCode(code)] = td.decode(payload.subarray(p, end));
    p = end + 1;
  }
  const msg = fields.M ?? 'PostgreSQL server error';
  const code = fields.C;
  const detail = fields.D;
  const hint = fields.H;
  const posNum = fields.P ? Number(fields.P) : undefined;
  const position = posNum && Number.isInteger(posNum) && posNum > 0 ? posNum : undefined;
  const loc = position && sql ? offsetToLineColumn(sql, position - 1) : undefined;
  const formatted = code ? `[${code}] ${msg}${detail ? ` (${detail})` : ''}` : msg;
  return new QueryError(formatted, {
    code,
    detail,
    hint,
    position,
    line: loc?.line,
    column: loc?.column,
  });
}

function parseCommandTagAffected(tag: string): number {
  const m = /(?:INSERT \d+|UPDATE|DELETE|MOVE|FETCH|COPY|MERGE)\s+(\d+)/.exec(tag);
  return m ? Number(m[1]) : 0;
}

export class PostgresDriver implements RelationalDriver {
  readonly engine: DatabaseEngineId;
  readonly family = 'postgres' as const;

  private stream: BufferedByteStream | null = null;
  private transport: ByteStreamTransport | null = null;
  private config: ConnectionConfig | null = null;
  private _connected = false;
  private _inTransaction = false;
  private _serverVersion = '';
  private _tlsActive = false;
  private backendPid = 0;
  private backendSecret = 0;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(engine: DatabaseEngineId = 'postgres') {
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

  private async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => {});
    return run;
  }

  private async readServerMessage(): Promise<{ tag: string; payload: Uint8Array }> {
    if (!this.stream) throw new Error('PostgreSQL connection is closed');
    const header = await this.stream.readExact(5);
    const tag = String.fromCharCode(header[0]);
    const length = new DataView(header.buffer, header.byteOffset + 1, 4).getInt32(0, false);
    if (length < 4) throw new Error(`Invalid PostgreSQL message length: ${length}`);
    const payload = await this.stream.readExact(length - 4);
    return { tag, payload };
  }

  async connect(config: ConnectionConfig, transport?: ByteStreamTransport): Promise<ConnectionInfo> {
    if (!transport) throw new Error('PostgreSQL driver requires a ByteStreamTransport');
    const started = performance.now();
    this.config = config;
    this.transport = transport;
    const host = config.host ?? '127.0.0.1';
    const port = config.port ?? 5432;
    const database = config.database ?? 'postgres';
    const username = config.username ?? 'postgres';
    const password = config.password ?? '';
    const tlsMode = config.tlsMode ?? 'prefer';

    const rawStream = await transport.connect({
      host,
      port,
      tls: false,
      servername: host,
      allowSelfSigned: config.allowSelfSigned ?? tlsMode !== 'verify-full',
      caPem: config.caPem,
      timeoutMs: config.timeoutMs ?? 15000,
    });
    const bs = new BufferedByteStream(rawStream);
    this.stream = bs;

    try {
      // STARTTLS negotiation via PostgreSQL SSLRequest (code 80877103)
      if (tlsMode !== 'disable') {
        const sslRequest = concatBytes(i32be(8), i32be(80877103));
        await bs.write(sslRequest);
        const resp = await bs.readByte();
        if (resp === 0x53) {
          // 'S' -> server supports SSL
          await bs.upgradeTls({
            servername: host,
            allowSelfSigned: config.allowSelfSigned ?? tlsMode !== 'verify-full',
            caPem: config.caPem,
          });
          this._tlsActive = true;
        } else if (resp === 0x4e) {
          // 'N' -> server does not support SSL
          if (tlsMode === 'require' || tlsMode === 'verify-full') {
            throw new Error('PostgreSQL server does not support SSL/TLS');
          }
          this._tlsActive = false;
        } else {
          throw new Error(`Unexpected PostgreSQL SSLRequest response byte: 0x${resp.toString(16)}`);
        }
      }

      // Send StartupMessage (protocol 3.0 = 196608)
      const paramsBody = concatBytes(
        i32be(196608),
        cstr('user'),
        cstr(username),
        cstr('database'),
        cstr(database),
        cstr('client_encoding'),
        cstr('UTF8'),
        cstr('application_name'),
        cstr('netcatty-database'),
        new Uint8Array([0]),
      );
      await bs.write(concatBytes(i32be(paramsBody.length + 4), paramsBody));

      // Authentication & startup message loop
      let scram: ScramSha256Session | null = null;
      while (true) {
        const msg = await this.readServerMessage();
        if (msg.tag === 'R') {
          const authCode = new DataView(msg.payload.buffer, msg.payload.byteOffset, 4).getInt32(0, false);
          const data = msg.payload.subarray(4);
          if (authCode === 0) {
            // AuthenticationOk
            continue;
          } else if (authCode === 3) {
            // Cleartext password
            await bs.write(pgFrame('p', [cstr(password)]));
          } else if (authCode === 5) {
            // MD5 password: "md5" + md5(md5(password + user) + salt)
            const salt = data.subarray(0, 4);
            const inner = md5Hex(password + username);
            const outer = md5Hex(concatBytes(te.encode(inner), salt));
            await bs.write(pgFrame('p', [cstr(`md5${outer}`)]));
          } else if (authCode === 10) {
            // AuthenticationSASL
            const mechs: string[] = [];
            let p = 0;
            while (p < data.length) {
              const end = data.indexOf(0, p);
              if (end <= p) break;
              mechs.push(td.decode(data.subarray(p, end)));
              p = end + 1;
            }
            if (!mechs.includes('SCRAM-SHA-256')) {
              throw new Error(`Unsupported PostgreSQL SASL mechanisms: ${mechs.join(', ')}`);
            }
            scram = new ScramSha256Session(username, password);
            const firstMsg = te.encode(scram.clientFirstMessage());
            await bs.write(pgFrame('p', [cstr('SCRAM-SHA-256'), i32be(firstMsg.length), firstMsg]));
          } else if (authCode === 11) {
            // AuthenticationSASLContinue
            if (!scram) throw new Error('Unexpected SASLContinue without SASL start');
            const serverFirst = td.decode(data);
            const clientFinal = await scram.processServerFirst(serverFirst);
            await bs.write(pgFrame('p', [te.encode(clientFinal)]));
          } else if (authCode === 12) {
            // AuthenticationSASLFinal
            if (!scram) throw new Error('Unexpected SASLFinal without SASL session');
            scram.verifyServerFinal(td.decode(data));
          } else {
            throw new Error(`Unsupported PostgreSQL authentication method: ${authCode}`);
          }
        } else if (msg.tag === 'S') {
          const nul = msg.payload.indexOf(0);
          if (nul > 0) {
            const key = td.decode(msg.payload.subarray(0, nul));
            const end = msg.payload.indexOf(0, nul + 1);
            const val = td.decode(msg.payload.subarray(nul + 1, end < 0 ? msg.payload.length : end));
            if (key === 'server_version') this._serverVersion = val;
          }
        } else if (msg.tag === 'K') {
          const dv = new DataView(msg.payload.buffer, msg.payload.byteOffset, msg.payload.byteLength);
          this.backendPid = dv.getInt32(0, false);
          this.backendSecret = dv.getInt32(4, false);
        } else if (msg.tag === 'Z') {
          const status = String.fromCharCode(msg.payload[0]);
          this._inTransaction = status === 'T' || status === 'E';
          break;
        } else if (msg.tag === 'E') {
          throw parseErrorFields(msg.payload);
        } else if (msg.tag === 'N') {
          // NoticeResponse — ignore during startup
        }
      }

      this._connected = true;
      return {
        engine: this.engine,
        family: 'postgres',
        serverVersion: this._serverVersion || 'PostgreSQL',
        database,
        tlsActive: this._tlsActive,
        latencyMs: Math.round(performance.now() - started),
        processId: this.backendPid,
      };
    } catch (error) {
      await bs.close().catch(() => {});
      this.stream = null;
      this._connected = false;
      throw error;
    }
  }

  async switchDatabase(db: string): Promise<ConnectionInfo> {
    if (!this.config || !this.transport) {
      throw new Error('PostgreSQL cannot switch database before connect');
    }
    const nextConfig: ConnectionConfig = { ...this.config, database: db };
    await this.close();
    return this.connect(nextConfig, this.transport);
  }

  async testConnection(): Promise<TestConnectionResult> {
    const started = performance.now();
    try {
      const res = await this.query('SELECT version()');
      const ver = String(res.results[0]?.rows[0]?.[0] ?? this._serverVersion);
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
    this._inTransaction = false;
    const bs = this.stream;
    this.stream = null;
    if (bs) {
      try {
        await bs.write(pgFrame('X', []));
      } catch {
        // ignore
      }
      await bs.close().catch(() => {});
    }
  }

  async cancelQuery(): Promise<void> {
    if (!this.transport || !this.config || !this.backendPid || !this.backendSecret) {
      return;
    }
    const cancelStream = await this.transport.connect({
      host: this.config.host ?? '127.0.0.1',
      port: this.config.port ?? 5432,
      tls: false,
      timeoutMs: 5000,
    });
    try {
      // CancelRequest: length=16, code=80877102, pid, secretKey
      const packet = concatBytes(i32be(16), i32be(80877102), i32be(this.backendPid), i32be(this.backendSecret));
      await cancelStream.write(packet);
    } finally {
      await cancelStream.close().catch(() => {});
    }
  }

  private async executeExtendedQuery(
    sql: string,
    params: readonly (string | number | boolean | null)[],
    maxRows: number,
  ): Promise<QueryResultSet> {
    const bs = this.stream!;
    const started = performance.now();

    const bindParts: Uint8Array[] = [cstr(''), cstr(''), i16be(0), i16be(params.length)];
    for (const p of params) {
      if (p === null || p === undefined) {
        bindParts.push(i32be(-1));
      } else {
        const encoded = te.encode(typeof p === 'boolean' ? (p ? 'true' : 'false') : String(p));
        bindParts.push(i32be(encoded.length), encoded);
      }
    }
    bindParts.push(i16be(0));

    const wire = concatBytes(
      pgFrame('P', [cstr(''), cstr(sql), i16be(0)]),
      pgFrame('B', bindParts),
      pgFrame('D', [te.encode('P'), cstr('')]),
      pgFrame('E', [cstr(''), i32be(0)]),
      pgFrame('S', []),
    );
    await bs.write(wire);

    let columns: ColumnMeta[] = [];
    let colOids: number[] = [];
    const rows: CellValue[][] = [];
    let truncated = false;
    let affectedRows = 0;
    let commandTag = '';
    let queryError: QueryError | undefined;

    while (true) {
      const msg = await this.readServerMessage();
      if (msg.tag === 'T') {
        const parsed = this.parseRowDescription(msg.payload);
        columns = parsed.columns;
        colOids = parsed.oids;
      } else if (msg.tag === 'D') {
        if (rows.length < maxRows) {
          rows.push(this.parseDataRow(msg.payload, colOids));
        } else {
          truncated = true;
        }
      } else if (msg.tag === 'C') {
        commandTag = td.decode(msg.payload.subarray(0, msg.payload.indexOf(0)));
        affectedRows = parseCommandTagAffected(commandTag);
      } else if (msg.tag === 'E') {
        queryError = parseErrorFields(msg.payload, sql);
      } else if (msg.tag === 'Z') {
        const status = String.fromCharCode(msg.payload[0]);
        this._inTransaction = status === 'T' || status === 'E';
        break;
      }
    }

    if (queryError) throw queryError;
    return {
      sql,
      columns,
      rows,
      rowCount: rows.length,
      affectedRows,
      executionMs: Math.round(performance.now() - started),
      truncated,
      commandTag,
    };
  }

  private async executeSimpleQuery(sql: string, maxRows: number): Promise<QueryResultSet[]> {
    const bs = this.stream!;
    const started = performance.now();
    await bs.write(pgFrame('Q', [cstr(sql)]));

    const results: QueryResultSet[] = [];
    let columns: ColumnMeta[] = [];
    let colOids: number[] = [];
    let rows: CellValue[][] = [];
    let truncated = false;
    let queryError: QueryError | undefined;

    while (true) {
      const msg = await this.readServerMessage();
      if (msg.tag === 'T') {
        const parsed = this.parseRowDescription(msg.payload);
        columns = parsed.columns;
        colOids = parsed.oids;
        rows = [];
        truncated = false;
      } else if (msg.tag === 'D') {
        if (rows.length < maxRows) {
          rows.push(this.parseDataRow(msg.payload, colOids));
        } else {
          truncated = true;
        }
      } else if (msg.tag === 'C') {
        const nul = msg.payload.indexOf(0);
        const tag = td.decode(nul >= 0 ? msg.payload.subarray(0, nul) : msg.payload);
        results.push({
          sql,
          columns,
          rows,
          rowCount: rows.length,
          affectedRows: parseCommandTagAffected(tag),
          executionMs: Math.round(performance.now() - started),
          truncated,
          commandTag: tag,
        });
        columns = [];
        colOids = [];
        rows = [];
        truncated = false;
      } else if (msg.tag === 'I') {
        // EmptyQueryResponse
        results.push({
          sql,
          columns: [],
          rows: [],
          rowCount: 0,
          affectedRows: 0,
          executionMs: Math.round(performance.now() - started),
          truncated: false,
          commandTag: 'EMPTY',
        });
      } else if (msg.tag === 'E') {
        queryError = parseErrorFields(msg.payload, sql);
      } else if (msg.tag === 'Z') {
        const status = String.fromCharCode(msg.payload[0]);
        this._inTransaction = status === 'T' || status === 'E';
        break;
      }
    }

    if (queryError) throw queryError;
    return results;
  }

  private parseRowDescription(payload: Uint8Array): { columns: ColumnMeta[]; oids: number[] } {
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const count = dv.getInt16(0, false);
    const columns: ColumnMeta[] = [];
    const oids: number[] = [];
    let p = 2;
    for (let i = 0; i < count; i++) {
      const nul = payload.indexOf(0, p);
      const name = td.decode(payload.subarray(p, nul));
      p = nul + 1;
      // tableOid (4), attrNum (2), typeOid (4), typeSize (2), typeModifier (4), format (2)
      const typeOid = dv.getUint32(p + 6, false);
      p += 18;
      oids.push(typeOid);
      columns.push({
        name,
        typeOid,
        dataType: PG_OID_NAMES[typeOid] ?? `oid(${typeOid})`,
      });
    }
    return { columns, oids };
  }

  private parseDataRow(payload: Uint8Array, oids: number[]): CellValue[] {
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const count = dv.getInt16(0, false);
    const row: CellValue[] = new Array(count);
    let p = 2;
    for (let i = 0; i < count; i++) {
      const len = dv.getInt32(p, false);
      p += 4;
      if (len === -1) {
        row[i] = null;
      } else {
        row[i] = decodePgValue(oids[i] ?? 25, payload.subarray(p, p + len));
        p += len;
      }
    }
    return row;
  }

  async query(sql: string, options?: QueryOptions): Promise<MultiQueryResult> {
    if (!this._connected || !this.stream) throw new Error('PostgreSQL is not connected');
    const maxRows = options?.maxRows ?? 10000;
    const totalStart = performance.now();

    const onAbort = () => {
      void this.cancelQuery().catch(() => {});
    };
    options?.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      return await this.enqueue(async () => {
        if (options?.params && options.params.length > 0) {
          const single = await this.executeExtendedQuery(sql, options.params, maxRows);
          return { results: [single], totalExecutionMs: Math.round(performance.now() - totalStart) };
        }
        const stmts = splitSqlStatements(sql, 'postgres');
        if (stmts.length <= 1) {
          const results = await this.executeSimpleQuery(sql, maxRows);
          return { results, totalExecutionMs: Math.round(performance.now() - totalStart) };
        }
        const allResults: QueryResultSet[] = [];
        for (const st of stmts) {
          const res = await this.executeSimpleQuery(st.sql, maxRows);
          allResults.push(...res);
        }
        return { results: allResults, totalExecutionMs: Math.round(performance.now() - totalStart) };
      });
    } finally {
      options?.signal?.removeEventListener('abort', onAbort);
    }
  }

  async beginTransaction(): Promise<void> {
    await this.query('BEGIN');
  }
  async commitTransaction(): Promise<void> {
    await this.query('COMMIT');
  }
  async rollbackTransaction(): Promise<void> {
    await this.query('ROLLBACK');
  }

  async listDatabases(): Promise<DatabaseInfo[]> {
    const res = await this.query(`
      SELECT d.datname,
             pg_catalog.pg_get_userbyid(d.datdba) AS owner,
             pg_catalog.pg_encoding_to_char(d.encoding) AS encoding,
             pg_catalog.pg_database_size(d.datname) AS size_bytes
      FROM pg_catalog.pg_database d
      WHERE d.datistemplate = false
      ORDER BY d.datname
    `);
    return (res.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      owner: r[1] ? String(r[1]) : undefined,
      encoding: r[2] ? String(r[2]) : undefined,
      sizeBytes: r[3] !== null ? Number(r[3]) : undefined,
    }));
  }

  async listSchemas(_db?: string): Promise<SchemaInfo[]> {
    const res = await this.query(`
      SELECT nspname, pg_catalog.pg_get_userbyid(nspowner) AS owner
      FROM pg_catalog.pg_namespace
      WHERE nspname NOT LIKE 'pg_temp_%' AND nspname NOT LIKE 'pg_toast_temp_%'
      ORDER BY nspname
    `);
    return (res.results[0]?.rows ?? []).map((r) => {
      const name = String(r[0]);
      return {
        name,
        owner: r[1] ? String(r[1]) : undefined,
        isSystem: name === 'pg_catalog' || name === 'information_schema' || name.startsWith('pg_toast'),
      };
    });
  }

  async listTables(db?: string, schema = 'public'): Promise<TableSummary[]> {
    const res = await this.query(
      `SELECT c.relname,
              c.relkind,
              GREATEST(
                CASE WHEN c.reltuples > 0 THEN c.reltuples::bigint
                     ELSE COALESCE(pg_catalog.pg_stat_get_live_tuples(c.oid), 0)
                END,
                0
              ) AS row_est,
              pg_catalog.pg_total_relation_size(c.oid) AS size_bytes,
              pg_catalog.obj_description(c.oid, 'pg_class') AS comment
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'f')
       ORDER BY c.relname`,
      { params: [schema] },
    );
    const database = db ?? this.config?.database ?? 'postgres';
    return (res.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      schema,
      database,
      kind: r[1] === 'p' ? 'partitioned_table' : r[1] === 'f' ? 'foreign_table' : 'table',
      rowCountEstimate: r[2] !== null ? Number(r[2]) : undefined,
      sizeBytes: r[3] !== null ? Number(r[3]) : undefined,
      comment: r[4] ? String(r[4]) : undefined,
    }));
  }

  async listViews(db?: string, schema = 'public'): Promise<ViewSummary[]> {
    const res = await this.query(
      `SELECT c.relname,
              c.relkind = 'm' AS is_mat,
              pg_catalog.pg_get_viewdef(c.oid, true) AS def,
              pg_catalog.obj_description(c.oid, 'pg_class') AS comment
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('v', 'm')
       ORDER BY c.relname`,
      { params: [schema] },
    );
    const database = db ?? this.config?.database ?? 'postgres';
    return (res.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      schema,
      database,
      isMaterialized: Boolean(r[1]),
      definition: r[2] ? String(r[2]) : undefined,
      comment: r[3] ? String(r[3]) : undefined,
    }));
  }

  async listRoutines(db?: string, schema = 'public'): Promise<RoutineSummary[]> {
    const res = await this.query(
      `SELECT p.proname,
              p.prokind,
              pg_catalog.pg_get_function_result(p.oid) AS ret_type,
              pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
              l.lanname,
              CASE WHEN p.prokind IN ('f', 'p') AND l.lanname NOT IN ('internal', 'c')
                   THEN pg_catalog.pg_get_functiondef(p.oid)
                   ELSE NULL
              END AS definition
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_catalog.pg_language l ON l.oid = p.prolang
       WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
       ORDER BY p.proname`,
      { params: [schema] },
    );
    const database = db ?? this.config?.database ?? 'postgres';
    return (res.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      schema,
      database,
      kind: r[1] === 'p' ? 'procedure' : 'function',
      returnType: r[2] ? String(r[2]) : undefined,
      arguments: r[3] ? String(r[3]) : undefined,
      language: r[4] ? String(r[4]) : undefined,
      definition: r[5] ? String(r[5]) : undefined,
    }));
  }

  async listTriggers(db?: string, schema = 'public'): Promise<TriggerSummary[]> {
    const res = await this.query(
      `SELECT t.tgname,
              c.relname AS table_name,
              pg_catalog.pg_get_triggerdef(t.oid) AS def,
              t.tgenabled <> 'D' AS enabled
       FROM pg_catalog.pg_trigger t
       JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND NOT t.tgisinternal
       ORDER BY c.relname, t.tgname`,
      { params: [schema] },
    );
    const database = db ?? this.config?.database ?? 'postgres';
    return (res.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      schema,
      database,
      tableName: String(r[1]),
      definition: r[2] ? String(r[2]) : undefined,
      enabled: r[3] !== undefined && r[3] !== null ? Boolean(r[3]) : true,
    }));
  }

  async listSequences(db?: string, schema = 'public'): Promise<SequenceSummary[]> {
    const database = db ?? this.config?.database ?? 'postgres';
    try {
      const res = await this.query(
        `SELECT c.relname,
                COALESCE(pg_catalog.format_type(s.seqtypid, NULL), 'bigint'),
                s.seqstart::text,
                s.seqmin::text,
                s.seqmax::text,
                s.seqincrement::text,
                s.seqcycle
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_catalog.pg_sequence s ON s.seqrelid = c.oid
         WHERE c.relkind = 'S' AND n.nspname = $1
         ORDER BY c.relname`,
        { params: [schema] },
      );
      return (res.results[0]?.rows ?? []).map((r) => {
        const name = String(r[0]);
        const dataType = r[1] ? String(r[1]) : 'bigint';
        const startValue = r[2] != null ? String(r[2]) : '1';
        const minValue = r[3] != null ? String(r[3]) : undefined;
        const maxValue = r[4] != null ? String(r[4]) : undefined;
        const increment = r[5] != null ? String(r[5]) : '1';
        const cycle = Boolean(r[6]);
        const qSeq = qualifiedTableName(database, schema, name, 'postgres');
        const definition = `CREATE SEQUENCE ${qSeq} AS ${dataType} INCREMENT BY ${increment}${minValue ? ` MINVALUE ${minValue}` : ''}${maxValue ? ` MAXVALUE ${maxValue}` : ''} START WITH ${startValue}${cycle ? ' CYCLE' : ' NO CYCLE'};`;
        return { name, schema, database, dataType, startValue, minValue, maxValue, increment, cycle, definition };
      });
    } catch {
      // PG < 10 / openGauss fallback
      const res = await this.query(
        `SELECT sequence_name, data_type, start_value, minimum_value, maximum_value, increment, cycle_option
         FROM information_schema.sequences
         WHERE sequence_schema = $1
         ORDER BY sequence_name`,
        { params: [schema] },
      );
      return (res.results[0]?.rows ?? []).map((r) => ({
        name: String(r[0]),
        schema,
        database,
        dataType: r[1] ? String(r[1]) : 'bigint',
        startValue: r[2] != null ? String(r[2]) : undefined,
        minValue: r[3] != null ? String(r[3]) : undefined,
        maxValue: r[4] != null ? String(r[4]) : undefined,
        increment: r[5] != null ? String(r[5]) : undefined,
        cycle: String(r[6]).toUpperCase() === 'YES',
      }));
    }
  }

  async listCustomTypes(db?: string, schema = 'public'): Promise<CustomTypeSummary[]> {
    const database = db ?? this.config?.database ?? 'postgres';
    const res = await this.query(
      `SELECT t.typname, t.typtype, d.description,
              CASE WHEN t.typtype = 'e' THEN ARRAY(SELECT e.enumlabel FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder) ELSE NULL END AS enum_vals
       FROM pg_catalog.pg_type t
       JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
       LEFT JOIN pg_catalog.pg_class c ON c.oid = t.typrelid
       LEFT JOIN pg_catalog.pg_description d ON d.objoid = t.oid AND d.classoid = 'pg_catalog.pg_type'::regclass AND d.objsubid = 0
       WHERE n.nspname = $1 AND t.typtype IN ('b','c','d','e','r','m') AND t.typisdefined AND t.typelem = 0 AND (t.typrelid = 0 OR c.relkind = 'c')
       ORDER BY t.typname`,
      { params: [schema] },
    );
    const mapKind = (k: string): CustomTypeSummary['kind'] => {
      if (k === 'e') return 'enum';
      if (k === 'c') return 'composite';
      if (k === 'd') return 'domain';
      if (k === 'r') return 'range';
      if (k === 'm') return 'multirange';
      return 'base';
    };
    return (res.results[0]?.rows ?? []).map((r) => {
      const name = String(r[0]);
      const kind = mapKind(String(r[1] ?? 'b'));
      const enumValues = r[3] != null ? normalizePgStringArray(r[3]) : undefined;
      const qType = qualifiedTableName(database, schema, name, 'postgres');
      const definition =
        kind === 'enum' && enumValues?.length
          ? `CREATE TYPE ${qType} AS ENUM (${enumValues.map((v) => `'${v.replaceAll("'", "''")}'`).join(', ')});`
          : `-- PostgreSQL ${kind} type ${qType}`;
      return {
        name,
        schema,
        database,
        kind,
        description: r[2] ? String(r[2]) : undefined,
        enumValues,
        definition,
      };
    });
  }

  async listExtensions(): Promise<ExtensionSummary[]> {
    const [instRes, availRes] = await Promise.all([
      this.query(
        `SELECT e.extname, COALESCE(e.extversion, ''), n.nspname, d.description
         FROM pg_catalog.pg_extension e
         JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
         LEFT JOIN pg_catalog.pg_description d ON d.objoid = e.oid AND d.classoid = 'pg_catalog.pg_extension'::regclass
         ORDER BY e.extname`,
      ).catch(() => null),
      this.query(
        `SELECT name, COALESCE(default_version, ''), comment
         FROM pg_catalog.pg_available_extensions
         WHERE installed_version IS NULL
         ORDER BY name
         LIMIT 200`,
      ).catch(() => null),
    ]);
    const installed: ExtensionSummary[] = (instRes?.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      version: String(r[1] ?? ''),
      schema: r[2] ? String(r[2]) : undefined,
      description: r[3] ? String(r[3]) : undefined,
      installed: true,
    }));
    const available: ExtensionSummary[] = (availRes?.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      version: String(r[1] ?? ''),
      description: r[2] ? String(r[2]) : undefined,
      installed: false,
    }));
    return [...installed, ...available];
  }

  async listEventTriggers(): Promise<EventTriggerSummary[]> {
    const res = await this.query(
      `SELECT e.evtname,
              e.evtevent,
              p.proname,
              e.evtenabled,
              e.evttags
       FROM pg_catalog.pg_event_trigger e
       LEFT JOIN pg_catalog.pg_proc p ON p.oid = e.evtfoid
       ORDER BY e.evtname`,
    ).catch(() => null);
    return (res?.results[0]?.rows ?? []).map((r) => {
      const name = String(r[0]);
      const event = String(r[1] ?? '');
      const functionName = r[2] ? String(r[2]) : undefined;
      const enabled = String(r[3] ?? 'O') !== 'D';
      const tags = r[4] != null ? normalizePgStringArray(r[4]) : undefined;
      const tagClause = tags?.length
        ? `\n  WHEN TAG IN (${tags.map((t) => `'${t.replaceAll("'", "''")}'`).join(', ')})`
        : '';
      const definition = `CREATE EVENT TRIGGER ${quoteIdent(name, 'postgres')}\n  ON ${event}${tagClause}${functionName ? `\n  EXECUTE FUNCTION ${quoteIdent(functionName, 'postgres')}()` : ''};`;
      return { name, event, functionName, enabled, tags, definition };
    });
  }

  async listRules(db?: string, schema = 'public'): Promise<RuleSummary[]> {
    const database = db ?? this.config?.database ?? 'postgres';
    const res = await this.query(
      `SELECT rulename, tablename, definition
       FROM pg_catalog.pg_rules
       WHERE schemaname = $1
       ORDER BY tablename, rulename`,
      { params: [schema] },
    ).catch(() => null);
    return (res?.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      schema,
      database,
      tableName: String(r[1] ?? ''),
      definition: r[2] ? String(r[2]) : undefined,
    }));
  }

  async listTablePartitions(_db: string, schema: string, table: string): Promise<PartitionSummary[]> {
    const targetSchema = schema || 'public';
    const res = await this.query(
      `SELECT child.relname,
              CASE pt.partstrat WHEN 'r' THEN 'RANGE' WHEN 'l' THEN 'LIST' WHEN 'h' THEN 'HASH' ELSE '' END AS method,
              pg_catalog.pg_get_partkeydef(parent.oid) AS expr,
              pg_catalog.pg_get_expr(child.relpartbound, child.oid) AS bound,
              child.reltuples::bigint AS row_est,
              pg_catalog.pg_total_relation_size(child.oid) AS size_bytes
       FROM pg_catalog.pg_inherits i
       JOIN pg_catalog.pg_class parent ON parent.oid = i.inhparent
       JOIN pg_catalog.pg_namespace pn ON pn.oid = parent.relnamespace
       JOIN pg_catalog.pg_class child ON child.oid = i.inhrelid
       LEFT JOIN pg_catalog.pg_partitioned_table pt ON pt.partrelid = parent.oid
       WHERE pn.nspname = $1 AND parent.relname = $2
       ORDER BY child.relname`,
      { params: [targetSchema, table] },
    ).catch(() => null);
    return (res?.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      method: r[1] ? String(r[1]) : undefined,
      expression: r[2] ? String(r[2]) : undefined,
      bound: r[3] ? String(r[3]) : undefined,
      rowCountEstimate: r[4] != null ? Number(r[4]) : undefined,
      sizeBytes: r[5] != null ? Number(r[5]) : undefined,
      active: true,
    }));
  }

  async listObjectDependencies(_db: string, schema: string, name: string): Promise<ObjectDependency[]> {
    const targetSchema = schema || 'public';
    const res = await this.query(
      `SELECT DISTINCT 'referenced_by' AS dir,
              CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view' WHEN 'r' THEN 'table' ELSE 'object' END AS kind,
              n.nspname, c.relname
       FROM pg_catalog.pg_depend d
       JOIN pg_catalog.pg_rewrite rw ON rw.oid = d.objid
       JOIN pg_catalog.pg_class c ON c.oid = rw.ev_class
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_class src ON src.oid = d.refobjid
       JOIN pg_catalog.pg_namespace sn ON sn.oid = src.relnamespace
       WHERE sn.nspname = $1 AND src.relname = $2 AND c.oid <> src.oid
       LIMIT 100`,
      { params: [targetSchema, name] },
    ).catch(() => null);
    return (res?.results[0]?.rows ?? []).map((r) => ({
      direction: 'referenced_by',
      kind: String(r[1] ?? 'object'),
      schema: String(r[2] ?? targetSchema),
      name: String(r[3] ?? ''),
    }));
  }

  async refreshMaterializedView(db: string, schema: string, name: string, concurrently = false): Promise<void> {
    const qName = qualifiedTableName(db, schema || 'public', name, 'postgres');
    await this.query(`REFRESH MATERIALIZED VIEW ${concurrently ? 'CONCURRENTLY ' : ''}${qName};`);
  }

  async createDatabase(name: string, options?: { charset?: string; owner?: string }): Promise<void> {
    const parts = [`CREATE DATABASE ${quoteIdent(name, 'postgres')}`];
    if (options?.owner) parts.push(`OWNER ${quoteIdent(options.owner, 'postgres')}`);
    if (options?.charset) parts.push(`ENCODING '${options.charset.replaceAll("'", "''")}'`);
    await this.query(`${parts.join(' ')};`);
  }

  async createSchema(_db: string, name: string): Promise<void> {
    await this.query(`CREATE SCHEMA ${quoteIdent(name, 'postgres')};`);
  }

  async listProcesses(): Promise<ProcessEntry[]> {
    const res = await this.query(
      `SELECT pid::text, COALESCE(usename, ''), COALESCE(client_addr::text, 'local'),
              COALESCE(datname, ''), COALESCE(backend_type, ''), COALESCE(state, ''),
              COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - query_start))::int, 0),
              COALESCE(query, ''), COALESCE(wait_event, ''), pid = pg_backend_pid()
       FROM pg_catalog.pg_stat_activity
       ORDER BY query_start DESC NULLS LAST
       LIMIT 200`,
    );
    return (res.results[0]?.rows ?? []).map((r) => ({
      id: String(r[0]),
      user: String(r[1] ?? ''),
      host: String(r[2] ?? ''),
      database: String(r[3] ?? ''),
      command: String(r[4] ?? ''),
      state: String(r[5] ?? ''),
      durationSec: r[6] != null ? Number(r[6]) : undefined,
      sql: r[7] ? String(r[7]) : undefined,
      waitEvent: r[8] ? String(r[8]) : undefined,
      isCurrentSession: Boolean(r[9]),
    }));
  }

  async killProcess(id: string, mode: 'cancel' | 'terminate' = 'cancel'): Promise<void> {
    const pid = Number(id);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid PostgreSQL backend PID');
    const fn = mode === 'terminate' ? 'pg_terminate_backend' : 'pg_cancel_backend';
    await this.query(`SELECT pg_catalog.${fn}(${pid});`);
  }

  async getServerStatus(): Promise<ServerStatusSnapshot> {
    const [statRes, varsRes] = await Promise.all([
      this.query(
        `SELECT
           EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint AS uptime_sec,
           (SELECT count(*) FROM pg_stat_activity WHERE state = 'active')::int AS active_conns,
           (SELECT count(*) FROM pg_stat_activity WHERE state = 'idle')::int AS idle_conns,
           (SELECT count(*) FROM pg_stat_activity)::int AS total_conns,
           COALESCE(SUM(xact_commit + xact_rollback), 0)::bigint AS total_xact,
           COALESCE(SUM(blks_hit), 0)::bigint AS blks_hit,
           COALESCE(SUM(blks_read), 0)::bigint AS blks_read,
           COALESCE(SUM(deadlocks), 0)::bigint AS deadlocks,
           COALESCE(SUM(temp_files), 0)::bigint AS temp_files
         FROM pg_stat_database`,
      ).catch(() => null),
      this.query(
        `SELECT name, setting, short_desc FROM pg_catalog.pg_settings ORDER BY name LIMIT 300`,
      ).catch(() => null),
    ]);
    const row = statRes?.results[0]?.rows[0];
    const blksHit = Number(row?.[5] ?? 0);
    const blksRead = Number(row?.[6] ?? 0);
    const cacheHitRatio = blksHit + blksRead > 0 ? Math.round((blksHit / (blksHit + blksRead)) * 10000) / 100 : 100;
    return {
      engine: this.engine,
      timestamp: Date.now(),
      uptimeSeconds: Number(row?.[0] ?? 0),
      activeConnections: Number(row?.[1] ?? 0),
      idleConnections: Number(row?.[2] ?? 0),
      totalConnections: Number(row?.[3] ?? 0),
      qpsOrTps: Number(row?.[4] ?? 0),
      cacheHitRatio,
      deadlocks: Number(row?.[7] ?? 0),
      metrics: [
        { key: 'total_xact', label: 'Transactions', value: String(row?.[4] ?? 0), group: 'Throughput' },
        { key: 'cache_hit', label: 'Cache Hit Ratio', value: `${cacheHitRatio}%`, group: 'Memory' },
        { key: 'deadlocks', label: 'Deadlocks', value: String(row?.[7] ?? 0), group: 'Locks' },
        { key: 'temp_files', label: 'Temp Files', value: String(row?.[8] ?? 0), group: 'Disk' },
      ],
      variables: (varsRes?.results[0]?.rows ?? []).map((r) => ({
        name: String(r[0]),
        value: String(r[1] ?? ''),
        description: r[2] ? String(r[2]) : undefined,
      })),
    };
  }

  async listUsers(): Promise<DatabaseUserSummary[]> {
    const res = await this.query(
      `SELECT rolname, rolsuper, rolcanlogin, rolcreatedb, rolcreaterole
       FROM pg_catalog.pg_roles
       ORDER BY rolname`,
    );
    return (res.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      isSuperuser: Boolean(r[1]),
      canLogin: Boolean(r[2]),
      canCreateDb: Boolean(r[3]),
      canCreateRole: Boolean(r[4]),
    }));
  }

  async getUserGrants(user: string): Promise<string[]> {
    const res = await this.query(
      `SELECT 'GRANT ' || privilege_type || ' ON ' || table_schema || '.' || table_name || ' TO ' || grantee
       FROM information_schema.role_table_grants
       WHERE grantee = $1
       LIMIT 200`,
      { params: [user] },
    ).catch(() => null);
    return (res?.results[0]?.rows ?? []).map((r) => String(r[0]));
  }

  async getTableStructure(db: string, schema: string, table: string): Promise<TableStructure> {
    const targetSchema = schema || 'public';
    const [relRes, colsRes, idxRes, fkRes, chkRes] = await Promise.all([
      this.query(
        `SELECT c.relkind,
                CASE WHEN c.relkind IN ('v', 'm') THEN pg_catalog.pg_get_viewdef(c.oid, true) ELSE NULL END AS view_def,
                pg_catalog.obj_description(c.oid, 'pg_class') AS comment
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2
         LIMIT 1`,
        { params: [targetSchema, table] },
      ),
      this.query(
        `SELECT a.attname,
                pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
                NOT a.attnotnull AS nullable,
                pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS default_val,
                COALESCE(pk.is_pk, false) AS is_pk,
                pk.pk_pos,
                (a.attidentity <> '' OR COALESCE(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid), '') LIKE 'nextval(%') AS is_auto,
                pg_catalog.col_description(c.oid, a.attnum) AS comment
         FROM pg_catalog.pg_attribute a
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
         LEFT JOIN LATERAL (
           SELECT true AS is_pk, array_position(con.conkey, a.attnum) AS pk_pos
           FROM pg_catalog.pg_constraint con
           WHERE con.conrelid = c.oid AND con.contype = 'p' AND a.attnum = ANY(con.conkey)
           LIMIT 1
         ) pk ON true
         WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`,
        { params: [targetSchema, table] },
      ),
      this.query(
        `SELECT ic.relname AS idx_name,
                i.indisunique,
                i.indisprimary,
                am.amname AS idx_type,
                pg_catalog.pg_get_indexdef(i.indexrelid) AS idx_def,
                ARRAY(
                  SELECT pg_catalog.pg_get_indexdef(i.indexrelid, k + 1, true)
                  FROM generate_subscripts(i.indkey, 1) AS k
                  ORDER BY k
                ) AS cols
         FROM pg_catalog.pg_index i
         JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = tc.relnamespace
         JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
         JOIN pg_catalog.pg_am am ON am.oid = ic.relam
         WHERE n.nspname = $1 AND tc.relname = $2
         ORDER BY i.indisprimary DESC, ic.relname`,
        { params: [targetSchema, table] },
      ),
      this.query(
        `SELECT con.conname,
                ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                      JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS src_cols,
                rn.nspname AS ref_schema,
                rc.relname AS ref_table,
                ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                      JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS ref_cols,
                con.confupdtype,
                con.confdeltype
         FROM pg_catalog.pg_constraint con
         JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid
         JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'f'
         ORDER BY con.conname`,
        { params: [targetSchema, table] },
      ),
      this.query(
        `SELECT con.conname, pg_catalog.pg_get_constraintdef(con.oid)
         FROM pg_catalog.pg_constraint con
         JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'c'
         ORDER BY con.conname`,
        { params: [targetSchema, table] },
      ),
    ]);

    const relRow = relRes.results[0]?.rows[0];
    const relKind = relRow?.[0] ? String(relRow[0]) : 'r';
    const viewDef = relRow?.[1] ? String(relRow[1]) : null;
    const tableComment = relRow?.[2] ? String(relRow[2]) : null;
    const objectKind: TableStructure['objectKind'] =
      relKind === 'v' ? 'view' : relKind === 'm' ? 'materialized_view' : 'table';

    const indexes: IndexStructure[] = (idxRes.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      unique: Boolean(r[1]),
      primary: Boolean(r[2]),
      type: r[3] ? String(r[3]) : undefined,
      definition: r[4] ? String(r[4]) : null,
      columns: normalizePgStringArray(r[5]),
    }));

    const fkAction = (code: unknown): string | undefined => {
      switch (String(code)) {
        case 'c': return 'CASCADE';
        case 'r': return 'RESTRICT';
        case 'n': return 'SET NULL';
        case 'd': return 'SET DEFAULT';
        case 'a': return 'NO ACTION';
        default: return undefined;
      }
    };

    const foreignKeys: ForeignKeyStructure[] = (fkRes.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      columns: normalizePgStringArray(r[1]),
      referencedSchema: String(r[2]),
      referencedTable: String(r[3]),
      referencedColumns: normalizePgStringArray(r[4]),
      onUpdate: fkAction(r[5]),
      onDelete: fkAction(r[6]),
    }));

    const fkColSet = new Set(foreignKeys.flatMap((fk) => fk.columns));

    const columns: ColumnStructure[] = (colsRes.results[0]?.rows ?? []).map((r) => {
      const name = String(r[0]);
      return {
        name,
        dataType: String(r[1]),
        nullable: Boolean(r[2]),
        defaultValue: r[3] !== null ? String(r[3]) : null,
        isPrimaryKey: Boolean(r[4]),
        primaryKeyOrdinal: r[5] !== null ? Number(r[5]) : undefined,
        isForeignKey: fkColSet.has(name),
        isAutoIncrement: Boolean(r[6]),
        comment: r[7] !== null ? String(r[7]) : null,
      };
    });

    const checkConstraints = (chkRes.results[0]?.rows ?? []).map((r) => ({
      name: String(r[0]),
      expression: String(r[1]),
    }));

    const qTable = qualifiedTableName(db, targetSchema, table, 'postgres');
    let createDdl: string;
    if (objectKind === 'view' && viewDef) {
      const cleanDef = viewDef.trim().replace(/;+\s*$/, '');
      createDdl = `CREATE OR REPLACE VIEW ${qTable} AS\n${cleanDef};`;
    } else if (objectKind === 'materialized_view' && viewDef) {
      const cleanDef = viewDef.trim().replace(/;+\s*$/, '');
      createDdl = `CREATE MATERIALIZED VIEW ${qTable} AS\n${cleanDef};`;
    } else {
      // Build pg_get_tabledef-style CREATE TABLE DDL
      const colLines = columns.map((c) => {
        let line = `  ${quoteIdent(c.name, 'postgres')} ${c.dataType}`;
        if (!c.nullable) line += ' NOT NULL';
        if (c.defaultValue !== null) line += ` DEFAULT ${c.defaultValue}`;
        return line;
      });
      const pkCols = columns
        .filter((c) => c.isPrimaryKey)
        .sort((a, b) => (a.primaryKeyOrdinal ?? 0) - (b.primaryKeyOrdinal ?? 0))
        .map((c) => quoteIdent(c.name, 'postgres'));
      if (pkCols.length > 0) {
        colLines.push(`  PRIMARY KEY (${pkCols.join(', ')})`);
      }
      for (const fk of foreignKeys) {
        const src = fk.columns.map((c) => quoteIdent(c, 'postgres')).join(', ');
        const refTbl = qualifiedTableName(db, fk.referencedSchema, fk.referencedTable, 'postgres');
        const ref = fk.referencedColumns.map((c) => quoteIdent(c, 'postgres')).join(', ');
        let fkLine = `  CONSTRAINT ${quoteIdent(fk.name, 'postgres')} FOREIGN KEY (${src}) REFERENCES ${refTbl} (${ref})`;
        if (fk.onDelete && fk.onDelete !== 'NO ACTION') fkLine += ` ON DELETE ${fk.onDelete}`;
        if (fk.onUpdate && fk.onUpdate !== 'NO ACTION') fkLine += ` ON UPDATE ${fk.onUpdate}`;
        colLines.push(fkLine);
      }
      for (const chk of checkConstraints) {
        colLines.push(`  CONSTRAINT ${quoteIdent(chk.name, 'postgres')} ${chk.expression}`);
      }
      const nonPkIndexes = indexes
        .filter((idx) => !idx.primary && idx.definition)
        .map((idx) => `${idx.definition};`);
      createDdl = [
        `CREATE TABLE ${qTable} (\n${colLines.join(',\n')}\n);`,
        ...nonPkIndexes,
      ].join('\n');
    }

    return {
      database: db || this.config?.database || 'postgres',
      schema: targetSchema,
      table,
      objectKind,
      columns,
      indexes,
      foreignKeys,
      checkConstraints,
      createDdl,
      comment: tableComment,
    };
  }

  async getSchemaErGraph(db: string, schema = 'public'): Promise<SchemaErGraph> {
    const tables = await this.listTables(db, schema);
    const erTables: SchemaErTable[] = [];
    const edges: SchemaErEdge[] = [];
    for (const t of tables) {
      const struct = await this.getTableStructure(db, schema, t.name);
      erTables.push({ name: t.name, schema, columns: struct.columns });
      for (const fk of struct.foreignKeys) {
        edges.push({
          id: `${t.name}.${fk.name}`,
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
    return { database: db || this.config?.database || 'postgres', schema, tables: erTables, edges };
  }

  async browseTable(
    db: string,
    schema: string,
    table: string,
    options?: BrowseTableOptions,
  ): Promise<BrowseTableResult> {
    const targetSchema = schema || 'public';
    const page = Math.max(1, options?.page ?? 1);
    const pageSize = Math.min(1000, Math.max(1, options?.pageSize ?? 50));
    const offset = (page - 1) * pageSize;
    const qTable = qualifiedTableName(db, targetSchema, table, 'postgres');

    const where = options?.whereClause?.trim() ? ` WHERE ${options.whereClause.trim()}` : '';
    const order = options?.sortBy
      ? ` ORDER BY ${quoteIdent(options.sortBy, 'postgres')} ${options.sortDir === 'desc' ? 'DESC' : 'ASC'}`
      : '';
    const dataSql = `SELECT * FROM ${qTable}${where}${order} LIMIT ${pageSize} OFFSET ${offset}`;
    const countSql = `SELECT COUNT(*) FROM ${qTable}${where}`;

    const started = performance.now();
    const [dataRes, countRes] = await Promise.all([
      this.query(dataSql, { maxRows: pageSize, signal: options?.signal }),
      this.query(countSql, { maxRows: 1, signal: options?.signal }),
    ]);

    const rs = dataRes.results[0];
    const totalRows = Number(countRes.results[0]?.rows[0]?.[0] ?? rs?.rowCount ?? 0);
    return {
      database: db || this.config?.database || 'postgres',
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
    return buildBatchMutations('postgres', db, schema, table, structure, changes);
  }

  async applyBatchMutations(sqlStatements: readonly string[]): Promise<BatchMutationApplyResult> {
    const started = performance.now();
    let affectedRows = 0;
    const wasInTx = this._inTransaction;
    if (!wasInTx) await this.beginTransaction();
    try {
      for (const stmt of sqlStatements) {
        const res = await this.query(stmt);
        for (const r of res.results) affectedRows += r.affectedRows;
      }
      if (!wasInTx) await this.commitTransaction();
      return {
        applied: sqlStatements.length,
        affectedRows,
        executionMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      if (!wasInTx) await this.rollbackTransaction().catch(() => {});
      throw err;
    }
  }

  async explain(sql: string, analyze = false): Promise<ExplainResult> {
    const prefix = analyze ? 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)' : 'EXPLAIN (FORMAT JSON)';
    const res = await this.query(`${prefix} ${sql}`);
    const raw = res.results[0]?.rows[0]?.[0];
    return parsePostgresExplainJson(raw, analyze);
  }

  generateAlterTableDdl(db: string, schema: string, table: string, diff: TableStructureDiff): string[] {
    return buildAlterTableDdl('postgres', db, schema, table, diff);
  }

  generateCreateTableDdl(db: string, schema: string, spec: CreateTableSpec): string {
    return buildCreateTableDdl('postgres', db, schema, spec);
  }

  async dropObject(
    db: string,
    schema: string,
    name: string,
    kind: DropObjectKind,
    cascade = false,
    tableName?: string,
  ): Promise<void> {
    await this.query(buildDropObjectSql('postgres', db, schema, name, kind, cascade, tableName));
  }

  async truncateTable(db: string, schema: string, table: string, cascade = false): Promise<void> {
    await this.query(buildTruncateTableSql('postgres', db, schema, table, cascade));
  }

  async dumpDatabaseSql(
    db: string,
    schema = 'public',
    tables?: string[],
    includeData = true,
  ): Promise<string> {
    const list = tables ?? (await this.listTables(db, schema)).map((t) => t.name);
    const dumpTables = [];
    for (const table of list) {
      const structure = await this.getTableStructure(db, schema, table);
      let columns = structure.columns.map((c) => c.name);
      let rows: CellValue[][] = [];
      if (includeData) {
        const qTable = qualifiedTableName(db, schema, table, 'postgres');
        const res = await this.query(`SELECT * FROM ${qTable}`, { maxRows: 50000 });
        columns = res.results[0]?.columns.map((c) => c.name) ?? columns;
        rows = res.results[0]?.rows ?? [];
      }
      dumpTables.push({ structure, columns, rows });
    }
    return generateSqlDump('postgres', db || this.config?.database || 'postgres', schema, dumpTables, includeData);
  }

  diffSchemas(leftSchema: SchemaSnapshot, rightSchema: SchemaSnapshot): SchemaDiffResult {
    return runSchemaDiff(leftSchema, rightSchema);
  }
}

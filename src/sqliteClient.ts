import initSqlJs from 'sql.js/dist/sql-asm.js';
import type { Database, SqlJsStatic } from 'sql.js';
import type { PluginContext } from '@netcatty/plugin-sdk';
import type { PluginDatabaseClient, WorkbenchContext } from './databaseClient';
import type { DatabaseHandleRequest, DatabaseQueryRequest, DatabaseQueryResult, DatabaseSavedConnection, DatabaseSaveConnectionRequest, DatabaseScalar, DatabaseSchemaResult } from './databaseTypes';

// No database RPC, native addon, WebAssembly, Worker, eval, direct network or user file.
// The engine runs in the existing offline plugin runtime. It has no hard CPU deadline.
const STORE_KEY = 'database.saved-memory-connections.v1';
const MAX_CONNECTIONS = 40;
let engine: Promise<SqlJsStatic> | undefined;
const unavailable = async (): Promise<never> => { throw new Error('This operation is not available on the Netcatty main adapter.'); };
const scalar = (value: unknown): DatabaseScalar => value instanceof Uint8Array ? `<BLOB ${value.length} bytes>` : value as DatabaseScalar;
function readSql(sql: string): string {
  let head = sql.trimStart();
  while (head.startsWith('--') || head.startsWith('/*')) {
    if (head.startsWith('--')) { const end = head.indexOf('\n'); head = end < 0 ? '' : head.slice(end + 1).trimStart(); }
    else { const end = head.indexOf('*/', 2); if (end < 0) break; head = head.slice(end + 2).trimStart(); }
  }
  if (!/^(SELECT|WITH|EXPLAIN)\b/i.test(head)) throw new Error('This SQLite workspace accepts one read-only SELECT, WITH or EXPLAIN statement.');
  return sql;
}
function validSaved(value: unknown): value is DatabaseSavedConnection {
  if (!value || typeof value !== 'object') return false;
  const c = value as DatabaseSavedConnection;
  return typeof c.id === 'string' && c.id.length <= 128 && typeof c.name === 'string' && c.name.length > 0 && c.name.length <= 128 && c.engine === 'sqlite' && c.targetKind === 'memory' && c.readOnly === true && ['default','blue','green','purple','orange'].includes(c.color)
    && Object.keys(c).every(key => ['id','name','engine','targetKind','readOnly','color'].includes(key));
}
export const SQLITE_SCHEMA_LIMITS = Object.freeze({ objects: 32, columns: 64, indexes: 32, foreignKeyColumns: 64, triggers: 32, text: 8192, bytes: 96 * 1024 });
/** Read-only schema inspection, exported for real-engine fixture regression tests. */
export function inspectSqliteSchema(db: Database): DatabaseSchemaResult {
  let bytes = 0;
  const rows = (sql: string, parameters: string[], limit: number, kind: string) => {
    const statement = db.prepare(sql);
    const result: ReturnType<typeof statement.get>[] = [];
    try {
      statement.bind(parameters);
      while (statement.step()) {
        if (result.length >= limit) throw new Error(`Schema exceeds the workspace ${kind} budget.`);
        const row = statement.get();
        if (row.some(value => typeof value === 'string' && value.length > SQLITE_SCHEMA_LIMITS.text)) throw new Error('Schema exceeds the workspace metadata text budget.');
        bytes += new TextEncoder().encode(JSON.stringify(row)).length;
        if (bytes > SQLITE_SCHEMA_LIMITS.bytes) throw new Error('Schema exceeds the workspace metadata byte budget.');
        result.push(row);
      }
      return result;
    } finally { statement.free(); }
  };
  const objects = rows("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name", [], SQLITE_SCHEMA_LIMITS.objects, 'object');
  const tables: DatabaseSchemaResult['tables'] = objects.map(([rawName, rawKind, definition]) => {
    const name = String(rawName); const kind = rawKind as 'table' | 'view';
    const columns = rows('SELECT cid,name,type,[notnull],dflt_value,pk FROM pragma_table_info(?) ORDER BY cid', [name], SQLITE_SCHEMA_LIMITS.columns, 'column');
    const indexes = rows('SELECT name,[unique],origin,partial FROM pragma_index_list(?) ORDER BY seq', [name], SQLITE_SCHEMA_LIMITS.indexes, 'index').map(([rawIndexName, unique, origin, partial]) => {
      const indexName = String(rawIndexName);
      const indexColumns = rows('SELECT name,cid,desc,coll FROM pragma_index_xinfo(?) WHERE [key]=1 ORDER BY seqno', [indexName], SQLITE_SCHEMA_LIMITS.columns, 'index column');
      const ddl = rows("SELECT sql FROM sqlite_master WHERE type='index' AND name=?", [indexName], 1, 'index definition')[0]?.[0];
      return { name: indexName, unique: Boolean(unique), origin: String(origin), partial: Boolean(partial), columns: indexColumns.map(([column, cid, desc, coll]) => ({name: column === null ? null : String(column), expression: Number(cid) === -2, descending: Boolean(desc), collation: coll === null ? null : String(coll)})), ...(typeof ddl === 'string' ? {definition: ddl} : {}) };
    });
    const foreignKeys: NonNullable<DatabaseSchemaResult['tables'][number]['foreignKeys']> = [];
    for (const [id, , targetTable, from, to, onUpdate, onDelete, match] of rows('SELECT id,seq,[table],[from],[to],on_update,on_delete,match FROM pragma_foreign_key_list(?) ORDER BY id,seq', [name], SQLITE_SCHEMA_LIMITS.foreignKeyColumns, 'foreign key column')) {
      let foreignKey = foreignKeys.find(item => item.id === Number(id));
      if (!foreignKey) { foreignKey = {id: Number(id), targetTable: String(targetTable), columns: [], onUpdate: String(onUpdate), onDelete: String(onDelete), match: String(match)}; foreignKeys.push(foreignKey); }
      foreignKey.columns.push({from: String(from), to: to === null ? null : String(to)});
    }
    const triggers = rows("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name", [name], SQLITE_SCHEMA_LIMITS.triggers, 'trigger').map(([triggerName, sql]) => ({name: String(triggerName), definition: String(sql)}));
    return {name, kind, columns: columns.map(([, columnName, type, notNull, , primaryKey]) => ({name: String(columnName), type: String(type), primaryKey: Boolean(primaryKey), ...(kind === 'table' ? {nullable: !notNull && !primaryKey} : {})})),
      ...(typeof definition === 'string' ? {definition} : {}), primaryKeyColumns: columns.filter(column => Number(column[5]) > 0).sort((a,b) => Number(a[5]) - Number(b[5])).map(column => String(column[1])), indexes, foreignKeys, triggers};
  });
  const result = {tables};
  if (new TextEncoder().encode(JSON.stringify(result)).length > SQLITE_SCHEMA_LIMITS.bytes) throw new Error('Schema exceeds the workspace metadata byte budget.');
  return result;
}
export function createWorkbenchContext(context: PluginContext): WorkbenchContext {
  const sessions = new Map<string, Database>();
  let disposed = false;
  const assertLive = () => { if (disposed) throw new Error("Database runtime is closed."); };
  const get = ({handleId}: DatabaseHandleRequest) => { assertLive(); const db = sessions.get(handleId); if (!db) throw new Error('Database connection is closed.'); return db; };
  const list = async () => {
    assertLive();
    const value = await context.storage.get(STORE_KEY);
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_CONNECTIONS || !value.every(validSaved)) throw new Error('Saved connection metadata is invalid.');
    return value;
  };
  let mutations: Promise<unknown> = Promise.resolve();
  function mutate<T>(operation: () => Promise<T>): Promise<T> { const next = mutations.then(operation); mutations = next.catch(() => {}); return next; }
  const close = async (target: DatabaseHandleRequest): Promise<null> => { const db = sessions.get(target.handleId); sessions.delete(target.handleId); db?.close(); return null; };
  const open = async () => {
    assertLive();
    if (sessions.size >= 4) throw new Error('Close an existing connection before opening another.');
    const SQL = await (engine ??= initSqlJs());
    assertLive();
    if (sessions.size >= 4) throw new Error('Close an existing connection before opening another.');
    const db = new SQL.Database();
    try {
      db.run(`CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL);
        INSERT INTO notes VALUES (1,'Synthetic launch checklist','open'),(2,'Document the query','done'),(3,'Parameter binding example','open');
        CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO customers VALUES (1,'Ada'),(2,'林');
        CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), amount REAL, memo TEXT);
        INSERT INTO orders VALUES (1,1,29.5,NULL),(2,2,45.25,''),(3,1,12.0,'Sample order');
        CREATE VIEW order_totals AS SELECT c.name, SUM(o.amount) AS total FROM customers c JOIN orders o ON o.customer_id=c.id GROUP BY c.id;
        PRAGMA hard_heap_limit=8388608;
        PRAGMA query_only=ON;`);
      const handleId = crypto.randomUUID(); sessions.set(handleId, db);
      return {handleId, engine: 'sqlite' as const, label: 'Disposable synthetic notes' as const, fixture: true as const, readOnly: true as const};
    } catch (error) { db.close(); throw error; }
  };
  const query = async (request: DatabaseQueryRequest): Promise<DatabaseQueryResult> => {
    const db = get(request); const started = performance.now();
    if (request.mode !== 'read') throw new Error('This SQLite workspace is read-only.');
    if (!request.sql || request.sql.length > 8192) throw new Error('SQL must contain at most 8192 characters.');
    if (!Array.isArray(request.parameters) || request.parameters.length > 32) throw new Error('Invalid SQL parameters.');
    if (request.maxRows !== undefined && (!Number.isInteger(request.maxRows) || request.maxRows < 1 || request.maxRows > 100)) throw new Error("Invalid row limit.");
    const sql = readSql(request.sql);
    let count = 0;
    for (const statement of db.iterateStatements(sql)) { void statement; if (++count > 1) throw new Error('Run one SQL statement at a time.'); }
    if (count !== 1) throw new Error('Run one SQL statement at a time.');
    const statement = db.prepare(sql);
    try {
      statement.bind(request.parameters.map(value => typeof value === 'boolean' ? Number(value) : value));
      const columns = statement.getColumnNames();
      if (columns.length > 64) throw new Error('Results support at most 64 columns.');
      const rows: DatabaseScalar[][] = []; let bytes = JSON.stringify(columns).length; let truncated = false;
      const limit = Math.min(100, Math.max(1, Math.floor(request.maxRows ?? 100)));
      while (statement.step()) {
        if (rows.length >= limit) { truncated = true; break; }
        const row = statement.get().map(scalar); bytes += new TextEncoder().encode(JSON.stringify(row)).length;
        if (bytes > 96 * 1024) { truncated = true; break; }
        rows.push(row);
      }
      return {columns, rows, truncated, changes:0, elapsedMs: Math.round(performance.now()-started)};
    } finally { statement.free(); }
  };
  const readSchema = async (request: DatabaseHandleRequest): Promise<DatabaseSchemaResult> => inspectSqliteSchema(get(request));
  const database: PluginDatabaseClient & {capabilities: ReadonlySet<string>} = {
    capabilities: new Set(['database.sqlite-fixture.v1','database.saved-connections.v1']),
    openFixture: open, readSchema, query, close, cancel:close,
    listSavedConnections:list,
    saveConnection: (request: DatabaseSaveConnectionRequest) => mutate(async () => {
      get(request);
      if (request.secret || request.meta.hostId) throw new Error('Credentials and host bindings are not supported by the memory adapter.');
      const saved = await list();
      if (saved.length >= MAX_CONNECTIONS) throw new Error('The saved connection limit has been reached.');
      const value: DatabaseSavedConnection = {id:crypto.randomUUID(),name:request.meta.name,color:request.meta.color,engine:'sqlite',targetKind:'memory',readOnly:true};
      if (!validSaved(value)) throw new Error('Invalid connection metadata.');
      assertLive(); await context.storage.set(STORE_KEY,[...saved,value]); return value;
    }),
    openSavedConnection: async ({id}) => { if (!(await list()).some(c => c.id===id)) throw new Error('Saved connection not found.'); return open(); },
    deleteConnection: ({id}) => mutate(async () => { await context.storage.set(STORE_KEY,(await list()).filter(c=>c.id!==id)); return null; }),
    openTcp: unavailable, openSqliteFile: unavailable, refreshSqliteFile: unavailable,
    listHostsForDatabase: unavailable, testTunnel: unavailable, cancelTunnelTest: unavailable,
    probeHostDatabasePorts: unavailable, cancelHostDatabasePorts: unavailable,
    openHostLiveSshPgFixture: unavailable, cancelHostLiveSshPgFixture: unavailable, closeHostLiveSshPgSession: unavailable,
  };
  context.subscriptions.add({dispose() { disposed = true; for (const db of sessions.values()) db.close(); sessions.clear(); }});
  return Object.assign(Object.create(context), {database}) as WorkbenchContext;
}

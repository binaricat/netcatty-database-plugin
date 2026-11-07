import {previewCreateIndexSql,CreateIndexError} from './schemaCreateIndex';
import type {DatabaseCreateIndexRequest,DatabaseCreateIndexApplyRequest,DatabaseCreateIndexReview,DatabaseCreateIndexResult} from './databaseTypes';
import {previewCreateTableSql,CreateTableError} from './schemaCreateTable';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import type { Database, SqlJsStatic } from 'sql.js';
import type { PluginContext } from '@netcatty/plugin-sdk';
import type { PluginDatabaseClient, WorkbenchContext } from './databaseClient';
import type { DatabaseHandleRequest, DatabaseQueryRequest, DatabaseQueryResult, DatabaseSavedConnection, DatabaseSaveConnectionRequest, DatabaseScalar, DatabaseSchemaResult, DatabaseCreateTableRequest, DatabaseCreateTableApplyRequest, DatabaseCreateTableReview, DatabaseCreateTableResult } from './databaseTypes';

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
/** Deliberately small write grammar: no subqueries, functions, expressions, scripts or DDL. */
function reviewedWriteSql(request: DatabaseQueryRequest): string {
  const review = request.writeConfirmation;
  if (!review || review.handleId !== request.handleId || review.sql !== request.sql || JSON.stringify(review.parameters) !== JSON.stringify(request.parameters)) throw new Error('Explicit write confirmation must match this connection, SQL and parameters.');
  const tokens: string[] = []; let rest = request.sql;
  while (rest.trim()) {
    rest = rest.trimStart();
    const match = /^(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|<>|!=|<=|>=|[?(),;=<>+-])/.exec(rest);
    if (!match) throw new Error('Reviewed writes support only simple parameterized INSERT, UPDATE or DELETE statements.');
    rest = rest.slice(match[0].length);
    if (!match[0].startsWith('--') && !match[0].startsWith('/*')) tokens.push(match[0]);
    if (tokens.length > 512) throw new Error('Write exceeds the token budget.');
  }
  let i = 0; const peek = () => tokens[i]?.toUpperCase();
  const expect = (token: string) => { if (peek() !== token) throw new Error('Unsupported reviewed write syntax. Use scalar values and simple AND predicates.'); i++; };
  const identifier = () => { const token = tokens[i]; if (!token || !/^(?:[A-Za-z_][A-Za-z_0-9]*|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\])$/.test(token)) throw new Error('Write identifier is invalid.'); i++; };
  const tableIdentifier = () => {
    const token = tokens[i] ?? '';
    const name = token.startsWith('"') ? token.slice(1,-1).replaceAll('""','"') : token.startsWith('`') ? token.slice(1,-1).replaceAll('``','`') : token.startsWith('[') ? token.slice(1,-1) : token;
    if (name.toLowerCase().startsWith('sqlite_')) throw new Error('SQLite system tables cannot be modified.');
    identifier();
  };
  const value = () => {
    if (peek() === '+' || peek() === '-') { i++; if (!/^(?:\d|\.)/.test(tokens[i] ?? '')) throw new Error('Signed write value must be numeric.'); }
    const token = tokens[i];
    if (!token || !/^(?:\?|'(?:''|[^'])*'|NULL|TRUE|FALSE|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/i.test(token)) throw new Error('Write values must be scalar literals or bound parameters.');
    i++;
  };
  const where = () => {
    if (peek() !== 'WHERE') return;
    i++;
    do { identifier(); if (!['=', '!=', '<>', '<', '>', '<=', '>=', 'IS'].includes(peek())) throw new Error('Unsupported write predicate.'); const op = peek(); i++; if (op === 'IS' && peek() === 'NOT') i++; value(); if (peek() !== 'AND') break; i++; } while (true);
  };
  const operation = peek(); i++;
  if (operation === 'INSERT') {
    expect('INTO'); tableIdentifier();
    if (peek() === '(') { i++; identifier(); while (peek() === ',') { i++; identifier(); } expect(')'); }
    expect('VALUES'); expect('('); value(); while (peek() === ',') { i++; value(); } expect(')');
  } else if (operation === 'UPDATE') {
    tableIdentifier(); expect('SET'); identifier(); expect('='); value();
    while (peek() === ',') { i++; identifier(); expect('='); value(); } where();
  } else if (operation === 'DELETE') { expect('FROM'); tableIdentifier(); where(); }
  else throw new Error('Reviewed writes allow only INSERT, UPDATE or DELETE.');
  if (peek() === ';') i++;
  if (i !== tokens.length) throw new Error('Run one simple write statement at a time.');
  return request.sql;
}
function validSaved(value: unknown): value is DatabaseSavedConnection {
  if (!value || typeof value !== 'object') return false;
  const c = value as DatabaseSavedConnection;
  return typeof c.id === 'string' && c.id.length <= 128 && typeof c.name === 'string' && c.name.length > 0 && c.name.length <= 128 && c.engine === 'sqlite' && c.targetKind === 'memory' && typeof c.readOnly === 'boolean' && ['default','blue','green','purple','orange'].includes(c.color)
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
  const tableReviews=new Map<string,string>();
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
  const close = async (target: DatabaseHandleRequest): Promise<null> => { const db = sessions.get(target.handleId); tableReviews.delete(target.handleId); sessions.delete(target.handleId); db?.close(); return null; };
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
        PRAGMA foreign_keys=ON;
        PRAGMA query_only=ON;`);
      const handleId = crypto.randomUUID(); sessions.set(handleId, db);
      return {handleId, engine: 'sqlite' as const, label: 'Disposable synthetic notes' as const, fixture: true as const, readOnly: false as const, supportsReviewedWrites: true as const};
    } catch (error) { db.close(); throw error; }
  };
  const query = async (request: DatabaseQueryRequest): Promise<DatabaseQueryResult> => {
    const db = get(request); const started = performance.now();
    if (request.mode !== 'read' && request.mode !== 'write') throw new Error('Invalid query mode.');
    if (!request.sql || request.sql.length > 8192) throw new Error('SQL must contain at most 8192 characters.');
    if (!Array.isArray(request.parameters) || request.parameters.length > 32 || request.parameters.some(value => !(value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 2048))) throw new Error('Invalid SQL parameters.');
    if (request.maxRows !== undefined && (!Number.isInteger(request.maxRows) || request.maxRows < 1 || request.maxRows > 100)) throw new Error("Invalid row limit.");
    if (request.mode === 'write') {
      const sql = reviewedWriteSql(request);
      let transaction = false;
      try {
        db.run('PRAGMA query_only=OFF');
        db.run('SAVEPOINT plugin_reviewed_write'); transaction = true;
        const statement = db.prepare(sql);
        try { statement.bind(request.parameters.map(value => typeof value === 'boolean' ? Number(value) : value)); while (statement.step()) { /* grammar has no RETURNING */ } } finally { statement.free(); }
        const changes = db.getRowsModified();
        if (changes > 100) throw new Error('Write affects more than 100 rows; transaction rolled back.');
        const size = db.exec('PRAGMA page_count')[0].values[0][0] as number;
        const pageSize = db.exec('PRAGMA page_size')[0].values[0][0] as number;
        if (size * pageSize > 1024 * 1024) throw new Error('Write exceeds the 1 MiB database budget; transaction rolled back.');
        const schema = inspectSqliteSchema(db);
        for (const table of schema.tables.filter(item => item.kind === 'table')) {
          const quoted = '"' + table.name.replaceAll('"','""') + '"';
          if (Number(db.exec(`SELECT COUNT(*) FROM ${quoted}`)[0].values[0][0]) > 10000) throw new Error('Write exceeds the 10000 rows per table budget; transaction rolled back.');
        }
        db.run('RELEASE plugin_reviewed_write'); transaction = false;
        return {columns: [], rows: [], truncated: false, changes, elapsedMs: Math.round(performance.now()-started), schema};
      } catch (error) {
        if (transaction) {
          try { db.run('ROLLBACK TO plugin_reviewed_write; RELEASE plugin_reviewed_write'); }
          catch { tableReviews.delete(request.handleId); sessions.delete(request.handleId); db.close(); }
        }
        throw error;
      } finally {
        if (sessions.has(request.handleId)) {
          try { db.run('PRAGMA query_only=ON'); } catch { tableReviews.delete(request.handleId); sessions.delete(request.handleId); db.close(); throw new Error('SQLite read protection could not be restored; session closed.'); }
        }
      }
    }
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
  const schemaRevision=(db:Database):number=>{
    const revision=db.exec('PRAGMA schema_version')[0]?.values[0]?.[0];
    if(typeof revision!=='number'||!Number.isSafeInteger(revision)||revision<0)throw new CreateTableError('stale');return revision;
  };
  const previewCreateTable=async(request:DatabaseCreateTableRequest):Promise<DatabaseCreateTableReview>=>{
    const db=get(request);tableReviews.delete(request.handleId);const schema=inspectSqliteSchema(db);
    if(schema.tables.length>=SQLITE_SCHEMA_LIMITS.objects)throw new CreateTableError('budget');
    const preview=previewCreateTableSql(request.draft,schema.tables.map(table=>table.name));
    const review={handleId:request.handleId,...preview,schemaRevision:schemaRevision(db)};
    tableReviews.set(request.handleId,JSON.stringify(review));return review;
  };
  const applyCreateTable=async(request:DatabaseCreateTableApplyRequest):Promise<DatabaseCreateTableResult>=>{
    const db=get(request),review=request.review;
    if(!review||review.handleId!==request.handleId||!Number.isSafeInteger(review.schemaRevision)||review.schemaRevision!==schemaRevision(db))throw new CreateTableError('stale');
    if(tableReviews.get(request.handleId)!==JSON.stringify(review))throw new CreateTableError('review');
    tableReviews.delete(request.handleId); // One issued preview per connection, consumed once.
    const preview=previewCreateTableSql(review.draft);
    if(preview.sql!==review.sql||JSON.stringify(preview.draft)!==JSON.stringify(review.draft))throw new CreateTableError('review');
    const before=inspectSqliteSchema(db);
    if(before.tables.length>=SQLITE_SCHEMA_LIMITS.objects)throw new CreateTableError('budget');
    previewCreateTableSql(review.draft,before.tables.map(table=>table.name));
    let transaction=false;
    try{
      db.run('PRAGMA query_only=OFF');db.run('SAVEPOINT plugin_create_table');transaction=true;
      db.run(preview.sql);
      const size=Number(db.exec('PRAGMA page_count')[0].values[0][0])*Number(db.exec('PRAGMA page_size')[0].values[0][0]);
      if(size>1024*1024)throw new CreateTableError('budget');
      const schema=inspectSqliteSchema(db);
      db.run('RELEASE plugin_create_table');transaction=false;
      return {changes:0,schema,sql:preview.sql};
    }catch(error){
      if(transaction){try{db.run('ROLLBACK TO plugin_create_table; RELEASE plugin_create_table');}catch{tableReviews.delete(request.handleId);sessions.delete(request.handleId);db.close();}}
      throw error;
    }finally{
      if(sessions.has(request.handleId)){try{db.run('PRAGMA query_only=ON');}catch{tableReviews.delete(request.handleId);sessions.delete(request.handleId);db.close();throw new Error('SQLite read protection could not be restored; session closed.');}}
    }
  };
  const previewCreateIndex=async(request:DatabaseCreateIndexRequest):Promise<DatabaseCreateIndexReview>=>{
    const db=get(request);tableReviews.delete(request.handleId);
    const preview=previewCreateIndexSql(request.draft,inspectSqliteSchema(db));
    const review={handleId:request.handleId,...preview,schemaRevision:schemaRevision(db)};
    tableReviews.set(request.handleId,JSON.stringify(review));return review;
  };
  const applyCreateIndex=async(request:DatabaseCreateIndexApplyRequest):Promise<DatabaseCreateIndexResult>=>{
    const db=get(request),review=request.review;
    if(!review||review.handleId!==request.handleId||!Number.isSafeInteger(review.schemaRevision)||review.schemaRevision!==schemaRevision(db))throw new CreateIndexError('stale');
    if(tableReviews.get(request.handleId)!==JSON.stringify(review))throw new CreateIndexError('review');
    tableReviews.delete(request.handleId);
    const preview=previewCreateIndexSql(review.draft,inspectSqliteSchema(db));
    if(preview.sql!==review.sql||JSON.stringify(preview.draft)!==JSON.stringify(review.draft))throw new CreateIndexError('review');
    let transaction=false;
    try{
      db.run('PRAGMA query_only=OFF');db.run('SAVEPOINT plugin_create_index');transaction=true;
      db.run(preview.sql);
      const size=Number(db.exec('PRAGMA page_count')[0].values[0][0])*Number(db.exec('PRAGMA page_size')[0].values[0][0]);
      if(size>1024*1024)throw new CreateIndexError('budget');
      const schema=inspectSqliteSchema(db);
      db.run('RELEASE plugin_create_index');transaction=false;return {changes:0,schema,sql:preview.sql};
    }catch(error){
      if(transaction){try{db.run('ROLLBACK TO plugin_create_index; RELEASE plugin_create_index');}catch{tableReviews.delete(request.handleId);sessions.delete(request.handleId);db.close();}}
      throw error;
    }finally{
      if(sessions.has(request.handleId)){try{db.run('PRAGMA query_only=ON');}catch{tableReviews.delete(request.handleId);sessions.delete(request.handleId);db.close();throw new Error('SQLite read protection could not be restored; session closed.');}}
    }
  };
  const database: PluginDatabaseClient & {capabilities: ReadonlySet<string>} = {
    capabilities: new Set(['database.sqlite-fixture.v1','database.saved-connections.v1','database.sqlite-reviewed-writes.v1','database.sqlite-create-table.v1','database.sqlite-create-index.v1']),
    previewCreateTable,applyCreateTable,previewCreateIndex,applyCreateIndex,
    openFixture: open, readSchema, query, close, cancel:close,
    listSavedConnections:list,
    saveConnection: (request: DatabaseSaveConnectionRequest) => mutate(async () => {
      get(request);
      if (request.secret || request.meta.hostId) throw new Error('Credentials and host bindings are not supported by the memory adapter.');
      const saved = await list();
      if (saved.length >= MAX_CONNECTIONS) throw new Error('The saved connection limit has been reached.');
      const value: DatabaseSavedConnection = {id:crypto.randomUUID(),name:request.meta.name,color:request.meta.color,engine:'sqlite',targetKind:'memory',readOnly:false};
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
  context.subscriptions.add({dispose() { disposed = true; for (const db of sessions.values()) db.close(); sessions.clear(); tableReviews.clear(); }});
  return Object.assign(Object.create(context), {database}) as WorkbenchContext;
}

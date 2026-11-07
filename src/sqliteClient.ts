import {createDropColumnAdapter} from './sqliteDropColumn';
import {createRenameTableAdapter} from './sqliteRenameTable';
import {previewSqliteGridBatch,executeSqliteGridBatch} from './sqliteGridBatch';
import {GridBatchError} from './gridBatchMutation';
import type {GridBatchRequest,GridBatchReview,GridBatchApplyRequest} from './databaseTypes';
import {createQueryLibraryStorage,QueryLibraryStorageError} from './queryLibraryStorage';
import {createSnapshotStorage} from './snapshotStorage';
import {SqliteSnapshotError,exportProtectedSnapshot,validateSnapshotDatabase,protectSnapshotDatabase} from './sqliteSnapshot';
import type {SnapshotRestoreReview} from './databaseTypes';
import {previewRowInsert as buildRowInsert,RowInsertError,type RowInsertPlan} from './rowInsertModel';
import type {RowInsertRequest,RowInsertReview,RowInsertApplyRequest,RowInsertResult} from './databaseTypes';
import {previewDropIndexSql,DropIndexError,type DropIndexDraft} from './schemaDropIndex';
import type {DropIndexRequest,DropIndexReview,DropIndexApplyRequest,DropIndexResult} from './databaseTypes';
import {previewRenameColumnSql,RenameColumnError,type RenameColumnDraft} from './schemaRenameColumn';
import type {RenameColumnRequest,RenameColumnReview,RenameColumnApplyRequest,RenameColumnResult} from './databaseTypes';
import {previewAddColumnSql,AddColumnError} from './alterTableModel';
import type {AddColumnRequest,AddColumnApplyRequest,AddColumnReview,AddColumnResult} from './databaseTypes';
import {previewCsvImport as buildCsvImport} from './csvImportModel';
import type {CsvImportRequest,CsvImportApplyRequest,CsvImportReview,CsvImportResult} from './databaseTypes';
import {previewGridMutation,GridMutationError} from './gridMutation';
import type {GridMutationRequest,GridMutationApplyRequest,GridMutationReview,GridMutationResult} from './databaseTypes';
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
  const objects = rows("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND lower(substr(name,1,7)) != 'sqlite_' ORDER BY name", [], SQLITE_SCHEMA_LIMITS.objects, 'object');
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
    const tableFlags=kind==='table'?rows("SELECT type,wr FROM pragma_table_list WHERE schema='main' AND name=?",[name],1,'table flags')[0]:undefined;
    const xinfo=kind==='table'?rows('SELECT hidden FROM pragma_table_xinfo(?)',[name],SQLITE_SCHEMA_LIMITS.columns,'column flags'):[];
    const ordinary=tableFlags?.[0]==='table'&&xinfo.length===columns.length&&xinfo.every(row=>row[0]===0);
    return {name, kind, columns: columns.map(([, columnName, type, notNull, defaultSql, primaryKey]) => ({name: String(columnName), type: String(type), primaryKey: Boolean(primaryKey), ...(kind === 'table' ? {nullable: !notNull && !primaryKey,...(ordinary?{defaultSql:defaultSql===null?null:String(defaultSql),rowidAlias:tableFlags?.[1]===0&&columns.filter(c=>Number(c[5])>0).length===1&&Number(primaryKey)>0&&String(type).toUpperCase()==='INTEGER'&&!indexes.some(i=>i.origin==='pk')}:{})} : {})})),
      ...(typeof definition === 'string' ? {definition} : {}), primaryKeyColumns: columns.filter(column => Number(column[5]) > 0).sort((a,b) => Number(a[5]) - Number(b[5])).map(column => String(column[1])), indexes, foreignKeys, triggers};
  });
  const result = {tables};
  if (new TextEncoder().encode(JSON.stringify(result)).length > SQLITE_SCHEMA_LIMITS.bytes) throw new Error('Schema exceeds the workspace metadata byte budget.');
  return result;
}
/** Authoritative table_list/xinfo check; never infer hidden or shadow status from UI metadata. */
export function assertPlainAddColumnTable(db:Database,table:string):void {
  const statement=db.prepare("SELECT type,strict FROM pragma_table_list WHERE schema='main' AND name=? COLLATE BINARY");
  try{statement.bind([table]);if(!statement.step())throw new AddColumnError('table');const row=statement.get();if(row[0]!=='table'||row[1]!==0||statement.step())throw new AddColumnError('table');}finally{statement.free();}
  const columns=db.prepare('SELECT hidden FROM pragma_table_xinfo(?)');let count=0;
  try{columns.bind([table]);while(columns.step()){if(++count>=64)throw new AddColumnError('budget');if(columns.get()[0]!==0)throw new AddColumnError('table');}if(!count)throw new AddColumnError('table');}finally{columns.free();}
}
/** Full authoritative metadata for rename; UI schema alone is not dependency proof. */
export function inspectRenameColumnAuthority(db:Database,table:string){
  const all:Array<{schema:string;type:string;name:string;table:string;rootpage:number;sql:string|null}>=[];let bytes=0;
  for(const scope of ['main','temp']){
    const statement=db.prepare(`SELECT type,name,tbl_name,rootpage,sql FROM ${scope}.sqlite_schema ORDER BY type,name`);
    try{while(statement.step()){
      const [type,name,tbl_name,rootpage,sql]=statement.get();
      if(all.length>=128)throw new RenameColumnError('budget');
      const object={schema:scope,type:String(type),name:String(name),table:String(tbl_name),rootpage:Number(rootpage),sql:sql===null?null:String(sql)};
      bytes+=new TextEncoder().encode(JSON.stringify(object)).length;if(bytes>96*1024)throw new RenameColumnError('budget');
      // TEMP dependencies/shadowing cannot be inferred from main's UI schema.
      if(scope==='temp')throw new RenameColumnError('dependency');all.push(object);
    }}finally{statement.free();}
  }
  const list=db.prepare("SELECT type,strict FROM pragma_table_list WHERE schema='main' AND name=? COLLATE BINARY");
  try{list.bind([table]);if(!list.step())throw new RenameColumnError('table');const row=list.get();if(row[0]!=='table'||row[1]!==0||list.step())throw new RenameColumnError('table');}finally{list.free();}
  const statement=db.prepare("SELECT cid,name,type,[notnull],dflt_value,pk,hidden FROM pragma_table_xinfo(?, 'main') ORDER BY cid");const columns:unknown[][]=[];
  try{statement.bind([table]);while(statement.step()){const row=statement.get();if(columns.length>=64)throw new RenameColumnError('budget');if(row[6]!==0||row[4]!==null)throw new RenameColumnError('table');columns.push(row);}}finally{statement.free();}
  if(!columns.length)throw new RenameColumnError('table');return {all,columns};
}
/** Plugin-local structured operation, not an arbitrary DDL execution API. */
export function applySqliteRenameColumn(db:Database,draft:RenameColumnDraft):RenameColumnResult{
  let transaction=false;
  try{
    db.run('PRAGMA query_only=OFF');db.run('SAVEPOINT plugin_rename_column');transaction=true;
    const before=inspectSqliteSchema(db),preview=previewRenameColumnSql(draft,before),authority=inspectRenameColumnAuthority(db,preview.draft.table);
    db.run(preview.sql);
    const after=inspectSqliteSchema(db),next=inspectRenameColumnAuthority(db,preview.draft.table);
    const others=(objects:typeof authority.all)=>objects.filter(o=>!(o.schema==='main'&&o.type==='table'&&o.name===preview.draft.table));
    if(JSON.stringify(others(authority.all))!==JSON.stringify(others(next.all)))throw new RenameColumnError('dependency');
    const targetIdentity=(objects:typeof authority.all)=>objects.filter(o=>o.schema==='main'&&o.type==='table'&&o.name===preview.draft.table).map(({sql: _sql,...identity})=>identity);
    if(JSON.stringify(targetIdentity(authority.all))!==JSON.stringify(targetIdentity(next.all)))throw new RenameColumnError('dependency');
    const metadataOthers=(schema:DatabaseSchemaResult)=>schema.tables.filter(t=>t.name!==preview.draft.table);
    if(JSON.stringify(metadataOthers(before))!==JSON.stringify(metadataOthers(after)))throw new RenameColumnError('dependency');
    const expectedColumns=authority.columns.map(c=>c[1]===preview.draft.from?c.map((v,i)=>i===1?preview.draft.to:v):c);
    if(JSON.stringify(expectedColumns)!==JSON.stringify(next.columns))throw new RenameColumnError('dependency');
    const beforeTarget=before.tables.find(t=>t.name===preview.draft.table)!,afterTarget=after.tables.find(t=>t.name===preview.draft.table)!;
    const expected={...beforeTarget,columns:beforeTarget.columns.map(c=>c.name===preview.draft.from?{...c,name:preview.draft.to}:c),definition:undefined};
    if(JSON.stringify(expected)!==JSON.stringify({...afterTarget,definition:undefined}))throw new RenameColumnError('dependency');
    // Reparse post-ALTER DDL through the same narrow grammar; no added constraints.
    previewRenameColumnSql({table:preview.draft.table,from:preview.draft.to,to:preview.draft.from},after);
    const size=Number(db.exec('PRAGMA page_count')[0].values[0][0])*Number(db.exec('PRAGMA page_size')[0].values[0][0]);
    if(size>1024*1024)throw new RenameColumnError('budget');
    db.run('RELEASE plugin_rename_column');transaction=false;return {changes:0,schema:after,sql:preview.sql};
  }catch(error){
    if(transaction){try{db.run('ROLLBACK TO plugin_rename_column; RELEASE plugin_rename_column');}catch{db.close();throw new Error('SQLite rename rollback failed; session closed.');}}
    throw error;
  }finally{try{db.run('PRAGMA query_only=ON');}catch{try{db.close();}catch{}throw new Error('SQLite read protection could not be restored; session closed.');}}
}

/** Reused authority helpers must not leak another operation's error taxonomy. */
function dropIndexCheck<T>(work:()=>T):T {
  try{return work();}catch(error){
    if(error instanceof RenameColumnError){
      const codes:Partial<Record<RenameColumnError['code'],DropIndexError['code']>>={draft:'draft',identifier:'identifier',schema:'schema',table:'table',column:'schema',exists:'index',unchanged:'draft',dependency:'dependency',definition:'table',budget:'budget',stale:'stale',review:'review'};
      const code=codes[error.code];if(code)throw new DropIndexError(code);
      throw new Error('SQLite index operation failed.');
    }
    throw error;
  }
}
/** Confirmed structured index removal with authority and unchanged-object checks. */
export function applySqliteDropIndex(db:Database,draft:DropIndexDraft):DropIndexResult{
  let transaction=false;
  try{
    db.run('PRAGMA query_only=OFF');db.run('SAVEPOINT plugin_drop_index');transaction=true;
    const before=inspectSqliteSchema(db),preview=previewDropIndexSql(draft,before),authority=dropIndexCheck(()=>inspectRenameColumnAuthority(db,preview.draft.table));
    const target=authority.all.filter(o=>o.schema==='main'&&o.type==='index'&&o.name===preview.draft.name&&o.table===preview.draft.table);
    if(target.length!==1||target[0].sql===null)throw new DropIndexError('index');
    db.run(preview.sql);
    const after=inspectSqliteSchema(db),next=dropIndexCheck(()=>inspectRenameColumnAuthority(db,preview.draft.table));
    const expectedObjects=authority.all.filter(o=>!(o.schema==='main'&&o.type==='index'&&o.name===preview.draft.name));
    if(JSON.stringify(expectedObjects)!==JSON.stringify(next.all)||JSON.stringify(authority.columns)!==JSON.stringify(next.columns))throw new DropIndexError('dependency');
    const expected={tables:before.tables.map(t=>t.name===preview.draft.table?{...t,indexes:t.indexes!.filter(i=>i.name!==preview.draft.name)}:t)};
    // index_list seq affects ordering only; inspect sorts indexes by seq. Removal
    // must leave the relative ordering and every remaining index field intact.
    if(JSON.stringify(expected)!==JSON.stringify(after))throw new DropIndexError('dependency');
    const size=Number(db.exec('PRAGMA page_count')[0].values[0][0])*Number(db.exec('PRAGMA page_size')[0].values[0][0]);if(size>1024*1024)throw new DropIndexError('budget');
    db.run('RELEASE plugin_drop_index');transaction=false;return {changes:0,schema:after,sql:preview.sql};
  }catch(error){
    if(transaction){try{db.run('ROLLBACK TO plugin_drop_index; RELEASE plugin_drop_index');}catch{db.close();throw new Error('SQLite drop-index rollback failed; session closed.');}}throw error;
  }finally{try{db.run('PRAGMA query_only=ON');}catch{try{db.close();}catch{}throw new Error('SQLite read protection could not be restored; session closed.');}}
}

/** @internal Adapter transaction implementation, exported only for real-engine regression.
 * Not a Workbench/API capability: production calls only after issued-review validation. */
export function executeSqliteRowInsert(db:Database,plan:RowInsertPlan,onFatal:()=>void=()=>db.close()):RowInsertResult{
  let closed=false;const close=()=>{closed=true;onFatal();};
  let transaction=false;try{db.run('PRAGMA query_only=OFF');db.run('SAVEPOINT plugin_row_insert');transaction=true;
      const statement=db.prepare(plan.sql);try{statement.bind(plan.parameters.map(value=>typeof value==='boolean'?Number(value):value));while(statement.step()){} }finally{statement.free();}
      if(db.getRowsModified()!==1)throw new RowInsertError('constraint');
      const size=Number(db.exec('PRAGMA page_count')[0].values[0][0])*Number(db.exec('PRAGMA page_size')[0].values[0][0]);if(size>1024*1024)throw new RowInsertError('budget');
      inspectSqliteSchema(db);db.run('RELEASE plugin_row_insert');transaction=false;return {changes:1};
    }catch(error){if(transaction){try{db.run('ROLLBACK TO plugin_row_insert; RELEASE plugin_row_insert');}catch{close();throw new Error('Insert rollback failed; session closed.');}}if(error instanceof RowInsertError)throw error;throw new RowInsertError('constraint');
    }finally{if(!closed){try{db.run('PRAGMA query_only=ON');}catch{close();throw new Error('SQLite read protection could not be restored; session closed.');}}}
}
export function createWorkbenchContext(context: PluginContext): WorkbenchContext {
  const sessions = new Map<string, Database>();
  const tableReviews=new Map<string,string>();
  const savedIds=new Map<string,string>(),snapshotLocks=new Set<string>(),snapshotSavedLocks=new Set<string>();
  const restoreReviews=new Map<string,{review:SnapshotRestoreReview;candidate:Database}>();
  const snapshots=createSnapshotStorage(context.storage);
  const storedQueries=createQueryLibraryStorage(context.storage);
  const discardRestore=(handleId:string)=>{const old=restoreReviews.get(handleId);restoreReviews.delete(handleId);old?.candidate.close();};
  let disposed = false;
  const assertLive = () => { if (disposed) throw new Error("Database runtime is closed."); };
  let dropColumnAdapter:ReturnType<typeof createDropColumnAdapter>|undefined;
  const get = ({handleId}: DatabaseHandleRequest,preserveDropReview=false) => { assertLive(); if(!preserveDropReview)dropColumnAdapter?.cancel(handleId); if(snapshotLocks.has(handleId))throw new SqliteSnapshotError('busy');discardRestore(handleId); const db = sessions.get(handleId); if (!db) throw new Error('Database connection is closed.'); return db; };
  const renameTableAdapter=createRenameTableAdapter({getDatabase:handleId=>get({handleId}),inspectSchema:inspectSqliteSchema,reviewTokens:tableReviews,onFatal:handleId=>{tableReviews.delete(handleId);savedIds.delete(handleId);sessions.delete(handleId);discardRestore(handleId);}});
  const previewRenameTable:WorkbenchContext['database']['previewRenameTable']=async request=>renameTableAdapter.preview(request);
  const applyRenameTable:WorkbenchContext['database']['applyRenameTable']=async request=>renameTableAdapter.apply(request);
  dropColumnAdapter=createDropColumnAdapter({getDatabase:handleId=>get({handleId},true),inspectSchema:inspectSqliteSchema,reviewTokens:tableReviews,onFatal:handleId=>{tableReviews.delete(handleId);savedIds.delete(handleId);sessions.delete(handleId);discardRestore(handleId);}});
  const previewDropColumn:WorkbenchContext['database']['previewDropColumn']=async request=>dropColumnAdapter!.preview(request);
  const applyDropColumn:WorkbenchContext['database']['applyDropColumn']=async request=>dropColumnAdapter!.apply(request);
  const cancelDropColumnReview:WorkbenchContext['database']['cancelDropColumnReview']=async request=>{assertLive();dropColumnAdapter!.cancel(request.handleId,request.token);return null;};
  const list = async () => {
    assertLive();
    const value = await context.storage.get(STORE_KEY);
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_CONNECTIONS || !value.every(validSaved)) throw new Error('Saved connection metadata is invalid.');
    return value;
  };
  let mutations: Promise<unknown> = Promise.resolve();
  function mutate<T>(operation: () => Promise<T>): Promise<T> { const next = mutations.then(operation); mutations = next.catch(() => {}); return next; }
  const close = async (target: DatabaseHandleRequest): Promise<null> => { const db = sessions.get(target.handleId); dropColumnAdapter?.cancel(target.handleId);discardRestore(target.handleId);savedIds.delete(target.handleId);tableReviews.delete(target.handleId); sessions.delete(target.handleId); db?.close(); return null; };
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
      protectSnapshotDatabase(db);
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
  const tempRevision=(db:Database):number=>{const value=db.exec('PRAGMA temp.schema_version')[0]?.values[0]?.[0];if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new RenameColumnError('stale');return value;};
  const previewDropIndex=async(request:DropIndexRequest):Promise<DropIndexReview>=>{
    const db=get(request);tableReviews.delete(request.handleId);const preview=previewDropIndexSql(request.draft,inspectSqliteSchema(db));dropIndexCheck(()=>inspectRenameColumnAuthority(db,preview.draft.table));
    const review={handleId:request.handleId,...preview,schemaRevision:schemaRevision(db),tempSchemaRevision:dropIndexCheck(()=>tempRevision(db))};tableReviews.set(request.handleId,JSON.stringify(review));return review;
  };
  const applyDropIndex=async(request:DropIndexApplyRequest):Promise<DropIndexResult>=>{
    const db=get(request),review=request.review;
    if(!review||review.handleId!==request.handleId||review.schemaRevision!==schemaRevision(db)||review.tempSchemaRevision!==dropIndexCheck(()=>tempRevision(db)))throw new DropIndexError('stale');
    if(tableReviews.get(request.handleId)!==JSON.stringify(review))throw new DropIndexError('review');tableReviews.delete(request.handleId);
    const preview=previewDropIndexSql(review.draft,inspectSqliteSchema(db));
    if(JSON.stringify(preview)!==JSON.stringify({draft:review.draft,sql:review.sql,unique:review.unique}))throw new DropIndexError('review');
    try{return applySqliteDropIndex(db,preview.draft);}catch(error){try{db.exec('SELECT 1');}catch{sessions.delete(request.handleId);tableReviews.delete(request.handleId);}throw error;}
  };
  const previewRenameColumn=async(request:RenameColumnRequest):Promise<RenameColumnReview>=>{
    const db=get(request);tableReviews.delete(request.handleId);const preview=previewRenameColumnSql(request.draft,inspectSqliteSchema(db));inspectRenameColumnAuthority(db,preview.draft.table);
    const review={handleId:request.handleId,...preview,schemaRevision:schemaRevision(db),tempSchemaRevision:tempRevision(db)};tableReviews.set(request.handleId,JSON.stringify(review));return review;
  };
  const applyRenameColumn=async(request:RenameColumnApplyRequest):Promise<RenameColumnResult>=>{
    const db=get(request),review=request.review;
    if(!review||review.handleId!==request.handleId||review.schemaRevision!==schemaRevision(db)||review.tempSchemaRevision!==tempRevision(db))throw new RenameColumnError('stale');
    if(tableReviews.get(request.handleId)!==JSON.stringify(review))throw new RenameColumnError('review');tableReviews.delete(request.handleId);
    const preview=previewRenameColumnSql(review.draft,inspectSqliteSchema(db));
    if(JSON.stringify(preview)!==JSON.stringify({draft:review.draft,sql:review.sql,dependencyValidation:review.dependencyValidation}))throw new RenameColumnError('review');
    try{return applySqliteRenameColumn(db,preview.draft);}catch(error){try{db.exec('SELECT 1');}catch{sessions.delete(request.handleId);tableReviews.delete(request.handleId);}throw error;}
  };
  const previewAddColumn=async(request:AddColumnRequest):Promise<AddColumnReview>=>{
    const db=get(request);tableReviews.delete(request.handleId);
    const preview=previewAddColumnSql(request.draft,inspectSqliteSchema(db));
    assertPlainAddColumnTable(db,preview.draft.table);
    const review={handleId:request.handleId,...preview,schemaRevision:schemaRevision(db)};
    tableReviews.set(request.handleId,JSON.stringify(review));return review;
  };
  const applyAddColumn=async(request:AddColumnApplyRequest):Promise<AddColumnResult>=>{
    const db=get(request),review=request.review;
    if(!review||review.handleId!==request.handleId||!Number.isSafeInteger(review.schemaRevision)||review.schemaRevision!==schemaRevision(db))throw new AddColumnError('stale');
    if(tableReviews.get(request.handleId)!==JSON.stringify(review))throw new AddColumnError('review');
    tableReviews.delete(request.handleId);
    const preview=previewAddColumnSql(review.draft,inspectSqliteSchema(db));
    assertPlainAddColumnTable(db,preview.draft.table);
    if(preview.sql!==review.sql||JSON.stringify(preview.draft)!==JSON.stringify(review.draft))throw new AddColumnError('review');
    let transaction=false;
    try{
      db.run('PRAGMA query_only=OFF');db.run('SAVEPOINT plugin_add_column');transaction=true;
      db.run(preview.sql);
      const size=Number(db.exec('PRAGMA page_count')[0].values[0][0])*Number(db.exec('PRAGMA page_size')[0].values[0][0]);
      if(size>1024*1024)throw new AddColumnError('budget');
      const schema=inspectSqliteSchema(db);
      db.run('RELEASE plugin_add_column');transaction=false;return {changes:0,schema,sql:preview.sql};
    }catch(error){
      if(transaction){try{db.run('ROLLBACK TO plugin_add_column; RELEASE plugin_add_column');}catch{tableReviews.delete(request.handleId);sessions.delete(request.handleId);db.close();}}
      throw error;
    }finally{
      if(sessions.has(request.handleId)){try{db.run('PRAGMA query_only=ON');}catch{tableReviews.delete(request.handleId);sessions.delete(request.handleId);db.close();throw new Error('SQLite read protection could not be restored; session closed.');}}
    }
  };
  const previewGridBatch=async(request:GridBatchRequest):Promise<GridBatchReview>=>{
    const db=get(request);tableReviews.delete(request.handleId);
    const plan=previewSqliteGridBatch(db,request.draft);
    const review:GridBatchReview={kind:'grid-batch',handleId:request.handleId,token:crypto.randomUUID(),schemaRevision:schemaRevision(db),plan};
    tableReviews.set(request.handleId,JSON.stringify(review));return review;
  };
  const applyGridBatch=async(request:GridBatchApplyRequest):Promise<{changes:number}>=>{
    const db=get(request),issued=tableReviews.get(request.handleId);tableReviews.delete(request.handleId);
    const review=request.review;
    if(!review||review.kind!=='grid-batch'||review.handleId!==request.handleId||review.schemaRevision!==schemaRevision(db))throw new GridBatchError('review');
    if(!issued||issued!==JSON.stringify(review))throw new GridBatchError('review');
    return executeSqliteGridBatch(db,review.plan,{onFatal:()=>{tableReviews.delete(request.handleId);savedIds.delete(request.handleId);sessions.delete(request.handleId);discardRestore(request.handleId);}});
  };
  const previewGridRow=async(request:GridMutationRequest):Promise<GridMutationReview>=>{
    const db=get(request);tableReviews.delete(request.handleId);
    const preview=previewGridMutation(request.draft,inspectSqliteSchema(db));
    const quoted=(value:string)=>'"'+value.replaceAll('"','""')+'"';
    const keys=Object.keys(preview.draft.original);
    const statement=db.prepare(`SELECT COUNT(*) FROM ${quoted(preview.draft.table)} WHERE ${keys.map(key=>`${quoted(key)} COLLATE BINARY IS ?`).join(' AND ')}`);
    try{statement.bind(keys.map(key=>{const value=preview.draft.original[key];return typeof value==='boolean'?Number(value):value;}));if(!statement.step()||statement.get()[0]!==1)throw new GridMutationError('conflict');}finally{statement.free();}
    const review={handleId:request.handleId,...preview,schemaRevision:schemaRevision(db)};
    tableReviews.set(request.handleId,JSON.stringify(review));return review;
  };
  const applyGridMutation=async(request:GridMutationApplyRequest):Promise<GridMutationResult>=>{
    const db=get(request),review=request.review;
    if(!review||review.handleId!==request.handleId||review.schemaRevision!==schemaRevision(db))throw new GridMutationError('stale');
    if(tableReviews.get(request.handleId)!==JSON.stringify(review))throw new GridMutationError('review');
    tableReviews.delete(request.handleId);
    const preview=previewGridMutation(review.draft,inspectSqliteSchema(db));
    if(preview.sql!==review.sql||JSON.stringify(preview.parameters)!==JSON.stringify(review.parameters)||JSON.stringify(preview.draft)!==JSON.stringify(review.draft))throw new GridMutationError('review');
    let transaction=false;
    try{
      db.run('PRAGMA query_only=OFF');db.run('SAVEPOINT plugin_grid_mutation');transaction=true;
      const statement=db.prepare(preview.sql);
      try{statement.bind(preview.parameters.map(value=>typeof value==='boolean'?Number(value):value));while(statement.step()){} }finally{statement.free();}
      if(db.getRowsModified()!==1)throw new GridMutationError('conflict');
      const size=Number(db.exec('PRAGMA page_count')[0].values[0][0])*Number(db.exec('PRAGMA page_size')[0].values[0][0]);
      if(size>1024*1024)throw new GridMutationError('budget');
      inspectSqliteSchema(db);
      db.run('RELEASE plugin_grid_mutation');transaction=false;return {changes:1};
    }catch(error){
      if(transaction){try{db.run('ROLLBACK TO plugin_grid_mutation; RELEASE plugin_grid_mutation');}catch{tableReviews.delete(request.handleId);sessions.delete(request.handleId);db.close();}}
      throw error;
    }finally{
      if(sessions.has(request.handleId)){try{db.run('PRAGMA query_only=ON');}catch{tableReviews.delete(request.handleId);sessions.delete(request.handleId);db.close();throw new Error('SQLite read protection could not be restored; session closed.');}}
    }
  };
  const previewRowInsert=async(request:RowInsertRequest):Promise<RowInsertReview>=>{
    const db=get(request);tableReviews.delete(request.handleId);const plan=buildRowInsert(request.draft,inspectSqliteSchema(db));
    const review={handleId:request.handleId,...plan,schemaRevision:schemaRevision(db)};tableReviews.set(request.handleId,JSON.stringify(review));return review;
  };
  const applyRowInsert=async(request:RowInsertApplyRequest):Promise<RowInsertResult>=>{
    const db=get(request),review=request.review;
    if(!review||review.handleId!==request.handleId||review.schemaRevision!==schemaRevision(db))throw new RowInsertError('stale');
    if(tableReviews.get(request.handleId)!==JSON.stringify(review))throw new RowInsertError('review');tableReviews.delete(request.handleId);
    const plan=buildRowInsert(review.draft,inspectSqliteSchema(db));if(JSON.stringify(plan)!==JSON.stringify({draft:review.draft,sql:review.sql,parameters:review.parameters,resolved:review.resolved,automaticColumns:review.automaticColumns}))throw new RowInsertError('review');
    return executeSqliteRowInsert(db,plan,()=>{tableReviews.delete(request.handleId);sessions.delete(request.handleId);db.close();});
  };
  const previewCsvImport=async(request:CsvImportRequest):Promise<CsvImportReview>=>{
    const db=get(request);tableReviews.delete(request.handleId);
    const plan=buildCsvImport(request.draft,inspectSqliteSchema(db));
    const review={handleId:request.handleId,draft:JSON.parse(JSON.stringify(request.draft)) as CsvImportRequest['draft'],plan,schemaRevision:schemaRevision(db)};
    tableReviews.set(request.handleId,JSON.stringify(review));return review;
  };
  const applyCsvImport=async(request:CsvImportApplyRequest):Promise<CsvImportResult>=>{
    const db=get(request),review=request.review;
    if(!review||review.handleId!==request.handleId||review.schemaRevision!==schemaRevision(db))throw new Error('Import schema is stale. Prepare a new preview.');
    if(tableReviews.get(request.handleId)!==JSON.stringify(review))throw new Error('Import review is missing, changed or consumed.');
    tableReviews.delete(request.handleId);
    const plan=buildCsvImport(review.draft,inspectSqliteSchema(db));
    if(JSON.stringify(plan)!==JSON.stringify(review.plan))throw new Error('Import review does not match the current schema.');
    let transaction=false;
    try{
      db.run('PRAGMA query_only=OFF');db.run('SAVEPOINT plugin_csv_import');transaction=true;
      let changes=0;
      const statement=db.prepare(plan.sql);
      try{for(const row of plan.rows){statement.reset();statement.bind(row.map(value=>typeof value==='boolean'?Number(value):value));while(statement.step()){}if(db.getRowsModified()!==1)throw new Error('Import did not insert exactly one row.');changes++;}}finally{statement.free();}
      if(changes!==plan.rowCount)throw new Error('Import row count mismatch.');
      const size=Number(db.exec('PRAGMA page_count')[0].values[0][0])*Number(db.exec('PRAGMA page_size')[0].values[0][0]);
      if(size>1024*1024)throw new Error('Import exceeds database size budget.');
      inspectSqliteSchema(db);db.run('RELEASE plugin_csv_import');transaction=false;return {changes};
    }catch(error){
      if(transaction){try{db.run('ROLLBACK TO plugin_csv_import; RELEASE plugin_csv_import');}catch{tableReviews.delete(request.handleId);sessions.delete(request.handleId);db.close();}}
      throw error;
    }finally{
      if(sessions.has(request.handleId)){try{db.run('PRAGMA query_only=ON');}catch{tableReviews.delete(request.handleId);sessions.delete(request.handleId);db.close();throw new Error('SQLite read protection could not be restored; session closed.');}}
    }
  };
  async function withSnapshot<T>(request:DatabaseHandleRequest,work:(db:Database,id:string)=>Promise<T>):Promise<T>{
    assertLive();const db=sessions.get(request.handleId),id=savedIds.get(request.handleId);
    if(!db||!id)throw new SqliteSnapshotError('unbound');if(snapshotLocks.has(request.handleId)||snapshotSavedLocks.has(id))throw new SqliteSnapshotError('busy');
    snapshotLocks.add(request.handleId);snapshotSavedLocks.add(id);dropColumnAdapter?.cancel(request.handleId);tableReviews.delete(request.handleId);
    try{return await work(db,id);}finally{snapshotLocks.delete(request.handleId);snapshotSavedLocks.delete(id);}
  }
  const stillCurrent=(handleId:string,db:Database)=>{if(disposed||sessions.get(handleId)!==db)throw new SqliteSnapshotError('stale');};
  const snapshotInfo=(request:DatabaseHandleRequest)=>withSnapshot(request,async(db,id)=>{discardRestore(request.handleId);const record=await snapshots.get(id);record?.bytes.fill(0);stillCurrent(request.handleId,db);return record?.info;});
  const saveSnapshot=(request:DatabaseHandleRequest)=>withSnapshot(request,async(db,id)=>{
    discardRestore(request.handleId);const bytes=exportProtectedSnapshot(db,()=>{sessions.delete(request.handleId);savedIds.delete(request.handleId);db.close();});
    try{const result=await snapshots.save(id,bytes);return result;}finally{bytes.fill(0);}
  });
  const previewRestoreSnapshot=(request:DatabaseHandleRequest)=>withSnapshot(request,async(db,id)=>{
    discardRestore(request.handleId);const record=await snapshots.get(id);if(!record)throw new SqliteSnapshotError('missing');let candidate:Database|undefined;
    try{const SQL=await(engine??=initSqlJs());stillCurrent(request.handleId,db);candidate=new SQL.Database(record.bytes);validateSnapshotDatabase(candidate);const schema=inspectSqliteSchema(candidate);
      const review:SnapshotRestoreReview={handleId:request.handleId,token:crypto.randomUUID(),info:record.info,schema};restoreReviews.set(request.handleId,{candidate,review:JSON.parse(JSON.stringify(review)) as SnapshotRestoreReview});candidate=undefined;return review;
    }catch(error){if(error instanceof SqliteSnapshotError)throw error;throw new SqliteSnapshotError('invalid');}finally{candidate?.close();record.bytes.fill(0);}
  });
  const applyRestoreSnapshot=(request:DatabaseHandleRequest & {review:SnapshotRestoreReview})=>withSnapshot(request,async(db,id)=>{
    const pending=restoreReviews.get(request.handleId);restoreReviews.delete(request.handleId);if(!pending)throw new SqliteSnapshotError('stale');let installed=false;
    try{if(JSON.stringify(pending.review)!==JSON.stringify(request.review))throw new SqliteSnapshotError('stale');const record=await snapshots.get(id);record?.bytes.fill(0);
      stillCurrent(request.handleId,db);if(!record||JSON.stringify(record.info)!==JSON.stringify(pending.review.info))throw new SqliteSnapshotError('stale');
      validateSnapshotDatabase(pending.candidate);const schema=inspectSqliteSchema(pending.candidate);sessions.set(request.handleId,pending.candidate);installed=true;try{db.close();}catch{/* Commit already succeeded: cleanup failure must not report replacement as failed. */}return {schema};
    }finally{if(!installed)pending.candidate.close();}
  });
  const deleteSnapshot=(request:DatabaseHandleRequest)=>withSnapshot(request,async(db,id)=>{discardRestore(request.handleId);await snapshots.delete(id);return null;});
  async function withQueryLibrary<T>(id:string,work:()=>Promise<T>):Promise<T>{
    assertLive();if(snapshotSavedLocks.has(id))throw new QueryLibraryStorageError('stale');
    snapshotSavedLocks.add(id);
    try{if(!(await list()).some(c=>c.id===id&&c.engine==='sqlite'))throw new QueryLibraryStorageError('missing');assertLive();return await work();}
    finally{snapshotSavedLocks.delete(id);}
  }
  const queryLibraryStore:ReturnType<typeof createQueryLibraryStorage>={
    load:id=>withQueryLibrary(id,()=>storedQueries.load(id)),
    save:(id,input,revision)=>{const snapshot={...input};return withQueryLibrary(id,()=>storedQueries.save(id,snapshot,revision));},
    remove:(id,entryId,revision)=>withQueryLibrary(id,()=>storedQueries.remove(id,entryId,revision))
  };
  const database: PluginDatabaseClient & {capabilities: ReadonlySet<string>} = {
    capabilities: new Set(['database.sqlite-drop-column.v1','database.sqlite-rename-table.v1','database.sqlite-grid-batch.v1','database.sqlite-snapshot.v1','database.sqlite-fixture.v1','database.saved-connections.v1','database.sqlite-reviewed-writes.v1','database.sqlite-create-table.v1','database.sqlite-create-index.v1','database.sqlite-grid-mutation.v1','database.sqlite-csv-import.v1','database.sqlite-rename-column.v1','database.sqlite-row-insert.v1','database.sqlite-drop-index.v1','database.sqlite-add-column.v1']),
    snapshotInfo,saveSnapshot,previewRestoreSnapshot,applyRestoreSnapshot,deleteSnapshot,
    previewDropColumn,applyDropColumn,cancelDropColumnReview,previewRenameTable,applyRenameTable,previewGridBatch,applyGridBatch,previewRowInsert,applyRowInsert,previewDropIndex,applyDropIndex,previewRenameColumn,applyRenameColumn,previewAddColumn,applyAddColumn,previewCsvImport,applyCsvImport,previewCreateTable,applyCreateTable,previewCreateIndex,applyCreateIndex,previewGridMutation:previewGridRow,applyGridMutation,
    openFixture: open, readSchema, query, close, cancel:close,
    listSavedConnections:list,
    saveConnection: (request: DatabaseSaveConnectionRequest) => mutate(async () => {
      get(request);
      if (request.secret || request.meta.hostId) throw new Error('Credentials and host bindings are not supported by the memory adapter.');
      const saved = await list();
      if (saved.length >= MAX_CONNECTIONS) throw new Error('The saved connection limit has been reached.');
      const value: DatabaseSavedConnection = {id:crypto.randomUUID(),name:request.meta.name,color:request.meta.color,engine:'sqlite',targetKind:'memory',readOnly:false};
      if (!validSaved(value)) throw new Error('Invalid connection metadata.');
      assertLive(); await context.storage.set(STORE_KEY,[...saved,value]); get(request);savedIds.set(request.handleId,value.id);return value;
    }),
    openSavedConnection: async ({id}) => { if(snapshotSavedLocks.has(id))throw new SqliteSnapshotError('busy');snapshotSavedLocks.add(id);try{if (!(await list()).some(c => c.id===id)) throw new Error('Saved connection not found.');const result=await open();savedIds.set(result.handleId,id);return result;}finally{snapshotSavedLocks.delete(id);} },
    deleteConnection: ({id}) => mutate(async () => {
      if(snapshotSavedLocks.has(id))throw new SqliteSnapshotError('busy');snapshotSavedLocks.add(id);
      try{const library=await storedQueries.load(id);if(library.saved.length)throw new Error('Permanently remove this connection’s saved SQL entries explicitly before deleting the connection.');const snapshot=await snapshots.get(id);if(snapshot){snapshot.bytes.fill(0);throw new Error('Clear this connection’s local database snapshot explicitly before deleting the connection.');}
        await context.storage.set(STORE_KEY,(await list()).filter(c=>c.id!==id));for(const [handle,saved] of savedIds)if(saved===id){discardRestore(handle);savedIds.delete(handle);}return null;
      }finally{snapshotSavedLocks.delete(id);}
    }),
    openTcp: unavailable, openSqliteFile: unavailable, refreshSqliteFile: unavailable,
    listHostsForDatabase: unavailable, testTunnel: unavailable, cancelTunnelTest: unavailable,
    probeHostDatabasePorts: unavailable, cancelHostDatabasePorts: unavailable,
    openHostLiveSshPgFixture: unavailable, cancelHostLiveSshPgFixture: unavailable, closeHostLiveSshPgSession: unavailable,
  };
  context.subscriptions.add({dispose() { dropColumnAdapter?.dispose();disposed = true; for(const h of restoreReviews.keys())discardRestore(h);savedIds.clear();for (const db of sessions.values()) db.close(); sessions.clear(); tableReviews.clear(); }});
  return Object.assign(Object.create(context), {database,queryLibraryStore}) as WorkbenchContext;
}

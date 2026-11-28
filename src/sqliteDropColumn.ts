import type {Database} from 'sql.js';import type {DatabaseSchemaResult} from './databaseTypes';import {sqliteSchemaTokens} from './sqliteSchemaKeywords';
export interface DropColumnDraft {table:string;column:string}
export interface DropColumnReview {handleId:string;draft:DropColumnDraft;sql:string;schemaRevision:number;tempSchemaRevision:number;token:string;affectedRows:number;warning:'permanently-deletes-column-values'}
export class DropColumnError extends Error {constructor(readonly code:'draft'|'identifier'|'table'|'column'|'dependency'|'budget'|'review'|'stale'|'protection'|'transaction'){super(`Drop column ${code}`);}}
function fail(c:DropColumnError['code']):never{throw new DropColumnError(c);}const q=(s:string)=>'"'+s.replaceAll('"','""')+'"',fold=(s:string)=>s.replace(/[A-Z]/g,c=>c.toLowerCase());
const name=(s:unknown):s is string=>typeof s==='string'&&!!s.trim()&&s.length<=128&&!s.includes('\0')&&!/^sqlite_/i.test(s);
function rows(db:Database,sql:string,args:string[]=[],max=128){const s=db.prepare(sql),out:ReturnType<typeof s.get>[]=[];let bytes=0;try{s.bind(args);while(s.step()){if(out.length>=max)fail('budget');const row=s.get();bytes+=new TextEncoder().encode(JSON.stringify(row)).length;if(bytes>96*1024)fail('budget');out.push(row);}return out;}finally{s.free();}}
const version=(db:Database,scope:string)=>{const v=db.exec(`PRAGMA ${scope}.schema_version`)[0]?.values[0]?.[0];if(typeof v!=='number'||!Number.isSafeInteger(v))return fail('stale');return v;};
function authority(db:Database){
 const size=Number(db.exec('PRAGMA page_count')[0]?.values[0]?.[0])*Number(db.exec('PRAGMA page_size')[0]?.values[0]?.[0]);if(!Number.isSafeInteger(size)||size>1024*1024)fail('budget');
 if(rows(db,'SELECT name FROM temp.sqlite_schema',[],1).length)fail('dependency');
 const all=rows(db,'SELECT type,name,tbl_name,rootpage,sql FROM main.sqlite_schema ORDER BY type,name');if(all.some(r=>r[0]==='trigger'))fail('dependency');if(all.some(r=>r[0]==='table'&&/^sqlite_/i.test(String(r[1]))))fail('table');
 const tables=rows(db,"SELECT name,type,wr,strict FROM pragma_table_list WHERE schema='main' AND type!='view' AND lower(substr(name,1,7)) != 'sqlite_' ORDER BY name",[],32);
 const columns=new Map<string,ReturnType<typeof rows>>();for(const [raw,type,wr,strict] of tables){if(type!=='table'||wr!==0||strict!==0)fail('table');const table=String(raw);const cols=rows(db,"SELECT cid,name,type,[notnull],dflt_value,pk,hidden FROM pragma_table_xinfo(?, 'main') ORDER BY cid",[table],64);if(!cols.length||cols.some(c=>c[6]!==0))fail('table');columns.set(table,cols);}
 const views=all.filter(r=>r[0]==='view').map(r=>{const view=String(r[1]);const metadata=rows(db,"SELECT cid,name,type,[notnull],dflt_value,pk,hidden FROM pragma_table_xinfo(?, 'main') ORDER BY cid",[view],64);let statement;try{statement=db.prepare(`SELECT * FROM \"main\".${q(view)} LIMIT 0`);}catch{return fail('dependency');}finally{statement?.free();}return {view,metadata};});
 return {all,columns,views};
}
function plan(input:unknown,schema:DatabaseSchemaResult,db:Database){
 if(!input||typeof input!=='object'||Object.keys(input).sort().join(',')!=='column,table')fail('draft');const d=input as DropColumnDraft;if(!name(d.table)||!name(d.column))fail('identifier');
 const table=schema.tables.find(t=>fold(t.name)===fold(d.table));if(!table||table.kind!=='table')fail('table');const column=table.columns.find(c=>fold(c.name)===fold(d.column));if(!column||column.primaryKey||table.columns.length<2)fail('column');
 if(!table.definition||table.indexes?.length!==0||table.triggers?.length!==0)fail('dependency');let tokens:string[];try{tokens=sqliteSchemaTokens(table.definition);}catch{return fail('table');}if(tokens.some(t=>['DEFAULT','CHECK','GENERATED','UNIQUE','REFERENCES','COLLATE','AUTOINCREMENT'].includes(t)))fail('dependency');
 for(const t of schema.tables){if(!Array.isArray(t.foreignKeys))fail('dependency');if(t.foreignKeys.some(f=>t===table||fold(f.targetTable)===fold(table.name)))fail('dependency');}
 const a=authority(db),cols=a.columns.get(table.name);if(!cols||cols.some(c=>c[4]!==null||! /^(INTEGER|REAL|TEXT|BLOB|NUMERIC)$/i.test(String(c[2]))))fail('table');
 return {draft:{table:table.name,column:column.name},sql:`ALTER TABLE "main".${q(table.name)} DROP COLUMN ${q(column.name)};`,authority:a};
}
/** Exact retained row values, including rowid and SQLite storage class. INTEGER
 * values stay text (int64-safe), BLOB bytes stay hex, finite REAL stays JS double.
 * Entire database scan is bounded; unsupported/large data refuses the operation.
 */
function data(db:Database,a:ReturnType<typeof authority>,omit?:DropColumnDraft){let totalRows=0,totalBytes=0;const result:Array<{table:string;rows:ReturnType<typeof rows>}>=[];
 for(const [table,cols] of a.columns){const names=cols.map(c=>String(c[1])),rowid=['_rowid_','rowid','oid'].find(n=>!names.some(c=>fold(c)===n));if(!rowid)fail('table');const selected=names.filter(c=>!(omit?.table===table&&omit.column===c));
  const expressions=selected.flatMap(c=>{const col=q(c);return [`typeof(${col})`,`CASE typeof(${col}) WHEN 'integer' THEN CAST(${col} AS TEXT) WHEN 'blob' THEN hex(${col}) WHEN 'text' THEN hex(CAST(${col} AS BLOB)) ELSE ${col} END`];});
  const values=rows(db,`SELECT CAST(${q(rowid)} AS TEXT)${expressions.length?', '+expressions.join(', '):''} FROM "main".${q(table)} ORDER BY ${q(rowid)}`,[],1000-totalRows);totalRows+=values.length;
  if(values.some(r=>r.some(v=>typeof v==='number'&&!Number.isFinite(v))))fail('budget');totalBytes+=new TextEncoder().encode(JSON.stringify(values)).length;if(totalBytes>96*1024)fail('budget');result.push({table,rows:values.map(row=>row.map(v=>typeof v==='number'?`real:${Object.is(v,-0)?'-0':String(v)}`:v))});
 }return result;
}
export function createDropColumnAdapter({getDatabase,inspectSchema,reviewTokens,onFatal}:{getDatabase:(handleId:string)=>Database;inspectSchema:(db:Database)=>DatabaseSchemaResult;reviewTokens:Map<string,string>;onFatal?:(handleId:string)=>void}){
 const pending=new Map<string,{token:string;data:string}>();
 const owns=(handle:string,token:string)=>{const raw=reviewTokens.get(handle);if(!raw)return false;try{const parsed=JSON.parse(raw);return parsed?.handleId===handle&&parsed?.token===token;}catch{return false;}};
 return {
  preview({handleId,draft}:{handleId:string;draft:DropColumnDraft}):DropColumnReview{for(const [h,p] of pending)if(!owns(h,p.token))pending.delete(h);if(!pending.has(handleId)&&pending.size>=4)fail('budget');reviewTokens.delete(handleId);pending.delete(handleId);const db=getDatabase(handleId),p=plan(draft,inspectSchema(db),db),snapshot=data(db,p.authority);const review={handleId,draft:p.draft,sql:p.sql,schemaRevision:version(db,'main'),tempSchemaRevision:version(db,'temp'),token:crypto.randomUUID(),affectedRows:snapshot.find(t=>t.table===p.draft.table)!.rows.length,warning:'permanently-deletes-column-values' as const};pending.set(handleId,{token:review.token,data:JSON.stringify(snapshot)});reviewTokens.set(handleId,JSON.stringify(review));return review;},
  apply({handleId,review}:{handleId:string;review:DropColumnReview}){const issued=reviewTokens.get(handleId),saved=pending.get(handleId);if(!saved||issued!==JSON.stringify(review)||review.handleId!==handleId||saved.token!==review.token)fail('review');reviewTokens.delete(handleId);pending.delete(handleId);const db=getDatabase(handleId);if(version(db,'main')!==review.schemaRevision||version(db,'temp')!==review.tempSchemaRevision)fail('stale');let transaction=false,closed=false;const fatal=()=>{closed=true;try{onFatal?.(handleId);}catch{}try{db.close();}catch{}};const guards=(readonly:number)=>{if(db.exec('PRAGMA query_only')[0]?.values[0]?.[0]!==readonly||db.exec('PRAGMA foreign_keys')[0]?.values[0]?.[0]!==1||db.exec('PRAGMA trusted_schema')[0]?.values[0]?.[0]!==0)fail('protection');};
   try{guards(1);const before=inspectSchema(db),p=plan(review.draft,before,db);if(p.sql!==review.sql)fail('review');if(JSON.stringify(data(db,p.authority))!==saved.data)fail('stale');const expected=data(db,p.authority,p.draft);
    try{db.run('BEGIN');}catch{fail('transaction');}transaction=true;db.run('SAVEPOINT plugin_drop_column');db.run('PRAGMA query_only=OFF');guards(0);db.run(p.sql);
    const after=inspectSchema(db),next=authority(db),others=(all:typeof next.all)=>all.filter(r=>!(r[0]==='table'&&r[1]===p.draft.table));
    if(JSON.stringify(p.authority.views)!==JSON.stringify(next.views)||JSON.stringify(others(p.authority.all))!==JSON.stringify(others(next.all)))fail('dependency');
    const oldCols=p.authority.columns.get(p.draft.table)!,newCols=next.columns.get(p.draft.table)!;if(JSON.stringify(oldCols.filter(c=>c[1]!==p.draft.column).map((c,i)=>[i,...c.slice(1)]))!==JSON.stringify(newCols))fail('dependency');
    const expectedSchema=before.tables.map(t=>t.name===p.draft.table?{...t,columns:t.columns.filter(c=>c.name!==p.draft.column),definition:undefined}:t),actualSchema=after.tables.map(t=>t.name===p.draft.table?{...t,definition:undefined}:t);
    if(JSON.stringify(expectedSchema)!==JSON.stringify(actualSchema)||JSON.stringify(expected)!==JSON.stringify(data(db,next)))fail('dependency');
    const size=Number(db.exec('PRAGMA page_count')[0]?.values[0]?.[0])*Number(db.exec('PRAGMA page_size')[0]?.values[0]?.[0]);if(!Number.isSafeInteger(size)||size>1024*1024)fail('budget');guards(0);db.run('PRAGMA query_only=ON');guards(1);db.run('RELEASE plugin_drop_column; COMMIT');transaction=false;return {schema:after,sql:p.sql,changes:0 as const};
   }catch(error){if(transaction){try{db.run('ROLLBACK');}catch{fatal();fail('protection');}}throw error;}finally{if(!closed){try{db.run('PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');guards(1);}catch{fatal();fail('protection');}}}
  },
  cancel(handleId:string,expectedToken?:string){const p=pending.get(handleId);if(expectedToken!==undefined&&p?.token!==expectedToken)return;if(p&&owns(handleId,p.token))reviewTokens.delete(handleId);pending.delete(handleId);},
  dispose(){for(const [handle,p] of pending){if(owns(handle,p.token))reviewTokens.delete(handle);}pending.clear();}
 };
}

import {sqliteSchemaTokens} from './sqliteSchemaKeywords';
import type {Database} from 'sql.js';import type {DatabaseSchemaResult} from './databaseTypes';
export interface RenameTableDraft {from:string;to:string}
export interface RenameTableReview {handleId:string;draft:RenameTableDraft;sql:string;schemaRevision:number;tempSchemaRevision:number;token:string}
export class RenameTableError extends Error {constructor(readonly code:'draft'|'identifier'|'table'|'exists'|'dependency'|'budget'|'stale'|'review'|'protection'|'transaction'){super(`Rename table ${code}`);}}
function fail(c:RenameTableError['code']):never{throw new RenameTableError(c);}const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';const fold=(s:string)=>s.replace(/[A-Z]/g,c=>c.toLowerCase());
function name(v:unknown):v is string{return typeof v==='string'&&!!v.trim()&&v.length<=128&&!v.includes('\0')&&!/^sqlite_/i.test(v);}
function version(db:Database,scope='main'){const v=db.exec(`PRAGMA ${scope}.schema_version`)[0]?.values[0]?.[0];if(typeof v!=='number'||!Number.isSafeInteger(v))return fail('stale');return v;}
function rows(db:Database,sql:string,params:string[]=[],max=128){const s=db.prepare(sql),result:ReturnType<typeof s.get>[]=[];try{s.bind(params);while(s.step()){if(result.length>=max)fail('budget');result.push(s.get());}if(new TextEncoder().encode(JSON.stringify(result)).length>96*1024)fail('budget');return result;}finally{s.free();}}
function authority(db:Database,table:string){
 if(rows(db,'SELECT name FROM temp.sqlite_schema',[],1).length)fail('dependency');
 const all=rows(db,'SELECT type,name,tbl_name,rootpage,sql FROM main.sqlite_schema ORDER BY type,name');
 if(all.some(r=>r[0]==='trigger'))fail('dependency');
 const t=rows(db,"SELECT type,strict FROM pragma_table_list WHERE schema='main' AND name=? COLLATE BINARY",[table],1)[0];if(!t||t[0]!=='table'||t[1]!==0)fail('table');
 const columns=rows(db,"SELECT cid,name,type,[notnull],dflt_value,pk,hidden FROM pragma_table_xinfo(?, 'main') ORDER BY cid",[table],64);
 if(!columns.length||columns.some(c=>c[4]!==null||c[6]!==0||! /^(INTEGER|REAL|TEXT|BLOB|NUMERIC)$/i.test(String(c[2]))))fail('table');
 const definition=all.find(r=>r[0]==='table'&&r[1]===table)?.[4];if(typeof definition!=='string')fail('table');let tokens:string[];try{tokens=sqliteSchemaTokens(definition);}catch{return fail('table');}if(tokens.some(t=>['CHECK','GENERATED','VIRTUAL','STRICT'].includes(t)))fail('table');
 if(rows(db,'SELECT name FROM pragma_index_list(?)',[table],1).length)fail('dependency');
 return {all,columns};
}
export function previewRenameTableSql(input:unknown,schema:DatabaseSchemaResult){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='from,to')fail('draft');const draft=input as RenameTableDraft;if(!name(draft.from)||!name(draft.to))fail('identifier');
 const table=schema.tables.find(t=>fold(t.name)===fold(draft.from));if(!table||table.kind!=='table')fail('table');if(schema.tables.some(t=>fold(t.name)===fold(draft.to)))fail('exists');
 if(!Array.isArray(table.indexes)||table.indexes.length||!Array.isArray(table.triggers)||table.triggers.length)fail('dependency');
 for(const t of schema.tables){if(!Array.isArray(t.foreignKeys))fail('dependency');if(t.foreignKeys.some(f=>t===table||fold(f.targetTable)===fold(table.name)))fail('dependency');}
 const canonical={from:table.name,to:draft.to};return {draft:canonical,sql:`ALTER TABLE "main".${quote(canonical.from)} RENAME TO ${quote(canonical.to)};`};
}
/** Plugin-local only. Pass the SAME reviewTokens map as other schema operations.
 * getDatabase must reject closed handles; inspectSchema must be authoritative.
 */
export function createRenameTableAdapter({getDatabase,inspectSchema,reviewTokens,onFatal}:{getDatabase:(handleId:string)=>Database;inspectSchema:(db:Database)=>DatabaseSchemaResult;reviewTokens:Map<string,string>;onFatal?:(handleId:string)=>void}){
 return {
  preview({handleId,draft}:{handleId:string;draft:RenameTableDraft}):RenameTableReview{
   reviewTokens.delete(handleId);const db=getDatabase(handleId),p=previewRenameTableSql(draft,inspectSchema(db));const a=authority(db,p.draft.from);if(a.all.some(r=>fold(String(r[1]))===fold(p.draft.to)))fail('exists');
   const review={handleId,...p,schemaRevision:version(db),tempSchemaRevision:version(db,'temp'),token:crypto.randomUUID()};reviewTokens.set(handleId,JSON.stringify(review));return review;
  },
  apply({handleId,review}:{handleId:string;review:RenameTableReview}){
   const saved=reviewTokens.get(handleId);reviewTokens.delete(handleId);if(!saved||review.handleId!==handleId||saved!==JSON.stringify(review))fail('review');const db=getDatabase(handleId);if(version(db)!==review.schemaRevision||version(db,'temp')!==review.tempSchemaRevision)fail('stale');let transaction=false,closed=false;const fatal=()=>{closed=true;try{onFatal?.(handleId);}catch{}try{db.close();}catch{}};
   const guards=(readOnly:number)=>{if(db.exec('PRAGMA query_only')[0]?.values[0]?.[0]!==readOnly||db.exec('PRAGMA foreign_keys')[0]?.values[0]?.[0]!==1||db.exec('PRAGMA trusted_schema')[0]?.values[0]?.[0]!==0)fail('protection');};
   try{guards(1);const before=inspectSchema(db),p=previewRenameTableSql(review.draft,before),a=authority(db,p.draft.from);if(p.sql!==review.sql)fail('review');
    // BEGIN fails without touching an existing caller transaction.
    try{db.run('BEGIN');}catch{fail('transaction');}transaction=true;db.run('SAVEPOINT plugin_rename_table');db.run('PRAGMA query_only=OFF');guards(0);db.run(p.sql);
    const after=inspectSchema(db),b=authority(db,p.draft.to),other=(all:typeof a.all,target:string)=>all.filter(r=>!(r[0]==='table'&&r[1]===target));
    if(JSON.stringify(other(a.all,p.draft.from))!==JSON.stringify(other(b.all,p.draft.to))||JSON.stringify(a.columns)!==JSON.stringify(b.columns))fail('dependency');
    const old=a.all.find(r=>r[0]==='table'&&r[1]===p.draft.from)!,next=b.all.find(r=>r[0]==='table'&&r[1]===p.draft.to)!;if(old[3]!==next[3]||next[2]!==p.draft.to)fail('dependency');
    if(JSON.stringify(before.tables.filter(t=>t.name!==p.draft.from))!==JSON.stringify(after.tables.filter(t=>t.name!==p.draft.to)))fail('dependency');
    const oldMeta=before.tables.find(t=>t.name===p.draft.from)!,newMeta=after.tables.find(t=>t.name===p.draft.to)!;if(JSON.stringify({...oldMeta,name:p.draft.to,definition:undefined})!==JSON.stringify({...newMeta,definition:undefined}))fail('dependency');
    const size=Number(db.exec('PRAGMA page_count')[0]?.values[0]?.[0])*Number(db.exec('PRAGMA page_size')[0]?.values[0]?.[0]);if(!Number.isSafeInteger(size)||size<1||size>1024*1024)fail('budget');
    guards(0);db.run('PRAGMA query_only=ON');guards(1);db.run('RELEASE plugin_rename_table');db.run('COMMIT');transaction=false;return {schema:after,sql:p.sql,changes:0 as const};
   }catch(error){if(transaction){try{db.run('ROLLBACK');}catch{fatal();fail('protection');}}throw error;}
   finally{if(!closed){try{db.run('PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');guards(1);}catch{fatal();fail('protection');}}}
  },
  cancel(handleId:string){reviewTokens.delete(handleId);}
 };
}

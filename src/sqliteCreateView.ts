import type {Database} from 'sql.js';import type {DatabaseSchemaResult} from './databaseTypes';
export interface CreateViewDraft {name:string;sourceTable:string;columns:string[]}
export interface CreateViewReview {handleId:string;draft:CreateViewDraft;sql:string;schemaRevision:number;tempSchemaRevision:number;token:string}
export interface CreateViewResult {schema:DatabaseSchemaResult;sql:string;changes:0}
export class CreateViewError extends Error {constructor(readonly code:'draft'|'identifier'|'table'|'column'|'exists'|'dependency'|'budget'|'review'|'stale'|'protection'|'transaction'){super(`Create view ${code}`);}}
function fail(code:CreateViewError['code']):never{throw new CreateViewError(code);}const q=(s:string)=>'"'+s.replaceAll('"','""')+'"',fold=(s:string)=>s.replace(/[A-Z]/g,c=>c.toLowerCase());
const name=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=128&&!v.includes('\0')&&!/^sqlite_/i.test(v);
function rows(db:Database,sql:string,params:string[]=[],max=128){const s=db.prepare(sql),out:ReturnType<typeof s.get>[]=[];let bytes=0;try{s.bind(params);while(s.step()){if(out.length>=max)fail('budget');const r=s.get();bytes+=new TextEncoder().encode(JSON.stringify(r)).length;if(bytes>96*1024)fail('budget');out.push(r);}return out;}finally{s.free();}}
function version(db:Database,scope:string){const v=db.exec(`PRAGMA ${scope}.schema_version`)[0]?.values[0]?.[0];if(typeof v!=='number'||!Number.isSafeInteger(v))return fail('stale');return v;}
function catalog(db:Database){if(rows(db,'SELECT name FROM temp.sqlite_schema',[],1).length)fail('dependency');return rows(db,'SELECT type,name,tbl_name,rootpage,sql FROM main.sqlite_schema ORDER BY type,name');}
function columnInfo(db:Database,table:string){return rows(db,"SELECT cid,name,type,[notnull],dflt_value,pk,hidden FROM pragma_table_xinfo(?, 'main') ORDER BY cid",[table],64);}
function plan(db:Database,input:unknown,schema:DatabaseSchemaResult){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='columns,name,sourceTable')fail('draft');const draft=input as CreateViewDraft;
 if(!name(draft.name)||!name(draft.sourceTable))fail('identifier');if(!Array.isArray(draft.columns)||!draft.columns.length||draft.columns.length>32||draft.columns.some(c=>!name(c))||new Set(draft.columns.map(fold)).size!==draft.columns.length)fail('column');
 if(schema.tables.length>=32)fail('budget');const all=catalog(db);if(all.some(r=>fold(String(r[1]))===fold(draft.name)))fail('exists');
 const source=schema.tables.find(t=>fold(t.name)===fold(draft.sourceTable));if(!source||source.kind!=='table')fail('table');
 const flags=rows(db,"SELECT type,wr,strict FROM pragma_table_list WHERE schema='main' AND name=? COLLATE BINARY",[source.name],1)[0];if(!flags||flags[0]!=='table'||flags[1]!==0||flags[2]!==0)fail('table');
 const info=columnInfo(db,source.name);if(!info.length||info.length!==source.columns.length||info.some((c,i)=>c[6]!==0||c[1]!==source.columns[i].name||c[2]!==source.columns[i].type))fail('table');
 const selected=draft.columns.map(n=>{const c=source.columns.find(c=>fold(c.name)===fold(n));if(!c)fail('column');return c;});
 const canonical={name:draft.name,sourceTable:source.name,columns:selected.map(c=>c.name)};
 const sql=`CREATE VIEW "main".${q(canonical.name)} AS SELECT ${canonical.columns.map(q).join(', ')} FROM "main".${q(canonical.sourceTable)};`;
 if(new TextEncoder().encode(sql).length>8192)fail('budget');return {draft:canonical,sql,all,types:selected.map(c=>c.type)};
}
/** No arbitrary SELECT source, data execution, expressions, scripts or functions.
 * Caller owns serialization/live handles and shares tokens with other DDL.
 */
export function createCreateViewAdapter({getDatabase,inspectSchema,reviewTokens,onFatal}:{getDatabase:(handleId:string)=>Database;inspectSchema:(db:Database)=>DatabaseSchemaResult;reviewTokens:Map<string,string>;onFatal?:(handleId:string)=>void}){
 const owned=new Map<string,string>();const owns=(h:string,token:string)=>{try{const r=JSON.parse(reviewTokens.get(h)??'null');return r?.handleId===h&&r?.token===token;}catch{return false;}};
 const cancel=(handleId:string,expectedToken?:string)=>{const token=owned.get(handleId);if(expectedToken!==undefined&&expectedToken!==token)return;if(token&&owns(handleId,token))reviewTokens.delete(handleId);owned.delete(handleId);};
 return {
  preview({handleId,draft}:{handleId:string;draft:CreateViewDraft}):CreateViewReview{for(const [h,t] of owned)if(!owns(h,t))owned.delete(h);cancel(handleId);if(owned.size>=4)fail('budget');const db=getDatabase(handleId);if(db.exec('PRAGMA query_only')[0]?.values[0]?.[0]!==1||db.exec('PRAGMA foreign_keys')[0]?.values[0]?.[0]!==1||db.exec('PRAGMA trusted_schema')[0]?.values[0]?.[0]!==0)fail('protection');const p=plan(db,draft,inspectSchema(db));const review={handleId,draft:p.draft,sql:p.sql,schemaRevision:version(db,'main'),tempSchemaRevision:version(db,'temp'),token:crypto.randomUUID()};owned.set(handleId,review.token);reviewTokens.set(handleId,JSON.stringify(review));return review;},
  apply({handleId,review}:{handleId:string;review:CreateViewReview}):CreateViewResult{
   const token=owned.get(handleId),raw=reviewTokens.get(handleId);if(!token||review.handleId!==handleId||review.token!==token||raw!==JSON.stringify(review))fail('review');cancel(handleId,token);const db=getDatabase(handleId);if(version(db,'main')!==review.schemaRevision||version(db,'temp')!==review.tempSchemaRevision)fail('stale');let transaction=false,closed=false;
   const fatal=()=>{closed=true;try{onFatal?.(handleId);}catch{}try{db.close();}catch{}};
   const guards=(readonly:number)=>{if(db.exec('PRAGMA query_only')[0]?.values[0]?.[0]!==readonly||db.exec('PRAGMA foreign_keys')[0]?.values[0]?.[0]!==1||db.exec('PRAGMA trusted_schema')[0]?.values[0]?.[0]!==0)fail('protection');};
   // Refuse an existing transaction before entering any guard-restoration path.
   try{db.run('BEGIN');}catch{fail('transaction');}transaction=true;
   try{guards(1);const before=inspectSchema(db),p=plan(db,review.draft,before);if(p.sql!==review.sql)fail('review');db.run('SAVEPOINT plugin_create_view');db.run('PRAGMA query_only=OFF');guards(0);db.run(p.sql);
    const after=inspectSchema(db),all=catalog(db),created=all.filter(r=>r[0]==='view'&&r[1]===p.draft.name);if(created.length!==1||created[0][2]!==p.draft.name||created[0][3]!==0||created[0][4]!==`CREATE VIEW ${q(p.draft.name)} AS SELECT ${p.draft.columns.map(q).join(', ')} FROM \"main\".${q(p.draft.sourceTable)}`||JSON.stringify(all.filter(r=>!(r[0]==='view'&&r[1]===p.draft.name)))!==JSON.stringify(p.all))fail('dependency');
    if(JSON.stringify(after.tables.filter(t=>t.name!==p.draft.name))!==JSON.stringify(before.tables))fail('dependency');
    const view=after.tables.find(t=>t.name===p.draft.name),cols=columnInfo(db,p.draft.name);if(!view||view.kind!=='view'||cols.length!==p.draft.columns.length||cols.some((c,i)=>c[0]!==i||c[1]!==p.draft.columns[i]||c[2]!==p.types[i]||c[3]!==0||c[4]!==null||c[5]!==0||c[6]!==0))fail('dependency');
    // Compile only: never step this statement or run view data while creating.
    const statement=db.prepare(`SELECT * FROM "main".${q(p.draft.name)} LIMIT 0`);statement.free();
    const size=Number(db.exec('PRAGMA page_count')[0]?.values[0]?.[0])*Number(db.exec('PRAGMA page_size')[0]?.values[0]?.[0]);if(!Number.isSafeInteger(size)||size>1024*1024)fail('budget');guards(0);db.run('PRAGMA query_only=ON');guards(1);db.run('RELEASE plugin_create_view; COMMIT');transaction=false;return {schema:after,sql:p.sql,changes:0};
   }catch(error){if(transaction){try{db.run('ROLLBACK');}catch{fatal();fail('protection');}}throw error;}finally{if(!closed){try{db.run('PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');guards(1);}catch{fatal();fail('protection');}}}
  },cancel,
  dispose(){for(const h of owned.keys())cancel(h);}
 };
}

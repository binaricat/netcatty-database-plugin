import type {Database} from 'sql.js';import type {DatabaseSchemaResult} from './databaseTypes';
export interface DropViewDraft {name:string}
export interface DropViewReview {handleId:string;draft:DropViewDraft;sql:string;schemaRevision:number;tempSchemaRevision:number;token:string;definition:string;warning:'removes-view-definition-only'}
export interface DropViewResult {schema:DatabaseSchemaResult;sql:string;changes:0}
export class DropViewError extends Error {constructor(readonly code:'draft'|'identifier'|'view'|'dependency'|'budget'|'review'|'stale'|'protection'|'transaction'){super(`Drop view ${code}`);}}
function fail(c:DropViewError['code']):never{throw new DropViewError(c);}const q=(s:string)=>'"'+s.replaceAll('"','""')+'"',fold=(s:string)=>s.replace(/[A-Z]/g,c=>c.toLowerCase());
function rows(db:Database,sql:string,params:string[]=[],max=128){const s=db.prepare(sql),out:ReturnType<typeof s.get>[]=[];let bytes=0;try{s.bind(params);while(s.step()){if(out.length>=max)fail('budget');const r=s.get();bytes+=new TextEncoder().encode(JSON.stringify(r)).length;if(bytes>96*1024)fail('budget');out.push(r);}return out;}finally{s.free();}}
function guards(db:Database,readonly:number){if(db.exec('PRAGMA query_only')[0]?.values[0]?.[0]!==readonly||db.exec('PRAGMA foreign_keys')[0]?.values[0]?.[0]!==1||db.exec('PRAGMA trusted_schema')[0]?.values[0]?.[0]!==0)fail('protection');}
function version(db:Database,scope:string){const v=db.exec(`PRAGMA ${scope}.schema_version`)[0]?.values[0]?.[0];if(typeof v!=='number'||!Number.isSafeInteger(v))return fail('stale');return v;}
function authority(db:Database){
 if(rows(db,'SELECT name FROM temp.sqlite_schema',[],1).length)fail('dependency');
 const all=rows(db,'SELECT type,name,tbl_name,rootpage,sql FROM main.sqlite_schema ORDER BY type,name');if(all.some(r=>r[0]==='trigger'))fail('dependency');
 // No virtual/shadow tables: preparing a dependent virtual-table view can invoke
 // extension callbacks. This slice never evaluates view data or extensions.
 if(rows(db,"SELECT name FROM pragma_table_list WHERE schema='main' AND type IN ('virtual','shadow')",[],1).length)fail('dependency');
 const views=all.filter(r=>r[0]==='view').map(r=>{const name=String(r[1]);const columns=rows(db,"SELECT cid,name,type,[notnull],dflt_value,pk,hidden FROM pragma_table_xinfo(?, 'main') ORDER BY cid",[name],64);let s;try{s=db.prepare(`SELECT * FROM "main".${q(name)} LIMIT 0`);}catch{return fail('dependency');}finally{s?.free();}return {name,columns};});
 if(new TextEncoder().encode(JSON.stringify(views)).length>96*1024)fail('budget');return {all,views};
}
function plan(db:Database,input:unknown,schema:DatabaseSchemaResult){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).join(',')!=='name')fail('draft');const name=(input as DropViewDraft).name;if(typeof name!=='string'||!name.trim()||name.length>128||name.includes('\0')||/^sqlite_/i.test(name))fail('identifier');
 const view=schema.tables.find(t=>fold(t.name)===fold(name));if(!view||view.kind!=='view')fail('view');const a=authority(db),match=a.all.find(r=>r[0]==='view'&&r[1]===view.name);if(!match||match[2]!==view.name||match[3]!==0||typeof match[4]!=='string'||!match[4]||new TextEncoder().encode(match[4]).length>8192)fail('view');return {draft:{name:view.name},sql:`DROP VIEW "main".${q(view.name)};`,definition:match[4],authority:a};}
/** Definition removal only. All view SELECTs are prepared, never stepped. */
export function createDropViewAdapter({getDatabase,inspectSchema,reviewTokens,onFatal}:{getDatabase:(handleId:string)=>Database;inspectSchema:(db:Database)=>DatabaseSchemaResult;reviewTokens:Map<string,string>;onFatal?:(handleId:string)=>void}){
 const owned=new Map<string,string>(),owns=(h:string,t:string)=>{try{const r=JSON.parse(reviewTokens.get(h)??'null');return r?.handleId===h&&r?.token===t;}catch{return false;}};
 const cancel=(h:string,expectedToken?:string)=>{const t=owned.get(h);if(expectedToken!==undefined&&t!==expectedToken)return;if(t&&owns(h,t))reviewTokens.delete(h);owned.delete(h);};
 return {
  preview({handleId,draft}:{handleId:string;draft:DropViewDraft}):DropViewReview{for(const [h,t] of owned)if(!owns(h,t))owned.delete(h);cancel(handleId);if(owned.size>=4)fail('budget');const db=getDatabase(handleId);guards(db,1);const p=plan(db,draft,inspectSchema(db));const review:DropViewReview={handleId,draft:p.draft,sql:p.sql,definition:p.definition,schemaRevision:version(db,'main'),tempSchemaRevision:version(db,'temp'),token:crypto.randomUUID(),warning:'removes-view-definition-only'};owned.set(handleId,review.token);reviewTokens.set(handleId,JSON.stringify(review));return review;},
  apply({handleId,review}:{handleId:string;review:DropViewReview}):DropViewResult{const t=owned.get(handleId);if(!t||review.handleId!==handleId||review.token!==t||reviewTokens.get(handleId)!==JSON.stringify(review))fail('review');cancel(handleId,t);const db=getDatabase(handleId);if(version(db,'main')!==review.schemaRevision||version(db,'temp')!==review.tempSchemaRevision)fail('stale');let transaction=false,closed=false;const fatal=()=>{closed=true;try{onFatal?.(handleId);}catch{}try{db.close();}catch{}};
   try{db.run('BEGIN');}catch{fail('transaction');}transaction=true;
   try{guards(db,1);const before=inspectSchema(db),p=plan(db,review.draft,before);if(p.sql!==review.sql||p.definition!==review.definition)fail('review');db.run('SAVEPOINT plugin_drop_view');db.run('PRAGMA query_only=OFF');guards(db,0);db.run(p.sql);
    const a=authority(db),after=inspectSchema(db);if(JSON.stringify(a.all)!==JSON.stringify(p.authority.all.filter(r=>!(r[0]==='view'&&r[1]===p.draft.name)))||JSON.stringify(a.views)!==JSON.stringify(p.authority.views.filter(v=>v.name!==p.draft.name))||JSON.stringify(after.tables)!==JSON.stringify(before.tables.filter(t=>t.name!==p.draft.name)))fail('dependency');
    const size=Number(db.exec('PRAGMA page_count')[0]?.values[0]?.[0])*Number(db.exec('PRAGMA page_size')[0]?.values[0]?.[0]);if(!Number.isSafeInteger(size)||size>1024*1024)fail('budget');guards(db,0);db.run('PRAGMA query_only=ON');guards(db,1);db.run('RELEASE plugin_drop_view; COMMIT');transaction=false;return {schema:after,sql:p.sql,changes:0};
   }catch(error){if(transaction){try{db.run('ROLLBACK');}catch{fatal();fail('protection');}}if(error instanceof DropViewError)throw error;throw new DropViewError('dependency');}finally{if(!closed){try{db.run('PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');guards(db,1);}catch{fatal();fail('protection');}}}
  },cancel,dispose(){for(const h of owned.keys())cancel(h);}
 };
}

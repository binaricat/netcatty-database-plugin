import React,{useEffect,useMemo,useRef,useSyncExternalStore} from 'react';
import type {WorkbenchContext} from './databaseClient';
import type {DatabaseSchemaResult,AddColumnDraft,AddColumnReview} from './databaseTypes';
import {AddColumnError} from './alterTableModel';
import {SQLITE_TABLE_TYPES} from './schemaCreateTable';
import {SqlPreview} from './SqlPreview';
type State={draft:AddColumnDraft;review:AddColumnReview|null;busy:'idle'|'preview'|'apply';done:boolean;notice:string;};
// Serial per adapter/connection, including unmount/reopen. A stale in-flight
// preview may finish, but can never overwrite a newer ADD preview issued here.
const previewQueues=new WeakMap<object,Map<string,Promise<void>>>();
async function serialPreview<T>(database:object,handleId:string,run:()=>Promise<T>):Promise<T>{
 let queues=previewQueues.get(database);if(!queues){queues=new Map();previewQueues.set(database,queues);}
 const previous=queues.get(handleId)??Promise.resolve();const current=previous.then(run);const tail=current.then(()=>{},()=>{});queues.set(handleId,tail);
 try{return await current;}finally{if(queues.get(handleId)===tail)queues.delete(handleId);}
}
export function addColumnErrorText(code:string,zh:boolean):string {
 const messages:Record<string,[string,string]>={
 draft:['Use one nullable INTEGER, REAL, TEXT, BLOB or NUMERIC column without constraints or defaults.','请仅添加一个可空的 INTEGER、REAL、TEXT、BLOB 或 NUMERIC 列，不含约束或默认值。'],
 identifier:['Use a nonblank name of at most 128 characters, without NUL or the sqlite_ prefix.','名称须非空且不超过 128 字符，不能包含空字符或以 sqlite_ 开头。'],
 schema:['Schema metadata is incomplete or inconsistent. Refresh the connection schema before editing.','结构元数据不完整或不一致，请先刷新连接结构。'],
 table:['Choose a regular table without triggers, STRICT, virtual/shadow or generated/hidden columns. Those table layouts are not supported here.','请选择普通表；此处不支持带触发器、STRICT、虚拟或影子表，以及生成列或隐藏列的表。'],
 exists:['A column with this name already exists. Choose a different column name.','同名列已存在，请更换列名。'],
 budget:['Workspace limit reached: at most 64 columns, 1 MiB database and bounded schema metadata. Use a smaller table or workspace.','已达到工作区限制：最多 64 列、数据库 1 MiB，结构元数据亦有大小限制。请使用更小的表或工作区。'],
 stale:['The schema changed. Refresh it and prepare a new review.','表结构已变化，请刷新后重新生成审阅。'],
 review:['The review is missing, changed or already consumed. Prepare a new review before confirming.','审阅缺失、已变化或已使用，请重新生成审阅后确认。'],
 };
 return messages[code]?.[zh?1:0]??(zh?'操作失败，请检查连接后重新预览。':'Operation failed. Check the connection and prepare a new preview.');
}
export function addColumnController(database:Pick<WorkbenchContext['database'],'previewAddColumn'|'applyAddColumn'>,handleId:string,schema:DatabaseSchemaResult,onApplied:(schema:DatabaseSchemaResult)=>void){
 let state:State={draft:{table:schema.tables.find(t=>t.kind==='table')?.name??'',name:'',type:'TEXT'},review:null,busy:'idle',done:false,notice:''};let epoch=0,disposed=false;const listeners=new Set<()=>void>();
 const emit=(patch:Partial<State>)=>{if(disposed)return;state={...state,...patch};listeners.forEach(fn=>fn());};
 return {getSnapshot:()=>state,subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},
 edit(patch:Partial<AddColumnDraft>){if(disposed||state.busy==='apply'||state.done)return;epoch++;emit({draft:{...state.draft,...patch},review:null,notice:''});},
 cancel(){if(state.busy==='apply')return false;epoch++;emit({review:null,notice:'cancelled'});return true;},
 async preview(){if(disposed||state.busy!=='idle'||state.done)return;const op=++epoch,draft={...state.draft};emit({busy:'preview',review:null,notice:''});try{
 const review=await serialPreview(database,handleId,async()=>{if(disposed||op!==epoch)return null;return database.previewAddColumn({handleId,draft});});if(disposed||op!==epoch)return;
 if(!review||review.handleId!==handleId||JSON.stringify(review.draft)!==JSON.stringify(draft))throw new AddColumnError('review');emit({review:{...review,draft:{...review.draft}},notice:'review-ready'});
 }catch(e){if(!disposed&&op===epoch)emit({notice:e instanceof AddColumnError?e.code:'failed'});}finally{emit({busy:'idle'});}},
 async confirm(){if(disposed||state.busy!=='idle'||!state.review||state.done)return;const review=state.review,op=++epoch;emit({review:null,busy:'apply',notice:''});try{
 const result=await database.applyAddColumn({handleId,review});if(disposed||op!==epoch)return;emit({done:true,notice:'done'});try{onApplied(result.schema);}catch{emit({notice:'refresh'});}
 }catch(e){if(!disposed&&op===epoch)emit({notice:e instanceof AddColumnError?e.code:'failed'});}finally{if(op===epoch)emit({busy:'idle'});}},
 dispose(){disposed=true;epoch++;state={...state,review:null};listeners.clear();},
 };
}
export function AddColumn({context,handleId,schema,onApplied,onClose}:{context:WorkbenchContext;handleId:string;schema:DatabaseSchemaResult;onApplied:(schema:DatabaseSchemaResult)=>void;onClose:()=>void}){
 const callback=useRef(onApplied);callback.current=onApplied;
 const controller=useMemo(()=>addColumnController(context.database,handleId,schema,s=>callback.current(s)),[context.database,handleId]);
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);useEffect(()=>()=>controller.dispose(),[controller]);
 const zh=context.environment?.locale?.toLowerCase().startsWith('zh'),tr=(en:string,cn:string)=>zh?cn:en;
 const locked=state.busy==='apply'||state.done;
 const notices:Record<string,string>={cancelled:tr('Preview cancelled; no ALTER submitted.','预览已取消，未提交 ALTER。'),'review-ready':tr('Review the exact SQL, then confirm once.','请审阅完整 SQL，再确认一次。'),done:tr('Column added. Schema refreshed and prior query results invalidated.','列已添加，结构已刷新，旧查询结果已失效。'),refresh:tr('Column added, but refresh failed. Reopen the schema browser.','列已添加，但刷新失败。请重新打开结构浏览器。'),failed:tr('Operation failed. Prepare a new preview before retrying.','操作失败，请重新预览后再试。')};
 return <section className="create-table" aria-label={tr('Add SQLite column','添加 SQLite 列')}>
 <header className="results-heading create-table-header"><div className="create-table-intro"><h2>{tr('Add column','添加列')}</h2><p className="hint">{tr('Disposable SQLite only. One nullable column; existing rows receive NULL. No defaults or constraints.','仅临时 SQLite：添加一个可空列，原有行填 NULL。不含默认值或约束。')}</p></div><button className="secondary toolbar-button" disabled={state.busy==='apply'} onClick={()=>{if(controller.cancel())onClose();}}>{state.done?tr('Close','关闭'):tr('Cancel','取消')}</button></header>
 {!state.done && <><div className="create-table-column"><label className="create-table-column-name">{tr('Table','表')}<select aria-label={tr('Alter table','修改表')} disabled={locked} value={state.draft.table} onChange={e=>controller.edit({table:e.currentTarget.value})}>{schema.tables.filter(t=>t.kind==='table').map(t=><option key={t.name} value={t.name}>{t.name}</option>)}</select></label>
 <label className="create-table-column-name">{tr('Column name','列名')}<input aria-label={tr('Added column name','新增列名')} disabled={locked} maxLength={128} value={state.draft.name} onChange={e=>controller.edit({name:e.currentTarget.value})}/></label>
 <label className="create-table-column-type">{tr('Type','类型')}<select aria-label={tr('Added column type','新增列类型')} disabled={locked} value={state.draft.type} onChange={e=>controller.edit({type:e.currentTarget.value as AddColumnDraft['type']})}>{SQLITE_TABLE_TYPES.map(type=><option key={type} value={type}>{type}</option>)}</select></label></div>
 <div className="results-heading create-table-actions"><button className="secondary toolbar-button" disabled={locked||state.busy!=='idle'||!state.draft.name.trim()||!state.draft.table} onClick={()=>void controller.preview()}>{tr('Preview ALTER TABLE','预览 ALTER TABLE')}</button><button className="secondary toolbar-button" disabled={locked||state.busy!=='idle'||!state.review} onClick={()=>void controller.confirm()}>{tr('Confirm add column','确认添加列')}</button></div></>}
 {!state.done && state.review && <section className="create-table-review"><p className="hint">{state.review?tr(`Schema revision ${state.review.schemaRevision}; edits invalidate this review.`,`结构版本 ${state.review.schemaRevision}；修改表单将使预览失效。`):tr('Preview does not change the table. Confirm only after reviewing SQL.','预览不会修改表，请审阅 SQL 后再确认。')}</p><SqlPreview label={tr('Reviewed ALTER TABLE SQL','待确认的 ALTER TABLE SQL')} sql={state.review.sql}/></section>}
 <p role="status" className="create-table-status">{state.notice?(notices[state.notice]??addColumnErrorText(state.notice,Boolean(zh))):''}</p>
 </section>;
}

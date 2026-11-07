import {serialPreview} from './schemaPreviewQueue';
import React,{useEffect,useMemo,useRef,useSyncExternalStore} from 'react';
import type {WorkbenchContext} from './databaseClient';
import type {DatabaseSchemaResult,RenameColumnReview} from './databaseTypes';
import type {RenameColumnDraft} from './schemaRenameColumn';
import {RenameColumnError} from './schemaRenameColumn';
import {SqlPreview} from './SqlPreview';
type State={draft:RenameColumnDraft;review:RenameColumnReview|null;busy:'idle'|'preview'|'apply';done:boolean;notice:string;};
// Serial per adapter/connection, including unmount/reopen. A stale in-flight
// preview may finish, but can never overwrite a newer RENAME preview issued here.
export function renameColumnErrorText(code:string,zh:boolean):string {
 const messages:Record<string,[string,string]>={
 identifier:['Use a nonblank name of at most 128 characters, without NUL or sqlite_ prefix.','名称须非空且不超过 128 字符，不含空字符或 sqlite_ 前缀。'],
 exists:['The new column name already exists. Choose another name.','新列名已存在，请使用其他名称。'],
 unchanged:['Choose a different column name.','请输入不同的列名。'],
 column:['Select an existing column from this table.','请选择此表的已有列。'],
 dependency:['Referenced objects would change. The rename was refused or rolled back; review the dependencies first.','引用对象会受影响，重命名已被拒绝或回滚；请先检查依赖。'],
 definition:['This table definition is outside the supported plain scalar subset.','此表定义不属于受支持的普通标量表范围。'],
 table:['Select a supported regular table; virtual, shadow and special layouts are not supported.','请选择受支持的普通表；不支持虚拟、影子或特殊结构。'],
 schema:['Schema metadata is incomplete. Refresh the connection schema.','结构元数据不完整，请刷新连接结构。'],
 budget:['The schema or database exceeds the workspace limits.','结构或数据库超过工作区限制。'],
 stale:['The schema changed. Refresh and prepare a new preview.','结构已变化，请刷新后重新预览。'],
 review:['The review is missing, changed or consumed. Prepare a new preview.','审阅缺失、已变化或已使用，请重新预览。'],
 draft:['Select a table and source column, and enter a new name.','请选择表与原列，并输入新列名。'],
 };
 return messages[code]?.[zh?1:0]??(zh?'操作失败，请检查连接后重新预览。':'Operation failed. Check the connection and prepare a new preview.');
}
export function renameColumnController(database:Pick<WorkbenchContext['database'],'previewRenameColumn'|'applyRenameColumn'>,handleId:string,schema:DatabaseSchemaResult,onApplied:(schema:DatabaseSchemaResult)=>void){
 let state:State={draft:{table:schema.tables.find(t=>t.kind==='table')?.name??'',from:schema.tables.find(t=>t.kind==='table')?.columns[0]?.name??'',to:''},review:null,busy:'idle',done:false,notice:''};let epoch=0,disposed=false;const listeners=new Set<()=>void>();
 const emit=(patch:Partial<State>)=>{if(disposed)return;state={...state,...patch};listeners.forEach(fn=>fn());};
 return {getSnapshot:()=>state,subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},
 edit(patch:Partial<RenameColumnDraft>){if(patch.table!==undefined){const table=schema.tables.find(t=>t.kind==='table'&&t.name===patch.table);if(!table)return;patch={...patch,from:table.columns[0]?.name??''};}if(disposed||state.busy==='apply'||state.done)return;epoch++;emit({draft:{...state.draft,...patch},review:null,notice:''});},
 cancel(){if(state.busy==='apply')return false;epoch++;emit({review:null,notice:'cancelled'});return true;},
 async preview(){if(disposed||state.busy!=='idle'||state.done)return;const op=++epoch,draft={...state.draft};emit({busy:'preview',review:null,notice:''});try{
 const review=await serialPreview(database,handleId,async()=>{if(disposed||op!==epoch)return null;return database.previewRenameColumn({handleId,draft});});if(disposed||op!==epoch)return;
 if(!review||review.handleId!==handleId||JSON.stringify(review.draft)!==JSON.stringify(draft))throw new RenameColumnError('review');emit({review:{...review,draft:{...review.draft}},notice:'review-ready'});
 }catch(e){if(!disposed&&op===epoch)emit({notice:e instanceof RenameColumnError?e.code:'failed'});}finally{emit({busy:'idle'});}},
 async confirm(){if(disposed||state.busy!=='idle'||!state.review||state.done)return;const review=state.review,op=++epoch;emit({review:null,busy:'apply',notice:''});try{
 const result=await database.applyRenameColumn({handleId,review});if(disposed||op!==epoch)return;emit({done:true,notice:'done'});try{onApplied(result.schema);}catch{emit({notice:'refresh'});}
 }catch(e){if(!disposed&&op===epoch)emit({notice:e instanceof RenameColumnError?e.code:'failed'});}finally{if(op===epoch)emit({busy:'idle'});}},
 dispose(){disposed=true;epoch++;state={...state,review:null};listeners.clear();},
 };
}
export function RenameColumn({context,handleId,schema,onApplied,onClose,onBusyChange}:{context:WorkbenchContext;handleId:string;schema:DatabaseSchemaResult;onApplied:(schema:DatabaseSchemaResult)=>void;onClose:()=>void;onBusyChange?:(busy:boolean)=>void}){
 const callback=useRef(onApplied);callback.current=onApplied;
 const controller=useMemo(()=>renameColumnController(context.database,handleId,schema,s=>callback.current(s)),[context.database,handleId]);
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);useEffect(()=>()=>controller.dispose(),[controller]);
 useEffect(()=>{onBusyChange?.(state.busy==='apply');return()=>onBusyChange?.(false);},[state.busy,onBusyChange]);
 const zh=Boolean(context.environment?.locale?.toLowerCase().startsWith('zh')),tr=(en:string,cn:string)=>zh?cn:en,locked=state.busy==='apply'||state.done;
 const notices:Record<string,string>={cancelled:tr('Preview cancelled; no ALTER submitted.','预览已取消，未提交 ALTER。'),'review-ready':tr('Review the exact SQL before confirming. Dependencies are checked during apply.','请审阅完整 SQL 后再确认；提交时会验证依赖。'),done:tr('Column renamed. Schema refreshed and prior query results invalidated.','列已重命名，结构已刷新，旧查询结果已失效。'),refresh:tr('Column renamed, but refresh failed. Reopen the schema browser.','列已重命名，但刷新失败。请重新打开结构浏览器。')};
 const columns=schema.tables.find(t=>t.name===state.draft.table)?.columns??[];
 return <section className="create-table" aria-label={tr('Rename SQLite column','重命名 SQLite 列')}><header className="results-heading create-table-header"><div><h2>{tr('Rename column','重命名列')}</h2><p className="hint">{tr('Disposable SQLite only. If referenced objects would change, confirmation refuses or rolls back the rename.','仅临时 SQLite。若引用对象会受影响，确认时会拒绝或回滚重命名。')}</p></div><button className="secondary toolbar-button" disabled={state.busy==='apply'} onClick={()=>{if(controller.cancel())onClose();}}>{tr(state.done?'Close':'Cancel',state.done?'关闭':'取消')}</button></header>
 {!state.done?<><div className="create-index-definition"><label>{tr('Table','表')}<select aria-label={tr('Rename table','重命名列所属表')} disabled={locked} value={state.draft.table} onChange={e=>controller.edit({table:e.currentTarget.value})}>{schema.tables.filter(t=>t.kind==='table').map(t=><option key={t.name} value={t.name}>{t.name}</option>)}</select></label><label>{tr('Existing column','原列')}<select aria-label={tr('Rename source column','重命名原列')} disabled={locked} value={state.draft.from} onChange={e=>controller.edit({from:e.currentTarget.value})}>{columns.map(c=><option key={c.name} value={c.name}>{c.name}</option>)}</select></label><label>{tr('New name','新名称')}<input aria-label={tr('Renamed column name','重命名后列名')} maxLength={128} disabled={locked} value={state.draft.to} onChange={e=>controller.edit({to:e.currentTarget.value})}/></label></div>
 {state.review?<SqlPreview label={tr('Reviewed RENAME COLUMN SQL','待确认的 RENAME COLUMN SQL')} sql={state.review.sql}/>:null}
 <div className="results-heading create-table-actions"><button className="secondary toolbar-button" disabled={locked||state.busy!=='idle'||!state.draft.table||!state.draft.from||!state.draft.to.trim()} onClick={()=>void controller.preview()}>{tr('Preview RENAME COLUMN','预览 RENAME COLUMN')}</button><button className="secondary toolbar-button" disabled={locked||state.busy!=='idle'||!state.review} onClick={()=>void controller.confirm()}>{tr('Confirm rename column','确认重命名列')}</button></div></>:null}
 <p role="status" className="create-table-status">{state.notice?(notices[state.notice]??renameColumnErrorText(state.notice,zh)):''}</p></section>;
}

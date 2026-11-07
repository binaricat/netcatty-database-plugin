import {acquireSchemaBusy,type SchemaBusyCallback} from './schemaBusy';
import React,{useEffect,useMemo,useRef,useSyncExternalStore} from 'react';
import {serialPreview} from './schemaPreviewQueue';
import type {WorkbenchContext} from './databaseClient';
import type {DatabaseSchemaResult,DropIndexReview} from './databaseTypes';
import {DropIndexError,type DropIndexDraft} from './schemaDropIndex';
import {SqlPreview} from './SqlPreview';
type State={draft:DropIndexDraft;review:DropIndexReview|null;busy:'idle'|'preview'|'apply';done:boolean;notice:string};
const candidates=(schema:DatabaseSchemaResult,table:string)=>schema.tables.find(t=>t.kind==='table'&&t.name===table)?.indexes?.filter(i=>i.origin==='c'&&!/^sqlite_/i.test(i.name))??[];
export function dropIndexErrorText(code:string,zh:boolean):string{
 const messages:Record<string,[string,string]>={
 draft:['Select an existing table and index.','请选择已有表和索引。'],identifier:['This index name is not supported.','此索引名称不受支持。'],
 table:['This table is outside the supported ordinary-table subset.','此表不属于受支持的普通表范围。'],
 index:['Only explicit ordinary column indexes can be removed; constraint, partial and expression indexes are excluded.','仅可移除显式普通列索引；不支持约束自动索引、部分或表达式索引。'],
 dependency:['This removal failed conservative dependency checks. Foreign keys, INDEXED hints or TEMP objects may be outside the supported subset.','此操作未通过保守依赖检查。外键、INDEXED 提示或 TEMP 对象可能超出支持范围。'],
 schema:['Schema metadata is incomplete. Refresh and prepare a new preview.','结构元数据不完整，请刷新后重新预览。'],budget:['The schema or database exceeds workspace limits.','结构或数据库超过工作区限制。'],
 stale:['The schema changed. Refresh and prepare a new preview.','结构已变化，请刷新后重新预览。'],review:['The review is missing, changed or consumed. Prepare a new preview.','审阅缺失、已变化或已使用，请重新预览。'],
 };
 return messages[code]?.[zh?1:0]??(zh?'操作失败，请检查连接后重新预览。':'Operation failed. Check the connection and prepare a new preview.');
}
export function dropIndexController(database:Pick<WorkbenchContext['database'],'previewDropIndex'|'applyDropIndex'>,handleId:string,schema:DatabaseSchemaResult,onApplied:(schema:DatabaseSchemaResult)=>void,onBusyChange?:SchemaBusyCallback){
 const table=schema.tables.find(t=>t.kind==='table'&&candidates(schema,t.name).length)?.name??schema.tables.find(t=>t.kind==='table')?.name??'';
 let state:State={draft:{table,name:candidates(schema,table)[0]?.name??''},review:null,busy:'idle',done:false,notice:''};let epoch=0,disposed=false;const listeners=new Set<()=>void>();
 const emit=(patch:Partial<State>)=>{if(disposed)return;state={...state,...patch};listeners.forEach(fn=>fn());};
 return {getSnapshot:()=>state,subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
 edit(patch:Partial<DropIndexDraft>){if(disposed||state.busy==='apply'||state.done)return;const table=patch.table??state.draft.table;if(!schema.tables.some(t=>t.kind==='table'&&t.name===table))return;const name=patch.name??(patch.table!==undefined?candidates(schema,table)[0]?.name??'':state.draft.name);if(name&&!candidates(schema,table).some(i=>i.name===name))return;epoch++;emit({draft:{table,name},review:null,notice:''});},
 cancel(){if(disposed||state.busy==='apply')return false;epoch++;emit({review:null,notice:'cancelled'});return true;},
 async preview(){if(disposed||state.busy!=='idle'||state.done||!state.draft.name)return;const op=++epoch,draft={...state.draft};emit({busy:'preview',review:null,notice:''});
  try{const review=await serialPreview(database,handleId,async()=>{if(disposed||op!==epoch)return null;return database.previewDropIndex({handleId,draft});});if(disposed||op!==epoch)return;
   if(!review||review.handleId!==handleId||JSON.stringify(review.draft)!==JSON.stringify(draft)||typeof review.unique!=='boolean'||review.unique!==candidates(schema,draft.table).find(i=>i.name===draft.name)?.unique)throw new DropIndexError('review');
   emit({review:{...review,draft:{...review.draft}},notice:'review-ready'});
  }catch(error){if(!disposed&&op===epoch)emit({notice:error instanceof DropIndexError?error.code:'failed'});}finally{emit({busy:'idle'});}
 },
 async confirm(){if(disposed||state.busy!=='idle'||!state.review||state.done)return;const review=state.review,op=++epoch;emit({busy:'apply',review:null,notice:''});let releaseBusy=()=>{};
  try{releaseBusy=acquireSchemaBusy(onBusyChange);const result=await database.applyDropIndex({handleId,review});if(disposed||op!==epoch)return;emit({done:true,notice:'done'});try{onApplied(result.schema);}catch{emit({notice:'refresh'});}
  }catch(error){if(!disposed&&op===epoch)emit({notice:error instanceof DropIndexError?error.code:'failed'});}finally{if(op===epoch)emit({busy:'idle'});releaseBusy();}
 },
 dispose(){disposed=true;epoch++;state={...state,review:null};listeners.clear();},
 };
}
export function DropIndex({context,handleId,schema,onApplied,onClose,onBusyChange}:{context:WorkbenchContext;handleId:string;schema:DatabaseSchemaResult;onApplied:(schema:DatabaseSchemaResult)=>void;onClose:()=>void;onBusyChange?:SchemaBusyCallback}){
 const callback=useRef(onApplied);callback.current=onApplied;const busyCallback=useRef(onBusyChange);busyCallback.current=onBusyChange;
 // Keep the opening schema snapshot for this adapter/handle. A successful
 // onApplied publishes a new schema object; it must not recreate and erase done.
 // External schema changes remain protected by the adapter review revision.
 const controller=useMemo(()=>dropIndexController(context.database,handleId,schema,s=>callback.current(s),(busy,owner)=>busyCallback.current?.(busy,owner)),[context.database,handleId]);
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);useEffect(()=>()=>controller.dispose(),[controller]);
 const zh=Boolean(context.environment?.locale?.toLowerCase().startsWith('zh')),tr=(en:string,cn:string)=>zh?cn:en,locked=state.busy==='apply'||state.done;
 const selected=candidates(schema,state.draft.table),unique=state.review?.unique??selected.find(i=>i.name===state.draft.name)?.unique??false;
 const notices:Record<string,string>={cancelled:tr('Preview cancelled; no DROP submitted.','预览已取消，未提交 DROP。'),'review-ready':tr('Review the exact SQL and consequences before confirming.','请审阅完整 SQL 及后果后再确认。'),done:tr('Index removed.','索引已移除。'),refresh:tr('Index removed, but the schema callback failed. Refresh the connection.','索引已移除，但结构刷新回调失败。请刷新连接。')};
 return <section className="create-table drop-index" aria-label={tr('Remove SQLite index','移除 SQLite 索引')}><header className="results-heading create-table-header"><div><h2>{tr('Remove index','移除索引')}</h2><p className="hint">{tr('Disposable SQLite only. Rows remain, but query performance may change. Unsupported dependency cases refuse or roll back.','仅临时 SQLite。数据行保留，但查询性能可能变化。不支持的依赖情况会拒绝或回滚。')}</p></div><button className="secondary toolbar-button" disabled={state.busy==='apply'} onClick={()=>{if(controller.cancel())onClose();}}>{tr(state.done?'Close':'Cancel',state.done?'关闭':'取消')}</button></header>
 {!state.done?<><div className="drop-index-fields"><label>{tr('Table','表')}<select aria-label={tr('Index removal table','移除索引所属表')} disabled={locked} value={state.draft.table} onChange={e=>controller.edit({table:e.currentTarget.value})}>{schema.tables.filter(t=>t.kind==='table').map(t=><option key={t.name} value={t.name}>{t.name}</option>)}</select></label><label>{tr('Index','索引')}<select aria-label={tr('Index to remove','待移除索引')} disabled={locked||!selected.length} value={state.draft.name} onChange={e=>controller.edit({name:e.currentTarget.value})}>{selected.length?selected.map(i=><option key={i.name} value={i.name}>{i.name}{i.unique?' (UNIQUE)':''}</option>):<option value="">{tr('No explicit index','没有显式索引')}</option>}</select></label></div>
 {unique&&<p role="alert" className="error"><strong>{tr('Warning: removing this UNIQUE index removes its uniqueness enforcement. Duplicate values may then be accepted.','警告：移除此 UNIQUE 索引将移除其唯一性约束，之后可能允许重复值。')}</strong></p>}
 {state.review&&<SqlPreview label={tr('Reviewed DROP INDEX SQL','待确认的 DROP INDEX SQL')} sql={state.review.sql}/>}
 <div className="results-heading create-table-actions"><button className="secondary toolbar-button" disabled={locked||state.busy!=='idle'||!state.draft.name} onClick={()=>void controller.preview()}>{tr('Preview DROP INDEX','预览 DROP INDEX')}</button><button className="secondary toolbar-button" disabled={locked||state.busy!=='idle'||!state.review} onClick={()=>void controller.confirm()}>{unique?tr('Confirm remove UNIQUE index','确认移除 UNIQUE 索引'):tr('Confirm remove index','确认移除索引')}</button></div></>:null}
 <p role="status" className="create-table-status">{state.notice?(notices[state.notice]??dropIndexErrorText(state.notice,zh)):''}</p></section>;
}

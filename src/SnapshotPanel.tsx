import React,{useMemo,useRef,useEffect,useSyncExternalStore} from 'react';
import type {WorkbenchContext} from './databaseClient';
import type {DatabaseSchemaResult,SnapshotRestoreReview} from './databaseTypes';
import type {SnapshotInfo} from './snapshotStorage';
type API=Pick<WorkbenchContext['database'],'snapshotInfo'|'saveSnapshot'|'previewRestoreSnapshot'|'applyRestoreSnapshot'|'deleteSnapshot'>;
type State={busy:boolean;info:SnapshotInfo|undefined;review:SnapshotRestoreReview|null;deleteConfirm:boolean;notice:string};
export function snapshotController(database:API,handleId:string,onRestored:(schema:DatabaseSchemaResult)=>void,onBusyChange?:(busy:boolean)=>void){
 let state:State={busy:false,info:undefined,review:null,deleteConfirm:false,notice:''},disposed=false;const listeners=new Set<()=>void>();
 const emit=(patch:Partial<State>)=>{if(disposed)return;state={...state,...patch};listeners.forEach(fn=>fn());};
 async function run(work:()=>Promise<void>){if(disposed||state.busy)return;emit({busy:true,notice:''});try{onBusyChange?.(true);await work();}catch(error){const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';emit({review:null,deleteConfirm:false,notice:['missing','budget','integrity','invalid','version','unbound','stale','protection','storage','busy'].includes(code)?code:'failed'});}finally{emit({busy:false});try{onBusyChange?.(false);}catch{}}}
 return {getSnapshot:()=>state,subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},
  inspect(){return run(async()=>{emit({review:null,deleteConfirm:false});const info=await database.snapshotInfo({handleId});if(!disposed)emit({info,notice:info?'found':'missing'});});},
  save(){return run(async()=>{emit({review:null,deleteConfirm:false});const info=await database.saveSnapshot({handleId});if(!disposed)emit({info,notice:'saved'});});},
  preview(){return run(async()=>{emit({review:null,deleteConfirm:false});const review=await database.previewRestoreSnapshot({handleId});if(disposed)return;if(review.handleId!==handleId||!review.token||!review.info||!Array.isArray(review.schema.tables))throw new Error('Invalid snapshot review');emit({review:structuredClone(review),info:{...review.info},notice:'review'});});},
  confirmRestore(){if(!state.review)return Promise.resolve();const review=structuredClone(state.review);return run(async()=>{emit({review:null,deleteConfirm:false});const result=await database.applyRestoreSnapshot({handleId,review});if(disposed)return;emit({notice:'restored'});try{onRestored(result.schema);}catch{emit({notice:'refresh'});}});},
  requestDelete(){if(disposed||state.busy)return;emit({review:null,deleteConfirm:true,notice:''});},
  confirmDelete(){if(!state.deleteConfirm)return Promise.resolve();return run(async()=>{emit({review:null,deleteConfirm:false});await database.deleteSnapshot({handleId});if(!disposed)emit({info:undefined,notice:'deleted'});});},
  cancel(){if(disposed||state.busy)return false;emit({review:null,deleteConfirm:false,notice:'cancelled'});return true;},
  dispose(){disposed=true;state={...state,review:null,deleteConfirm:false};listeners.clear();}
 };
}
export function SnapshotPanel({context,handleId,onRestored,onClose,onBusyChange}:{context:WorkbenchContext;handleId:string;onRestored:(schema:DatabaseSchemaResult)=>void;onClose:()=>void;onBusyChange?:(busy:boolean)=>void}){
 const callback=useRef(onRestored);callback.current=onRestored;const busy=useRef(onBusyChange);busy.current=onBusyChange;
 const controller=useMemo(()=>snapshotController(context.database,handleId,s=>callback.current(s),b=>busy.current?.(b)),[context.database,handleId]);
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);useEffect(()=>()=>controller.dispose(),[controller]);
 const zh=context.environment?.locale?.toLowerCase().startsWith('zh'),tr=(en:string,cn:string)=>zh?cn:en;
 const notices:Record<string,string>={found:tr('Saved snapshot found.','找到已保存快照。'),missing:tr('No saved snapshot.','没有已保存快照。'),saved:tr('Database snapshot saved.','数据库快照已保存。'),review:tr('Review this snapshot before replacing current database data.','替换当前数据库数据前，请审阅此快照。'),restored:tr('Database restored. Query results and pending reviews must be refreshed.','数据库已恢复，查询结果及待确认操作需刷新。'),refresh:tr('Database replaced, but the view did not refresh. Do not restore again; close this panel and inspect manually.','数据库已替换，但界面未刷新；勿重复恢复，关闭此面板后手动检查。'),deleted:tr('Saved snapshot cleared; current database is unchanged.','已清除保存的快照；当前数据库不变。'),cancelled:tr('Review cancelled.','审阅已取消。'),failed:tr('Snapshot operation failed or became stale. Check storage permission, size limits and connection, then retry.','快照操作失败或已失效。请检查存储权限、大小限制及连接后重试。')};
 Object.assign(notices,{
 budget:tr('Snapshot exceeds the size or count budget. Reduce data or explicitly clear another saved snapshot.','快照超过大小或数量限制，请减少数据或明确清除另一份快照。'),
 integrity:tr('Snapshot integrity check failed. Do not restore this saved copy.','快照完整性校验失败，不可恢复此副本。'),
 invalid:tr('Snapshot content is unsupported or invalid. Current data was not replaced.','快照内容不受支持或无效，当前数据未被替换。'),version:tr('Snapshot version is unsupported.','不支持此快照版本。'),
 unbound:tr('Save this connection first before using snapshots.','请先保存此连接，再使用快照。'),
 stale:tr('The connection or review changed. Inspect the current state before preparing a new review.','连接或审阅已变化，请先检查当前状态再重新预览。'),
 protection:tr('SQLite safety protection failed. This session may be closed; do not continue editing it.','SQLite 安全保护失败，此会话可能已关闭，请勿继续编辑。'),
 storage:tr('Local plugin storage operation failed. Check storage permission and inspect saved status before retrying.','本地插件存储操作失败，请检查权限及已存状态后再决定是否重试。'),
 busy:tr('Another database operation is running. Wait for it to finish.','另一数据库操作正在进行，请等待完成。')
 });
 const detail=(info:SnapshotInfo)=><div className="hint"><p>{tr('Saved connection','保存的连接')}: {info.savedConnectionId}</p><p>{tr('Bytes / saved time','字节数 / 保存时间')}: {info.byteLength} / {new Date(info.savedAt).toISOString()}</p><p>SHA-256: {info.sha256}</p></div>;
 return <section className="create-table snapshot-panel" aria-label={tr('SQLite database snapshots','SQLite 数据库快照')}><header className="results-heading create-table-header"><h2>{tr('Database snapshots','数据库快照')}</h2><button className="secondary toolbar-button" disabled={state.busy} onClick={()=>{if(controller.cancel())onClose();}}>{tr('Close','关闭')}</button></header>
 <p role="alert">{tr('Saves the entire database, including potentially sensitive data, unencrypted in local plugin storage. This is not a credential vault, native file sync, or WAL backup. Saving replaces this connection’s previous snapshot. Limit: 512 KiB each, 4 snapshots total. Only this plugin storage is used; concurrent writes across runtimes are not guaranteed.','将整个数据库（可能包含敏感数据）以未加密形式保存到本地插件存储。这不是凭据保险库、原生文件同步或 WAL 备份。保存会替换此连接之前的快照。每份上限 512 KiB，共最多 4 份。仅使用此插件存储，不保证跨运行时并发写入安全。')}</p>
 <div className="create-table-actions"><button className="secondary toolbar-button" disabled={state.busy} onClick={()=>void controller.inspect()}>{tr('Check saved snapshot','检查已存快照')}</button><button className="secondary toolbar-button" disabled={state.busy} onClick={()=>void controller.save()}>{tr('Save entire database snapshot','保存整个数据库快照')}</button><button className="secondary toolbar-button" disabled={state.busy} onClick={()=>void controller.preview()}>{tr('Preview restore','预览恢复')}</button><button className="secondary toolbar-button" disabled={state.busy} onClick={()=>controller.requestDelete()}>{tr('Clear saved snapshot…','清除已存快照…')}</button></div>
 {state.info&&detail(state.info)}
 {state.review&&<div><p role="alert">{tr('Restoring replaces current in-memory database data. Current unsaved contents will be permanently lost. No query is automatically executed.','恢复将替换当前内存数据库数据，当前未保存的内容将永久丢失。不会自动执行查询。')}</p><p>{tr('Snapshot objects','快照对象')}: {state.review.schema.tables.map(t=>t.name).join(', ')}</p><button className="secondary toolbar-button" disabled={state.busy} onClick={()=>void controller.confirmRestore()}>{tr('Confirm replace current database','确认替换当前数据库')}</button><button className="secondary toolbar-button" disabled={state.busy} onClick={()=>controller.cancel()}>{tr('Cancel restore','取消恢复')}</button></div>}
 {state.deleteConfirm&&<div><p role="alert">{tr('Clear this saved snapshot? Current in-memory data stays unchanged; this snapshot will be permanently deleted and cannot be recovered.','清除此保存的快照？当前内存数据不变，但该快照将永久删除，无法恢复。')}</p><button className="secondary toolbar-button" disabled={state.busy} onClick={()=>void controller.confirmDelete()}>{tr('Confirm clear saved snapshot','确认清除已存快照')}</button><button className="secondary toolbar-button" disabled={state.busy} onClick={()=>controller.cancel()}>{tr('Cancel clear','取消清除')}</button></div>}
 <p role="status">{notices[state.notice]??''}</p></section>;
}

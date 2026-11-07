import {acquireSchemaBusy,type SchemaBusyCallback} from './schemaBusy';
import {serialPreview} from './schemaPreviewQueue';
import {SqlPreview} from './SqlPreview';
import {createIndexTranslator,translateCreateIndexNotice} from './createIndexI18n';
import React,{useEffect,useMemo,useRef,useSyncExternalStore} from 'react';
import type {WorkbenchContext} from './databaseClient';
import type {DatabaseSchemaResult,DatabaseCreateIndexReview} from './databaseTypes';
import {CreateIndexError,type DatabaseCreateIndexDraft} from './schemaCreateIndex';
export type CreateIndexState={draft:DatabaseCreateIndexDraft;review:DatabaseCreateIndexReview|null;busy:'idle'|'preview'|'apply';notice:string|null;created:boolean;};
const initialDraft=(schema:DatabaseSchemaResult):DatabaseCreateIndexDraft=>{const table=schema.tables.find(table=>table.kind==='table'&&table.columns.length>0&&!/^sqlite_/i.test(table.name));return {name:'',table:table?.name??'',unique:false,columns:table?[{name:table.columns[0].name,direction:'ASC'}]:[]};};
const cloneDraft=(draft:DatabaseCreateIndexDraft):DatabaseCreateIndexDraft=>({name:draft.name,table:draft.table,unique:draft.unique,columns:draft.columns.map(column=>({...column}))});
/** Local explicit-review controller. A cancelled preview cannot apply; disposal
 * cannot undo an already submitted CREATE, so no cancellation claim is made then. */
export function createIndexController(database:Pick<WorkbenchContext['database'],'previewCreateIndex'|'applyCreateIndex'>,handleId:string,schema:DatabaseSchemaResult,onCreated:(schema:DatabaseSchemaResult)=>void,onApplying?:SchemaBusyCallback){
 let state:CreateIndexState={draft:initialDraft(schema),review:null,busy:'idle',notice:null,created:false};let revision=0,disposed=false,operation=0;
 const listeners=new Set<()=>void>();const emit=(patch:Partial<CreateIndexState>)=>{if(disposed)return;state={...state,...patch};for(const fn of listeners)fn();};
 const edit=(next:DatabaseCreateIndexDraft)=>{if(disposed||state.busy==='apply'||state.created)return;revision++;emit({draft:cloneDraft(next),review:null,notice:null});};
 return {getSnapshot:()=>state,subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},
  setName(name:string){edit({...state.draft,name:name.slice(0,128)});},
  setTable(tableName:string){const table=schema.tables.find(table=>table.name===tableName&&table.kind==='table'&&!/^sqlite_/i.test(table.name));if(!table||!table.columns.length)return;edit({...state.draft,table:table.name,columns:[{name:table.columns[0].name,direction:'ASC'}]});},
  setUnique(unique:boolean){edit({...state.draft,unique});},
  setColumn(index:number,patch:Partial<DatabaseCreateIndexDraft['columns'][number]>){if(!state.draft.columns[index])return;const draft=cloneDraft(state.draft);const next={...draft.columns[index],...patch};const table=schema.tables.find(table=>table.name===draft.table);if(!table?.columns.some(column=>column.name===next.name)||!['ASC','DESC'].includes(next.direction)||draft.columns.some((column,i)=>i!==index&&column.name===next.name))return;draft.columns[index]=next;edit(draft);},
  addColumn(){if(state.draft.columns.length>=32)return;const table=schema.tables.find(table=>table.name===state.draft.table);const next=table?.columns.find(column=>!state.draft.columns.some(selected=>selected.name===column.name));if(next)edit({...state.draft,columns:[...state.draft.columns,{name:next.name,direction:'ASC'}]});},
  removeColumn(index:number){if(state.draft.columns.length<=1||!state.draft.columns[index])return;edit({...state.draft,columns:state.draft.columns.filter((_,i)=>i!==index)});},
  cancelReview(){if(state.busy==='apply')return false;if(state.created)return true;revision++;operation++;emit({review:null,notice:'Preview cancelled. No CREATE was submitted.'});return true;},
  async preview(){if(disposed||state.busy!=='idle'||state.created)return;const rev=revision,op=++operation,draft=cloneDraft(state.draft);emit({busy:'preview',review:null,notice:null});
   try{const review=await serialPreview(database,handleId,async()=>{if(disposed||op!==operation||rev!==revision)return null;return database.previewCreateIndex({handleId,draft});});if(!disposed&&op===operation&&rev===revision){if(!review||review.handleId!==handleId||JSON.stringify(review.draft)!==JSON.stringify(draft))throw new CreateIndexError('review');emit({review:{...review,draft:cloneDraft(review.draft)},notice:'Review the exact CREATE INDEX statement before confirming.'});}}
   catch(error){if(!disposed&&op===operation&&rev===revision)emit({review:null,notice:error instanceof CreateIndexError?`Create index: ${error.code}.`:'Create index preview failed.'});}
   finally{if(!disposed)emit({busy:'idle'});}
  },
  async confirm(){if(disposed||state.busy!=='idle'||!state.review||state.created)return;const review=state.review,op=++operation;let releaseBusy=()=>{};emit({busy:'apply',review:null,notice:'Creating the reviewed index…'});
   try{releaseBusy=acquireSchemaBusy(onApplying);const result=await database.applyCreateIndex({handleId,review});if(!disposed&&op===operation){emit({created:true,notice:'Index created. Schema refreshed; no additional SQL was executed.'});try{onCreated(result.schema);}catch{emit({notice:'Index created, but workspace refresh failed. Reopen the schema browser.'});}}}
   catch(error){if(!disposed&&op===operation)emit({notice:error instanceof CreateIndexError?`Create index: ${error.code}. Preview again before retrying.`:'Create index failed. Preview again before retrying.'});}
   finally{if(!disposed&&op===operation)emit({busy:'idle'});releaseBusy();}
  },
  dispose(){disposed=true;revision++;operation++;state={...state,review:null};listeners.clear();},
 };
}
export function CreateIndex({context,handleId,schema,onCreated,onClose,onBusyChange}:{context:WorkbenchContext;handleId:string;schema:DatabaseSchemaResult;onCreated:(schema:DatabaseSchemaResult)=>void;onClose:()=>void;onBusyChange?:SchemaBusyCallback}){
 const callback=useRef(onCreated);callback.current=onCreated;const busyCallback=useRef(onBusyChange);busyCallback.current=onBusyChange;
 const initialSchema=useMemo(()=>schema,[context.database,handleId]);
 const controller=useMemo(()=>createIndexController(context.database,handleId,initialSchema,value=>callback.current(value),(busy,owner)=>busyCallback.current?.(busy,owner)),[context.database,handleId,initialSchema]);
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);useEffect(()=>()=>controller.dispose(),[controller]);
 const locale=context.environment?.locale??'en',tr=createIndexTranslator(locale),locked=state.busy==='apply'||state.created;
 const tables=initialSchema.tables.filter(table=>table.kind==='table'&&table.columns.length>0&&!/^sqlite_/i.test(table.name));
 const columns=tables.find(table=>table.name===state.draft.table)?.columns??[];
 return <section className="create-table create-index" aria-label={tr('Create SQLite index')}>
  <header className="results-heading create-table-header"><div className="create-table-intro"><h2>{tr('Create index')}</h2><p className="hint">{tr('Disposable SQLite only. Select existing columns, review the exact SQL, then confirm once.')}</p></div><button className="secondary toolbar-button" disabled={state.busy==='apply'} onClick={()=>{if(controller.cancelReview())onClose();}}>{tr(state.created?'Close':'Cancel')}</button></header>
  {!tables.length?<p className="hint">{tr('No eligible tables. Create a regular table first.')}</p>:<div className="create-index-definition">
   <label className="create-table-name">{tr('Index name')}<input aria-label={tr('New index name')} maxLength={128} disabled={locked} value={state.draft.name} onChange={event=>controller.setName(event.currentTarget.value)}/></label>
   <label className="create-index-table">{tr('Table')}<select aria-label={tr('Index table')} disabled={locked} value={state.draft.table} onChange={event=>controller.setTable(event.currentTarget.value)}>{tables.map(table=><option key={table.name} value={table.name}>{table.name}</option>)}</select></label>
   <label className="create-table-constraint"><input type="checkbox" aria-label={tr('Unique index')} disabled={locked} checked={state.draft.unique} onChange={event=>controller.setUnique(event.currentTarget.checked)}/>{tr('Unique index')}</label>
  </div>}
  <div className="results-heading create-table-columns-heading"><strong>{tr('Columns · {count} / 32',{count:state.draft.columns.length})}</strong><button className="secondary toolbar-button" disabled={locked||state.draft.columns.length>=Math.min(32,columns.length)} onClick={()=>controller.addColumn()}>{tr('Add column')}</button></div>
  <div className="create-table-columns">{state.draft.columns.map((column,index)=><div className="create-table-column create-index-column" key={index}>
   <label className="create-table-column-name">{tr('Column')}<select aria-label={tr('Index column {index}',{index:index+1})} disabled={locked} value={column.name} onChange={event=>controller.setColumn(index,{name:event.currentTarget.value})}>{columns.map(option=><option key={option.name} value={option.name} disabled={state.draft.columns.some((selected,i)=>i!==index&&selected.name===option.name)}>{option.name}</option>)}</select></label>
   <label className="create-table-column-type">{tr('Order')}<select aria-label={tr('Index column {index} order',{index:index+1})} disabled={locked} value={column.direction} onChange={event=>controller.setColumn(index,{direction:event.currentTarget.value as 'ASC'|'DESC'})}><option value="ASC">{tr('Ascending (ASC)')}</option><option value="DESC">{tr('Descending (DESC)')}</option></select></label>
   <button className="secondary toolbar-button create-table-remove" aria-label={tr('Remove column {index}',{index:index+1})} disabled={locked||state.draft.columns.length<=1} onClick={()=>controller.removeColumn(index)}>{tr('Remove')}</button>
  </div>)}</div>
  <p className="hint create-table-constraints-note">{tr('Column order is significant. UNIQUE rejects duplicate values. No expressions, WHERE clauses, DROP or ALTER are executed here.')}</p>
  <div className="results-heading create-table-actions"><button className="secondary toolbar-button" disabled={locked||state.busy!=='idle'||!state.draft.columns.length} onClick={()=>void controller.preview()}>{tr(state.busy==='preview'?'Preparing preview…':'Preview CREATE INDEX')}</button><button className="secondary toolbar-button" disabled={locked||state.busy!=='idle'||!state.review} onClick={()=>void controller.confirm()}>{tr('Confirm create index')}</button></div>
  <section className="create-table-review" aria-label={tr('CREATE INDEX review')}><strong>{tr('SQL preview')}</strong><p className="hint">{state.review?tr('Schema revision {revision}. Any form edit invalidates this preview.',{revision:state.review.schemaRevision}):tr('Preview does not create an index. Confirmation requires a current preview.')}</p><SqlPreview label={tr('Reviewed CREATE INDEX SQL')} sql={state.review?.sql??''}/></section>
  <p className="create-table-status" role="status">{translateCreateIndexNotice(locale,state.notice)}</p>
 </section>;
}

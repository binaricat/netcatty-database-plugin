import {createTableTranslator,translateCreateTableNotice} from './createTableI18n';
import React,{useEffect,useMemo,useRef,useSyncExternalStore} from 'react';
import type {WorkbenchContext} from './databaseClient';
import type {DatabaseSchemaResult,DatabaseCreateTableReview} from './databaseTypes';
import {CreateTableError,SQLITE_TABLE_TYPES,type DatabaseCreateTableDraft} from './schemaCreateTable';
export type CreateTableState={draft:DatabaseCreateTableDraft;review:DatabaseCreateTableReview|null;busy:'idle'|'preview'|'apply';notice:string|null;created:boolean;};
const initialDraft=():DatabaseCreateTableDraft=>({name:'',columns:[{name:'id',type:'INTEGER',nullable:false,primaryKey:true}]});
const cloneDraft=(draft:DatabaseCreateTableDraft):DatabaseCreateTableDraft=>({name:draft.name,columns:draft.columns.map(column=>({...column}))});
/** Local explicit-review controller. A cancelled preview cannot apply; disposal
 * cannot undo an already submitted CREATE, so no cancellation claim is made then. */
export function createTableController(database:Pick<WorkbenchContext['database'],'previewCreateTable'|'applyCreateTable'>,handleId:string,onCreated:(schema:DatabaseSchemaResult)=>void){
 let state:CreateTableState={draft:initialDraft(),review:null,busy:'idle',notice:null,created:false};let revision=0,disposed=false,operation=0;
 const listeners=new Set<()=>void>();const emit=(patch:Partial<CreateTableState>)=>{if(disposed)return;state={...state,...patch};for(const fn of listeners)fn();};
 const edit=(next:DatabaseCreateTableDraft)=>{if(disposed||state.busy==='apply'||state.created)return;revision++;emit({draft:cloneDraft(next),review:null,notice:null});};
 return {getSnapshot:()=>state,subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},
  setName(name:string){edit({...state.draft,name:name.slice(0,128)});},
  setColumn(index:number,patch:Partial<DatabaseCreateTableDraft['columns'][number]>){if(!state.draft.columns[index])return;const draft=cloneDraft(state.draft);draft.columns[index]={...draft.columns[index],...patch};if(patch.primaryKey===true)draft.columns.forEach((column,i)=>{column.primaryKey=i===index;});if(draft.columns[index].primaryKey)draft.columns[index].nullable=false;edit(draft);},
  addColumn(){if(state.draft.columns.length>=32)return;edit({...state.draft,columns:[...state.draft.columns,{name:'',type:'TEXT',nullable:true,primaryKey:false}]});},
  removeColumn(index:number){if(state.draft.columns.length<=1||!state.draft.columns[index])return;edit({...state.draft,columns:state.draft.columns.filter((_,i)=>i!==index)});},
  cancelReview(){if(state.busy==='apply')return false;if(state.created)return true;revision++;operation++;emit({review:null,busy:'idle',notice:'Preview cancelled. No CREATE was submitted.'});return true;},
  async preview(){if(disposed||state.busy!=='idle'||state.created)return;const rev=revision,op=++operation,draft=cloneDraft(state.draft);emit({busy:'preview',review:null,notice:null});
   try{const review=await database.previewCreateTable({handleId,draft});if(!disposed&&op===operation&&rev===revision){if(review.handleId!==handleId||JSON.stringify(review.draft)!==JSON.stringify(draft))throw new CreateTableError('review');emit({review:{...review,draft:cloneDraft(review.draft)},notice:'Review the exact CREATE statement before confirming.'});}}
   catch(error){if(!disposed&&op===operation&&rev===revision)emit({review:null,notice:error instanceof CreateTableError?`Create table: ${error.code}.`:'Create table preview failed.'});}
   finally{if(!disposed&&op===operation)emit({busy:'idle'});}
  },
  async confirm(){if(disposed||state.busy!=='idle'||!state.review||state.created)return;const review=state.review,op=++operation;emit({busy:'apply',review:null,notice:'Creating the reviewed table…'});
   try{const result=await database.applyCreateTable({handleId,review});if(!disposed&&op===operation){emit({created:true,notice:'Table created. Schema refreshed; no additional SQL was executed.'});try{onCreated(result.schema);}catch{emit({notice:'Table created, but workspace refresh failed. Reopen the schema browser.'});}}}
   catch(error){if(!disposed&&op===operation)emit({notice:error instanceof CreateTableError?`Create table: ${error.code}. Preview again before retrying.`:'Create table failed. Preview again before retrying.'});}
   finally{if(!disposed&&op===operation)emit({busy:'idle'});}
  },
  dispose(){disposed=true;revision++;operation++;state={...state,review:null};listeners.clear();},
 };
}
export function CreateTable({context,handleId,onCreated,onClose}:{context:WorkbenchContext;handleId:string;onCreated:(schema:DatabaseSchemaResult)=>void;onClose:()=>void}){
 const callback=useRef(onCreated);callback.current=onCreated;
 const controller=useMemo(()=>createTableController(context.database,handleId,schema=>callback.current(schema)),[context.database,handleId]);
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
 useEffect(()=>()=>controller.dispose(),[controller]);
 const locked=state.busy==='apply'||state.created;
 const locale=context.environment?.locale??'en';
 const tr=createTableTranslator(locale);
 return <section className="create-table" aria-label={tr('Create SQLite table')}>
  <header className="results-heading create-table-header"><div className="create-table-intro"><h2>{tr('Create table')}</h2><p className="hint">{tr('Disposable SQLite only. Define columns, preview the exact SQL, then confirm once.')}</p></div><button className="secondary toolbar-button" disabled={state.busy==='apply'} onClick={()=>{if(controller.cancelReview())onClose();}}>{tr(state.created?'Close':'Cancel')}</button></header>
  <label className="create-table-name">{tr('Table name')}<input aria-label={tr('New table name')} maxLength={128} value={state.draft.name} disabled={locked} onChange={event=>controller.setName(event.currentTarget.value)}/></label>
  <div className="results-heading create-table-columns-heading"><strong>{tr('Columns · {count} / 32',{count:state.draft.columns.length})}</strong><button className="secondary toolbar-button" disabled={locked||state.draft.columns.length>=32} onClick={()=>controller.addColumn()}>{tr('Add column')}</button></div>
  <div className="create-table-columns">{state.draft.columns.map((column,index)=><div className="create-table-column" key={index}>
   <label className="create-table-column-name">{tr('Name')}<input aria-label={tr('Column {index} name',{index:index+1})} maxLength={128} value={column.name} disabled={locked} onChange={event=>controller.setColumn(index,{name:event.currentTarget.value})}/></label>
   <label className="create-table-column-type">{tr('Type')}<select aria-label={tr('Column {index} type',{index:index+1})} value={column.type} disabled={locked} onChange={event=>controller.setColumn(index,{type:event.currentTarget.value as typeof column.type})}>{SQLITE_TABLE_TYPES.map(type=><option key={type} value={type}>{type}</option>)}</select></label>
   <label className="create-table-constraint create-table-primary-key"><input aria-label={tr('Column {index} primary key',{index:index+1})} type="checkbox" checked={column.primaryKey} disabled={locked} onChange={event=>controller.setColumn(index,{primaryKey:event.currentTarget.checked})}/>{tr('Primary key')}</label>
   <label className="create-table-constraint create-table-nullable"><input aria-label={tr('Column {index} nullable',{index:index+1})} type="checkbox" checked={column.nullable} disabled={locked||column.primaryKey} onChange={event=>controller.setColumn(index,{nullable:event.currentTarget.checked})}/>{tr('Nullable')}</label>
   <button className="secondary toolbar-button create-table-remove" aria-label={tr('Remove column {index}',{index:index+1})} disabled={locked||state.draft.columns.length<=1} onClick={()=>controller.removeColumn(index)}>{tr('Remove')}</button>
  </div>)}</div>
  <p className="hint create-table-constraints-note">{tr('At most one primary key. Selecting it clears the previous primary key and forces NOT NULL. No defaults, expressions, foreign keys, DROP or ALTER are executed here.')}</p>
  <div className="results-heading create-table-actions"><button className="secondary toolbar-button" disabled={locked||state.busy!=='idle'} onClick={()=>void controller.preview()}>{tr(state.busy==='preview'?'Preparing preview…':'Preview CREATE TABLE')}</button><button className="secondary toolbar-button" disabled={locked||state.busy!=='idle'||!state.review} onClick={()=>void controller.confirm()}>{tr('Confirm create table')}</button></div>
  <section className="create-table-review" aria-label={tr('CREATE TABLE review')}><strong>{tr('SQL preview')}</strong><p className="hint">{state.review?tr('Schema revision {revision}. Any form edit invalidates this preview.',{revision:state.review.schemaRevision}):tr('Preview does not create a table. Confirmation is unavailable until a current preview exists.')}</p><textarea className="create-table-sql" aria-label={tr('Reviewed CREATE TABLE SQL')} rows={8} readOnly value={state.review?.sql??''}/></section>
  <p className="create-table-status" role="status">{translateCreateTableNotice(locale,state.notice)}</p>
 </section>;
}

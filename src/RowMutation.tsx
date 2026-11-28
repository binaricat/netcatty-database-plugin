import {SqlPreview} from './SqlPreview';
import React,{useEffect,useMemo,useRef,useSyncExternalStore} from 'react';
import type {WorkbenchContext} from './databaseClient';
import type {DatabaseSchemaResult,DatabaseScalar} from './databaseTypes';
import {rowMutationTranslator} from './rowMutationI18n';
import {GridMutationError,type GridMutationDraft as Draft} from './gridMutation';
import type {GridMutationReview as Review} from './databaseTypes';
type Adapter=Pick<WorkbenchContext['database'],'previewGridMutation'|'applyGridMutation'>;
type Field={type:'text'|'number'|'null';value:string};
export type RowMutationState={kind:'update'|'delete';fields:Record<string,Field>;review:Review|null;busy:'idle'|'preview'|'apply';notice:string|null;applied:boolean;eligible:boolean};
const copy=<T,>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
function eligibility(schema:DatabaseSchemaResult,table:string,original:Record<string,DatabaseScalar>){const found=schema.tables.find(value=>value.name===table&&value.kind==='table');return !!found&&found.columns.length>0&&found.columns.length<=16&&Array.isArray(found.triggers)&&found.triggers.length===0&&!/\bCREATE\s+VIRTUAL\s+TABLE\b/i.test(found.definition??'')&&found.columns.some(column=>column.primaryKey)&&!found.columns.some(column=>/BLOB/i.test(column.type)||typeof column.nullable!=='boolean'||column.primaryKey&&original[column.name]===null)&&found.columns.every(column=>Object.hasOwn(original,column.name)&&(typeof original[column.name]!=='string'||String(original[column.name]).length<=2048)&&!(column.nullable===false&&original[column.name]===null)&&['string','number','boolean','object'].includes(typeof original[column.name])&&(typeof original[column.name]!=='object'||original[column.name]===null)&&(typeof original[column.name]!=='number'||Number.isFinite(original[column.name])&&(!Number.isInteger(original[column.name])||Number.isSafeInteger(original[column.name]))))&&Object.keys(original).length===found.columns.length;}
const mutationErrors:Record<GridMutationError['code'],string>={
 draft:'The row change definition is invalid. Check the selected action and fields.',
 table:'This table is unsupported: conflict policies, generated columns, triggers, cascading changes, virtual tables or incomplete metadata prevent safe single-row editing.',
 columns:'Editing requires complete column metadata, at most 16 columns and no BLOB columns.',
 'primary-key':'A complete non-null primary key is required and cannot be edited.',
 value:'A value violates its type, nullability or edit-size limit. Check the fields.',
 unchanged:'No changed values.',
 budget:'This change exceeds the supported edit limit. Reduce its size or use another database client.',
 stale:'The schema changed. Reload the table and prepare a new preview.',
 review:'The review is missing, changed or already consumed. Prepare a new preview before confirming.',
 conflict:'The original row changed or no longer identifies exactly one row. Reload the row before editing again.',
};
function mutationFailure(error:unknown,fallback:string){return error instanceof GridMutationError?(mutationErrors[error.code]??fallback):fallback;}
export function createRowMutationController(database:Adapter,handleId:string,schema:DatabaseSchemaResult,table:string,originalInput:Record<string,DatabaseScalar>,onApplied:()=>void){
 const columns=schema.tables.find(value=>value.name===table)?.columns??[];
 const original=Object.fromEntries(columns.filter(column=>Object.hasOwn(originalInput,column.name)).map(column=>[column.name,originalInput[column.name]]));
 let state:RowMutationState={kind:'update',fields:Object.fromEntries(columns.map(column=>{const value=original[column.name];return [column.name,{type:value===null?'null':typeof value==='number'?'number':'text',value:value===null?'':String(value)}];})),review:null,busy:'idle',notice:null,applied:false,eligible:eligibility(schema,table,originalInput)};
 let disposed=false,revision=0,operation=0;const listeners=new Set<()=>void>();const emit=(patch:Partial<RowMutationState>)=>{if(!disposed){state={...state,...patch};for(const fn of listeners)fn();}};const editable=()=>!disposed&&!state.applied&&state.busy!=='apply';
 const invalidate=(patch:Partial<RowMutationState>)=>{revision++;emit({...patch,review:null,notice:null});};
 function draft():Draft{const result:Draft={kind:state.kind,table,original:copy(original)};if(state.kind==='delete')return result;const changes:Record<string,DatabaseScalar>=Object.create(null);for(const column of columns){if(column.primaryKey)continue;const field=state.fields[column.name];let value:DatabaseScalar;if(field.type==='null'){if(column.nullable===false)throw Error('input');value=null;}else if(field.type==='number'){if(!field.value.trim()||!Number.isFinite(Number(field.value)))throw Error('input');value=Number(field.value);}else value=field.value;
 // Untouched booleans retain their original scalar rather than silently becoming text.
 if(typeof original[column.name]==='boolean'&&field.type==='text'&&field.value===String(original[column.name]))continue;
 if(value!==original[column.name])changes[column.name]=value;}
 if(!Object.keys(changes).length)throw Error('unchanged');return {...result,changes};}
 return {getSnapshot:()=>state,subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},
 setKind(kind:'update'|'delete'){if(editable()&&(kind==='update'||kind==='delete'))invalidate({kind});},
 setField(name:string,patch:Partial<Field>){const column=columns.find(column=>column.name===name);if(!editable()||!column||column.primaryKey)return;const next={...state.fields[name],...patch};if(!['text','number','null'].includes(next.type)||next.type==='null'&&column.nullable===false)return;invalidate({fields:{...state.fields,[name]:next}});},
 cancel(){if(state.busy==='apply')return false;operation++;revision++;emit({review:null,busy:'idle'});return true;},
 async preview(){if(!editable()||!state.eligible||state.busy!=='idle')return;let requested:Draft;try{requested=draft();}catch(error){emit({notice:error instanceof Error&&error.message==='unchanged'?'No changed values.':'Enter a valid finite number and respect NOT NULL constraints.'});return;}const op=++operation,rev=revision;emit({busy:'preview',review:null,notice:null});try{const review=await database.previewGridMutation({handleId,draft:requested});if(disposed||op!==operation||rev!==revision)return;if(review.handleId!==handleId||JSON.stringify(review.draft)!==JSON.stringify(requested))throw new GridMutationError('review');emit({review:copy(review),notice:'Review the SQL and every parameter before confirming.'});}catch(error){if(!disposed&&op===operation&&rev===revision)emit({review:null,notice:mutationFailure(error,'Preview failed. No change was submitted.')});}finally{if(!disposed&&op===operation)emit({busy:'idle'});}},
 async confirm(){if(disposed||state.applied||state.busy!=='idle'||!state.review)return;const review=state.review,op=++operation;emit({busy:'apply',review:null,notice:'Applying the reviewed change…'});try{const result=await database.applyGridMutation({handleId,review});if(disposed||op!==operation)return;if(result.changes!==1)throw Error('count');emit({applied:true,notice:'One row changed. No additional SQL was executed.'});try{onApplied();}catch{emit({notice:'One row changed, but workspace refresh failed. Reload the table.'});}}catch(error){if(!disposed&&op===operation)emit({notice:mutationFailure(error,'The change could not be confirmed. Check the table state before preparing another preview.')});}finally{if(!disposed&&op===operation)emit({busy:'idle'});}},
 dispose(){disposed=true;operation++;revision++;state={...state,review:null};listeners.clear();},
 };
}
export function RowMutation({context,handleId,schema,table,original,onApplied,onClose}:{context:WorkbenchContext;handleId:string;schema:DatabaseSchemaResult;table:string;original:Record<string,DatabaseScalar>;onApplied:()=>void;onClose:()=>void}){
 const callback=useRef(onApplied);callback.current=onApplied;const snapshot=useMemo(()=>({schema,table,original:copy(original)}),[context.database,handleId]);
 const controller=useMemo(()=>createRowMutationController(context.database,handleId,snapshot.schema,snapshot.table,snapshot.original,()=>callback.current()),[context.database,handleId,snapshot]);const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);useEffect(()=>()=>controller.dispose(),[controller]);
 const tr=rowMutationTranslator(context.environment?.locale??'en'),locked=state.busy==='apply'||state.applied,columns=snapshot.schema.tables.find(value=>value.name===snapshot.table)?.columns??[];
 return <section className={`create-table row-mutation row-mutation-${state.kind}`} aria-label={tr('Edit or delete one row')}>
 <header className="row-mutation-panel-header"><h2>{tr(state.kind==='delete'?'Delete this row':'Edit values')}<span className="row-mutation-table-name">{snapshot.table}</span></h2><p className={state.kind==='delete'?'row-mutation-warning':'hint'}>{tr(state.kind==='delete'?'Permanently deletes 1 row after confirmation.':'Primary key values are read only. Only changed fields will be updated.')}</p></header>
 {!state.eligible?<p role="status">{tr('This row cannot be edited here. A regular table, primary key, complete row, at most 16 columns no BLOB columns, known trigger-free metadata and values within the edit limit are required.')}</p>:<>
 <div className="row-mutation-toolbar"><label className="row-mutation-mode">{tr('Action')}<select aria-label={tr('Row action')} value={state.kind} disabled={locked} onChange={event=>controller.setKind(event.currentTarget.value as 'update'|'delete')}><option value="update">{tr('Edit values')}</option><option value="delete">{tr('Delete this row')}</option></select></label></div>
 <div className="row-mutation-content">
 <section className="row-mutation-editor" aria-label={tr(state.kind==='delete'?'Original row':'Edit fields')}>
 <div className="row-mutation-section-heading"><h3>{tr(state.kind==='delete'?'Original row':'Edit fields')}</h3></div>
 {state.kind==='delete'?<pre className="row-mutation-original-json" tabIndex={0} aria-label={tr('Original row')}>{JSON.stringify(snapshot.original)}</pre>:<div className="row-mutation-fields">{columns.map(column=><div className="row-mutation-field" key={column.name}>
 <div className="row-mutation-field-heading"><strong>{column.name}</strong>{column.primaryKey?<span className="row-mutation-key">{tr('Primary key')}</span>:<span className="row-mutation-column-type">{column.type}{column.nullable===false?' · NOT NULL':''}</span>}</div>
 <div className="row-mutation-original-value"><span>{tr('Original value')}</span><pre className="row-mutation-value" tabIndex={0} aria-label={tr('Original: {name}',{name:column.name})}>{JSON.stringify(snapshot.original[column.name])}</pre></div>
 <div className="row-mutation-inputs"><label className="row-mutation-type">{tr('Value type')}<select aria-label={tr('Type: {name}',{name:column.name})} disabled={locked||column.primaryKey} value={state.fields[column.name].type} onChange={event=>controller.setField(column.name,{type:event.currentTarget.value as Field['type']})}><option value="text">{tr('Text')}</option><option value="number">{tr('Number')}</option><option value="null" disabled={column.nullable===false}>NULL</option></select></label><label className="row-mutation-new-value">{tr('New value')}<input aria-label={tr('Value: {name}',{name:column.name})} disabled={locked||column.primaryKey||state.fields[column.name].type==='null'} value={state.fields[column.name].value} onChange={event=>controller.setField(column.name,{value:event.currentTarget.value})}/></label></div>
 </div>)}</div>}
 </section>
 <section className="row-mutation-review" aria-label={tr('SQL and parameters')}>
 {state.review?<><div className="row-mutation-section-heading"><h3>SQL</h3></div><SqlPreview sql={state.review.sql} label={tr('Reviewed SQL')}/><div className="row-mutation-parameters row-mutation-parameters-compact"><strong>{tr('Parameters in binding order')}</strong><pre tabIndex={0} aria-label={tr('Reviewed parameters in binding order')}>{JSON.stringify(state.review.parameters)}</pre></div></>:null}
 </section>
 </div>
 </>}
 <p className="create-table-status row-mutation-status" role="status">{tr(state.notice??'')}</p>
 <footer className="row-mutation-actions row-mutation-footer">
 <button className="secondary toolbar-button" disabled={state.busy==='apply'} onClick={()=>{if(controller.cancel())onClose();}}>{tr(state.applied?'Close':'Cancel')}</button>
 {state.eligible?<><button className="secondary toolbar-button" disabled={locked||state.busy!=='idle'} onClick={()=>void controller.preview()}>{tr(state.busy==='preview'?'Preparing preview…':'Preview change')}</button><button className={state.kind==='delete'?'toolbar-button row-mutation-delete-confirm':'toolbar-button row-mutation-update-confirm'} disabled={locked||state.busy!=='idle'||!state.review} onClick={()=>void controller.confirm()}>{tr(state.kind==='delete'?'Confirm delete one row':'Confirm update one row')}</button></>:null}
 </footer>
 </section>;
}

import {sqliteSchemaTokens,schemaTokenSequence} from './sqliteSchemaKeywords';
import type {Database} from 'sql.js';
import {inspectSqliteSchema} from './sqliteClient';
import {previewGridBatch,GridBatchError,type GridBatchPlan} from './gridBatchMutation';
import {protectSnapshotDatabase} from './sqliteSnapshot';
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const fold=(name:string)=>name.replace(/[A-Z]/g,c=>c.toLowerCase());
function authority(db:Database,table:string){
 const schema=inspectSqliteSchema(db),target=schema.tables.find(t=>fold(t.name)===fold(table));if(!target||target.kind!=='table'||!target.definition?.trim())throw new GridBatchError('authority');
 let tokens:string[];try{tokens=sqliteSchemaTokens(target.definition);}catch{throw new GridBatchError('authority');}
 if(tokens[0]!=='CREATE'||tokens[1]!=='TABLE'||schemaTokenSequence(tokens,'ON','CONFLICT'))throw new GridBatchError('authority');
 const flags=db.exec('SELECT type,wr FROM pragma_table_list WHERE schema=\'main\' AND name=?',[target.name])[0]?.values;
 const columns=db.exec('SELECT name,hidden,pk FROM pragma_table_xinfo(?) ORDER BY cid',[target.name])[0]?.values;
 if(flags?.length!==1||flags[0][0]!=='table'||flags[0][1]!==0||columns?.length!==target.columns.length||columns.some((c,i)=>c[0]!==target.columns[i].name||c[1]!==0||Boolean(c[2])!==target.columns[i].primaryKey)||!columns.some(c=>Number(c[2])>0)||target.triggers?.length!==0)throw new GridBatchError('authority');
 // First slice refuses every direct/inbound FK, not merely cascading actions.
 for(const t of schema.tables){if(!Array.isArray(t.foreignKeys))throw new GridBatchError('authority');if(t.name===target.name&&t.foreignKeys.length||t.foreignKeys.some(f=>fold(f.targetTable)===fold(target.name)))throw new GridBatchError('authority');}
 return schema;
}
function checkOriginal(db:Database,step:GridBatchPlan['steps'][number]){const entries=Object.entries(step.draft.original),statement=db.prepare(`SELECT 1 FROM ${quote(step.draft.table)} WHERE ${entries.map(([name])=>`${quote(name)} COLLATE BINARY IS ?`).join(' AND ')} LIMIT 2`);try{statement.bind(entries.map(([,v])=>typeof v==='boolean'?Number(v):v));if(!statement.step()||statement.step())throw new GridBatchError('conflict');}finally{statement.free();}}
/** @internal Read-only authoritative preview; owning adapter must issue its own
 * connection/schema-bound, immutable, single-use token. Not a Workbench API. */
export function previewSqliteGridBatch(db:Database,draft:unknown):GridBatchPlan{
 const table=(draft as {table?:unknown}|null)?.table;if(typeof table!=='string')throw new GridBatchError('draft');const plan=previewGridBatch(draft,authority(db,table));for(const step of plan.steps)checkOriginal(db,step);return plan;
}
/** @internal Called only after adapter consumes a matching issued review. The
 * adapter owns an idle connection with no outer transaction and serializes all
 * calls. Cancellation is checked between synchronous SQLite statements, never
 * advertised as interrupting a running statement or undoing a committed batch. */
export function executeSqliteGridBatch(db:Database,review:GridBatchPlan,options:{signal?:AbortSignal;onFatal?:()=>void}={}):{changes:number}{
 const cancelled=()=>{if(options.signal?.aborted)throw new GridBatchError('cancelled');};cancelled();
 const plan=previewSqliteGridBatch(db,review.draft);if(JSON.stringify(plan)!==JSON.stringify(review))throw new GridBatchError('review');
 let transaction=false,closed=false;const fatal=()=>{closed=true;try{options.onFatal?.();}catch{/* Cleanup notification cannot replace the safe error. */}finally{try{db.close();}catch{}}};
 try{
  if(db.exec('PRAGMA query_only')[0]?.values[0]?.[0]!==1||db.exec('PRAGMA foreign_keys')[0]?.values[0]?.[0]!==1||db.exec('PRAGMA trusted_schema')[0]?.values[0]?.[0]!==0)throw new GridBatchError('protection');
  cancelled();db.run('PRAGMA query_only=OFF');db.run('SAVEPOINT plugin_grid_batch');transaction=true;
  for(const step of plan.steps){cancelled();checkOriginal(db,step);const statement=db.prepare(step.sql);try{statement.bind(step.parameters.map(v=>typeof v==='boolean'?Number(v):v));while(statement.step()){} }finally{statement.free();}if(db.getRowsModified()!==1)throw new GridBatchError('conflict');}
  cancelled();const size=Number(db.exec('PRAGMA page_count')[0]?.values[0]?.[0])*Number(db.exec('PRAGMA page_size')[0]?.values[0]?.[0]);if(!Number.isSafeInteger(size)||size>1024*1024)throw new GridBatchError('budget');authority(db,plan.draft.table);cancelled();
  db.run('RELEASE plugin_grid_batch');transaction=false;return {changes:plan.rowCount};
 }catch(error){if(transaction){try{db.run('ROLLBACK TO plugin_grid_batch; RELEASE plugin_grid_batch');}catch{fatal();throw new GridBatchError('protection');}}if(error instanceof GridBatchError)throw error;throw new GridBatchError('constraint');}
 finally{if(!closed){try{protectSnapshotDatabase(db);}catch{fatal();throw new GridBatchError('protection');}}}
}

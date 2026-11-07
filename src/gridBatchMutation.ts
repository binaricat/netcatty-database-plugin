import {previewGridMutation,GridMutationError,type GridMutationDraft} from './gridMutation';
import type {DatabaseSchemaResult} from './databaseTypes';
export type GridBatchDraft={table:string;rows:GridMutationDraft[]};
export type GridBatchPlan={draft:GridBatchDraft;steps:ReturnType<typeof previewGridMutation>[];rowCount:number};
export class GridBatchError extends Error {constructor(readonly code:'draft'|'duplicate'|'budget'|'authority'|'review'|'conflict'|'constraint'|'cancelled'|'protection'){super(`Grid batch ${code}`);}}
/** Pure bounded plan; no review token is issued here. */
export function previewGridBatch(input:unknown,schema:DatabaseSchemaResult):GridBatchPlan{
 if(!input||typeof input!=='object'||Array.isArray(input))throw new GridBatchError('draft');
 const value=input as GridBatchDraft;if(Object.keys(value).sort().join(',')!=='rows,table'||typeof value.table!=='string'||!Array.isArray(value.rows)||value.rows.length<1||value.rows.length>10)throw new GridBatchError('draft');
 const steps=value.rows.map(row=>{if(!row||row.table!==value.table)throw new GridBatchError('draft');return previewGridMutation(row,schema);});
 const table=schema.tables.find(t=>t.name===steps[0].draft.table)!;const pk=table.columns.filter(c=>c.primaryKey).map(c=>c.name);const seen=new Set<string>();
 for(const step of steps){const key=JSON.stringify(pk.map(name=>{const v=step.draft.original[name];return typeof v==='boolean'?Number(v):v;}));if(seen.has(key))throw new GridBatchError('duplicate');seen.add(key);}
 const plan={draft:{table:steps[0].draft.table,rows:steps.map(step=>step.draft)},steps,rowCount:steps.length};
 if(steps.reduce((n,s)=>n+s.parameters.length,0)>320||new TextEncoder().encode(JSON.stringify(plan)).length>96*1024)throw new GridBatchError('budget');return plan;
}
export {GridMutationError};

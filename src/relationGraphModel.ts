import type {DatabaseSchemaResult} from './databaseTypes';
export interface RelationNode {name:string;kind:'table'|'view'|'unknown';columns:Array<{name:string;type:string;primaryKey:boolean}>;primaryKeyColumns:string[]|null;foreignKeysKnown:boolean}
export interface RelationEdge {id:string;source:string;target:string;targetStatus:'known'|'unknown-target';pairs:Array<{from:string;to:string|null;sourceKnown:boolean;targetKnown:boolean|null}>;onUpdate:string;onDelete:string;match:string}
export interface RelationGraphModel {nodes:RelationNode[];edges:RelationEdge[];unknownForeignKeyTables:string[]}
export class RelationGraphError extends Error {constructor(readonly code:'invalid'|'budget'){super(`Relation graph ${code}`);}}
const fail=(code:RelationGraphError['code']):never=>{throw new RelationGraphError(code);};
const name=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256&&!v.includes('\0');
/** Only reported foreign keys. No inferred names, cardinality or implicit PK pairing. */
export function buildRelationGraph(schema:DatabaseSchemaResult):RelationGraphModel{
 if(!schema||!Array.isArray(schema.tables))fail('invalid');if(schema.tables.length>32)fail('budget');
 const names=new Set<string>();const nodes:RelationNode[]=schema.tables.map(t=>{
  if(!name(t.name)||names.has(t.name)||!Array.isArray(t.columns))return fail('invalid');names.add(t.name);if(t.columns.length>64)fail('budget');const cols=new Set<string>();
  const columns=t.columns.map(c=>{if(!name(c.name)||cols.has(c.name)||typeof c.type!=='string'||c.type.length>256||c.type.includes('\0')||typeof c.primaryKey!=='boolean')return fail('invalid');cols.add(c.name);return {name:c.name,type:c.type,primaryKey:c.primaryKey};});
  if(t.primaryKeyColumns!==undefined&&(!Array.isArray(t.primaryKeyColumns)||t.primaryKeyColumns.length>64||new Set(t.primaryKeyColumns).size!==t.primaryKeyColumns.length||t.primaryKeyColumns.some(c=>!cols.has(c))))fail('invalid');
  if(t.foreignKeys!==undefined&&!Array.isArray(t.foreignKeys))fail('invalid');
  return {name:t.name,kind:t.kind==='table'||t.kind==='view'?t.kind:'unknown',columns,primaryKeyColumns:t.primaryKeyColumns?[...t.primaryKeyColumns]:null,foreignKeysKnown:t.foreignKeys!==undefined};
 });
 let pairCount=0;const edges:RelationEdge[]=[];for(const table of schema.tables){const ids=new Set<number>();for(const fk of table.foreignKeys??[]){
  if(edges.length>=64)fail('budget');if(!Number.isSafeInteger(fk.id)||fk.id<0||ids.has(fk.id)||!name(fk.targetTable)||!Array.isArray(fk.columns)||!fk.columns.length)fail('invalid');ids.add(fk.id);pairCount+=fk.columns.length;if(fk.columns.length>64||pairCount>64)fail('budget');
  if(![fk.onUpdate,fk.onDelete,fk.match].every(name))fail('invalid');
  const target=nodes.find(n=>n.name===fk.targetTable),source=nodes.find(n=>n.name===table.name)!;
  const pairs=fk.columns.map(p=>{if(!name(p.from)||(p.to!==null&&!name(p.to)))return fail('invalid');return {from:p.from,to:p.to,sourceKnown:source.columns.some(c=>c.name===p.from),targetKnown:p.to===null||!target?null:target.columns.some(c=>c.name===p.to)};});
  edges.push({id:JSON.stringify([table.name,fk.id]),source:table.name,target:fk.targetTable,targetStatus:target?'known':'unknown-target',pairs,onUpdate:fk.onUpdate,onDelete:fk.onDelete,match:fk.match});
 }}
 const model={nodes,edges,unknownForeignKeyTables:nodes.filter(n=>!n.foreignKeysKnown).map(n=>n.name)};if(new TextEncoder().encode(JSON.stringify(model)).length>96*1024)fail('budget');return model;
}

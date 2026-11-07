import type {DatabaseScalar,DatabaseSchemaResult} from './databaseTypes';

export interface GridMutationDraft {
  kind:'update'|'delete';table:string;original:Record<string,DatabaseScalar>;changes?:Record<string,DatabaseScalar>;
}
export class GridMutationError extends Error {
  constructor(readonly code:'draft'|'table'|'columns'|'primary-key'|'value'|'unchanged'|'budget'|'stale'|'review'|'conflict'){super(`Grid mutation ${code}`);}
}
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const fold=(value:string)=>value.replace(/[A-Z]/g,c=>c.toLowerCase());
const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
const validName=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=128&&!value.includes('\0')&&!/^sqlite_/i.test(value);
function scalar(value:unknown,nullable:boolean):DatabaseScalar {
  if(value===null){if(!nullable)throw new GridMutationError('value');return null;}
  if(typeof value==='boolean')return value;
  if(typeof value==='number'&&Number.isFinite(value)&&(!Number.isInteger(value)||Number.isSafeInteger(value)))return value;
  if(typeof value==='string'&&value.length<=2048&&!/^<BLOB\s+\d+\s+bytes>$/i.test(value))return value;
  throw new GridMutationError('value');
}
/** Pure preview only. The applying adapter must bind the review to a live
 * connection/schema revision, transact and roll back unless exactly one row
 * changes. Binary collation avoids case-insensitive text conflicts; SQLite's
 * numeric IS comparison still treats equal INTEGER/REAL values as equal.
 */
export function previewGridMutation(input:unknown,schema:DatabaseSchemaResult):{draft:GridMutationDraft;sql:string;parameters:DatabaseScalar[]} {
  if(!record(input)||Object.keys(input).some(key=>!['kind','table','original','changes'].includes(key))||(input.kind!=='update'&&input.kind!=='delete')||!validName(input.table)||!record(input.original))throw new GridMutationError('draft');
  if(!schema||!Array.isArray(schema.tables)||schema.tables.length>32)throw new GridMutationError('table');
  const matching=schema.tables.filter(table=>typeof table?.name==='string'&&fold(table.name)===fold(input.table as string));
  if(matching.length!==1||matching[0].kind!=='table'||/\bCREATE\s+VIRTUAL\s+TABLE\b/i.test(matching[0].definition??''))throw new GridMutationError('table');
  const table=matching[0];if(!validName(table.name))throw new GridMutationError('table');
  if(!Array.isArray(table.triggers)||table.triggers.length)throw new GridMutationError('table');
  if(input.kind==='delete'){
    for(const source of schema.tables){
      if(!Array.isArray(source.foreignKeys))throw new GridMutationError('table');
      for(const foreignKey of source.foreignKeys){
        if(!foreignKey||typeof foreignKey.targetTable!=='string'||typeof foreignKey.onDelete!=='string')throw new GridMutationError('table');
        if(fold(foreignKey.targetTable)===fold(table.name)&&!['NO ACTION','RESTRICT'].includes(foreignKey.onDelete.toUpperCase()))throw new GridMutationError('table');
      }
    }
  }
  if(!Array.isArray(table.columns)||!table.columns.length||table.columns.length>16)throw new GridMutationError('columns');
  const seen=new Set<string>();
  for(const column of table.columns){
    if(!column||!validName(column.name)||seen.has(fold(column.name))||typeof column.type!=='string'||!column.type.trim()||/BLOB/i.test(column.type)||typeof column.primaryKey!=='boolean'||typeof column.nullable!=='boolean')throw new GridMutationError('columns');
    seen.add(fold(column.name));
  }
  if(Object.keys(input.original).length!==table.columns.length||table.columns.some(column=>!Object.hasOwn(input.original!,column.name)))throw new GridMutationError('columns');
  const originalInput=input.original;
  const primaryKeys=table.columns.filter(column=>column.primaryKey);
  if(!primaryKeys.length||primaryKeys.some(column=>originalInput[column.name]===null))throw new GridMutationError('primary-key');
  const original:Record<string,DatabaseScalar>={},changes:Record<string,DatabaseScalar>={};
  const put=(target:Record<string,DatabaseScalar>,key:string,value:DatabaseScalar)=>Object.defineProperty(target,key,{value,writable:true,enumerable:true,configurable:true});
  for(const column of table.columns)put(original,column.name,scalar(input.original[column.name],column.nullable!));
  if(input.kind==='delete'){
    if(Object.hasOwn(input,'changes'))throw new GridMutationError('draft');
  }else{
    if(!record(input.changes))throw new GridMutationError('draft');
    const keys=Object.keys(input.changes);if(!keys.length)throw new GridMutationError('unchanged');
    if(keys.some(key=>!table.columns.some(column=>column.name===key)))throw new GridMutationError('columns');
    for(const column of table.columns)if(Object.hasOwn(input.changes,column.name)){
      if(column.primaryKey)throw new GridMutationError('primary-key');
      const value=scalar(input.changes[column.name],column.nullable!);
      if(value===original[column.name])throw new GridMutationError('unchanged');
      put(changes,column.name,value);
    }
  }
  if(input.kind==='update'){
    for(const source of schema.tables){
      if(!Array.isArray(source.foreignKeys))throw new GridMutationError('table');
      for(const foreignKey of source.foreignKeys){
        if(!foreignKey||typeof foreignKey.targetTable!=='string')throw new GridMutationError('table');
        if(fold(foreignKey.targetTable)!==fold(table.name))continue;
        if(!Array.isArray(foreignKey.columns)||!foreignKey.columns.length||typeof foreignKey.onUpdate!=='string')throw new GridMutationError('table');
        const referenced=foreignKey.columns.map(column=>{
          if(typeof column?.to!=='string'||!table.columns.some(actual=>fold(actual.name)===fold(column.to!)))throw new GridMutationError('table');
          return fold(column.to);
        });
        if(Object.keys(changes).some(name=>referenced.includes(fold(name)))&&!['NO ACTION','RESTRICT'].includes(foreignKey.onUpdate.toUpperCase()))throw new GridMutationError('table');
      }
    }
  }
  const parameters:DatabaseScalar[]=[];
  const set=Object.keys(changes).map(name=>{parameters.push(changes[name]);return `${quote(name)} = ?`;}).join(', ');
  const where=table.columns.map(column=>{parameters.push(original[column.name]);return `${quote(column.name)} COLLATE BINARY IS ?`;}).join(' AND ');
  const sql=`${input.kind==='update'?`UPDATE ${quote(table.name)} SET ${set}`:`DELETE FROM ${quote(table.name)}`} WHERE ${where};`;
  if(parameters.length>32||new TextEncoder().encode(sql).length>8192)throw new GridMutationError('budget');
  const draft:GridMutationDraft={kind:input.kind as 'update'|'delete',table:table.name,original,...(input.kind==='update'?{changes}:{})};
  return {draft,sql,parameters};
}

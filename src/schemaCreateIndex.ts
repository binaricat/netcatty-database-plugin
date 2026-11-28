import type {DatabaseSchemaResult} from './databaseTypes';

export interface DatabaseCreateIndexDraft {
  name:string;
  table:string;
  unique:boolean;
  columns:Array<{name:string;direction:'ASC'|'DESC'}>;
}
export interface DatabaseCreateIndexReview {handleId:string;draft:DatabaseCreateIndexDraft;sql:string;schemaRevision:number;}
export class CreateIndexError extends Error {
  constructor(readonly code:'draft'|'identifier'|'schema'|'table'|'column'|'duplicate-column'|'exists'|'budget'|'stale'|'review') {super(`Create index ${code}`);}
}
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
// SQLite's identifier folding is ASCII-only, not Unicode case folding.
const fold=(value:string)=>value.replace(/[A-Z]/g,letter=>letter.toLowerCase());
const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
function identifier(value:unknown):string {
  if(typeof value!=='string'||!value.trim()||value.length>128||value.includes('\0')||/^sqlite_/i.test(value))throw new CreateIndexError('identifier');
  return value;
}
/** A preview only. The adapter must re-read authoritative metadata and bind review
 * to the connection/schema revision before applying. Missing index metadata is
 * not an empty namespace. No expressions, partial indexes or implicit columns.
 */
export function previewCreateIndexSql(input:unknown,schema:DatabaseSchemaResult):{draft:DatabaseCreateIndexDraft;sql:string} {
  if(!object(input)||Object.keys(input).some(key=>!['name','table','unique','columns'].includes(key))||typeof input.unique!=='boolean'||!Array.isArray(input.columns)||input.columns.length<1||input.columns.length>32)throw new CreateIndexError('draft');
  const name=identifier(input.name),tableName=identifier(input.table);
  if(!schema||!Array.isArray(schema.tables)||schema.tables.length>32)throw new CreateIndexError('schema');
  const names=new Set<string>();
  for(const table of schema.tables){
    if(!table||typeof table.name!=='string'||!Array.isArray(table.columns)||table.columns.length>64||!Array.isArray(table.indexes)||table.indexes.length>32)throw new CreateIndexError('schema');
    const key=fold(table.name);if(names.has(key))throw new CreateIndexError('schema');names.add(key);
  }
  for(const table of schema.tables)for(const index of table.indexes!){
    if(!index||typeof index.name!=='string')throw new CreateIndexError('schema');
    const key=fold(index.name);if(names.has(key))throw new CreateIndexError('schema');names.add(key);
  }
  if(names.has(fold(name)))throw new CreateIndexError('exists');
  const matches=schema.tables.filter(table=>fold(table.name)===fold(tableName));
  if(matches.length!==1||matches[0].kind!=='table')throw new CreateIndexError('table');
  const table=matches[0];identifier(table.name);
  if(table.indexes!.length>=32)throw new CreateIndexError('budget');
  const actualColumns=new Map<string,string>();
  for(const column of table.columns){
    if(!column||typeof column.name!=='string'||actualColumns.has(fold(column.name)))throw new CreateIndexError('schema');
    actualColumns.set(fold(column.name),column.name);
  }
  const seen=new Set<string>();
  const columns=input.columns.map(column=>{
    if(!object(column)||Object.keys(column).some(key=>!['name','direction'].includes(key))||(column.direction!=='ASC'&&column.direction!=='DESC'))throw new CreateIndexError('draft');
    const requested=identifier(column.name),key=fold(requested);
    if(seen.has(key))throw new CreateIndexError('duplicate-column');seen.add(key);
    const actual=actualColumns.get(key);if(actual===undefined)throw new CreateIndexError('column');
    return {name:identifier(actual),direction:column.direction as 'ASC'|'DESC'};
  });
  const draft:DatabaseCreateIndexDraft={name,table:table.name,unique:input.unique,columns};
  const sql=`CREATE ${draft.unique?'UNIQUE ':''}INDEX ${quote(name)} ON ${quote(table.name)} (${columns.map(column=>`${quote(column.name)} ${column.direction}`).join(', ')});`;
  if(new TextEncoder().encode(sql).length>8192)throw new CreateIndexError('budget');
  return {draft,sql};
}

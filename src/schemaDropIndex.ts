import type {DatabaseSchemaResult} from './databaseTypes';
export interface DropIndexDraft {table:string;name:string}
export interface DropIndexPreview {draft:DropIndexDraft;sql:string;unique:boolean}
export class DropIndexError extends Error {constructor(readonly code:'draft'|'identifier'|'table'|'index'|'dependency'|'schema'|'budget'|'stale'|'review'){super(`Drop index ${code}`);}}
function fail(code:DropIndexError['code']):never{throw new DropIndexError(code);}
const fold=(value:string)=>value.replace(/[A-Z]/g,c=>c.toLowerCase());
const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
function name(value:unknown):string{if(typeof value!=='string'||!value.trim()||value.length>128||value.includes('\0')||/^sqlite_/i.test(value))fail('identifier');return value;}
/** Only explicit column indexes. UNIQUE=true is disclosed to review because
 * removing an explicit unique index removes its uniqueness enforcement. Native
 * PK/UNIQUE constraint autoindexes, partial and expression indexes are excluded.
 */
export function previewDropIndexSql(input:unknown,schema:DatabaseSchemaResult):DropIndexPreview{
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['table','name'].includes(key)))fail('draft');const d=input as Record<string,unknown>,tableName=name(d.table),indexName=name(d.name);
 if(!schema||!Array.isArray(schema.tables)||schema.tables.length>32)fail('schema');
 const tables=schema.tables.filter(t=>typeof t?.name==='string'&&fold(t.name)===fold(tableName));if(tables.length!==1||tables[0].kind!=='table')fail('table');const table=tables[0];
 if(!Array.isArray(table.indexes)||table.indexes.length>32||!Array.isArray(table.foreignKeys)||!Array.isArray(table.columns)||table.columns.length>64)fail('schema');
 if(table.foreignKeys.length)fail('dependency');
 for(const other of schema.tables){
  if(!Array.isArray(other.foreignKeys)||!Array.isArray(other.triggers)||other.foreignKeys.length>64||other.triggers.length>32)fail('schema');
  for(const fk of other.foreignKeys){if(typeof fk?.targetTable!=='string')fail('schema');if(fold(fk.targetTable)===fold(table.name))fail('dependency');}
  // SQLite does not rewrite INDEXED BY when dropping an index. Refuse any such
  // persistent hint rather than permit a view/trigger which fails only later.
  for(const sql of [other.definition,...other.triggers.map(t=>t.definition)]){if(typeof sql!=='string')fail('schema');if(sql.length>8192)fail('budget');if(/\bINDEXED\b/i.test(sql))fail('dependency');}
 }
 const indexes=table.indexes.filter(i=>fold(i.name)===fold(indexName));if(indexes.length!==1)fail('index');const index=indexes[0];
 if(index.origin!=='c'||typeof index.unique!=='boolean'||index.partial!==false||typeof index.definition!=='string'||!/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(index.definition)||!Array.isArray(index.columns)||!index.columns.length||index.columns.length>32)fail('index');
 name(index.name);const seen=new Set<string>();
 for(const column of index.columns){if(typeof column.name!=='string'||column.expression!==false||!table.columns.some(c=>c.name===column.name)||seen.has(fold(column.name)))fail('index');seen.add(fold(column.name));}
 const draft={table:table.name,name:index.name},sql=`DROP INDEX "main".${quote(index.name)};`;
 return {draft,sql,unique:index.unique};
}

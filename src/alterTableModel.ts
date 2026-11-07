import {sqliteSchemaTokens} from './sqliteSchemaKeywords';
import type {DatabaseSchemaResult} from './databaseTypes';
import {SQLITE_TABLE_TYPES} from './schemaCreateTable';
export interface AddColumnDraft {table:string;name:string;type:typeof SQLITE_TABLE_TYPES[number];}
export interface AddColumnReview {handleId:string;schemaRevision:number;draft:AddColumnDraft;sql:string;}
export class AddColumnError extends Error {
 constructor(readonly code:'draft'|'identifier'|'schema'|'table'|'exists'|'budget'|'stale'|'review'){super(`Add column ${code}`);}
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fold=(v:string)=>v.replace(/[A-Z]/g,c=>c.toLowerCase());
const quote=(v:string)=>'"'+v.replaceAll('"','""')+'"';
function identifier(v:unknown):string {
 if(typeof v!=='string'||!v.trim()||v.length>128||v.includes('\0')||/^sqlite_/i.test(v))throw new AddColumnError('identifier');return v;
}
/** Preview only, never executes. A single nullable scalar column without DEFAULT,
 * PK, UNIQUE, REFERENCES, CHECK or generated expressions. Existing rows get NULL.
 * Requires authoritative schema metadata; adapter must re-read and bind this plan
 * to its connection/schema revision, then issue a one-shot review before applying.
 * Missing triggers/definition must NOT be interpreted as safe empty metadata.
 */
export function previewAddColumnSql(input:unknown,schema:DatabaseSchemaResult):{draft:AddColumnDraft;sql:string}{
 if(!object(input)||Object.keys(input).some(k=>!['table','name','type'].includes(k))||!SQLITE_TABLE_TYPES.includes(input.type as typeof SQLITE_TABLE_TYPES[number]))throw new AddColumnError('draft');
 const requested=identifier(input.table),name=identifier(input.name);
 if(!schema||!Array.isArray(schema.tables)||schema.tables.length>32)throw new AddColumnError('schema');
 const names=new Set<string>();
 for(const table of schema.tables){
  if(!table||typeof table.name!=='string'||names.has(fold(table.name)))throw new AddColumnError('schema');names.add(fold(table.name));
 }
 const table=schema.tables.find(t=>fold(t.name)===fold(requested));
 if(!table||table.kind!=='table'||typeof table.definition!=='string'||table.definition.length>8192||!Array.isArray(table.triggers)||table.triggers.length!==0)throw new AddColumnError('table');
 // Conservative subset; STRICT accepts fewer declared types, generated columns and
 // virtual/shadow layouts require a separate reviewed policy, not guesswork.
 let tokens:string[];try{tokens=sqliteSchemaTokens(table.definition);}catch{throw new AddColumnError('table');}
 if(tokens[0]!=='CREATE'||tokens[1]!=='TABLE'||tokens.includes('GENERATED')||tokens.includes('STRICT'))throw new AddColumnError('table');
 if(!Array.isArray(table.columns)||table.columns.length<1||table.columns.length>64)throw new AddColumnError('schema');
 if(table.columns.length===64)throw new AddColumnError('budget');
 const columns=new Set<string>();
 for(const column of table.columns){if(!column||typeof column.name!=='string'||columns.has(fold(column.name)))throw new AddColumnError('schema');columns.add(fold(column.name));}
 if(columns.has(fold(name)))throw new AddColumnError('exists');
 const draft:AddColumnDraft={table:identifier(table.name),name,type:input.type as AddColumnDraft['type']};
 const sql=`ALTER TABLE ${quote(draft.table)} ADD COLUMN ${quote(name)} ${draft.type};`;
 if(new TextEncoder().encode(sql).length>8192)throw new AddColumnError('budget');return {draft,sql};
}

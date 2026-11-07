export const SQLITE_TABLE_TYPES=['INTEGER','REAL','TEXT','BLOB','NUMERIC'] as const;
export interface DatabaseCreateTableDraft {name:string;columns:Array<{name:string;type:typeof SQLITE_TABLE_TYPES[number];nullable:boolean;primaryKey:boolean}>;}
export interface DatabaseCreateTableReview {handleId:string;draft:DatabaseCreateTableDraft;sql:string;schemaRevision:number;}
export class CreateTableError extends Error {constructor(readonly code:'draft'|'identifier'|'duplicate-column'|'primary-key'|'budget'|'exists'|'stale'|'review'){super(`Create table ${code}`);}}
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function name(value:unknown):string {if(typeof value!=='string'||!value.trim()||value.length>128||value.includes('\0')||/^sqlite_/i.test(value))throw new CreateTableError('identifier');return value;}
const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
/** Plain CREATE TABLE only, with explicit scalar column types and no executable
 * expressions. SQL-looking identifier text remains one quoted SQLite identifier.
 */
export function previewCreateTableSql(input:unknown,existingObjects:readonly string[]=[]):{draft:DatabaseCreateTableDraft;sql:string}{
  if(!object(input)||Object.keys(input).some(key=>!['name','columns'].includes(key))||!Array.isArray(input.columns)||input.columns.length<1||input.columns.length>32)throw new CreateTableError('draft');
  const table=name(input.name);if(existingObjects.some(existing=>existing.toLowerCase()===table.toLowerCase()))throw new CreateTableError('exists');
  const seen=new Set<string>();let primaryKeys=0;
  const columns=input.columns.map(column=>{
    if(!object(column)||Object.keys(column).some(key=>!['name','type','nullable','primaryKey'].includes(key))||!SQLITE_TABLE_TYPES.includes(column.type as typeof SQLITE_TABLE_TYPES[number])||typeof column.nullable!=='boolean'||typeof column.primaryKey!=='boolean')throw new CreateTableError('draft');
    const columnName=name(column.name);if(seen.has(columnName.toLowerCase()))throw new CreateTableError('duplicate-column');seen.add(columnName.toLowerCase());
    if(column.primaryKey&&(++primaryKeys>1||column.nullable))throw new CreateTableError('primary-key');
    return {name:columnName,type:column.type as typeof SQLITE_TABLE_TYPES[number],nullable:column.nullable,primaryKey:column.primaryKey};
  });
  const draft={name:table,columns};const sql=`CREATE TABLE ${quote(table)} (\n${columns.map(column=>`  ${quote(column.name)} ${column.type}${column.nullable?'':' NOT NULL'}${column.primaryKey?' PRIMARY KEY':''}`).join(',\n')}\n);`;
  if(new TextEncoder().encode(sql).length>8192)throw new CreateTableError('budget');return {draft,sql};
}

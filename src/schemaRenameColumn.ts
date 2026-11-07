import type {DatabaseSchemaResult} from './databaseTypes';
export interface RenameColumnDraft {table:string;from:string;to:string}
export interface RenameColumnPreview {draft:RenameColumnDraft;sql:string;dependencyValidation:'adapter-required'}
export class RenameColumnError extends Error {constructor(readonly code:'draft'|'identifier'|'schema'|'table'|'column'|'exists'|'unchanged'|'dependency'|'definition'|'budget'|'stale'|'review'){super(`Rename column ${code}`);}}
function fail(code:RenameColumnError['code']):never{throw new RenameColumnError(code);}
const fold=(s:string)=>s.replace(/[A-Z]/g,c=>c.toLowerCase());
const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
function name(v:unknown):string{if(typeof v!=='string'||!v.trim()||v.length>128||v.includes('\0')||/^sqlite_/i.test(v))return fail('identifier');return v;}
type Token={text:string;quoted:boolean};
/** Deliberately recognizes only the plugin's ordinary scalar table grammar.
 * Rejects DEFAULT/CHECK/GENERATED/expressions/comments/table constraints rather
 * than trying to prove arbitrary SQLite DDL safe via keyword substring matching.
 */
function plainDefinition(definition:string,table:DatabaseSchemaResult['tables'][number]):void{
 if(new TextEncoder().encode(definition).length>8192)fail('budget');
 const tokens:Token[]=[];let i=0;
 while(i<definition.length){
  if(/\s/.test(definition[i])){i++;continue;}
  const first=definition[i];let text='';
  if(['"','`','['].includes(first)){
   const close=first==='['?']':first;i++;let ended=false;
   while(i<definition.length){if(definition[i]===close){if(first!=='['&&definition[i+1]===close){text+=close;i+=2;continue;}i++;ended=true;break;}text+=definition[i++];}
   if(!ended)fail('definition');tokens.push({text,quoted:true});
  }else if(/[A-Za-z_]/.test(first)){while(i<definition.length&&/[A-Za-z_0-9]/.test(definition[i]))text+=definition[i++];tokens.push({text,quoted:false});}
  else if('(),;'.includes(first)){tokens.push({text:first,quoted:false});i++;}else fail('definition');
  if(tokens.length>512)fail('budget');
 }
 let p=0;const is=(word:string)=>tokens[p]?.quoted===false&&tokens[p].text.toUpperCase()===word;
 const expect=(word:string)=>{if(!is(word))fail('definition');p++;};
 const ident=()=>{const token=tokens[p++];if(!token||!token.quoted&&!/^[A-Za-z_][A-Za-z_0-9]*$/.test(token.text))return fail('definition');return name(token.text);};
 expect('CREATE');expect('TABLE');if(is('IF')){expect('IF');expect('NOT');expect('EXISTS');}
 if(fold(ident())!==fold(table.name))fail('definition');expect('(');
 let count=0;
 while(true){
  const columnName=ident(),type=tokens[p++];if(!type||type.quoted||!['INTEGER','REAL','TEXT','BLOB','NUMERIC'].includes(type.text.toUpperCase()))fail('definition');
  let notNull=false,primary=false,nullableSeen=false;
  while(!is(',')&&!is(')')){
   if(is('NOT')){if(nullableSeen)fail('definition');expect('NOT');expect('NULL');notNull=true;nullableSeen=true;}
   else if(is('NULL')){if(nullableSeen)fail('definition');expect('NULL');nullableSeen=true;}
   else if(is('PRIMARY')){if(primary)fail('definition');expect('PRIMARY');expect('KEY');primary=true;}
   else fail('definition');
  }
  const column=table.columns[count++];if(!column||column.name!==columnName||column.type.trim().toUpperCase()!==type.text.toUpperCase()||column.primaryKey!==primary||column.nullable!==(!notNull&&!primary))fail('definition');
  if(is(')')){p++;break;}expect(',');
 }
 if(is(';'))p++;if(p!==tokens.length||count!==table.columns.length)fail('definition');
}
/** Preview is NOT execution authorization or a proof of global dependency safety.
 * The adapter must independently inspect main/temp schema and hidden columns,
 * validate review/revision, and roll back if any other object's SQL changes.
 */
export function previewRenameColumnSql(input:unknown,schema:DatabaseSchemaResult):RenameColumnPreview{
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['table','from','to'].includes(k)))fail('draft');
 const d=input as Record<string,unknown>,tableName=name(d.table),from=name(d.from),to=name(d.to);
 if(!schema||!Array.isArray(schema.tables)||schema.tables.length>32)fail('schema');
 const tables=schema.tables.filter(t=>typeof t?.name==='string'&&fold(t.name)===fold(tableName));if(tables.length!==1||tables[0].kind!=='table')fail('table');const table=tables[0];
 if(!Array.isArray(table.columns)||!table.columns.length||table.columns.length>64||typeof table.definition!=='string')fail('schema');
 const names=new Set<string>();for(const column of table.columns){name(column.name);if(names.has(fold(column.name))||typeof column.type!=='string'||typeof column.primaryKey!=='boolean'||typeof column.nullable!=='boolean')fail('schema');names.add(fold(column.name));}
 const column=table.columns.find(c=>fold(c.name)===fold(from));if(!column)fail('column');if(fold(from)===fold(to))fail('unchanged');if(names.has(fold(to)))fail('exists');if(column.primaryKey)fail('dependency');
 if(!Array.isArray(table.indexes)||!Array.isArray(table.foreignKeys)||!Array.isArray(table.triggers))fail('schema');if(table.indexes.length||table.foreignKeys.length||table.triggers.length)fail('dependency');
 for(const other of schema.tables){
  if(!Array.isArray(other.foreignKeys))fail('schema');if(other.foreignKeys.length>64)fail('budget');
  for(const fk of other.foreignKeys){if(typeof fk?.targetTable!=='string')fail('schema');if(fold(fk.targetTable)===fold(table.name))fail('dependency');}
 }
 plainDefinition(table.definition,table);
 const draft={table:table.name,from:column.name,to},sql=`ALTER TABLE ${quote(table.name)} RENAME COLUMN ${quote(column.name)} TO ${quote(to)};`;
 if(new TextEncoder().encode(sql).length>8192)fail('budget');return {draft,sql,dependencyValidation:'adapter-required'};
}

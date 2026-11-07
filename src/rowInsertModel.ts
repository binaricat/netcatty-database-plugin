import type {DatabaseScalar,DatabaseSchemaResult} from './databaseTypes';
import {sqliteSchemaTokens,schemaTokenSequence} from './sqliteSchemaKeywords';
export type InsertCell={mode:'value';value:DatabaseScalar}|{mode:'null'|'default'|'auto'};
export type RowInsertDraft={table:string;values:Record<string,InsertCell>};
export type RowInsertPlan={draft:RowInsertDraft;sql:string;parameters:DatabaseScalar[];resolved:Record<string,DatabaseScalar>;automaticColumns:string[]};
export class RowInsertError extends Error{constructor(readonly code:'draft'|'table'|'columns'|'value'|'default'|'auto'|'budget'|'review'|'stale'|'constraint'){super(`Insert row ${code}`);}}
const fail=(code:RowInsertError['code']):never=>{throw new RowInsertError(code);};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
const quote=(v:string)=>'"'+v.replaceAll('"','""')+'"';
function scalar(v:unknown):DatabaseScalar{if(v===null||typeof v==='boolean')return v;if(typeof v==='string'&&v.length<=2048&&!v.includes('\0')&&!/^<BLOB\s+\d+\s+bytes>$/i.test(v))return v;if(typeof v==='number'&&Number.isFinite(v)&&(!Number.isInteger(v)||Number.isSafeInteger(v)))return v;return fail('value');}
/** Decode constants only; never evaluate SQLite default expressions. */
export function literalInsertDefault(sql:string|null):DatabaseScalar{
 if(sql===null)return null;const value=sql.trim();if(/^NULL$/i.test(value))return null;if(/^TRUE$/i.test(value))return 1;if(/^FALSE$/i.test(value))return 0;
 if(/^'(?:[^']|'')*'$/.test(value))return scalar(value.slice(1,-1).replaceAll("''","'"));
 if(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)){const n=Number(value);if(n===0&&/[1-9]/.test(value.split(/[eE]/)[0]))return fail('default');return scalar(n);}
 return fail('default');
}
export function previewRowInsert(input:unknown,schema:DatabaseSchemaResult):RowInsertPlan{
 if(!object(input)||Object.keys(input).some(k=>!['table','values'].includes(k))||typeof input.table!=='string'||!object(input.values))return fail('draft');
 const table=schema.tables.find(t=>t.name===input.table&&t.kind==='table');if(!table||typeof table.definition!=='string'||!Array.isArray(table.triggers)||table.triggers.length||!Array.isArray(table.indexes))return fail('table');
 let tokens:string[];try{tokens=sqliteSchemaTokens(table.definition);}catch{return fail('table');}
 if(tokens[0]!=='CREATE'||tokens[1]!=='TABLE'||tokens.includes('GENERATED')||tokens.includes('CHECK')||schemaTokenSequence(tokens,'ON','CONFLICT')||table.indexes.some(i=>i.partial||i.columns.some(c=>c.expression)))return fail('table');
 if(!table.columns.length||table.columns.length>16||Object.keys(input.values).length!==table.columns.length)return fail('columns');
 const parameters:DatabaseScalar[]=[],names:string[]=[],automaticColumns:string[]=[],resolved:Record<string,DatabaseScalar>=Object.create(null),values:Record<string,InsertCell>=Object.create(null);
 for(const col of table.columns){if(!Object.hasOwn(input.values,col.name)||typeof col.nullable!=='boolean'||!['INTEGER','REAL','TEXT','NUMERIC'].includes(col.type.trim().toUpperCase())||typeof col.rowidAlias!=='boolean'||!Object.hasOwn(col,'defaultSql')||col.defaultSql!==null&&typeof col.defaultSql!=='string')return fail('columns');
 const cell=input.values[col.name];if(!object(cell)||!['value','null','default','auto'].includes(String(cell.mode))||Object.keys(cell).some(k=>!['mode',...(cell.mode==='value'?['value']:[])].includes(k)))return fail('draft');
 if(cell.mode==='auto'){if(!col.rowidAlias||col.defaultSql!==null)return fail('auto');values[col.name]={mode:'auto'};automaticColumns.push(col.name);continue;}
 let value:DatabaseScalar;if(cell.mode==='default')value=literalInsertDefault(col.defaultSql!);else if(cell.mode==='null')value=null;else value=scalar(cell.value);
 if(value===null&&(!col.nullable||col.primaryKey))return fail('value');if(col.rowidAlias&&(typeof value!=='number'||!Number.isSafeInteger(value)))return fail('value');
 values[col.name]=cell.mode==='value'?{mode:'value',value}:{mode:cell.mode as 'default'|'null'};resolved[col.name]=value;names.push(col.name);parameters.push(value);
 }
 const sql=names.length?`INSERT INTO ${quote(table.name)} (${names.map(quote).join(', ')}) VALUES (${names.map(()=>'?').join(', ')});`:`INSERT INTO ${quote(table.name)} DEFAULT VALUES;`;
 if(new TextEncoder().encode(sql).length>8192)return fail('budget');return {draft:{table:table.name,values},sql,parameters,resolved,automaticColumns};
}

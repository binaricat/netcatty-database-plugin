import type {PluginByteConnection} from '@netcatty/plugin-sdk';
import {executePostgresFilteredRead} from './postgresFilteredRead';
export interface PostgresIndexPage {items:Array<{name:string;definition:string}>;truncated:boolean;limit:number;coverage:'complete-visible-set'|'unordered-subset-not-pagination';continuation:null}
export class PostgresIndexesError extends Error {constructor(readonly code:'input'|'shape'|'type'|'budget'){super(`PG indexes ${code}`);}}
const fail=(code:PostgresIndexesError['code']):never=>{throw new PostgresIndexesError(code);};
const name=(s:unknown):s is string=>typeof s==='string'&&s.length>0&&s.length<=128&&!s.includes('\0');
/** Exact fixed catalog view and bound names only. Definitions are display text,
 * never parsed as constraint/uniqueness authority or submitted for execution.
 */
export async function readPostgresIndexes(connection:PluginByteConnection,input:{schema:string;table:string;limit?:number;timeoutMs?:number;signal?:AbortSignal}):Promise<PostgresIndexPage>{
 const {schema,table,timeoutMs,signal}=input,limit=input.limit??32;
 if(!name(schema)||!name(table)||!Number.isInteger(limit)||limit<1||limit>98)fail('input');
 const result=await executePostgresFilteredRead(connection,{schema:'pg_catalog',table:'pg_indexes',columns:['indexname','indexdef'],filters:[{column:'schemaname',value:schema},{column:'tablename',value:table}],limit:limit+1,timeoutMs,signal});
 if(result.transactionStatus!=='I'||result.valueFormat!=='postgres-text'||result.columns.join(',')!=='indexname,indexdef'||result.typeOids.length!==2||result.rowCount!==result.rows.length||result.rows.length>limit+1)fail('shape');
 if(result.typeOids.some(oid=>![19,25,1043].includes(oid)))fail('type');
 const seen=new Set<string>();const items=result.rows.map(row=>{if(row.length!==2||!name(row[0])||typeof row[1]!=='string'||!row[1].length||row[1].includes('\0')||seen.has(row[0]))return fail('shape');if(row[1].length>2048||new TextEncoder().encode(row[1]).length>8192)fail('budget');seen.add(row[0]);return {name:row[0],definition:row[1]};});
 if(new TextEncoder().encode(JSON.stringify(items)).length>96*1024)fail('budget');
 return {items:items.slice(0,limit),limit,truncated:items.length>limit,coverage:items.length>limit?'unordered-subset-not-pagination':'complete-visible-set',continuation:null};
}

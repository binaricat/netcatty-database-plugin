import type {PluginByteConnection} from '@netcatty/plugin-sdk';
import {executePostgresFilteredRead,type PostgresFilteredReadOptions,type PostgresFilteredReadResult} from './postgresFilteredRead';
export class PostgresMetadataError extends Error {constructor(readonly code:'input'|'shape'|'type'|'budget'){super(`PG metadata ${code}`);}}
export interface PostgresMetadataOptions {limit?:number;timeoutMs?:number;signal?:AbortSignal}
export interface PostgresTableMetadata {name:string;kind:'BASE TABLE'|'VIEW'|'FOREIGN'|'LOCAL TEMPORARY'}
export interface PostgresColumnMetadata {name:string;ordinal:number;nullable:boolean;dataType:string;udtSchema:string;udtName:string}
export interface PostgresMetadataPage<T> {items:T[];truncated:boolean;limit:number;scope:'visible-information-schema';ordering:'unspecified'|'ordinal';coverage:'complete-visible-set'|'unordered-subset-not-pagination';continuation:null}
type Reader=(connection:PluginByteConnection,options:PostgresFilteredReadOptions)=>Promise<PostgresFilteredReadResult>;
const fail=(code:PostgresMetadataError['code']):never=>{throw new PostgresMetadataError(code);};
const name=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=128&&!v.includes('\0');
const tableColumns=['table_name','table_type'];
const columnColumns=['column_name','ordinal_position','is_nullable','data_type','udt_schema','udt_name'];
/** No arbitrary SQL, catalog defaults, PK inference, or pagination claims.
 * Information-schema domain OIDs must already resolve to supported base types in
 * RowDescription; unknown OIDs remain rejected by the underlying protocol module.
 * Separate calls are separate read-only transactions, not one catalog snapshot.
 */
export function createPostgresMetadataReader(connection:PluginByteConnection){return metadataReader(connection,executePostgresFilteredRead);}
/** @internal Test-only dependency seam, not a connection or protocol verification API. */
export function createPostgresMetadataTestReader(connection:PluginByteConnection,reader:Reader){return metadataReader(connection,reader);}
function metadataReader(connection:PluginByteConnection,reader:Reader){
 async function fetch(schema:string,table:string|undefined,options:PostgresMetadataOptions){
  const limit=options.limit??(table===undefined?32:64);
  if(!name(schema)||(table!==undefined&&!name(table))||!Number.isInteger(limit)||limit<1||limit>98)fail('input');
  const columns=table===undefined?tableColumns:columnColumns;
  const result=await reader(connection,{schema:'information_schema',table:table===undefined?'tables':'columns',columns:[...columns],filters:[{column:'table_schema',value:schema},...(table===undefined?[]:[{column:'table_name',value:table}])],limit:limit+1,timeoutMs:options.timeoutMs,signal:options.signal});
  if(result.transactionStatus!=='I'||result.valueFormat!=='postgres-text'||result.columns.length!==columns.length||result.columns.some((v,i)=>v!==columns[i])||result.rowCount!==result.rows.length||result.rows.length>limit+1||result.typeOids.length!==columns.length)fail('shape');
  if(result.typeOids.some((oid,i)=>table!==undefined&&i===1?oid!==23:![19,25,1043].includes(oid)))fail('type');
  if(new TextEncoder().encode(JSON.stringify(result)).length>96*1024)fail('budget');
  for(const row of result.rows)if(row.length!==columns.length||row.some(v=>typeof v!=='string'||v.length>2048||v.includes('\0')))fail('shape');
  return {result,limit};
 }
 function page<T>(items:T[],limit:number):PostgresMetadataPage<T>{return {items:items.slice(0,limit),truncated:items.length>limit,limit,scope:'visible-information-schema',ordering:'unspecified',coverage:items.length>limit?'unordered-subset-not-pagination':'complete-visible-set',continuation:null};}
 return {
  async listTables(schema:string,options:PostgresMetadataOptions={}):Promise<PostgresMetadataPage<PostgresTableMetadata>>{
   const {result,limit}=await fetch(schema,undefined,options);const seen=new Set<string>();
   const items=result.rows.map(row=>{const [table,kind]=row;if(!name(table)||seen.has(table)||!['BASE TABLE','VIEW','FOREIGN','LOCAL TEMPORARY'].includes(kind!))return fail('shape');seen.add(table);return {name:table,kind:kind as PostgresTableMetadata['kind']};});
   return page(items,limit);
  },
  async listColumns(schema:string,table:string,options:PostgresMetadataOptions={}):Promise<PostgresMetadataPage<PostgresColumnMetadata>>{
   const {result,limit}=await fetch(schema,table,options);const names=new Set<string>(),ordinals=new Set<number>();
   const items=result.rows.map(row=>{const [column,position,nullable,dataType,udtSchema,udtName]=row;
    if(!name(column)||!name(dataType)||!name(udtSchema)||!name(udtName)||!position||! /^[1-9][0-9]{0,4}$/.test(position)||Number(position)>1600||!['YES','NO'].includes(nullable!))return fail('shape');
    const ordinal=Number(position);if(names.has(column)||ordinals.has(ordinal))return fail('shape');names.add(column);ordinals.add(ordinal);
    return {name:column,ordinal,nullable:nullable==='YES',dataType,udtSchema,udtName};
   });const resultPage=page(items,limit);if(!resultPage.truncated){resultPage.items.sort((a,b)=>a.ordinal-b.ordinal);resultPage.ordering='ordinal';}return resultPage;
  }
 };
}

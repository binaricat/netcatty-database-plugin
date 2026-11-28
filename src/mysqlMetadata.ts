import type {PluginByteConnection} from '@netcatty/plugin-sdk';
import {executeMysqlPreparedRead,executeMysqlMetadataPreparedRead,type MysqlPreparedReadOptions} from './mysqlPreparedRead';
export class MysqlMetadataError extends Error{constructor(readonly code:'input'|'response'|'limit'|'read'){super(`MySQL metadata ${code}`);}}
const fail=(code:MysqlMetadataError['code']):never=>{throw new MysqlMetadataError(code);};
type Result=Awaited<ReturnType<typeof executeMysqlPreparedRead>>;
export type MysqlMetadataExecutor=(connection:PluginByteConnection,options:MysqlPreparedReadOptions)=>Promise<Result>;
export interface MysqlMetadataOptions{schema:string;table?:string;limit?:number;timeoutMs?:number;signal?:AbortSignal;}
const projections={tables:['TABLE_NAME','TABLE_TYPE','ENGINE'],columns:['COLUMN_NAME','ORDINAL_POSITION','DATA_TYPE','COLUMN_TYPE','IS_NULLABLE','COLUMN_DEFAULT','EXTRA'],indexes:['INDEX_NAME','NON_UNIQUE','SEQ_IN_INDEX','COLUMN_NAME','COLLATION','INDEX_TYPE','EXPRESSION']} as const;
function name(v:unknown):string{if(typeof v!=='string'||!v||v.length>64||v.includes('\0'))fail('input');return v as string;}
function text(v:string|null,max=2048):string{if(typeof v!=='string'||v.length>max||v.includes('\0'))fail('response');return v as string;}
function positive(v:string|null){const s=text(v,10);if(!/^[1-9]\d*$/.test(s))fail('response');const n=Number(s);if(!Number.isSafeInteger(n)||n>65535)fail('response');return n;}
/** Fixed information_schema reads only. No fallback to SHOW, arbitrary SQL, DDL,
 * hidden extra queries or credential storage. Executor injection is for offline
 * tests; production defaults to the bounded prepared protocol implementation.
 * Caller must provide its exclusive authenticated verified-TLS connection. */
export function createMysqlMetadataClient(connection:PluginByteConnection,execute:MysqlMetadataExecutor=executeMysqlMetadataPreparedRead){
 async function read(kind:keyof typeof projections,options:MysqlMetadataOptions){
  const schema=name(options.schema),table=kind==='tables'?undefined:name(options.table),limit=options.limit??100;
  if(!Number.isInteger(limit)||limit<1||limit>100||kind==='tables'&&options.table!==undefined)fail('input');
  const columns=[...projections[kind]],where:MysqlPreparedReadOptions['where']=[{column:'TABLE_SCHEMA',value:{kind:'text',value:schema}}];
  if(table!==undefined)where.push({column:'TABLE_NAME',value:{kind:'text',value:table}});
  let result:Result;try{result=await execute(connection,{schema:'information_schema',table:kind==='tables'?'TABLES':kind==='columns'?'COLUMNS':'STATISTICS',columns,where,limit,timeoutMs:options.timeoutMs,signal:options.signal});}catch{return fail('read');}
  if(!result||JSON.stringify(result.columns)!==JSON.stringify(columns)||!Array.isArray(result.rows)||result.rows.length>limit||result.rowCount!==result.rows.length||result.limit!==limit||result.scope!=='limited-prepared-select'||result.rows.some(row=>!Array.isArray(row)||row.length!==columns.length||row.some(v=>v!==null&&typeof v!=='string')))fail('response');
  if(new TextEncoder().encode(JSON.stringify(result)).length>96*1024)fail('limit');
  return {result,schema,table,limit,possiblyTruncated:result.rows.length===limit,scope:'returned-metadata-only' as const};
 }
 return {
  async tables(options:MysqlMetadataOptions){const {result,...meta}=await read('tables',options);const seen=new Set<string>();const tables=result.rows.map(([raw,type,engine])=>{
   const tableName=text(raw,64),tableType=text(type,32);if(!tableName||seen.has(tableName)||!['BASE TABLE','VIEW','SYSTEM VIEW'].includes(tableType))fail('response');seen.add(tableName);
   return {name:tableName,kind:tableType==='BASE TABLE'?'table' as const:'view' as const,engine:engine===null?null:text(engine,64)};
  });return {...meta,tables};},
  async columns(options:MysqlMetadataOptions){const {result,...meta}=await read('columns',options);const names=new Set<string>(),positions=new Set<number>();const columns=result.rows.map(([raw,ordinal,dataType,columnType,nullable,defaultValue,extra])=>{
   const columnName=text(raw,64),position=positive(ordinal);if(!columnName||names.has(columnName)||positions.has(position)||!['YES','NO'].includes(nullable??''))fail('response');names.add(columnName);positions.add(position);
   return {name:columnName,position,dataType:text(dataType,64),columnType:text(columnType),nullable:nullable==='YES',defaultValue:defaultValue===null?null:text(defaultValue),extra:text(extra)};
  }).sort((a,b)=>a.position-b.position);return {...meta,columns};},
  /** Flat index parts, not grouped indexes: a bounded page may cut a composite
   * index. Never infer full definitions, uniqueness constraints or absence. */
  async indexes(options:MysqlMetadataOptions){const {result,...meta}=await read('indexes',options);const seen=new Set<string>();const parts=result.rows.map(([raw,nonUnique,sequence,columnName,collation,indexType,expression])=>{
   const indexName=text(raw,64),position=positive(sequence),key=JSON.stringify([indexName,position]);
   if(!indexName||seen.has(key)||!['0','1'].includes(nonUnique??'')||!(collation===null||collation==='A'||collation==='D')||(columnName===null)===(expression===null))fail('response');seen.add(key);
   return {name:indexName,unique:nonUnique==='0',position,column:columnName===null?null:text(columnName,64),expression:expression===null?null:text(expression),direction:collation==='A'?'ASC' as const:collation==='D'?'DESC' as const:null,indexType:text(indexType,32)};
  }).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:a.position-b.position);return {...meta,parts};},
 };
}

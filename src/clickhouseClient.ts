import type { PluginNetworkClient } from '@netcatty/plugin-sdk';
import type { SecretLeaseRef } from '@netcatty/plugin-contract';
export interface ClickHouseResult { columns:string[]; types:string[]; rows:(string|number|boolean|null)[][]; scope:'bounded-returned-rows'; }
export class ClickHouseClientError extends Error {constructor(readonly code:'endpoint'|'lease'|'transport'|'response'|'limit'|'table-engine'){super(`ClickHouse ${code}`);}}
const fail=(code:ClickHouseClientError['code']):never=>{throw new ClickHouseClientError(code);};
const name=(value:string)=>{if(typeof value!=='string'||!value||value.length>256||/[\0\r\n]/.test(value))fail('endpoint');return value;};
function endpoint(value:string):string{
 if(typeof value!=='string'||!value||value.length>512||/[\x00-\x20\x7f]/.test(value))fail('endpoint');
 let url:URL;try{url=new URL(value);}catch{return fail('endpoint');}
 if(url.hostname.endsWith('.')||url.hostname==='localhost'||url.hostname.endsWith('.localhost')||url.hostname.endsWith('.local')||url.hostname.startsWith('[')||/^[0-9.]+$/.test(url.hostname)||!url.hostname.includes('.'))fail('endpoint');
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||value.includes('*'))fail('endpoint');
 return url.origin+'/';
}
/** Fixed read routes only. No arbitrary SQL, table functions, OUTFILE, scripts,
 * raw passwords, automatic retries or settings downgrade. Host HTTP permission
 * is origin-scoped; require a trusted no-redirect server (see requestURL check).
 * FQDN-only: all IP literals, localhost and .local are rejected conservatively.
 * DNS/control-peer enforcement is not equivalent to byteStreamBroker. Never use
 * this adapter to bypass rejected loopback/control endpoints. Trusted fixture
 * tables must have no external default/alias/UDF behavior; engine checks cannot
 * sandbox server-side definitions or concurrent schema changes.
 */
export class ClickHouseReadClient {
 private readonly base:string;
 constructor(private readonly network:PluginNetworkClient, options:{endpoint:string;declaredEndpoints:readonly string[];lease:(operationId:string)=>Promise<{lease:SecretLeaseRef;username:string}>},private readonly now=Date.now){
  if(!options||typeof options!=='object'||!Array.isArray(options.declaredEndpoints)||!options.declaredEndpoints.length||options.declaredEndpoints.length>64||typeof options.lease!=='function')fail('endpoint');
  this.base=endpoint(options.endpoint);if(!options.declaredEndpoints.map(endpoint).includes(this.base))fail('endpoint');this.credentials=options.lease;
 }
 private readonly credentials:(operationId:string)=>Promise<{lease:SecretLeaseRef;username:string}>;
 private async query(sql:string,params:Record<string,string>):Promise<ClickHouseResult>{
  const url=new URL(this.base);for(const [key,value] of Object.entries({default_format:'JSONCompact',readonly:'1',max_result_rows:'100',max_result_bytes:'98304',result_overflow_mode:'throw',max_execution_time:'3',output_format_json_quote_decimals:'1',output_format_json_quote_64bit_integers:'1',...params}))url.searchParams.set(key,value);
  const operationId=`network:${url.origin}`;
  let auth:Awaited<ReturnType<typeof this.credentials>>;
  try {auth=await this.credentials(operationId);} catch {return fail('lease');}
  if(!auth||typeof auth!=='object'||!auth.lease||typeof auth.lease!=='object'||auth.lease.kind!=='secret-lease'||auth.lease.operationId!==operationId||!Number.isSafeInteger(auth.lease.expiresAt)||auth.lease.expiresAt<=this.now()||typeof auth.lease.id!=='string'||auth.lease.id.length<32||auth.lease.id.length>256||typeof auth.username!=='string'||!auth.username||auth.username.length>128||/[\x00-\x1f\x7f:]/.test(auth.username))fail('lease');
  let response:Awaited<ReturnType<PluginNetworkClient['request']>>;
  try{response=await this.network.request({url:url.href,method:'POST',body:{encoding:'utf8',data:sql},headers:{'content-type':'text/plain; charset=utf-8'},timeoutMs:5000,credentialLease:auth.lease,authorization:{scheme:'Basic',username:auth.username}});}catch{return fail('transport');}
  // Exact URL comparison intentionally rejects even harmless query reordering.
  // This rejects redirected results, not redirects already followed by the host.
  if(!response||typeof response!=='object'||response.url!==url.href||response.status!==200||!response.body||response.body.encoding!=='base64'||typeof response.body.data!=='string')fail('response');
  if(!response.headers||typeof response.headers!=='object'||Array.isArray(response.headers)||Object.keys(response.headers).some(key=>key.toLowerCase()==='x-clickhouse-exception-code'))fail('response');
  if(response.body.data.length>131072)fail('limit');
  if(response.body.data.length%4!==0||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(response.body.data))fail('response');
  let parsed:unknown;
  try{const binary=atob(response.body.data);if(btoa(binary)!==response.body.data)fail('response');if(binary.length>98304)fail('limit');parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(binary,c=>c.charCodeAt(0))));}catch(e){if(e instanceof ClickHouseClientError)throw e;return fail('response');}
  const body=parsed as {meta?:{name:unknown;type:unknown}[];data?:unknown[][];rows?:unknown};
  if(!body||Object.hasOwn(body,'exception')||Object.hasOwn(body,'exception_code')||!Array.isArray(body.meta)||body.meta.length>64||!body.meta.every(c=>c&&typeof c.name==='string'&&c.name.length<=256&&!c.name.includes('\0')&&typeof c.type==='string'&&c.type.length>0&&c.type.length<=1024&&!c.type.includes('\0'))||!Array.isArray(body.data)||body.data.length>100||body.rows!==body.data.length)fail('response');
  const meta=body.meta!;const data=body.data!;
  if(data.some(row=>!Array.isArray(row)||row.length!==meta.length||row.some(v=>!(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)&&(!Number.isInteger(v)||Number.isSafeInteger(v))))))fail('response');
  // Never accept Decimal JSON numbers after JSON.parse has already rounded them.
  // Quoted-decimal settings are requested, but server/version/profile support is
  // not yet live-qualified; refusal is final, with no precision-losing fallback.
  if(data.some(row=>row.some((value,index)=>/\bDecimal(?:32|64|128|256)?\s*\(/i.test(meta[index].type as string)&&!(value===null||typeof value==='string'&&/^[+-]?[0-9]+(?:\.[0-9]+)?$/.test(value)))))fail('response');
  return {columns:meta.map(c=>c.name as string),types:meta.map(c=>c.type as string),rows:data as ClickHouseResult['rows'],scope:'bounded-returned-rows'};
 }
 listTables(database:string){return this.query('SELECT name, engine FROM system.tables WHERE database = {db:String} ORDER BY name LIMIT 100',{param_db:name(database)});}
 columns(database:string,table:string){return this.query('SELECT name, type FROM system.columns WHERE database = {db:String} AND table = {table:String} ORDER BY position LIMIT 64',{param_db:name(database),param_table:name(table)});}
 async readTable(database:string,table:string,limit=100):Promise<ClickHouseResult>{
  if(!Number.isInteger(limit)||limit<1||limit>100)fail('limit');name(database);name(table);
  const engine=await this.query('SELECT engine FROM system.tables WHERE database = {db:String} AND name = {table:String} LIMIT 1',{param_db:database,param_table:table});
  if(engine.rows.length!==1||engine.columns[0]!=='engine'||!['Memory','Log','TinyLog','StripeLog','MergeTree','ReplacingMergeTree','SummingMergeTree','AggregatingMergeTree','CollapsingMergeTree','VersionedCollapsingMergeTree'].includes(String(engine.rows[0][0])))fail('table-engine');
  return this.query('SELECT * FROM {db:Identifier}.{table:Identifier} LIMIT {limit:UInt16}',{param_db:database,param_table:table,param_limit:String(limit)});
 }
}

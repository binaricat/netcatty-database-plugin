import type {PluginByteConnection} from '@netcatty/plugin-sdk';
import {PostgresDecoder,pgParse,pgBind,pgDescribe,pgExecute,pgSync,pgTextValue} from './postgresProtocol';
export interface PostgresFilteredReadOptions {schema:string;table:string;columns:string[];filters:Array<{column:string;value:string|null}>;limit?:number;timeoutMs?:number;signal?:AbortSignal}
export interface PostgresFilteredReadResult {columns:string[];typeOids:number[];rows:Array<Array<string|null>>;rowCount:number;limit:number;transactionStatus:'I';valueFormat:'postgres-text'}
export class PostgresFilteredReadError extends Error {constructor(readonly code:'input'|'busy'|'closed'|'protocol'|'sequence'|'limit'|'server'|'transport'|'timeout'|'aborted'){super(`PG filtered read ${code}`);}}
function fail(code:PostgresFilteredReadError['code']):never{throw new PostgresFilteredReadError(code);}
const active=new WeakSet<PluginByteConnection>(),failed=new WeakSet<PluginByteConnection>();
const supported=new Set([16,20,21,23,1700,700,701,18,19,25,1042,1043,1082,1083,1114,1184,1186,1266,2950,114,3802]);
const validName=(v:unknown):v is string=>typeof v==='string'&&!!v&&v.length<=128&&!v.includes('\0');
const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
function simple(sql:string){const text=new TextEncoder().encode(sql+'\0'),wire=new Uint8Array(text.length+5);wire[0]=81;new DataView(wire.buffer).setInt32(1,text.length+4);wire.set(text,5);text.fill(0);return wire;}
/** Exclusively owned, already authenticated verified-TLS connection at idle only.
 * Values are returned as PostgreSQL text, not lossy numeric conversions. SQL is
 * generated, values are Bind parameters, and no arbitrary SQL is accepted.
 * BEGIN READ ONLY prevents local DB writes, not external side effects of untrusted
 * extensions/views. Trusted schemas and a least-privilege DB account are required.
 * All failures close the connection; successful rollback is required for success.
 */
export async function executePostgresFilteredRead(connection:PluginByteConnection,input:PostgresFilteredReadOptions):Promise<PostgresFilteredReadResult>{
 if(failed.has(connection))fail('closed');if(active.has(connection))fail('busy');
 const limit=input.limit??99,ms=input.timeoutMs??5000;
 if(!validName(input.schema)||!validName(input.table)||!Array.isArray(input.columns)||input.columns.length<1||input.columns.length>16||input.columns.some(c=>!validName(c))||new Set(input.columns).size!==input.columns.length||!Array.isArray(input.filters)||!input.filters.length||input.filters.length>8||!Number.isInteger(limit)||limit<1||limit>99||!Number.isInteger(ms)||ms<1||ms>10000)fail('input');
 const columns=[...input.columns],filters=input.filters.map(filter=>{if(!filter||Object.keys(filter).some(k=>!['column','value'].includes(k))||!validName(filter.column)||(filter.value!==null&&(typeof filter.value!=='string'||filter.value.length>2048||filter.value.includes('\0'))))fail('input');return {column:filter.column,value:filter.value};});
 const sql=`SELECT ${columns.map(quote).join(', ')} FROM ${quote(input.schema)}.${quote(input.table)} WHERE ${filters.map((f,i)=>`${quote(f.column)} IS NOT DISTINCT FROM $${i+1}`).join(' AND ')} LIMIT ${limit}`;
 if(new TextEncoder().encode(sql).length>8192||new TextEncoder().encode(JSON.stringify(filters)).length>8192)fail('limit');
 const signal=input.signal;active.add(connection);let stopped=false,buffer=new Uint8Array(0),current:Uint8Array|undefined,wire:Uint8Array|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const rows:Array<Array<string|null>>=[];let types:number[]=[];const deadline=performance.now()+ms;let rejectStop!:(e:PostgresFilteredReadError)=>void;const stop=new Promise<never>((_,reject)=>rejectStop=reject);
 const close=()=>{failed.add(connection);buffer.fill(0);buffer=new Uint8Array(0);current?.fill(0);wire?.fill(0);rows.length=0;for(const f of filters)f.value=null;try{connection.readable.cancel();}catch{}try{connection.writable.cancel();}catch{}void Promise.resolve().then(()=>connection.close()).catch(()=>{});};
 const halt=(code:'timeout'|'aborted')=>{if(stopped)return;stopped=true;close();rejectStop(new PostgresFilteredReadError(code));};const abort=()=>halt('aborted');
 const check=()=>{if(stopped)fail('aborted');if(performance.now()>=deadline)fail('timeout');};
 const write=async(bytes:Uint8Array)=>{wire=bytes;try{check();if(bytes.length>16384)fail('limit');await connection.writable.write(bytes);check();}finally{bytes.fill(0);if(wire===bytes)wire=undefined;}};
 let bytes=0,frames=0,reads=0;const decoder=new PostgresDecoder();
 const readFrame=async()=>{
  while(true){check();if(buffer.length>=5){const n=new DataView(buffer.buffer,buffer.byteOffset+1,4).getInt32(0);if(n<4)fail('protocol');if(n>32768)fail('limit');if(buffer.length>=n+1){if(++frames>128)fail('limit');const frame=buffer.slice(0,n+1),rest=buffer.slice(n+1);buffer.fill(0);buffer=rest;return frame;}}
   if(++reads>4096)fail('limit');const chunk=await connection.readable.read();try{check();if(!(chunk instanceof Uint8Array)||!chunk.length)fail('protocol');bytes+=chunk.length;if(bytes>96*1024)fail('limit');const next=new Uint8Array(buffer.length+chunk.length);next.set(buffer);next.set(chunk,buffer.length);buffer.fill(0);buffer=next;}finally{if(chunk instanceof Uint8Array)chunk.fill(0);}
  }
 };
 const receive=async(stage:'begin'|'query'|'rollback')=>{
  let step=0,description=false,complete=false;
  while(true){current=await readFrame();try{
   check();const tag=String.fromCharCode(current[0]);if(tag==='E')fail('server');
   if(tag==='C'){
    const payload=current.subarray(5);if(payload.length<2||payload[payload.length-1]!==0||payload.subarray(0,-1).includes(0))fail('protocol');let command:string;try{command=pgTextValue(payload.subarray(0,-1));}catch{return fail('protocol');}
    if(stage==='begin'){if(command!==(step===0?'BEGIN':step===1?'SET':null))fail('sequence');step++;}
    else if(stage==='rollback'){if(command!=='ROLLBACK'||step!==0)fail('sequence');step++;}
    else{if(step!==2||!description||complete||command!==`SELECT ${rows.length}`)fail('sequence');complete=true;}
    continue;
   }
   let message;try{const messages=decoder.feed(current);if(messages.length!==1)fail('protocol');message=messages[0];}catch{return fail('protocol');}
   try{
    if(message.type==='ready'){
     if(buffer.length||message.status!==(stage==='rollback'?'I':'T')||(stage==='begin'?step!==2:stage==='rollback'?step!==1:!complete))fail('sequence');decoder.finish();return;
    }
    if(stage!=='query')fail('sequence');
    if(message.type==='complete'){if((step===0&&message.kind==='parse')||(step===1&&message.kind==='bind'))step++;else fail('sequence');}
    else if(message.type==='columns'){
     if(step!==2||description||complete||message.columns.length!==columns.length)fail('sequence');
     if(message.columns.some((c,i)=>c.name!==columns[i]||c.format!==0||!supported.has(c.typeOid)))fail('protocol');types=message.columns.map(c=>c.typeOid);description=true;
    }else if(message.type==='row'){
     if(step!==2||!description||complete||message.values.length!==columns.length)fail('sequence');if(rows.length>=limit)fail('limit');
     rows.push(message.values.map(cell=>{if(cell===null)return null;if(cell.length>8192)fail('limit');let text:string;try{text=pgTextValue(cell);}catch{return fail('protocol');}if(text.length>2048)fail('limit');return text;}));
    }else fail('sequence');
   }finally{if(message.type==='row')for(const cell of message.values)cell?.fill(0);else if(message.type==='authentication')message.data.fill(0);}
  }finally{current?.fill(0);current=undefined;}}
 };
 try{
  timer=setTimeout(()=>halt('timeout'),ms);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const run=async()=>{
   await write(simple(`BEGIN READ ONLY; SET LOCAL statement_timeout = '${ms}ms';`));await receive('begin');
   // SQL LIMIT<=99 and Execute100 ensure a bounded page completes rather than
   // reaching Execute's portal-suspension threshold. Never silently truncate.
   await write(pgParse(sql));await write(pgBind(filters.map(f=>f.value)));for(const f of filters)f.value=null;
   await write(pgDescribe());await write(pgExecute("",100));await write(pgSync());await receive('query');
   await write(simple('ROLLBACK;'));await receive('rollback');check();
   const result:PostgresFilteredReadResult={columns,typeOids:types,rows,rowCount:rows.length,limit,transactionStatus:'I',valueFormat:'postgres-text'};
   if(new TextEncoder().encode(JSON.stringify(result)).length>96*1024)fail('limit');return result;
  };
  return await Promise.race([run(),stop]);
 }catch(error){if(!stopped){stopped=true;close();}throw error instanceof PostgresFilteredReadError?error:new PostgresFilteredReadError('transport');}
 finally{if(timer)clearTimeout(timer);signal?.removeEventListener('abort',abort);wire?.fill(0);buffer.fill(0);current?.fill(0);for(const f of filters)f.value=null;active.delete(connection);}
}

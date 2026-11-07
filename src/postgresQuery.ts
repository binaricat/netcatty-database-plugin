import type {PluginByteConnection} from '@netcatty/plugin-sdk';
import type {DatabaseScalar} from './databaseTypes';
import {PostgresDecoder,pgTextValue} from './postgresProtocol';
export interface PostgresReadOptions {schema:string;table:string;columns:string[];limit?:number;timeoutMs?:number;signal?:AbortSignal}
export interface PostgresReadResult {columns:string[];rows:DatabaseScalar[][];rowCount:number;limit:number;scope:'limited-select';transactionStatus:'I'}
export class PostgresReadError extends Error {constructor(readonly code:'input'|'busy'|'closed'|'protocol'|'sequence'|'limit'|'value'|'server'|'transport'|'timeout'|'aborted'){super(`PG read ${code}`);}}
const supportedOids=new Set([16,20,21,23,1700,700,701,18,19,25,1042,1043,1082,1083,1114,1184,1186,1266,2950,114,3802]);
const active=new WeakSet<PluginByteConnection>(),failed=new WeakSet<PluginByteConnection>();
const fail=(code:PostgresReadError['code']):never=>{throw new PostgresReadError(code);};
const name=(value:unknown):value is string=>typeof value==='string'&&!!value&&value.length<=128&&!value.includes('\0');
const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
function value(bytes:Uint8Array|null,oid:number):DatabaseScalar {
 if(bytes===null)return null;
 if(bytes.length>8192)fail('limit');let text:string;try{text=pgTextValue(bytes);}catch{return fail('value');}
 if(text.length>2048)fail('limit');
 if(oid===16){if(text==='t')return true;if(text==='f')return false;return fail('value');}
 if([20,21,23].includes(oid)){
  if(!/^-?(?:0|[1-9]\d*)$/.test(text))fail('value');
  const integer=BigInt(text),min=oid===20?-(1n<<63n):oid===21?-32768n:-2147483648n,max=oid===20?(1n<<63n)-1n:oid===21?32767n:2147483647n;
  if(integer<min||integer>max)fail('value');return oid===20?text:Number(integer);
 }
 if(oid===1700){if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text))fail('value');return text;}
 if([700,701].includes(oid)){if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text))fail('value');const number=Number(text);if(!Number.isFinite(number)||(Number.isInteger(number)&&!Number.isSafeInteger(number))||(number===0&&/[1-9]/.test(text.split(/[eE]/)[0])))fail('value');return number;}
 // Known text-like OIDs only. bytea/arrays/extension types need explicit codecs.
 if([18,19,25,1042,1043,1082,1083,1114,1184,1186,1266,2950,114,3802].includes(oid))return text;
 return fail('value');
}
/** On an exclusively owned, authenticated, host-verified TLS connection at idle
 * ReadyForQuery only. No connection establishment or arbitrary SQL. Read-only
 * transactions prevent database writes, not side effects of untrusted server
 * extensions/views; use trusted schemas and a least-privilege read-only account.
 * Owns the stream until completion; all failures close it. No silent truncation.
 */
export async function executePostgresRead(connection:PluginByteConnection,options:PostgresReadOptions):Promise<PostgresReadResult>{
 if(failed.has(connection))fail('closed');if(active.has(connection))fail('busy');
 const limit=options.limit??100,ms=options.timeoutMs??5000;
 if(!name(options.schema)||!name(options.table)||!Array.isArray(options.columns)||!options.columns.length||options.columns.length>16||options.columns.some(c=>!name(c))||new Set(options.columns).size!==options.columns.length||!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(ms)||ms<1||ms>10000)fail('input');
 const columns=[...options.columns];
 const sql=`BEGIN READ ONLY; SET LOCAL statement_timeout = '${ms}ms'; SELECT ${columns.map(quote).join(', ')} FROM ${quote(options.schema)}.${quote(options.table)} LIMIT ${limit}; ROLLBACK;`;
 const body=new TextEncoder().encode(sql+'\0');if(body.length>8192)fail('limit');
 const wire=new Uint8Array(body.length+5);wire[0]=81;new DataView(wire.buffer).setInt32(1,body.length+4);wire.set(body,5);body.fill(0);
 active.add(connection);let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,buffer=new Uint8Array(0),current:Uint8Array|undefined;
 const rows:DatabaseScalar[][]=[];
 const deadline=performance.now()+ms;let rejectStop!:(error:PostgresReadError)=>void;
 const stop=new Promise<never>((_,reject)=>rejectStop=reject);
 const close=()=>{rows.length=0;failed.add(connection);wire.fill(0);buffer.fill(0);buffer=new Uint8Array(0);current?.fill(0);try{connection.readable.cancel();}catch{}try{connection.writable.cancel();}catch{}void Promise.resolve().then(()=>connection.close()).catch(()=>{});};
 const halt=(code:'aborted'|'timeout')=>{if(stopped)return;stopped=true;close();rejectStop(new PostgresReadError(code));};
 const abort=()=>halt('aborted');
 const check=()=>{if(stopped)fail('aborted');if(performance.now()>=deadline)fail('timeout');};
 try{
  timer=setTimeout(()=>halt('timeout'),ms);options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  const run=async():Promise<PostgresReadResult>=>{
   check();try{await connection.writable.write(wire);}finally{wire.fill(0);}check();
   let phase=0,description=false,bytes=0,frames=0,reads=0;let oids:number[]=[];const decoder=new PostgresDecoder();
   while(true){
    check();if(++reads>4096)fail('limit');const chunk=await connection.readable.read();
    try{
     check();if(!(chunk instanceof Uint8Array)||!chunk.length)fail('protocol');bytes+=chunk!.length;if(bytes>96*1024)fail('limit');
     const next=new Uint8Array(buffer.length+chunk!.length);next.set(buffer);next.set(chunk!,buffer.length);buffer.fill(0);buffer=next;
    }finally{if(chunk instanceof Uint8Array)chunk.fill(0);}
    while(buffer.length>=5){
     check();const n=new DataView(buffer.buffer,buffer.byteOffset+1,4).getInt32(0);if(n<4)fail('protocol');if(n>32768)fail('limit');if(buffer.length<n+1)break;
     if(++frames>128)fail('limit');current=buffer.slice(0,n+1);const rest=buffer.slice(n+1);buffer.fill(0);buffer=rest;
     try{
      const tag=String.fromCharCode(current[0]);
      if(tag==='E')fail('server');
      if(tag==='C'){
       const payload=current.subarray(5);if(payload.length<2||payload[payload.length-1]!==0||payload.subarray(0,-1).includes(0))fail('protocol');
       let command:string;try{command=pgTextValue(payload.subarray(0,-1));}catch{return fail('protocol');}
       const expected=phase===0?'BEGIN':phase===1?'SET':phase===2?`SELECT ${rows.length}`:phase===3?'ROLLBACK':null;
       if(command!==expected||phase===2&&!description)fail('sequence');phase++;continue;
      }
      let message;try{const messages=decoder.feed(current);if(messages.length!==1)fail('protocol');message=messages[0];}catch{return fail('protocol');}
      if(message.type==='columns'){
       if(phase!==2||description||message.columns.length!==columns.length)fail('sequence');
       if(message.columns.some((column,index)=>column.name!==columns[index]||column.format!==0||!supportedOids.has(column.typeOid)))fail('protocol');
       oids=message.columns.map(column=>column.typeOid);description=true;
      }else if(message.type==='row'){
       try{
        if(phase!==2||!description||message.values.length!==columns.length)fail('sequence');if(rows.length>=limit)fail('limit');
        rows.push(message.values.map((cell,index)=>value(cell,oids[index])));
       }finally{for(const cell of message.values)cell?.fill(0);}
      }else if(message.type==='ready'){
       if(phase!==4||message.status!=='I'||buffer.length)fail('sequence');decoder.finish();check();
       const result:PostgresReadResult={columns,rows,rowCount:rows.length,limit,scope:'limited-select',transactionStatus:'I'};
       if(new TextEncoder().encode(JSON.stringify(result)).length>96*1024)fail('limit');return result;
      }else fail('sequence');
     }finally{current?.fill(0);current=undefined;}
    }
   }
  };
  return await Promise.race([run(),stop]);
 }catch(error){if(!stopped){stopped=true;close();}throw error instanceof PostgresReadError?error:new PostgresReadError('transport');}
 finally{if(timer)clearTimeout(timer);options.signal?.removeEventListener('abort',abort);wire.fill(0);buffer.fill(0);current?.fill(0);active.delete(connection);}
}

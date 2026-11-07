import type {PluginByteConnection} from '@netcatty/plugin-sdk';
import {encodeMysqlPacket,MysqlPacketDecoder,type MysqlPacket} from './mysqlProtocol';
export interface MysqlReadDiagnostic {phase:'begin'|'select'|'rollback'|'status';status?:number;packetTag?:number;sequence?:number;}
export class MysqlReadError extends Error{constructor(readonly code:'input'|'busy'|'closed'|'protocol'|'sequence'|'limit'|'value'|'server'|'transport'|'timeout'|'aborted',readonly diagnostic?:MysqlReadDiagnostic){super(`MySQL read ${code}`);}}
export interface MysqlReadOptions{schema:string;table:string;columns:string[];limit?:number;timeoutMs?:number;signal?:AbortSignal;}
export interface MysqlReadResult{columns:string[];rows:(string|null)[][];rowCount:number;limit:number;scope:'limited-select';}
const active=new WeakSet<PluginByteConnection>(),failed=new WeakSet<PluginByteConnection>();
const fail=(code:MysqlReadError['code']):never=>{throw new MysqlReadError(code);};
const utf8=new TextDecoder('utf-8',{fatal:true}),encoder=new TextEncoder();
function text(b:Uint8Array){try{return utf8.decode(b);}catch{return fail('value');}}
class Reader{
 pos=0;constructor(readonly data:Uint8Array){}
 take(n:number){if(!Number.isSafeInteger(n)||n<0||this.pos+n>this.data.length)fail('protocol');const b=this.data.subarray(this.pos,this.pos+n);this.pos+=n;return b;}
 number(n:number){const b=this.take(n);let v=0;for(let i=n-1;i>=0;i--)v=v*256+b[i];if(!Number.isSafeInteger(v))fail('limit');return v;}
 length():number|null{const tag=this.number(1);if(tag<251)return tag;if(tag===251)return null;if(tag===255)fail('protocol');const n=tag===252?2:tag===253?3:8;const value=this.number(n);if(value<(n===2?251:n===3?65536:16777216))fail('protocol');return value;}
 bytes(){const n=this.length();if(n===null)fail('protocol');if(n!>8192)fail('limit');return this.take(n!);}
 end(){if(this.pos!==this.data.length)fail('protocol');}
}
const numericTypes=new Set([0,1,2,3,4,5,8,9,13,246]);
const stringTypes=new Set([15,249,250,251,252,253,254]);
const quote=(s:string)=>'`'+s.replaceAll('`','``')+'`';
const identifier=(s:unknown):s is string=>typeof s==='string'&&!!s&&s.length<=128&&!s.includes('\0');
// MySQL 8.4 mysql_com.h:16/32 are query-plan hints, never transaction flags.
function status(value:number,inTransaction:boolean,selectEof=false){const state=selectEof?value&~(16|32):value;if(inTransaction?![3,8195].includes(state):state!==2)throw new MysqlReadError('sequence',{phase:'status',status:value});}
function ok(p:Uint8Array,inTransaction:boolean){const r=new Reader(p);if(r.number(1)!==0||r.length()!==0||r.length()!==0)fail('protocol');status(r.number(2),inTransaction);if(r.number(2)!==0)fail('protocol');r.end();}
function eof(p:Uint8Array){if(p.length!==5||p[0]!==254)fail('protocol');const r=new Reader(p);r.number(1);if(r.number(2)!==0)fail('protocol');status(r.number(2),true,true);}
function column(p:Uint8Array,schema:string,table:string,name:string){
 const r=new Reader(p);const catalog=text(r.bytes()),db=text(r.bytes()),tbl=text(r.bytes()),originalTable=text(r.bytes()),label=text(r.bytes()),originalName=text(r.bytes());
 if(catalog!=='def'||db!==schema||tbl!==table||originalTable!==table||label!==name||originalName!==name||r.length()!==12)fail('protocol');
 const charset=r.number(2);r.number(4);const type=r.number(1),flags=r.number(2);r.number(1);if(r.number(2)!==0)fail('protocol');r.end();
 if(!numericTypes.has(type)&&!stringTypes.has(type))fail('value');
 if(numericTypes.has(type)&&charset!==63)fail('value');
 if(stringTypes.has(type)&&(![33,45,46,83,255].includes(charset)||(flags&(128|256|2048))!==0))fail('value');return type;
}
function row(p:Uint8Array,types:number[]){const r=new Reader(p);const values=types.map(type=>{
 const n=r.length();if(n===null)return null;if(n>8192)fail('limit');const value=text(r.take(n));if(value.length>2048)fail('limit');
 if(numericTypes.has(type)){
  const pattern=[1,2,3,8,9,13].includes(type)?/^-?(?:0|[1-9]\d*)$/:/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
  if(!pattern.test(value))fail('value');
 }return value;
 });r.end();return values;}
/** Exclusive authenticated verified-TLS connection at idle, using the capabilities
 * from MysqlTlsFastAuth (classic EOF, no multi-statements/results/session track).
 * This function does not connect or verify TLS. Trusted tables and least-privilege
 * users remain necessary: read-only transactions do not sandbox server extensions.
 * Numeric cells remain exact strings; errors/timeouts close rather than claiming
 * server-side cancellation or successful ROLLBACK after a failed command.
 */
export async function executeMysqlRead(connection:PluginByteConnection,options:MysqlReadOptions):Promise<MysqlReadResult>{
 if(failed.has(connection))fail('closed');if(active.has(connection))fail('busy');
 const limit=options.limit??100,ms=options.timeoutMs??5000;
 if(!identifier(options.schema)||!identifier(options.table)||!Array.isArray(options.columns)||!options.columns.length||options.columns.length>16||options.columns.some(c=>!identifier(c))||new Set(options.columns).size!==options.columns.length||!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(ms)||ms<1||ms>10000)fail('input');
 const columns=[...options.columns],sql=`SELECT ${columns.map(quote).join(', ')} FROM ${quote(options.schema)}.${quote(options.table)} LIMIT ${limit}`;
 if(encoder.encode(sql).length>8192)fail('limit');
 active.add(connection);let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,current:Uint8Array|undefined;let liveDecoder:MysqlPacketDecoder|undefined;
 let diagnosticPhase:'begin'|'select'|'rollback'='begin',packetTag:number|undefined,sequence:number|undefined;
 let held:MysqlPacket[]=[];const rows:(string|null)[][]=[];let reads=0,bytes=0;
 const deadline=performance.now()+ms;let stopReject!:(error:MysqlReadError)=>void;const stop=new Promise<never>((_,reject)=>stopReject=reject);
 const close=()=>{rows.length=0;failed.add(connection);current?.fill(0);for(const p of held)p.payload.fill(0);held=[];try{liveDecoder?.finish();}catch{}try{connection.readable.cancel();}catch{}try{connection.writable.cancel();}catch{}void Promise.resolve().then(()=>connection.close()).catch(()=>{});};
 const halt=(code:'timeout'|'aborted')=>{if(stopped)return;stopped=true;close();stopReject(new MysqlReadError(code));};
 const check=()=>{if(stopped)fail('aborted');if(performance.now()>=deadline)fail('timeout');};
 const abort=()=>halt('aborted');
 try{
  timer=setTimeout(()=>halt('timeout'),ms);options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  const exchange=async(command:string,consume:(p:Uint8Array)=>boolean)=>{
   check();const body=encoder.encode('\x03'+command);current=encodeMysqlPacket(body,0);body.fill(0);liveDecoder=new MysqlPacketDecoder(1);
   try{await connection.writable.write(current);}finally{current.fill(0);current=undefined;}check();
   while(true){check();if(++reads>4096)fail('limit');const chunk=await connection.readable.read();try{
    check();if(!(chunk instanceof Uint8Array)||!chunk.length)fail('protocol');bytes+=chunk!.length;if(bytes>96*1024)fail('limit');
    try{held=liveDecoder.feed(chunk!);}catch{fail('protocol');}
   }finally{if(chunk instanceof Uint8Array)chunk.fill(0);}
   try{for(let i=0;i<held.length;i++){check();const p=held[i].payload;packetTag=p[0];sequence=held[i].sequence;if(p[0]===255)fail('server');if(consume(p)){if(i!==held.length-1)fail('sequence');try{liveDecoder.finish();}catch{fail('protocol');}return;}}}finally{for(const p of held)p.payload.fill(0);held=[];}
   }
  };
  const run=async()=>{
   await exchange('START TRANSACTION READ ONLY',p=>{ok(p,true);return true;});
   let phase:'count'|'columns'|'fields-end'|'rows'='count';const types:number[]=[];
   diagnosticPhase='select';await exchange(sql,p=>{
    if(phase==='count'){const r=new Reader(p);if(r.length()!==columns.length)fail('protocol');r.end();phase='columns';return false;}
    if(phase==='columns'){types.push(column(p,options.schema,options.table,columns[types.length]));if(types.length===columns.length)phase='fields-end';return false;}
    if(phase==='fields-end'){eof(p);phase='rows';return false;}
    if(p[0]===254&&p.length<9){eof(p);return true;}
    if(rows.length>=limit)fail('limit');rows.push(row(p,types));return false;
   });
   diagnosticPhase='rollback';await exchange('ROLLBACK',p=>{ok(p,false);return true;});check();
   const result:MysqlReadResult={columns,rows,rowCount:rows.length,limit,scope:'limited-select'};
   if(encoder.encode(JSON.stringify(result)).length>96*1024)fail('limit');return result;
  };
  return await Promise.race([run(),stop]);
 }catch(error){if(!stopped){stopped=true;close();}throw error instanceof MysqlReadError?new MysqlReadError(error.code,{phase:diagnosticPhase,...(error.diagnostic?.status!==undefined?{status:error.diagnostic.status}:{}),...(packetTag!==undefined?{packetTag}:{}),...(sequence!==undefined?{sequence}:{})}):new MysqlReadError('transport',{phase:diagnosticPhase});}
 finally{if(timer)clearTimeout(timer);options.signal?.removeEventListener('abort',abort);current?.fill(0);active.delete(connection);}
}

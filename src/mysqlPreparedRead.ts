import type {PluginByteConnection} from '@netcatty/plugin-sdk';
import {encodeMysqlPacket,MysqlPacketDecoder,type MysqlPacket} from './mysqlProtocol';
import {encodeMysqlPrepare,encodeMysqlExecute,encodeMysqlStatementClose,parseMysqlPrepareOk,parseMysqlPreparedColumn,parseMysqlBinaryRow,MysqlPreparedError,type MysqlPreparedSelect,type MysqlPreparedColumn} from './mysqlPreparedProtocol';
export interface MysqlPreparedReadOptions extends MysqlPreparedSelect{timeoutMs?:number;signal?:AbortSignal;}
export class MysqlPreparedReadError extends Error{constructor(readonly code:'input'|'busy'|'closed'|'protocol'|'sequence'|'limit'|'server'|'transport'|'timeout'|'aborted',readonly diagnostic?:{phase:string;status?:number}){super(`MySQL prepared read ${code}`);}}
const fail=(code:MysqlPreparedReadError['code']):never=>{throw new MysqlPreparedReadError(code);};
const active=new WeakSet<PluginByteConnection>(),failed=new WeakSet<PluginByteConnection>(),enc=new TextEncoder();
const query=(sql:string)=>{const b=enc.encode('\x03'+sql);try{return encodeMysqlPacket(b,0);}finally{b.fill(0);}};
function state(flags:number,transaction:boolean,select=false){const normalized=select?flags&~(16|32):flags;if(transaction?![3,8195].includes(normalized):normalized!==2)throw new MysqlPreparedReadError('sequence',{phase:'status',status:flags});}
function ok(p:Uint8Array,transaction:boolean){if(p.length!==7||p[0]!==0||p[1]!==0||p[2]!==0||p[5]!==0||p[6]!==0)fail('protocol');state(p[3]+p[4]*256,transaction);}
function eof(p:Uint8Array,select=false){if(p.length!==5||p[0]!==254||p[1]!==0||p[2]!==0)fail('protocol');state(p[3]+p[4]*256,true,select);}
/** Caller owns an exclusively authenticated verified-TLS idle connection with
 * classic EOF capabilities. No other reader (including mysqlRead) may use it.
 * This module does not connect/verify TLS or support arbitrary SQL, cursors,
 * long-data, RESET/re-execute, multiresults or extensions with external effects.
 */
export async function executeMysqlPreparedRead(connection:PluginByteConnection,options:MysqlPreparedReadOptions){
 if(failed.has(connection))fail('closed');if(active.has(connection))fail('busy');
 const ms=options.timeoutMs??5000,signal=options.signal;if(!Number.isInteger(ms)||ms<1||ms>10000)fail('input');
 const schema=options.schema,table=options.table;let prepared:ReturnType<typeof encodeMysqlPrepare>;
 try{prepared=encodeMysqlPrepare({schema,table,columns:options.columns,where:options.where,limit:options.limit});}catch{ return fail('input');}
 // The pure plan detaches every column, predicate and value before the first await.
 const plan=prepared.plan,rows:(string|null)[][]=[];active.add(connection);
 let stopped=false,phase='begin',current:Uint8Array|undefined,decoder:MysqlPacketDecoder|undefined,held:MysqlPacket[]=[];let reads=0,bytes=0;
 const deadline=performance.now()+ms;let stopReject!:(error:MysqlPreparedReadError)=>void;const stop=new Promise<never>((_,reject)=>stopReject=reject);
 const clean=()=>{current?.fill(0);prepared.wire.fill(0);for(const p of held)p.payload.fill(0);held=[];try{decoder?.finish();}catch{}rows.length=0;};
 const close=()=>{failed.add(connection);clean();try{connection.readable.cancel();}catch{}try{connection.writable.cancel();}catch{}void Promise.resolve().then(()=>connection.close()).catch(()=>{});};
 const halt=(code:'timeout'|'aborted')=>{if(stopped)return;stopped=true;close();stopReject(new MysqlPreparedReadError(code,{phase}));};
 const check=()=>{if(stopped)fail('aborted');if(performance.now()>=deadline)fail('timeout');};
 const abort=()=>halt('aborted');const timer=setTimeout(()=>halt('timeout'),ms);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const write=async(wire:Uint8Array)=>{current=wire;try{check();await connection.writable.write(wire);check();}finally{wire.fill(0);current=undefined;}};
 const exchange=async(wire:Uint8Array,consume:(p:Uint8Array)=>boolean)=>{
  decoder=new MysqlPacketDecoder(1);await write(wire);
  while(true){check();if(++reads>4096)fail('limit');const chunk=await connection.readable.read();try{
   check();if(!(chunk instanceof Uint8Array)||!chunk.length)fail('protocol');bytes+=chunk!.length;if(bytes>96*1024)fail('limit');held=decoder.feed(chunk!);
  }finally{if(chunk instanceof Uint8Array)chunk.fill(0);}
  try{for(let i=0;i<held.length;i++){check();const p=held[i].payload;if(p[0]===255)fail('server');if(consume(p)){if(i!==held.length-1)fail('sequence');decoder.finish();return;}}}
  finally{for(const p of held)p.payload.fill(0);held=[];}
  }
 };
 const resultColumn=(p:Uint8Array,index:number)=>{const c=parseMysqlPreparedColumn(p);if(c.schema!==schema||c.table!==table||c.originalTable!==table||c.name!==plan.columns[index]||c.originalName!==plan.columns[index])fail('protocol');parseMysqlBinaryRow(Uint8Array.of(0,4),[c]);return c;};
 try{
  const run=async()=>{
   await exchange(query('START TRANSACTION READ ONLY'),p=>{ok(p,true);return true;});phase='prepare';
   let statementId=0,step:'ok'|'params'|'params-end'|'columns'|'columns-end'='ok',params=0;const declared:MysqlPreparedColumn[]=[];
   await exchange(prepared.wire,p=>{
    if(step==='ok'){const info=parseMysqlPrepareOk(p,{parameters:plan.parameters.length,columns:plan.columns.length});statementId=info.statementId;step='params';return false;}
    if(step==='params'){const c=parseMysqlPreparedColumn(p);if(![0,1,2,3,4,5,6,7,8,9,10,11,12,13,15,16,245,246,249,250,251,252,253,254].includes(c.type)||c.charset<1)fail('protocol');if(++params===plan.parameters.length)step='params-end';return false;}
    if(step==='params-end'){eof(p);step='columns';return false;}
    if(step==='columns'){declared.push(resultColumn(p,declared.length));if(declared.length===plan.columns.length)step='columns-end';return false;}
    eof(p);return true;
   });
   phase='execute';let resultPhase:'count'|'columns'|'fields-end'|'rows'='count';const fields:MysqlPreparedColumn[]=[];
   await exchange(encodeMysqlExecute(statementId,plan.parameters),p=>{
    if(resultPhase==='count'){if(p.length!==1||p[0]!==plan.columns.length)fail('protocol');resultPhase='columns';return false;}
    if(resultPhase==='columns'){const c=resultColumn(p,fields.length);if(JSON.stringify(c)!==JSON.stringify(declared[fields.length]))fail('protocol');fields.push(c);if(fields.length===plan.columns.length)resultPhase='fields-end';return false;}
    if(resultPhase==='fields-end'){eof(p,true);resultPhase='rows';return false;}
    if(p[0]===254&&p.length<9){eof(p,true);return true;}
    if(rows.length>=plan.limit)fail('limit');rows.push(parseMysqlBinaryRow(p,fields));return false;
   });
   // COM_STMT_CLOSE has NO response. A spurious packet will fail the subsequent
   // ROLLBACK decoder rather than be silently discarded.
   phase='close-statement';await write(encodeMysqlStatementClose(statementId));phase='rollback';await exchange(query('ROLLBACK'),p=>{ok(p,false);return true;});check();
   const result={columns:plan.columns,rows,rowCount:rows.length,limit:plan.limit,scope:'limited-prepared-select' as const};if(enc.encode(JSON.stringify(result)).length>96*1024)fail('limit');return result;
  };
  return await Promise.race([run(),stop]);
 }catch(error){if(!stopped){stopped=true;close();}throw error instanceof MysqlPreparedReadError?new MysqlPreparedReadError(error.code,{phase,...(error.diagnostic?.status!==undefined?{status:error.diagnostic.status}:{})}):new MysqlPreparedReadError(error instanceof MysqlPreparedError?'protocol':'transport',{phase});}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);current?.fill(0);prepared.wire.fill(0);active.delete(connection);}
}

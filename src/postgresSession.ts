import type { PluginByteConnection } from '@netcatty/plugin-sdk';
import { PostgresDecoder, pgStartup, pgSaslMechanisms, pgSaslInitialResponse, pgSaslResponse, pgTextValue } from './postgresProtocol';
import { PostgresScramClient } from './postgresScram';
export class PostgresStartupError extends Error {
 constructor(readonly code:'input'|'sequence'|'authentication'|'protocol'|'limit'|'server'|'transport'|'timeout'|'aborted'){super(`PG startup ${code}`);}
}
export interface PostgresStartupOptions {user:string;database:string;password:string;timeoutMs?:number;signal?:AbortSignal;}
/** Protocol-only startup on an ALREADY host-verified TLS connection. This function
 * cannot establish/verify TLS or add PostgreSQL ALPN. Do not pass raw TCP, a proxy,
 * or treat success in an injected test as production broker compatibility.
 * Owns the stream until startup resolves; on failure cancels/closes it.
 * Rejects empty reads and caps startup at 4096 reads; monotonic deadline checks
 * bound microtask-only streams independently of timer scheduling. Success
 * transfers ownership back to caller. No query API, credential storage or cancel key.
 */
export async function authenticatePostgresTls(connection:PluginByteConnection,options:PostgresStartupOptions):Promise<{status:'ready';transactionStatus:'I'}>{
 let scram:PostgresScramClient|undefined;let inflightWire:Uint8Array|undefined;let stopped=false;let timer:ReturnType<typeof setTimeout>|undefined;
 let abort:()=>void=()=>{};let stopReject!:(e:PostgresStartupError)=>void;
 const stop=new Promise<never>((_,reject)=>{stopReject=reject;});
 const close=()=>{inflightWire?.fill(0);inflightWire=undefined;try{connection.readable.cancel();}catch{}try{connection.writable.cancel();}catch{}void Promise.resolve().then(()=>connection.close()).catch(()=>{});};
 const halt=(code:'timeout'|'aborted')=>{if(stopped)return;stopped=true;scram?.close();close();stopReject(new PostgresStartupError(code));};
 const fail=(code:PostgresStartupError['code']):never=>{throw new PostgresStartupError(code);};
 try{
  const ms=options.timeoutMs??5000;
  if(!Number.isInteger(ms)||ms<1||ms>10000||typeof options.database!=='string'||!options.database||options.database.length>128||options.database.includes('\0'))fail('input');
  const deadline=performance.now()+ms;
  const check=()=>{if(stopped)fail('aborted');if(performance.now()>=deadline)fail('timeout');};
  try{scram=new PostgresScramClient(options.user,options.password);}catch{fail('input');}
  timer=setTimeout(()=>halt('timeout'),ms);abort=()=>halt('aborted');options.signal?.addEventListener('abort',abort,{once:true});
  if(options.signal?.aborted)halt('aborted');
  const write=async(wire:Uint8Array)=>{try{check();inflightWire=wire;await connection.writable.write(wire);check();}finally{wire.fill(0);if(inflightWire===wire)inflightWire=undefined;}};
  const run=async()=>{
   await write(pgStartup(options.user,options.database));
   let phase:'sasl'|'continue'|'final'|'ok'|'ready'='sasl';let buffer=new Uint8Array(0),bytes=0,frames=0,reads=0,backendKey=false,parameters=0;
   const decoder=new PostgresDecoder();
   while(!stopped){
    check();if(++reads>4096)fail('limit');
    const chunk=await connection.readable.read();check();if(chunk===null)throw new PostgresStartupError('protocol');
    if(!(chunk instanceof Uint8Array)||chunk.length===0)fail('protocol');bytes+=chunk.length;if(bytes>96*1024)fail('limit');
    const merged=new Uint8Array(buffer.length+chunk.length);merged.set(buffer);merged.set(chunk,buffer.length);buffer=merged;
    while(buffer.length>=5){
     check();
     const n=new DataView(buffer.buffer,buffer.byteOffset+1,4).getInt32(0);if(n<4)fail('protocol');if(n>32768)fail('limit');if(buffer.length<n+1)break;
     if(++frames>128)fail('limit');const frame=buffer.slice(0,n+1);buffer=buffer.slice(n+1);
     if(frame[0]===75){if(phase!=='ready'||n!==12||backendKey)fail('sequence');backendKey=true;frame.fill(0);continue;}
     let messages;try{messages=decoder.feed(frame);}catch{fail('protocol');}const message=messages![0];if(!message)fail('protocol');
     if(message.type==='error')fail('server');
     if(message.type==='parameter'){if(phase!=='ready')fail('sequence');if(++parameters>64||message.name.length>128||message.value.length>4096)fail('limit');continue;}
     if(message.type==='ready'){if(phase!=='ready'||message.status!=='I'||buffer.length)fail('sequence');decoder.finish();return {status:'ready' as const,transactionStatus:'I' as const};}
     if(message.type!=='authentication')throw new PostgresStartupError('sequence');
     if(phase==='sasl'&&message.method===10){
      if(!pgSaslMechanisms(message.data).includes('SCRAM-SHA-256'))fail('authentication');
      const first=scram!.start();phase='continue';await write(pgSaslInitialResponse(first.mechanism,first.message));
     }else if(phase==='continue'&&message.method===11){
      let response:string;try{response=await scram!.receiveServerFirst(pgTextValue(message.data));}catch{check();fail('authentication');}
      check();phase='final';await write(pgSaslResponse(response!));
     }else if(phase==='final'&&message.method===12){
      try{scram!.receiveServerFinal(pgTextValue(message.data));}catch{fail('authentication');}phase='ok';
     }else if(phase==='ok'&&message.method===0){phase='ready';}
     else fail('sequence');
    }
   }return fail('aborted');
  };
  return await Promise.race([run(),stop]);
 }catch(e){if(!stopped){stopped=true;close();}throw e instanceof PostgresStartupError?e:new PostgresStartupError('transport');}
 finally{if(timer)clearTimeout(timer);options.signal?.removeEventListener('abort',abort);scram?.close();}
}

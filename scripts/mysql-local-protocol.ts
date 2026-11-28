/** MANUAL independent Node protocol integration, not plugin transport.
 * Node supplies SSLRequest -> TLS upgrade absent from current main public API.
 * Warm caching_sha2 cache using the separately authorized VERIFY_IDENTITY CLI.
 * node --import tsx scripts/mysql-local-protocol.ts [--reject-cert|--bad-password|--fast-only|--full-auth-required|--read|--prepared-read]
 * Full-auth password is sent only inside this same verified TLS connection.
 * --read uses bounded production read module; no arbitrary SQL or policy change.
 */
import type {PluginByteConnection} from '@netcatty/plugin-sdk';
import {executeMysqlRead,MysqlReadError} from '../src/mysqlRead';
import {executeMysqlPreparedRead,MysqlPreparedReadError} from '../src/mysqlPreparedRead';
import type {MysqlPreparedSelect} from '../src/mysqlPreparedProtocol';
import net from 'node:net';import tls from 'node:tls';import {readFile} from 'node:fs/promises';import {fileURLToPath} from 'node:url';
import {MysqlPacketDecoder,parseMysqlHandshake,parseMysqlError,type MysqlPacket} from '../src/mysqlProtocol';
import {planMysqlSslRequest,MysqlTlsFastAuth} from '../src/mysqlAuth';
const base=fileURLToPath(new URL('../../local-db-host/mysql-test/',import.meta.url));
const host='127.0.0.1',port=15479,mode=process.argv[2]??'auth';
if(!['auth','--reject-cert','--bad-password','--fast-only','--full-auth-required','--read','--prepared-read'].includes(mode)||process.argv.length>3){console.error('Unsupported test mode.');process.exit(2);}
class FixtureError extends Error{constructor(readonly code:'transport'|'timeout'|'protocol'|'certificate'|'fixture'|'full-auth-required'|'server-auth-denied'|'auth-flow'){super(`MySQL fixture ${code}`);}}
let raw:net.Socket|undefined,secure:tls.TLSSocket|undefined,auth:MysqlTlsFastAuth|undefined,stage='fixture-files';
function greeting():Promise<MysqlPacket>{return new Promise((resolve,reject)=>{
 const decoder=new MysqlPacketDecoder(0);let done=false,bytes=0,reads=0;
 const timer=setTimeout(()=>finish(new FixtureError('timeout')),5000);
 const finish=(error:FixtureError)=>{if(done)return;done=true;clearTimeout(timer);raw?.destroy();reject(error);};
 raw=net.createConnection({host,port});raw.on('error',()=>finish(new FixtureError('transport')));raw.once('end',()=>finish(new FixtureError('transport')));
 const data=(chunk:Buffer)=>{if(done)return;if(++reads>4096||(bytes+=chunk.length)>4096){finish(new FixtureError('protocol'));return;}
 try{const packets=decoder.feed(chunk);if(!packets.length)return;if(packets.length!==1)throw 0;decoder.finish();done=true;clearTimeout(timer);raw!.off('data',data);raw!.pause();resolve(packets[0]);}catch{finish(new FixtureError('protocol'));}};
 raw.on('data',data);
});}
async function write(socket:net.Socket,bytes:Uint8Array){try{await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{socket.destroy();reject(new FixtureError('timeout'));},5000);socket.write(bytes,error=>{clearTimeout(timer);if(error)reject(new FixtureError('transport'));else resolve();});});}finally{bytes.fill(0);}}
function upgrade(ca:Buffer):Promise<tls.TLSSocket>{return new Promise((resolve,reject)=>{
 let done=false;const timer=setTimeout(()=>finish(new FixtureError('timeout')),5000);
 const finish=(error:FixtureError)=>{if(done)return;done=true;clearTimeout(timer);secure?.destroy();raw?.destroy();reject(error);};
 secure=tls.connect({socket:raw!,ca:mode==='--reject-cert'?[]:[ca],rejectUnauthorized:true,minVersion:'TLSv1.2',checkServerIdentity:(_name,cert)=>tls.checkServerIdentity(host,cert)});
 secure.on('error',(error:NodeJS.ErrnoException)=>finish(new FixtureError(['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(error.code??'')?'certificate':'transport')));
 secure.once('secureConnect',()=>{if(!secure!.authorized||tls.checkServerIdentity(host,secure!.getPeerCertificate())){finish(new FixtureError('certificate'));return;}if(done)return;done=true;clearTimeout(timer);resolve(secure!);});
 raw!.resume();
});}
function authenticate(socket:tls.TLSSocket,client:MysqlTlsFastAuth,wire:Uint8Array):Promise<{fullAuth:boolean}>{return new Promise((resolve,reject)=>{
 let done=false,bytes=0,reads=0,fullAuth=false;let fullWire:Uint8Array|undefined;let inspector=new MysqlPacketDecoder(3);const timer=setTimeout(()=>finish(new FixtureError('timeout')),5000);
 const finish=(error?:FixtureError)=>{if(done)return;done=true;clearTimeout(timer);socket.pause();socket.off('data',data);socket.off('end',onEnd);socket.off('error',onError);wire.fill(0);fullWire?.fill(0);if(error){socket.destroy();reject(error);}else resolve({fullAuth});};
 const data=(chunk:Buffer)=>{
  if(done)return;if(++reads>4096||(bytes+=chunk.length)>96*1024){finish(new FixtureError('protocol'));return;}
  let packets:MysqlPacket[]=[];
  try{
   // Classify only safe protocol fields; never echo server text. The production
   // state machine still processes and validates every successful response.
   packets=inspector.feed(chunk);
   for(const p of packets){
    if(p.payload.length===2&&p.payload[0]===1&&p.payload[1]===4&&mode==='--fast-only'){client.close();finish(new FixtureError('full-auth-required'));return;}
    if(p.payload[0]===255){const error=parseMysqlError(p.payload);if(error.code===1045&&error.sqlState==='28000'){client.close();finish(new FixtureError('server-auth-denied'));return;}}
   }
   const state=client.receive(chunk);
   if(state==='authenticated'){inspector.finish();finish();}
   else if(state==='full-auth-required'){
    inspector.finish();inspector=new MysqlPacketDecoder(5);
    if(!socket.authorized||socket.destroyed||tls.checkServerIdentity(host,socket.getPeerCertificate()))throw new FixtureError('certificate');
    fullAuth=true;fullWire=client.fullAuthResponse();void write(socket,fullWire).catch(()=>finish(new FixtureError('transport')));
   }
  }catch{finish(new FixtureError('auth-flow'));}finally{for(const p of packets)p.payload.fill(0);}
 };
 const onEnd=()=>finish(new FixtureError('transport')),onError=()=>finish(new FixtureError('transport'));
 socket.on('data',data);socket.once('end',onEnd);socket.once('error',onError);
 void write(socket,wire).catch(()=>finish(new FixtureError('transport')));
});}
/** Attach only after auth has paused the stream and removed its data listener.
 * Unconsumed socket bytes are preserved by pause/resume, not thrown away. */
function readConnection(socket:tls.TLSSocket):PluginByteConnection{
 const queue:Uint8Array[]=[];let queued=0,closed=false,pending:((b:Uint8Array|null)=>void)|undefined;
 const wires=new Set<Buffer>();
 const close=()=>{if(closed)return;closed=true;socket.pause();socket.off('data',data);socket.off('error',close);socket.off('end',close);socket.off('close',close);for(const b of queue)b.fill(0);queue.length=0;queued=0;for(const b of wires)b.fill(0);wires.clear();pending?.(null);pending=undefined;socket.destroy();};
 const data=(input:Buffer)=>{if(closed)return;const b=new Uint8Array(input);if(pending){const resolve=pending;pending=undefined;resolve(b);return;}queued+=b.length;if(queued>96*1024){b.fill(0);close();return;}queue.push(b);};
 socket.on('data',data);socket.on('error',close);socket.on('end',close);socket.on('close',close);socket.resume();
 return {readable:{read:async()=>{if(queue.length){const b=queue.shift()!;queued-=b.length;return b;}if(closed)return null;if(pending)throw new FixtureError('protocol');return new Promise<Uint8Array|null>(resolve=>pending=resolve);},cancel:close},
 writable:{write:async(value:Uint8Array|ArrayBuffer)=>{if(closed)throw new FixtureError('transport');const b=Buffer.from(value instanceof Uint8Array?value:new Uint8Array(value));wires.add(b);try{await new Promise<void>((resolve,reject)=>socket.write(b,error=>error?reject(new FixtureError('transport')):resolve()));}finally{b.fill(0);wires.delete(b);}},cancel:close},close:async()=>{close();}} as unknown as PluginByteConnection;
}
const report=(status:string,check:string,extra:Record<string,unknown>={})=>console.log(JSON.stringify({status,lane:'independent-node-mysql-fast-auth',check,nativePluginConnected:false,queryCovered:false,preparedQueryCovered:false,...extra}));
try{
 const ca=await readFile(base+'server.crt');stage='server-greeting';const packet=await greeting();
 let hello;try{hello=parseMysqlHandshake(packet.payload);}catch{throw new FixtureError('protocol');}
 const serverVersion=hello.serverVersion;hello.authPluginData.fill(0);if(!/^8\.4\.7(?:-|$)/.test(serverVersion))throw new FixtureError('fixture');
 const plan=planMysqlSslRequest(packet);stage='ssl-request';await write(raw!,plan.packet);stage='verify-full-tls';
 try{await upgrade(ca);}catch(error){if(mode==='--reject-cert'&&error instanceof FixtureError&&error.code==='certificate'){report('PASS','untrusted-certificate-rejected');stage='expected-rejection';}else throw error;}
 if(stage!=='expected-rejection'){
  if(mode==='--reject-cert')throw new FixtureError('fixture');stage='fast-auth';let secret:Buffer|undefined,password='';let usedFullAuth=false;
  try{secret=await readFile(base+'password');if(!secret.length||secret.length>1025)throw new FixtureError('fixture');password=secret.toString('utf8').replace(/\r?\n$/,'');if(mode==='--bad-password')password+='-intentional-invalid';
   auth=new MysqlTlsFastAuth(packet,'netcatty_test',password,{verifiedTls:true,sslRequest:plan.descriptor,allowFullAuth:mode!=='--fast-only'});const wire=await auth.start();packet.payload.fill(0);usedFullAuth=(await authenticate(secure!,auth,wire)).fullAuth;
  }finally{secret?.fill(0);password='';}
  if(mode==='--bad-password')throw new FixtureError('fixture');
  if(mode==='--full-auth-required'&&!usedFullAuth){report('NOT_COVERED','full-auth-not-observed',{authenticated:true,authFlow:'fast'});process.exitCode=2;}
  else if(mode==='--prepared-read'){
   stage='prepared-read';const connection=readConnection(secure!);try{
    const options:MysqlPreparedSelect={schema:'netcatty_test',table:'netcatty_smoke',columns:['id','label','optional_value'],limit:10,where:[{column:'id',value:{kind:'int64',value:'1'}},{column:'label',value:{kind:'text',value:'real-tls-mysql'}},{column:'optional_value',value:{kind:'null'}}]};
    const verify=(result:Awaited<ReturnType<typeof executeMysqlPreparedRead>>,expected:(string|null)[][])=>{if(result.rowCount!==expected.length||JSON.stringify(result.columns)!==JSON.stringify(options.columns)||JSON.stringify(result.rows)!==JSON.stringify(expected))throw new FixtureError('fixture');};
    verify(await executeMysqlPreparedRead(connection,options),[['1','real-tls-mysql',null]]);
    const adversarial:MysqlPreparedSelect={...options,where:options.where.map((item,i)=>i===1?{column:'label',value:{kind:'text',value:"' OR 1=1; DROP TABLE netcatty_smoke; --"}}:item)};
    verify(await executeMysqlPreparedRead(connection,adversarial),[]);
    verify(await executeMysqlPreparedRead(connection,options),[['1','real-tls-mysql',null]]);
    report('PASS','prepared-bound-read-three-exchanges',{preparedQueryCovered:true,queryCovered:true,queryCount:3,connectionReused:true,statementCleanupAndRollbackVerified:true,int64BoundVerified:true,textBoundVerified:true,nullBoundVerified:true,sqlLookingTextReturnedZeroRows:true,authFlow:usedFullAuth?'full':'fast',tlsVerified:true,tlsVersion:secure!.getProtocol(),serverVersion});
   }finally{await connection.close();}
  }
  else if(mode==='--read'){
   stage='bounded-read';const connection=readConnection(secure!);try{
    const options={schema:'netcatty_test',table:'netcatty_smoke',columns:['id','label','optional_value'],limit:10};
    for(let pass=0;pass<2;pass++){const result=await executeMysqlRead(connection,options);if(result.rowCount!==1||JSON.stringify(result.columns)!==JSON.stringify(options.columns)||JSON.stringify(result.rows)!==JSON.stringify([['1','real-tls-mysql',null]]))throw new FixtureError('fixture');}
    report('PASS','bounded-read-twice',{queryCovered:true,queryCount:2,connectionReused:true,rollbackVerified:true,labelVerified:true,nullVerified:true,exactIntegerVerified:true,authFlow:usedFullAuth?'full':'fast',tlsVerified:true,tlsVersion:secure!.getProtocol(),serverVersion});
   }finally{await connection.close();}
  }
  else report('PASS',usedFullAuth?'verified-tls-full-auth':'cached-fast-auth',{authFlow:usedFullAuth?'full':'fast',tlsVerified:true,tlsVersion:secure!.getProtocol(),serverVersion,sslRequestDescriptorMatched:true});
 }
}catch(error){
 const code=error instanceof FixtureError?error.code:error instanceof MysqlReadError?`mysql-read-${error.code}`:error instanceof MysqlPreparedReadError?`mysql-prepared-read-${error.code}`:'fixture';
 if(code==='full-auth-required'){report('UNSUPPORTED','full-auth-required',{authenticated:false,passwordRejectedByServer:false});process.exitCode=2;}
 else if(mode==='--bad-password'&&code==='server-auth-denied')report('PASS','explicit-server-auth-denied',{errorCode:1045,sqlState:'28000'});
 else{console.error(JSON.stringify({status:'FAIL',lane:'independent-node-mysql-fast-auth',stage,reason:code,...(error instanceof MysqlReadError||error instanceof MysqlPreparedReadError?{diagnostic:error.diagnostic}:{}),nativePluginConnected:false,queryCovered:false,preparedQueryCovered:false}));process.exitCode=1;}
}finally{auth?.close();secure?.destroy();raw?.destroy();}

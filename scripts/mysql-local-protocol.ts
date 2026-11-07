/** MANUAL independent Node protocol integration, not plugin transport.
 * Node supplies SSLRequest -> TLS upgrade absent from current main public API.
 * Warm caching_sha2 cache using the separately authorized VERIFY_IDENTITY CLI.
 * node --import tsx scripts/mysql-local-protocol.ts [--reject-cert|--bad-password|--fast-only|--full-auth-required]
 * Full-auth password is sent only inside this same verified TLS connection.
 * No RSA response, SQL query or production policy change.
 */
import net from 'node:net';import tls from 'node:tls';import {readFile} from 'node:fs/promises';import {fileURLToPath} from 'node:url';
import {MysqlPacketDecoder,parseMysqlHandshake,parseMysqlError,type MysqlPacket} from '../src/mysqlProtocol';
import {planMysqlSslRequest,MysqlTlsFastAuth} from '../src/mysqlAuth';
const base=fileURLToPath(new URL('../../local-db-host/mysql-test/',import.meta.url));
const host='127.0.0.1',port=15479,mode=process.argv[2]??'auth';
if(!['auth','--reject-cert','--bad-password','--fast-only','--full-auth-required'].includes(mode)||process.argv.length>3){console.error('Unsupported test mode.');process.exit(2);}
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
 const finish=(error?:FixtureError)=>{if(done)return;done=true;clearTimeout(timer);socket.off('data',data);wire.fill(0);fullWire?.fill(0);if(error){socket.destroy();reject(error);}else resolve({fullAuth});};
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
 socket.on('data',data);socket.once('end',()=>finish(new FixtureError('transport')));socket.once('error',()=>finish(new FixtureError('transport')));
 void write(socket,wire).catch(()=>finish(new FixtureError('transport')));
});}
const report=(status:string,check:string,extra:Record<string,unknown>={})=>console.log(JSON.stringify({status,lane:'independent-node-mysql-fast-auth',check,nativePluginConnected:false,queryCovered:false,...extra}));
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
  else report('PASS',usedFullAuth?'verified-tls-full-auth':'cached-fast-auth',{authFlow:usedFullAuth?'full':'fast',tlsVerified:true,tlsVersion:secure!.getProtocol(),serverVersion,sslRequestDescriptorMatched:true});
 }
}catch(error){
 const code=error instanceof FixtureError?error.code:'fixture';
 if(code==='full-auth-required'){report('UNSUPPORTED','full-auth-required',{authenticated:false,passwordRejectedByServer:false});process.exitCode=2;}
 else if(mode==='--bad-password'&&code==='server-auth-denied')report('PASS','explicit-server-auth-denied',{errorCode:1045,sqlState:'28000'});
 else{console.error(JSON.stringify({status:'FAIL',lane:'independent-node-mysql-fast-auth',stage,reason:code,nativePluginConnected:false,queryCovered:false}));process.exitCode=1;}
}finally{auth?.close();secure?.destroy();raw?.destroy();}

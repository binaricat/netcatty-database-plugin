/** MANUAL independent Node lane, not imported by the plugin or npm tests.
 * Exercises real redisProtocol + redisBrowser, NOT redisSession/connectRedis.
 * AUTH and TLS below belong exclusively to this test harness. No endpoint alias,
 * broker policy change or production plugin connectivity claim is involved.
 * node --import tsx scripts/redis-local-protocol.ts [--bad-password|--reject-cert|--types]
 */
import {verifyRedisFixtureTypes} from './redis-local-types';
import tls from 'node:tls';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {encodeRedisCommand,RedisResp2Decoder,redisText,type RedisValue} from '../src/redisProtocol';
import {createRedisBrowser} from '../src/redisBrowser';
const base=fileURLToPath(new URL('../../local-db-host/redis-tls-test/',import.meta.url));
const host='127.0.0.1',port=16479,mode=process.argv[2]??'read';
if(!['read','--bad-password','--reject-cert','--types'].includes(mode)||process.argv.length>3){console.error('Unsupported test mode.');process.exit(2);}
class HarnessError extends Error {constructor(readonly code:'certificate'|'transport'|'timeout'|'protocol'|'budget'|'busy'|'command'|'authentication'|'fixture'){super(`Redis fixture ${code}`);}}
let socket:tls.TLSSocket|undefined,stage='fixture-files';
function verifiedTls(ca:Buffer){return new Promise<tls.TLSSocket>((resolve,reject)=>{
 let done=false;const timer=setTimeout(()=>finish(new HarnessError('timeout')),5000);
 const finish=(error:HarnessError)=>{if(done)return;done=true;clearTimeout(timer);socket?.destroy();reject(error);};
 socket=tls.connect({host,port,ca:mode==='--reject-cert'?[]:[ca],rejectUnauthorized:true,minVersion:'TLSv1.2',checkServerIdentity:(_name,cert)=>tls.checkServerIdentity(host,cert)});
 socket.on('error',(error:NodeJS.ErrnoException)=>finish(new HarnessError(['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(error.code??'')?'certificate':'transport')));
 socket.once('secureConnect',()=>{if(!socket!.authorized||tls.checkServerIdentity(host,socket!.getPeerCertificate())){finish(new HarnessError('certificate'));return;}if(done)return;done=true;clearTimeout(timer);resolve(socket!);});
});}
function transport(s:tls.TLSSocket){
 let active:{decoder:RedisResp2Decoder;bytes:number;resolve:(v:RedisValue)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>;wire:Uint8Array}|undefined;
 const fail=(code:HarnessError['code'])=>{const p=active;active=undefined;if(p){clearTimeout(p.timer);p.wire.fill(0);p.reject(new HarnessError(code));}s.destroy();};
 s.on('error',()=>fail('transport'));s.on('end',()=>fail('transport'));
 s.on('data',(chunk:Buffer)=>{
  const p=active;if(!p){fail('protocol');return;}p.bytes+=chunk.length;if(p.bytes>96*1024){fail('budget');return;}
  try{const replies=p.decoder.feed(chunk);if(!replies.length)return;if(replies.length!==1)throw new HarnessError('protocol');p.decoder.finish();active=undefined;clearTimeout(p.timer);p.wire.fill(0);p.resolve(replies[0]);}catch{fail('protocol');}
 });
 return {request(args:readonly(string|Uint8Array)[]):Promise<RedisValue>{
  if(active)return Promise.reject(new HarnessError('busy'));
  if(!['AUTH','PING','INFO','SCAN','TYPE','TTL','PTTL','GET','HSCAN','SSCAN','ZSCAN','LRANGE','ZRANGE'].includes(String(args[0])))return Promise.reject(new HarnessError('command'));
  const wire=encodeRedisCommand(args);if(wire.length>8192){wire.fill(0);return Promise.reject(new HarnessError('budget'));}
  return new Promise<RedisValue>((resolve,reject)=>{active={decoder:new RedisResp2Decoder(),bytes:0,resolve,reject,wire,timer:setTimeout(()=>fail('timeout'),5000)};s.write(wire,error=>{wire.fill(0);if(error)fail('transport');});});
 },close(){fail('transport');}};
}
const report=(check:string,extra:Record<string,unknown>={})=>console.log(JSON.stringify({status:'PASS',lane:'independent-node-redis-codec-browser',check,redisSessionCovered:false,nativePluginConnected:false,...extra}));
try{
 const ca=await readFile(base+'server.crt');stage='verify-full-tls';
 try{await verifiedTls(ca);}catch(error){if(mode==='--reject-cert'&&error instanceof HarnessError&&error.code==='certificate'){report('untrusted-certificate-rejected');stage='expected-rejection';}else throw error;}
 if(stage!=='expected-rejection'){
  if(mode==='--reject-cert')throw new HarnessError('fixture');
  const client=transport(socket!);stage='harness-authentication';let passwordBytes:Buffer|undefined,password='';
  try{
   passwordBytes=await readFile(base+'password');if(!passwordBytes.length||passwordBytes.length>1025)throw new HarnessError('fixture');password=passwordBytes.toString('utf8').replace(/\r?\n$/,'');
   if(mode==='--bad-password')password+='-intentional-invalid';
   const reply=await client.request(['AUTH',password]);
   if(mode==='--bad-password'){
    if(reply.type!=='error'||!/^WRONGPASS(?:\s|$)/.test(redisText(reply.value)))throw new HarnessError('authentication');
    reply.value.fill(0);report('wrongpass-rejected');stage='expected-rejection';
   }else if(reply.type!=='simple'||redisText(reply.value)!=='OK')throw new HarnessError('authentication');
  }finally{passwordBytes?.fill(0);password='';}
  if(stage!=='expected-rejection'){
   stage='codec-browser-read';const ping=await client.request(['PING']);if(ping.type!=='simple'||redisText(ping.value)!=='PONG')throw new HarnessError('protocol');
   const browser=createRedisBrowser(client),key=new TextEncoder().encode('netcatty:tls:proof');
   const info=await browser.serverInfo(),metadata=await browser.inspectKey(key),page=await browser.readPage(key,{pageSize:10});
   if(info.fields.redis_version!=='7.4.2'||metadata.type!=='string'||metadata.ttl!==-1||metadata.pttl!==-1||page.kind!=='string'||page.value?.utf8!=='real-tls-redis')throw new HarnessError('fixture');
   let cursor='0',found=false,done=false;for(let pages=0;pages<20;pages++){const scan=await browser.scan({cursor,pageSize:100});found ||= scan.keys.some(k=>k.utf8==='netcatty:tls:proof');cursor=scan.nextCursor;if(scan.done){done=true;break;}}
   if(!found||!done)throw new HarnessError('fixture');
   if(mode==='--types'){stage='codec-browser-types';const verified=await verifyRedisFixtureTypes(browser);report('tls-browser-types',{tlsVersion:socket!.getProtocol(),tlsVerified:true,harnessAuthentication:true,...verified});}
   report('tls-auth-scan-type-get',{tlsVersion:socket!.getProtocol(),tlsVerified:true,harnessAuthentication:true,redisVersion:info.fields.redis_version,scanVerified:true,typeVerified:true,valueVerified:true,ttlVerified:true});
  }
  client.close();
 }
}catch(error){console.error(JSON.stringify({status:'FAIL',lane:'independent-node-redis-codec-browser',stage,reason:error instanceof HarnessError?error.code:'fixture',redisSessionCovered:false,nativePluginConnected:false}));process.exitCode=1;}
finally{socket?.destroy();}

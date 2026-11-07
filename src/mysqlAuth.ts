import {encodeMysqlPacket,MysqlPacketDecoder,parseMysqlHandshake,parseMysqlError,type MysqlPacket} from './mysqlProtocol';
export class MysqlAuthError extends Error {
 constructor(readonly code:'input'|'tls-required'|'unsupported'|'state'|'protocol'|'authentication'|'crypto'){super(`MySQL auth ${code}`);}
}
const fail=(code:MysqlAuthError['code']):never=>{throw new MysqlAuthError(code);};
const te=new TextEncoder();
async function sha(bytes:Uint8Array){return new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource));}
/** Shared fixed header parameters for SSLRequest and HandshakeResponse41.
 * The caller must send the returned packet unchanged before verified TLS. This
 * contract cannot attest which bytes an external transport actually sent. */
export interface MysqlSslRequestDescriptor {sequence:1;capabilities:number;characterSet:45;maxPacketBytes:number;}
const CAPS=0x200|0x800|0x8000|0x80000;
function descriptor(value:unknown):MysqlSslRequestDescriptor{
 if(!value||typeof value!=='object'||Array.isArray(value))fail('input');
 const d=value as MysqlSslRequestDescriptor;
 if(Object.keys(d).length!==4||d.sequence!==1||d.capabilities!==CAPS||d.characterSet!==45||d.maxPacketBytes!==96*1024)fail('input');
 return Object.freeze({sequence:1,capabilities:CAPS,characterSet:45,maxPacketBytes:96*1024});
}
function header(d:MysqlSslRequestDescriptor){const body=new Uint8Array(32);const view=new DataView(body.buffer);view.setUint32(0,d.capabilities,true);view.setUint32(4,d.maxPacketBytes,true);body[8]=d.characterSet;return body;}
export function planMysqlSslRequest(greeting:MysqlPacket):{descriptor:MysqlSslRequestDescriptor;packet:Uint8Array}{
 if(!greeting||greeting.sequence!==0)fail('protocol');
 let hello;try{hello=parseMysqlHandshake(greeting.payload);}catch{return fail('protocol');}
 try{if(!hello.tlsAdvertised||hello.authPlugin!=='caching_sha2_password'||(hello.capabilities&CAPS)!==CAPS)fail('unsupported');
 const d=descriptor({sequence:1,capabilities:CAPS,characterSet:45,maxPacketBytes:96*1024});const body=header(d);try{return {descriptor:d,packet:encodeMysqlPacket(body,d.sequence)};}finally{body.fill(0);}
 }finally{hello.authPluginData.fill(0);}
}
/** Pure protocol slice, not a connection API. The caller must have sent
 * SSLRequest sequence 1 and completed independently verified TLS (certificate
 * chain + hostname). verifiedTls is a precondition assertion, NOT verification.
 * Cached caching_sha2_password is supported; full auth requires explicit opt-in
 * and the SAME verified TLS stream. RSA, auth switch and downgrades always fail.
 */
export class MysqlTlsFastAuth {
 private phase:'new'|'computing'|'fast'|'ok'|'full-required'|'full-ok'|'authenticated'|'failed'|'closed'='new';
 private password!:Uint8Array;private challenge!:Uint8Array;private generation=0;
 private decoder=new MysqlPacketDecoder(3);private username!:string;private parameters!:MysqlSslRequestDescriptor;private serverCapabilities!:number;private allowFullAuth=false;
 get state(){return this.phase;}
 constructor(greeting:MysqlPacket,username:string,password:string,options:{verifiedTls:true;sslRequest:MysqlSslRequestDescriptor;allowFullAuth?:boolean}){
  if(options?.verifiedTls!==true)fail('tls-required');
  if(options.allowFullAuth!==undefined&&typeof options.allowFullAuth!=='boolean')fail('input');
  this.allowFullAuth=options.allowFullAuth===true;
  const parameters=descriptor(options.sslRequest);
  if(!greeting||greeting.sequence!==0)fail('protocol');
  let hello;try{hello=parseMysqlHandshake(greeting.payload);}catch{return fail('protocol');}
  if(!hello.tlsAdvertised||hello.authPlugin!=='caching_sha2_password') {hello.authPluginData.fill(0);fail('unsupported');}
  if(typeof username!=='string'||!username||username.length>128||!username.trim()||!/^[\x20-\x7e]+$/.test(username)||typeof password!=='string'||!password||password.length>1024||!/^[\x20-\x7e]+$/.test(password)){hello.authPluginData.fill(0);fail('input');}
  this.username=username;this.password=te.encode(password);this.challenge=hello.authPluginData;this.parameters=parameters;this.serverCapabilities=hello.capabilities;
 }
 private wipe(){this.password.fill(0);this.challenge.fill(0);this.username='';}
 private reject(code:MysqlAuthError['code']):never{if(this.phase!=='closed')this.phase='failed';++this.generation;this.wipe();try{this.decoder.finish();}catch{}return fail(code);}
 /** Returned sequence-2 wire is caller-owned; send once over verified TLS, then
  * clear it. This initial packet contains a challenge response, not password bytes. */
 async start():Promise<Uint8Array>{
  if(this.phase!=='new')return this.reject('state');this.phase='computing';const epoch=++this.generation;
  let a:Uint8Array|undefined,b:Uint8Array|undefined,c:Uint8Array|undefined,mixed:Uint8Array|undefined,token:Uint8Array|undefined,body:Uint8Array|undefined;
  const check=()=>{if(epoch!==this.generation||this.phase!=='computing')fail('state');};
  try{
   a=await sha(this.password);check();b=await sha(a);check();mixed=new Uint8Array(52);mixed.set(b);mixed.set(this.challenge,32);c=await sha(mixed);check();token=a.map((v,i)=>v^c![i]);
   // Protocol41 | SSL | SecureConnection | PluginAuth; no database, session-track,
   // multi-statements, compression, local-file or optional server extensions.
   const capabilities=this.parameters.capabilities;
   if((this.serverCapabilities&capabilities)!==capabilities)fail('unsupported');
   const user=te.encode(this.username+'\0'),plugin=te.encode('caching_sha2_password\0');body=new Uint8Array(32+user.length+1+32+plugin.length);
   body.set(header(this.parameters));body.set(user,32);let p=32+user.length;body[p++]=32;body.set(token,p);p+=32;body.set(plugin,p);
   const result=encodeMysqlPacket(body,2);this.phase='fast';return result;
  }catch(error){if((this.phase as string)==='closed')throw new MysqlAuthError('state');return this.reject(error instanceof MysqlAuthError?error.code:'crypto');}
  finally{this.challenge.fill(0);this.username='';if(this.phase!=='fast'||!this.allowFullAuth)this.password.fill(0);a?.fill(0);b?.fill(0);c?.fill(0);mixed?.fill(0);token?.fill(0);body?.fill(0);}
 }
 /** Feed server bytes: cached 01 03 -> idle OK, or opt-in 01 04 ->
  * explicit TLS password response -> idle OK. No immediate OK shortcut.
  * TLS remains essential: caching_sha2 fast auth has no SCRAM-like server proof. */
 receive(chunk:Uint8Array):'pending'|'authenticated'|'full-auth-required'{
  if(!['fast','ok','full-ok'].includes(this.phase))return this.reject('state');
  let packets:MysqlPacket[]=[];
  try{
   packets=this.decoder.feed(chunk);
   for(const packet of packets){const p=packet.payload;
    if(p[0]===255){try{parseMysqlError(p);}catch{fail('protocol');}fail('authentication');}
    if(this.phase==='fast'){
     if(p.length===2&&p[0]===1&&p[1]===4){if(!this.allowFullAuth)fail('unsupported');this.phase='full-required';continue;}
     if(p.length!==2||p[0]!==1||p[1]!==3)fail('protocol');this.password.fill(0);this.phase='ok';
    }else if(this.phase==='ok'||this.phase==='full-ok'){
     // affected_rows=0, last_insert_id=0, status flags + warnings; no extra data.
     if(p.length!==7||p[0]!==0||p[1]!==0||p[2]!==0||p[3]!==2||p[4]!==0||p[5]!==0||p[6]!==0)fail('protocol');this.phase='authenticated';
    }else fail('protocol');
   }
   if(this.phase==='authenticated'){this.decoder.finish();this.wipe();return 'authenticated';}
   if(this.phase==='full-required'){this.decoder.finish();this.decoder=new MysqlPacketDecoder(5);return 'full-auth-required';}return 'pending';
  }catch(error){return this.reject(error instanceof MysqlAuthError?error.code:'protocol');}
  finally{for(const packet of packets)packet.payload.fill(0);}
 }
 /** Explicit opt-in full authentication only within the SAME verified TLS session.
  * Caller owns returned sequence-4 NUL-password packet and must wipe after write.
  * Never send through raw TCP, RSA key exchange, a new socket or a downgrade. */
 fullAuthResponse():Uint8Array{
  if(this.phase!=='full-required'||!this.allowFullAuth)return this.reject('state');
  const payload=new Uint8Array(this.password.length+1);payload.set(this.password);
  try{const wire=encodeMysqlPacket(payload,4);this.phase='full-ok';return wire;}
  finally{payload.fill(0);this.password.fill(0);}
 }
 close(){this.phase='closed';++this.generation;this.wipe();try{this.decoder.finish();}catch{}}
}

import {encodeMysqlPacket,MysqlPacketDecoder,parseMysqlHandshake,parseMysqlError,type MysqlPacket} from './mysqlProtocol';
export class MysqlAuthError extends Error {
 constructor(readonly code:'input'|'tls-required'|'unsupported'|'state'|'protocol'|'authentication'|'crypto'){super(`MySQL auth ${code}`);}
}
const fail=(code:MysqlAuthError['code']):never=>{throw new MysqlAuthError(code);};
const te=new TextEncoder();
async function sha(bytes:Uint8Array){return new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource));}
/** Pure protocol slice, not a connection API. The caller must have sent
 * SSLRequest sequence 1 and completed independently verified TLS (certificate
 * chain + hostname). verifiedTls is a precondition assertion, NOT verification.
 * Only cached caching_sha2_password fast authentication is supported. Full-auth
 * requests, RSA key exchange, auth switch and all password downgrade paths fail.
 */
export class MysqlTlsFastAuth {
 private phase:'new'|'computing'|'fast'|'ok'|'authenticated'|'failed'|'closed'='new';
 private password!:Uint8Array;private challenge!:Uint8Array;private generation=0;
 private decoder=new MysqlPacketDecoder(3);private username!:string;private charset!:number;private serverCapabilities!:number;
 get state(){return this.phase;}
 constructor(greeting:MysqlPacket,username:string,password:string,options:{verifiedTls:true}){
  if(options?.verifiedTls!==true)fail('tls-required');
  if(!greeting||greeting.sequence!==0)fail('protocol');
  let hello;try{hello=parseMysqlHandshake(greeting.payload);}catch{return fail('protocol');}
  if(!hello.tlsAdvertised||hello.authPlugin!=='caching_sha2_password') {hello.authPluginData.fill(0);fail('unsupported');}
  if(typeof username!=='string'||!username||username.length>128||!username.trim()||!/^[\x20-\x7e]+$/.test(username)||typeof password!=='string'||!password||password.length>1024||!/^[\x20-\x7e]+$/.test(password)){hello.authPluginData.fill(0);fail('input');}
  this.username=username;this.password=te.encode(password);this.challenge=hello.authPluginData;this.charset=hello.characterSet;this.serverCapabilities=hello.capabilities;
 }
 private wipe(){this.password.fill(0);this.challenge.fill(0);this.username='';}
 private reject(code:MysqlAuthError['code']):never{this.phase='failed';++this.generation;this.wipe();try{this.decoder.finish();}catch{}return fail(code);}
 /** Returned sequence-2 wire is caller-owned; send once over verified TLS, then
  * clear it. It includes username and a challenge response, never password bytes. */
 async start():Promise<Uint8Array>{
  if(this.phase!=='new')return this.reject('state');this.phase='computing';const epoch=++this.generation;
  let a:Uint8Array|undefined,b:Uint8Array|undefined,c:Uint8Array|undefined,mixed:Uint8Array|undefined,token:Uint8Array|undefined,body:Uint8Array|undefined;
  const check=()=>{if(epoch!==this.generation||this.phase!=='computing')fail('state');};
  try{
   a=await sha(this.password);check();b=await sha(a);check();mixed=new Uint8Array(52);mixed.set(b);mixed.set(this.challenge,32);c=await sha(mixed);check();token=a.map((v,i)=>v^c![i]);
   // Protocol41 | SSL | SecureConnection | PluginAuth; no database, session-track,
   // multi-statements, compression, local-file or optional server extensions.
   const capabilities=0x200|0x800|0x8000|0x80000;
   if((this.serverCapabilities&capabilities)!==capabilities)fail('unsupported');
   const user=te.encode(this.username+'\0'),plugin=te.encode('caching_sha2_password\0');body=new Uint8Array(32+user.length+1+32+plugin.length);
   const view=new DataView(body.buffer);view.setUint32(0,capabilities,true);view.setUint32(4,96*1024,true);body[8]=this.charset;body.set(user,32);let p=32+user.length;body[p++]=32;body.set(token,p);p+=32;body.set(plugin,p);
   const result=encodeMysqlPacket(body,2);this.phase='fast';return result;
  }catch(error){if((this.phase as string)==='closed')throw new MysqlAuthError('state');return this.reject(error instanceof MysqlAuthError?error.code:'crypto');}
  finally{this.wipe();a?.fill(0);b?.fill(0);c?.fill(0);mixed?.fill(0);token?.fill(0);body?.fill(0);}
 }
 /** Feed server bytes; authenticates only after 01 03 then a bounded, idle OK.
  * TLS remains essential: caching_sha2 fast auth has no SCRAM-like server proof. */
 receive(chunk:Uint8Array):'pending'|'authenticated'{
  if(!['fast','ok'].includes(this.phase))return this.reject('state');
  let packets:MysqlPacket[]=[];
  try{
   packets=this.decoder.feed(chunk);
   for(const packet of packets){const p=packet.payload;
    if(p[0]===255){try{parseMysqlError(p);}catch{fail('protocol');}fail('authentication');}
    if(this.phase==='fast'){
     if(p.length===2&&p[0]===1&&p[1]===4)fail('unsupported');
     if(p.length!==2||p[0]!==1||p[1]!==3)fail('protocol');this.phase='ok';
    }else if(this.phase==='ok'){
     // affected_rows=0, last_insert_id=0, status flags + warnings; no extra data.
     if(p.length!==7||p[0]!==0||p[1]!==0||p[2]!==0||p[3]!==2||p[4]!==0||p[5]!==0||p[6]!==0)fail('protocol');this.phase='authenticated';
    }else fail('protocol');
   }
   if(this.phase==='authenticated'){this.decoder.finish();return 'authenticated';}return 'pending';
  }catch(error){return this.reject(error instanceof MysqlAuthError?error.code:'protocol');}
  finally{for(const packet of packets)packet.payload.fill(0);}
 }
 close(){this.phase='closed';++this.generation;this.wipe();try{this.decoder.finish();}catch{}}
}

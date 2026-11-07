/** SCRAM-SHA-256 (RFC 5802/7677), no network/TLS or channel binding.
 * ASCII-only credentials deliberately fail closed until SASLprep is implemented.
 * Must run only over independently verified TLS. Never downgrade from PLUS-required.
 */
export class PostgresScramError extends Error {constructor(readonly code:'state'|'input'|'protocol'|'limit'|'server-rejected'|'signature'|'crypto'){super(`PG SCRAM ${code}`);}}
const fail=(code:PostgresScramError['code']):never=>{throw new PostgresScramError(code);};
const utf8=new TextEncoder();
const base64=(b:Uint8Array)=>btoa(String.fromCharCode(...b));
function unbase64(s:string){if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s))fail('protocol');let raw:string;try{raw=atob(s);}catch{return fail('protocol');}const b=Uint8Array.from(raw,c=>c.charCodeAt(0));if(base64(b)!==s)fail('protocol');return b;}
function fields(s:string,keys:string[]){if(typeof s!=='string'||s.length>2048||!/^[\x21-\x7e]+$/.test(s))fail('protocol');const parts=s.split(',');if(parts.length!==keys.length)fail('protocol');return parts.map((part,i)=>{if(!part.startsWith(keys[i]+'=')||part.length===2)fail('protocol');return part.slice(2);});}
async function hmac(key:Uint8Array,data:Uint8Array){const k=await crypto.subtle.importKey('raw',key as BufferSource,{name:'HMAC',hash:'SHA-256'},false,['sign']);return new Uint8Array(await crypto.subtle.sign('HMAC',k,data as BufferSource));}
async function sha(data:Uint8Array){return new Uint8Array(await crypto.subtle.digest('SHA-256',data as BufferSource));}
export class PostgresScramClient {
 private phase:'new'|'server-first'|'computing'|'server-final'|'verified'|'failed'|'closed'='new';
 private password:Uint8Array;private expected?:Uint8Array;private generation=0;private bare='';private readonly nonce!:string;
 get state(){return this.phase;}
 /** nonceOverride exists for deterministic protocol tests; production omits it. */
 constructor(private readonly username:string,password:string,nonceOverride?:string){
  if(typeof username!=='string'||!username||username.length>128||!/^[\x20-\x7e]+$/.test(username)||typeof password!=='string'||!password||password.length>1024||!/^[\x20-\x7e]+$/.test(password))fail('input');
  this.password=utf8.encode(password);
  try{this.nonce=nonceOverride??base64(crypto.getRandomValues(new Uint8Array(24)));}catch{this.password.fill(0);return fail('crypto');}
  if(this.nonce.length<16||this.nonce.length>128||!/^[\x21-\x2b\x2d-\x7e]+$/.test(this.nonce)){this.password.fill(0);fail('input');}
 }
 private reject(code:PostgresScramError['code']):never{this.phase='failed';this.password.fill(0);this.expected?.fill(0);this.expected=undefined;++this.generation;return fail(code);}
 start():{mechanism:'SCRAM-SHA-256';message:string}{
  if(this.phase!=='new')return this.reject('state');
  this.bare=`n=${this.username.replaceAll('=','=3D').replaceAll(',','=2C')},r=${this.nonce}`;this.phase='server-first';return {mechanism:'SCRAM-SHA-256',message:'n,,'+this.bare};
 }
 async receiveServerFirst(message:string):Promise<string>{
  if(this.phase!=='server-first')return this.reject('state');this.phase='computing';const generation=++this.generation;
  let salted:Uint8Array|undefined,clientKey:Uint8Array|undefined,serverKey:Uint8Array|undefined;
  try{
   const [nonce,saltText,iterationText]=fields(message,['r','s','i']);
   if(!nonce.startsWith(this.nonce)||nonce.length<=this.nonce.length||nonce.length>256||!/^[\x21-\x2b\x2d-\x7e]+$/.test(nonce))fail('protocol');
   if(!/^[1-9][0-9]{0,5}$/.test(iterationText))fail('limit');const iterations=Number(iterationText);if(iterations<4096||iterations>100000)fail('limit');
   const salt=unbase64(saltText);if(salt.length<8||salt.length>64)fail('limit');
   const key=await crypto.subtle.importKey('raw',this.password as BufferSource,'PBKDF2',false,['deriveBits']);
   salted=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:salt as BufferSource,iterations},key,256));
   clientKey=await hmac(salted,utf8.encode('Client Key'));serverKey=await hmac(salted,utf8.encode('Server Key'));
   const final=`c=biws,r=${nonce}`,auth=utf8.encode(`${this.bare},${message},${final}`);
   const signature=await hmac(await sha(clientKey),auth),proof=clientKey.map((v,i)=>v^signature[i]);
   const expected=await hmac(serverKey,auth);
   if(generation!==this.generation||this.phase!=='computing'){expected.fill(0);proof.fill(0);fail('state');}
   this.expected=expected;this.phase='server-final';const result=final+',p='+base64(proof);proof.fill(0);return result;
  }catch(e){return this.reject(e instanceof PostgresScramError?e.code:'crypto');}
  finally{this.password.fill(0);salted?.fill(0);clientKey?.fill(0);serverKey?.fill(0);}
 }
 receiveServerFinal(message:string):void{
  if(this.phase!=='server-final'||!this.expected)return this.reject('state');
  try{
   if(typeof message==='string'&&message.startsWith('e=')){fields(message,['e']);fail('server-rejected');}
   const [value]=fields(message,['v']),signature=unbase64(value);if(signature.length!==32)fail('signature');let different=0;for(let i=0;i<32;i++)different|=signature[i]^this.expected[i];if(different)fail('signature');
   this.expected.fill(0);this.expected=undefined;this.phase='verified';
  }catch(e){this.reject(e instanceof PostgresScramError?e.code:'protocol');}
 }
 close(){++this.generation;this.password.fill(0);this.expected?.fill(0);this.expected=undefined;this.phase='closed';}
}

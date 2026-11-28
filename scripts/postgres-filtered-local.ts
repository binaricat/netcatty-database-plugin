/** Explicit manual real-server test only; never imported by the plugin.
 * Copies the existing local-protocol harness SSLRequest / verify-full TLS lane.
 * This Node transport is NOT the main plugin broker and proves no native PG access.
 * No DDL / seed / arbitrary SQL: only bounded filtered reads of the existing fixture.
 * Run: node --import tsx scripts/postgres-filtered-local.ts
 */
import net from 'node:net';
import tls from 'node:tls';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import type {PluginByteConnection} from '@netcatty/plugin-sdk';
import {authenticatePostgresTls} from '../src/postgresSession';
import {executePostgresFilteredRead} from '../src/postgresFilteredRead';
import assert from 'node:assert/strict';
const hostname='127.0.0.1',port=15432;
const base=fileURLToPath(new URL('../../local-db-host/pg-test/',import.meta.url));
if(process.argv.length!==2){console.error('This fixture harness accepts no arguments.');process.exit(2);}
let raw:net.Socket|undefined,secure:tls.TLSSocket|undefined,connection:PluginByteConnection|undefined;
let stage='fixture-files';
let tlsFailure:'certificate-rejected'|'connection-refused'|'connection-timeout'|'other'|undefined;
function openVerifiedTls(ca:Buffer):Promise<tls.TLSSocket>{
 return new Promise((resolve,reject)=>{
  let settled=false;const deadline=setTimeout(()=>fail(),10000);
  const fail=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(deadline);raw?.destroy();secure?.destroy();const code=(error as NodeJS.ErrnoException|undefined)?.code;const certificateRejected=typeof code==='string'&&['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED'].includes(code);tlsFailure=certificateRejected?'certificate-rejected':code==='ECONNREFUSED'?'connection-refused':code==='ETIMEDOUT'||!error?'connection-timeout':'other';reject(new Error(certificateRejected?'Fixture certificate rejected':'TLS fixture handshake failed'));};
  raw=net.createConnection({host:hostname,port});raw.on('error',fail);
  raw.once('connect',()=>{
   // Int32 length 8, protocol request code 80877103. No user/password is sent yet.
   raw!.write(Buffer.from([0,0,0,8,4,210,22,47]));
  });
  raw.once('data',reply=>{
   if(reply.length!==1||reply[0]!==83){fail();return;}
   secure=tls.connect({socket:raw!,ca:[ca],rejectUnauthorized:true,minVersion:'TLSv1.2',
    // No SNI for an IP. Explicit hostname verification must check this exact IP.
    checkServerIdentity:(_ignored,cert)=>tls.checkServerIdentity(hostname,cert)});
   secure.on('error',fail);
   secure.once('secureConnect',()=>{
    // Repeat identity validation explicitly, independent of TLS callback behavior.
    if(!secure!.authorized||tls.checkServerIdentity(hostname,secure!.getPeerCertificate())){fail();return;}
    if(settled){secure!.destroy();return;}settled=true;clearTimeout(deadline);resolve(secure!);
   });
  });
 });
}
function brokerShape(socket:tls.TLSSocket):PluginByteConnection{
 const queue:Uint8Array[]=[];let queued=0,closed=false,pending:((b:Uint8Array|null)=>void)|undefined;
 const close=()=>{if(closed)return;closed=true;for(const b of queue)b.fill(0);queue.length=0;queued=0;pending?.(null);pending=undefined;socket.destroy();};
 socket.on('data',(data:Buffer)=>{
  if(closed)return;const chunk=new Uint8Array(data);if(pending){const resolve=pending;pending=undefined;resolve(chunk);return;}
  queued+=chunk.length;if(queued>96*1024){chunk.fill(0);close();return;}queue.push(chunk);
 });
 socket.on('error',close);socket.on('end',close);socket.on('close',close);
 return {readable:{read:async()=>{if(queue.length){const b=queue.shift()!;queued-=b.length;return b;}if(closed)return null;if(pending)throw new Error('Concurrent fixture read');return new Promise<Uint8Array|null>(resolve=>{pending=resolve;});},cancel:close},
 writable:{write:async(value:Uint8Array|ArrayBuffer)=>{if(closed)throw new Error('Fixture closed');const b=Buffer.from(value instanceof Uint8Array?value:new Uint8Array(value));try{await new Promise<void>((resolve,reject)=>socket.write(b,error=>error?reject(new Error('Fixture write failed')):resolve()));}finally{b.fill(0);}},cancel:close},close:async()=>{close();}} as unknown as PluginByteConnection;
}
try {
 const ca=await readFile(base+'server.crt');stage='verify-full-tls';
 secure=await openVerifiedTls(ca);connection=brokerShape(secure);stage='scram-startup';
 let passwordBytes:Buffer|undefined;let password='';
 try {
  passwordBytes=await readFile(base+'password');
  if(passwordBytes.length<1||passwordBytes.length>1025)throw new Error('Invalid fixture credential');
  password=passwordBytes.toString('utf8').replace(/\r?\n$/,'');
  await authenticatePostgresTls(connection,{user:'netcatty_test',database:'postgres',password,timeoutMs:5000});
 } finally {passwordBytes?.fill(0);password='';}
 const checks:string[]=[];
 const read=async(filters:Array<{column:string;value:string|null}>)=>{
  const result=await executePostgresFilteredRead(connection!,{schema:'public',table:'netcatty_smoke',columns:['id','label','optional_value'],filters,limit:10});
  assert.equal(result.transactionStatus,'I');assert.equal(result.valueFormat,'postgres-text');
  assert.deepEqual(result.typeOids,[23,25,25]);return result;
 };
 stage='bound-string';
 const stringResult=await read([{column:'label',value:'real-ssh-real-postgres'}]);
 assert.ok(stringResult.rows.some(row=>row[0]==='1'&&row[1]==='real-ssh-real-postgres'&&row[2]===null));
 checks.push('string-bind','int4-returned-as-exact-text','ready-idle-after-string');
 stage='bound-null';
 const nullResult=await read([{column:'optional_value',value:null},{column:'id',value:'1'}]);
 assert.deepEqual(nullResult.rows,[['1','real-ssh-real-postgres',null]]);
 checks.push('null-bind-is-not-distinct-from','ready-idle-after-null');
 stage='bound-injection-string';
 const injectionResult=await read([{column:'label',value:"' OR TRUE; DROP TABLE public.netcatty_smoke; --"}]);
 assert.equal(injectionResult.rowCount,0);assert.deepEqual(injectionResult.rows,[]);
 checks.push('sql-looking-value-remains-bound-text','ready-idle-after-empty-result');
 stage='read-after-injection';
 const finalResult=await read([{column:'id',value:'1'}]);
 assert.deepEqual(finalResult.rows,[['1','real-ssh-real-postgres',null]]);
 checks.push('same-connection-reusable','fixture-row-still-readable');
 console.log(JSON.stringify({status:'PASS',lane:'independent-node-extended-protocol',tlsVerified:true,tlsVersion:secure.getProtocol(),scram:true,checks,queries:4,transactionStatus:'I',nativePluginConnected:false,largeNumericPrecisionRealServerVerified:false}));
} catch {
 // Do not expose server errors, assertions with row contents, or credentials.
 console.error(JSON.stringify({status:'FAIL',lane:'independent-node-extended-protocol',stage,tlsFailure,nativePluginConnected:false}));process.exitCode=1;
} finally {await connection?.close();secure?.destroy();raw?.destroy();}

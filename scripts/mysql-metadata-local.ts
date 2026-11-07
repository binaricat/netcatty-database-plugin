/** MANUAL real-service metadata lane, not plugin main transport. No SQL interpolation,
 * no raw server diagnostics. Strict TLS/auth adapter copied from approved local
 * protocol harness; run explicitly: node --import tsx scripts/mysql-metadata-local.ts
 */
import type {PluginByteConnection} from '@netcatty/plugin-sdk';
import {executeMysqlRead,MysqlReadError} from '../src/mysqlRead';
import {createMysqlMetadataClient,MysqlMetadataError} from '../src/mysqlMetadata';
import {parseMysqlPreparedColumn} from '../src/mysqlPreparedProtocol';
import {executeMysqlMetadataPreparedRead,MysqlPreparedReadError} from '../src/mysqlPreparedRead';
import type {MysqlPreparedSelect} from '../src/mysqlPreparedProtocol';
import net from 'node:net';import tls from 'node:tls';import {readFile} from 'node:fs/promises';import {fileURLToPath} from 'node:url';
import {MysqlPacketDecoder,parseMysqlHandshake,parseMysqlError,type MysqlPacket} from '../src/mysqlProtocol';
import {planMysqlSslRequest,MysqlTlsFastAuth} from '../src/mysqlAuth';
const base=fileURLToPath(new URL('../../local-db-host/mysql-test/',import.meta.url));
const host='127.0.0.1',port=15479;const mode:string='metadata';
if(process.argv.length!==2){console.error('This metadata fixture takes no arguments.');process.exit(2);}
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

// Read-only diagnostic observer: records only fixed field names, booleans and
// numeric wire metadata. Never records schema/table names, values or payloads.
let expectation:{schema:string;table:string;columns:string[]}={schema:'information_schema',table:'TABLES',columns:[]};
let metadataDiagnostics:Array<{type:number;charset:number;flags:number;labelExpected:boolean;schemaMatches:boolean;schemaCategory:string;tableMatches:boolean;originalTableMatches:boolean;originalNameExpected:boolean}>=[];
function observe(connection:PluginByteConnection):PluginByteConnection{
 let decoder=new MysqlPacketDecoder(1);
 return {...connection,writable:{...connection.writable,write:async value=>{decoder=new MysqlPacketDecoder(1);await connection.writable.write(value);}},readable:{...connection.readable,read:async()=>{
  const b=await connection.readable.read();if(b)try{const packets=decoder.feed(b);try{for(const packet of packets){try{const c=parseMysqlPreparedColumn(packet.payload);if(metadataDiagnostics.length<32)metadataDiagnostics.push({type:c.type,charset:c.charset,flags:c.flags,labelExpected:expectation.columns.includes(c.name),schemaMatches:c.schema===expectation.schema,schemaCategory:c.schema===''?'empty':['information_schema','mysql'].includes(c.schema)?c.schema:'other',tableMatches:c.table===expectation.table,originalTableMatches:c.originalTable===expectation.table,originalNameExpected:expectation.columns.includes(c.originalName)});}catch{}}}finally{for(const packet of packets)packet.payload.fill(0);}}catch{}return b;
 }}} as PluginByteConnection;
}
let connection:PluginByteConnection|undefined;
try{
 const ca=await readFile(base+'server.crt');stage='server-greeting';const packet=await greeting();const hello=parseMysqlHandshake(packet.payload);const serverVersion=hello.serverVersion;hello.authPluginData.fill(0);if(!/^8\.4\.7(?:-|$)/.test(serverVersion))throw new FixtureError('fixture');
 const plan=planMysqlSslRequest(packet);stage='ssl-request';await write(raw!,plan.packet);stage='verify-full-tls';await upgrade(ca);
 stage='authentication';let secret:Buffer|undefined,password='';let fullAuth=false;
 try{secret=await readFile(base+'password');if(!secret.length||secret.length>1025)throw new FixtureError('fixture');password=secret.toString('utf8').replace(/\r?\n$/,'');auth=new MysqlTlsFastAuth(packet,'netcatty_test',password,{verifiedTls:true,sslRequest:plan.descriptor,allowFullAuth:true});const wire=await auth.start();packet.payload.fill(0);fullAuth=(await authenticate(secure!,auth,wire)).fullAuth;}finally{secret?.fill(0);password='';}
 connection=observe(readConnection(secure!));
 let lastPreparedDiagnostic:unknown;
 const metadata=createMysqlMetadataClient(connection,async(c,options)=>{
  expectation={schema:options.schema,table:options.table,columns:[...options.columns]};metadataDiagnostics=[];
  try{return await executeMysqlMetadataPreparedRead(c,options);}catch(error){if(error instanceof MysqlPreparedReadError)lastPreparedDiagnostic=error.diagnostic;throw error;}
 });
 // The fixed callback never emits server text; retain only known diagnostic keys.
 const failFixture=()=>{throw new FixtureError('fixture');};
 try{
  stage='metadata-tables';const tables=await metadata.tables({schema:'netcatty_test'});if(tables.possiblyTruncated||!tables.tables.some(t=>t.name==='netcatty_smoke'&&t.kind==='table'&&t.engine==='InnoDB'))failFixture();
  stage='metadata-columns';const cols=await metadata.columns({schema:'netcatty_test',table:'netcatty_smoke'});const id=cols.columns.find(c=>c.name==='id'),label=cols.columns.find(c=>c.name==='label'),optional=cols.columns.find(c=>c.name==='optional_value');
  if(cols.possiblyTruncated||cols.columns.length!==3||!id||id.dataType!=='int'||id.nullable||!label||label.dataType!=='varchar'||!label.nullable||!optional||optional.dataType!=='text'||!optional.nullable)failFixture();
  stage='metadata-indexes';const indexes=await metadata.indexes({schema:'netcatty_test',table:'netcatty_smoke'});if(indexes.possiblyTruncated||!indexes.parts.some(p=>p.name==='PRIMARY'&&p.unique&&p.position===1&&p.column==='id'&&p.expression===null&&p.indexType==='BTREE'))failFixture();
  stage='metadata-bound-name';const nonexistent=await metadata.columns({schema:'netcatty_test',table:"x' OR 1=1; --"});if(nonexistent.columns.length!==0||nonexistent.possiblyTruncated)failFixture();
  stage='ordinary-read-reuse';expectation={schema:'netcatty_test',table:'netcatty_smoke',columns:['id','label','optional_value']};metadataDiagnostics=[];
  const result=await executeMysqlRead(connection,{...expectation,limit:10});if(JSON.stringify(result.rows)!==JSON.stringify([['1','real-tls-mysql',null]]))failFixture();
  console.log(JSON.stringify({status:'PASS',lane:'independent-node-mysql-metadata',metadataCovered:true,tableVerified:true,columnsVerified:true,primaryIndexVerified:true,boundSqlLookingNameZeroRows:true,sameConnectionReadVerified:true,tlsVerified:true,tlsVersion:secure!.getProtocol(),serverVersion,authFlow:fullAuth?'full':'fast',nativePluginConnected:false}));
 }catch(error){console.error(JSON.stringify({status:'FAIL',lane:'independent-node-mysql-metadata',stage,reason:error instanceof MysqlMetadataError?error.code:error instanceof MysqlReadError?error.code:'fixture',preparedDiagnostic:lastPreparedDiagnostic,metadataDiagnostics,nativePluginConnected:false}));process.exitCode=1;}
}catch(error){console.error(JSON.stringify({status:'FAIL',lane:'independent-node-mysql-metadata',stage,reason:error instanceof FixtureError?error.code:'fixture',nativePluginConnected:false}));process.exitCode=1;}
finally{await connection?.close();auth?.close();secure?.destroy();raw?.destroy();}

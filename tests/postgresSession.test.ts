import test from 'node:test';
import assert from 'node:assert/strict';
import {pbkdf2Sync,createHmac} from 'node:crypto';
import type {PluginByteConnection} from '@netcatty/plugin-sdk';
import {PostgresScramClient} from '../src/postgresScram';
import {authenticatePostgresTls} from '../src/postgresSession';
const opts={user:'user',database:'fixture',password:'pencil',timeoutMs:1000};
const bytes=(s:string)=>new TextEncoder().encode(s);
function frame(tag:string,body:Uint8Array){const b=new Uint8Array(5+body.length);b[0]=tag.charCodeAt(0);new DataView(b.buffer).setInt32(1,body.length+4);b.set(body,5);return b;}
function auth(n:number,s=''){const b=new Uint8Array(4+bytes(s).length);new DataView(b.buffer).setInt32(0,n);b.set(bytes(s),4);return frame('R',b);}
function harness(reply:(wire:Uint8Array,push:(b:Uint8Array)=>void)=>void,fragment=false){
 const queue:Uint8Array[]=[];let waiting:((v:Uint8Array|null)=>void)|undefined;let closes=0,writes=0;
 const push=(b:Uint8Array)=>{for(const item of fragment?Array.from(b,v=>new Uint8Array([v])):[b]){if(waiting){const cb=waiting;waiting=undefined;cb(item);}else queue.push(item);}};
 const connection={readable:{read:()=>queue.length?Promise.resolve(queue.shift()!):new Promise<Uint8Array|null>(r=>waiting=r),cancel:()=>{waiting?.(null);waiting=undefined;}},writable:{write:async(b:Uint8Array)=>{writes++;reply(b.slice(),push);},cancel:()=>{}},close:async()=>{closes++;}} as unknown as PluginByteConnection;
 return {connection,get closes(){return closes;},get writes(){return writes;}};
}
function server(badSignature=false,tail:Uint8Array[]=[],fragment=false){let step=0,bare='',serverFirst='';return harness((wire,push)=>{
 if(step++===0){push(auth(10,'SCRAM-SHA-256\0\0'));return;}
 if(step===2){const start=wire.indexOf(0,5)+5;const first=new TextDecoder().decode(wire.slice(start));bare=first.slice(3);const nonce=bare.slice(bare.indexOf(',r=')+3);serverFirst=`r=${nonce}server,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096`;push(auth(11,serverFirst));return;}
 const final=new TextDecoder().decode(wire.slice(5));const withoutProof=final.slice(0,final.lastIndexOf(',p='));
 const salt=Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==','base64'),key=pbkdf2Sync('pencil',salt,4096,32,'sha256');
 const serverKey=createHmac('sha256',key).update('Server Key').digest();const sig=createHmac('sha256',serverKey).update(`${bare},${serverFirst},${withoutProof}`).digest('base64');
 push(auth(12,'v='+(badSignature?'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=':sig)));push(auth(0));
 for(const f of tail)push(f);push(frame('K',new Uint8Array(8)));push(frame('Z',bytes('I')));
 },fragment);}
test('offline broker-shaped fragmented SCRAM startup verifies signature then Ok then idle Ready',async()=>{
 const h=server(false,[frame('S',bytes('client_encoding\0UTF8\0'))],true);
 assert.deepEqual(await authenticatePostgresTls(h.connection,opts),{status:'ready',transactionStatus:'I'});assert.equal(h.writes,3);assert.equal(h.closes,0);
});
test('bad server verifier is not accepted and closes without exposing payload',async()=>{
 const h=server(true);await assert.rejects(authenticatePostgresTls(h.connection,opts),{message:'PG startup authentication'});assert.equal(h.closes,1);
});
test('unexpected methods, PLUS-only, early ready and error fail closed',async()=>{
 for(const f of [auth(0),auth(3),auth(11,'secret'),auth(10,'SCRAM-SHA-256-PLUS\0\0'),frame('Z',bytes('I')),frame('E',bytes('Mprivate-server-secret\0\0'))]){
 const h=harness((_,push)=>push(f));await assert.rejects(authenticatePostgresTls(h.connection,opts),e=>e instanceof Error&&!/secret|pencil/.test(e.message));assert.equal(h.closes,1);
 }
});
test('duplicate authentication and non-idle final state rejected',async()=>{
 const h=server(false,[auth(0)]);await assert.rejects(authenticatePostgresTls(h.connection,opts),{message:'PG startup sequence'});
 const h2=server(false,[frame('Z',bytes('T'))]);await assert.rejects(authenticatePostgresTls(h2.connection,opts),{message:'PG startup sequence'});
});
test('timeout and explicit abort cancel/close pending reads; pre-abort sends nothing',async()=>{
 const h=harness(()=>{});await assert.rejects(authenticatePostgresTls(h.connection,{...opts,timeoutMs:5}),{message:'PG startup timeout'});assert.equal(h.closes,1);
 const ctrl=new AbortController();ctrl.abort();const h2=harness(()=>{});await assert.rejects(authenticatePostgresTls(h2.connection,{...opts,signal:ctrl.signal}),{message:'PG startup aborted'});assert.equal(h2.writes,0);
});
test('oversized frame/total bytes and excess metadata are bounded',async()=>{
 const huge=new Uint8Array(5);huge[0]=82;new DataView(huge.buffer).setInt32(1,32769);
 for(const input of [huge,new Uint8Array(96*1024+1)]){const h=harness((_,push)=>push(input));await assert.rejects(authenticatePostgresTls(h.connection,opts),{message:'PG startup limit'});}
 const h=server(false,Array.from({length:65},()=>frame('S',bytes('x\0y\0'))));await assert.rejects(authenticatePostgresTls(h.connection,opts),{message:'PG startup limit'});
});
test('abort during startup and transport failures use fixed errors and cleanup',async()=>{
 const ctrl=new AbortController();const h=harness(()=>{});const pending=authenticatePostgresTls(h.connection,{...opts,signal:ctrl.signal});ctrl.abort();await assert.rejects(pending,{message:'PG startup aborted'});assert.equal(h.closes,1);
 const h2=harness(()=>{throw new Error('private-password');});await assert.rejects(authenticatePostgresTls(h2.connection,opts),{message:'PG startup transport'});assert.equal(h2.closes,1);
 const h3=harness(()=>{});h3.connection.readable.read=async()=>null;await assert.rejects(authenticatePostgresTls(h3.connection,opts),{message:'PG startup protocol'});
});
test('infinite empty microtask stream fails on first read and releases resources',async()=>{
 const h=harness(()=>{});let reads=0,cancels=0;
 h.connection.readable.read=async()=>{reads++;return new Uint8Array(0);};
 h.connection.readable.cancel=()=>{cancels++;};
 await assert.rejects(authenticatePostgresTls(h.connection,opts),{message:'PG startup protocol'});
 assert.equal(reads,1);assert.equal(cancels,1);assert.equal(h.closes,1);
});
test('single-byte microtask stream has read budget even before frame completes',async(t)=>{
 t.mock.method(performance,'now',()=>0);
 const h=harness(()=>{});let reads=0;
 // A large but admissible partial R frame, followed by indefinitely resolved bytes.
 const header=Uint8Array.of(82,0,0,127,255);
 h.connection.readable.read=async()=>Uint8Array.of(reads<header.length?header[reads++]: (reads++,0));
 await assert.rejects(authenticatePostgresTls(h.connection,{...opts,timeoutMs:10000}),{message:'PG startup limit'});
 assert.equal(reads,4096);assert.equal(h.closes,1);
});
test('monotonic deadline interrupts microtask stream without waiting for timer',async(t)=>{
 let now=0,reads=0; t.mock.method(performance,'now',()=>now);
 const h=harness(()=>{});h.connection.readable.read=async()=>{now+=2;reads++;return Uint8Array.of(82);};
 await assert.rejects(authenticatePostgresTls(h.connection,{...opts,timeoutMs:5}),{message:'PG startup timeout'});
 assert.equal(reads,3);assert.equal(h.closes,1);
});

test('deadline rechecked after SCRAM computation; no late proof write',async(t)=>{
 let now=0;t.mock.method(performance,'now',()=>now);
 const original=PostgresScramClient.prototype.receiveServerFirst;
 t.mock.method(PostgresScramClient.prototype,'receiveServerFirst',async function(this:PostgresScramClient,message:string){
  const proof=await original.call(this,message);now=1001;return proof;
 });
 const h=server();await assert.rejects(authenticatePostgresTls(h.connection,opts),{message:'PG startup timeout'});
 assert.equal(h.writes,2);assert.equal(h.closes,1);
});
test('hung write is wiped on timeout; late resolution/rejection cannot write again',async()=>{
 for(const rejectLate of [false,true]){
 const h=harness(()=>{});let wire:Uint8Array|undefined,writes=0,resolve!:()=>void,reject!:(e:Error)=>void;
 h.connection.writable.write=(value)=>{wire=value instanceof Uint8Array?value:new Uint8Array(value);writes++;return new Promise<void>((yes,no)=>{resolve=yes;reject=no;});};
 await assert.rejects(authenticatePostgresTls(h.connection,{...opts,timeoutMs:5}),{message:'PG startup timeout'});
 assert.ok(wire?.length);assert.ok(wire!.every(v=>v===0));assert.equal(h.closes,1);
 if(rejectLate)reject(new Error('private-secret'));else resolve();
 await new Promise(r=>setTimeout(r,0));assert.equal(writes,1);assert.equal(h.closes,1);
 }
});
test('Ready plus trailing frame in same chunk is rejected rather than losing bytes',async()=>{
 const h=server();const read=h.connection.readable.read.bind(h.connection.readable);
 h.connection.readable.read=async()=>{const b=await read();if(b?.[0]!==90)return b;const tail=auth(0),both=new Uint8Array(b.length+tail.length);both.set(b);both.set(tail,b.length);return both;};
 await assert.rejects(authenticatePostgresTls(h.connection,opts),{message:'PG startup sequence'});assert.equal(h.closes,1);
});

test('server errors retain only validated SQLSTATE, never diagnostic text',async()=>{
 const h=harness((_,push)=>push(frame('E',bytes('SERROR\0C28P01\0Mprivate-password-detail\0\0'))));
 await assert.rejects(authenticatePostgresTls(h.connection,opts),e=>e instanceof Error&&e.message==='PG startup server'&&(e as {sqlState?:string}).sqlState==='28P01'&&!JSON.stringify(e).includes('private'));
 assert.equal(h.closes,1);
});

test('owned startup reads are wiped after server failure and late timeout arrival',async()=>{
 const owned=frame('E',bytes('C28P01\0Mprivate-diagnostic\0\0'));
 const h=harness((_,push)=>push(owned));
 await assert.rejects(authenticatePostgresTls(h.connection,opts));
 assert.ok(owned.every(byte=>byte===0));
 let resolveRead!:(value:Uint8Array)=>void;
 const late=harness(()=>{});late.connection.readable.read=()=>new Promise<Uint8Array>(resolve=>resolveRead=resolve);
 await assert.rejects(authenticatePostgresTls(late.connection,{...opts,timeoutMs:5}),{message:'PG startup timeout'});
 const secret=bytes('late-private');resolveRead(secret);await new Promise(resolve=>setTimeout(resolve,0));
 assert.ok(secret.every(byte=>byte===0));
});

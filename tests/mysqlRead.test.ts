import test from 'node:test';import assert from 'node:assert/strict';import type {PluginByteConnection} from '@netcatty/plugin-sdk';
import {executeMysqlRead} from '../src/mysqlRead';import {encodeMysqlPacket} from '../src/mysqlProtocol';
const enc=new TextEncoder(),text=(s:string)=>enc.encode(s),str=(s:string)=>Uint8Array.of(text(s).length,...text(s));
const opts={schema:'fixture',table:'notes',columns:['id','label','missing'],limit:10,timeoutMs:1000};
const ok=(status=2)=>Uint8Array.of(0,0,0,status&255,status>>8,0,0),eof=(status=8195)=>Uint8Array.of(254,0,0,status&255,status>>8);
function col(name:string,type:number,charset=type===253?255:63){return Uint8Array.of(...str('def'),...str('fixture'),...str('notes'),...str('notes'),...str(name),...str(name),12,charset&255,charset>>8,255,0,0,0,type,0,0,0,0,0);}
const fields=()=>[Uint8Array.of(3),col('id',8),col('label',252,255),col('missing',253),eof()];
const cells=()=>Uint8Array.of(...str('9223372036854775807'),...str('hello'),251);
function harness(query:Uint8Array[]= [...fields(),cells(),eof()],fragment=false){
 const queue:Uint8Array[]=[];let wait:((v:Uint8Array|null)=>void)|undefined;let closes=0;const writes:string[]=[];let step=0;
 const push=(b:Uint8Array)=>{for(const item of fragment?Array.from(b,n=>Uint8Array.of(n)):[b]){if(wait){const cb=wait;wait=undefined;cb(item);}else queue.push(item);}};
 const connection={readable:{read:()=>queue.length?Promise.resolve(queue.shift()!):new Promise<Uint8Array|null>(r=>wait=r),cancel:()=>{wait?.(null);wait=undefined;}},writable:{write:async(w:Uint8Array)=>{assert.equal(w[3],0);assert.equal(w[4],3);writes.push(new TextDecoder().decode(w.slice(5)));const replies=step++===0?[ok(8195)]:step===2?query:[ok()];push(new Uint8Array(replies.flatMap((p,i)=>Array.from(encodeMysqlPacket(p,i+1)))));},cancel:()=>{}},close:async()=>{closes++;}} as unknown as PluginByteConnection;
 return {connection,writes,get closes(){return closes;}};
}
test('bounded COM_QUERY sequence preserves exact bigint/NULL and resets packet sequence',async()=>{
 for(const fragment of [false,true]){const h=harness(undefined,fragment);const result=await executeMysqlRead(h.connection,opts);assert.deepEqual(result.rows,[['9223372036854775807','hello',null]]);assert.deepEqual(h.writes,['START TRANSACTION READ ONLY','SELECT `id`, `label`, `missing` FROM `fixture`.`notes` LIMIT 10','ROLLBACK']);assert.equal(h.closes,0);}
});
test('unsupported binary type, charset, column mismatch and local infile rejected with cleanup',async()=>{
 for(const query of [[Uint8Array.of(251,...text('/private'))],[Uint8Array.of(3),col('wrong',8)],[Uint8Array.of(3),col('id',252)],[Uint8Array.of(3),col('id',8),col('label',253,63)]]){const h=harness(query);await assert.rejects(executeMysqlRead(h.connection,opts));assert.equal(h.closes,1);assert.equal(h.writes.length,2);}
});
test('strict statuses/multiresults, trailing packets, bad sequence and server messages fail closed',async()=>{
 for(const query of [[...fields(),cells(),eof(8195|8)],[...fields(),cells(),eof(),ok()],[Uint8Array.of(255,...text('private credentials'))]]){const h=harness(query);await assert.rejects(executeMysqlRead(h.connection,opts),e=>e instanceof Error&&!e.message.includes('private'));assert.equal(h.closes,1);}
 const h=harness();h.connection.writable.write=async()=>{};h.connection.readable.read=async()=>encodeMysqlPacket(ok(8195),2);await assert.rejects(executeMysqlRead(h.connection,opts));assert.equal(h.closes,1);
});
test('row limit, malformed lenenc/UTF8 and numeric values reject rather than truncate or round',async()=>{
 for(const value of [Uint8Array.of(...str('NaN'),...str('x'),251),Uint8Array.of(...str('1'),1,255,251),Uint8Array.of(254,255,255,255,255,255,255,255,255)]){const h=harness([...fields(),value,eof()]);await assert.rejects(executeMysqlRead(h.connection,opts));}
 const h=harness([...fields(),cells(),cells(),eof()]);await assert.rejects(executeMysqlRead(h.connection,{...opts,limit:1}),/limit/);
});
test('timeout, pre-abort, empty reads and concurrent invocation close safely',async()=>{
 const h=harness();h.connection.writable.write=async()=>{};await assert.rejects(executeMysqlRead(h.connection,{...opts,timeoutMs:5}),/timeout/);assert.equal(h.closes,1);
 const c=new AbortController();c.abort();const b=harness();await assert.rejects(executeMysqlRead(b.connection,{...opts,signal:c.signal}),/aborted/);assert.equal(b.writes.length,0);
 const e=harness();e.connection.writable.write=async()=>{};e.connection.readable.read=async()=>new Uint8Array();await assert.rejects(executeMysqlRead(e.connection,opts),/protocol/);
 const concurrent=harness();concurrent.connection.writable.write=async()=>{};const pending=executeMysqlRead(concurrent.connection,{...opts,timeoutMs:5});await assert.rejects(executeMysqlRead(concurrent.connection,opts),/busy/);await assert.rejects(pending,/timeout/);await assert.rejects(executeMysqlRead(concurrent.connection,opts),/closed/);
});
test('owned pending write wiped on abort; late write completion cannot issue SELECT',async()=>{
 const h=harness();let wire:Uint8Array|undefined,resolve!:()=>void,calls=0;h.connection.writable.write=value=>{wire=value instanceof Uint8Array?value:new Uint8Array(value);calls++;return new Promise<void>(r=>resolve=r);};
 const c=new AbortController();const pending=executeMysqlRead(h.connection,{...opts,signal:c.signal});c.abort();await assert.rejects(pending);assert.ok(wire!.every(b=>b===0));resolve();await new Promise(r=>setTimeout(r,0));assert.equal(calls,1);assert.equal(h.closes,1);
});
test('invalid inputs issue no requests; identifiers are quoted without widening SQL grammar',async()=>{
 const h=harness();for(const input of [{...opts,limit:101},{...opts,columns:[]},{...opts,table:'a\0b'},{...opts,timeoutMs:0}])await assert.rejects(executeMysqlRead(h.connection,input),/input/);assert.equal(h.writes.length,0);
 const quoted=harness();await assert.rejects(executeMysqlRead(quoted.connection,{...opts,table:'x`; DROP TABLE t;--'}));assert.match(quoted.writes[1],/`x``; DROP TABLE t;--`/);
});
test('microtask-only partial reads honor monotonic deadline and byte budget',async(t)=>{
 let now=0;t.mock.method(performance,'now',()=>now);
 const h=harness();h.connection.writable.write=async()=>{};h.connection.readable.read=async()=>{now+=2;return Uint8Array.of(1);};await assert.rejects(executeMysqlRead(h.connection,{...opts,timeoutMs:5}),/timeout/);assert.equal(h.closes,1);
 now=0;const b=harness();b.connection.writable.write=async()=>{};b.connection.readable.read=async()=>new Uint8Array(96*1024+1);await assert.rejects(executeMysqlRead(b.connection,opts),/limit/);assert.equal(b.closes,1);
});
test('status rejection diagnostics expose only fixed phase and numeric wire metadata',async()=>{
 const h=harness([...fields(),cells(),eof(8195|64)]);
 await assert.rejects(executeMysqlRead(h.connection,opts),(error:unknown)=>{
  assert.ok(error instanceof Error);assert.equal(error.message,'MySQL read sequence');
  assert.deepEqual((error as Error&{diagnostic:unknown}).diagnostic,{phase:'select',status:8259,packetTag:254,sequence:7});
  assert.ok(!JSON.stringify(error).includes('hello'));return true;
 });assert.equal(h.closes,1);
});

test('SELECT EOF permits only documented index-plan hints while preserving transaction status',async()=>{
 for(const hints of [16,32,48]){const h=harness([...fields(),cells(),eof(8195|hints)]);const result=await executeMysqlRead(h.connection,opts);assert.equal(result.rowCount,1);assert.equal(h.closes,0);}
 for(const flag of [8,64,128,256,1024,16384]){const h=harness([...fields(),cells(),eof(8195|flag)]);await assert.rejects(executeMysqlRead(h.connection,opts),/sequence/);assert.equal(h.closes,1);}
});

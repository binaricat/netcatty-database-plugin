import test from 'node:test';import assert from 'node:assert/strict';import type {PluginByteConnection} from '@netcatty/plugin-sdk';
import {executeMysqlPreparedRead} from '../src/mysqlPreparedRead';import {encodeMysqlPacket} from '../src/mysqlProtocol';
const t=(s:string)=>new TextEncoder().encode(s),str=(s:string)=>Uint8Array.of(t(s).length,...t(s));
const opts=()=>({schema:'fixture',table:'notes',columns:['id','label','optional'],where:[{column:'id',value:{kind:'int64' as const,value:'1'}}],limit:10,timeoutMs:1000});
const ok=(n=2)=>Uint8Array.of(0,0,0,n&255,n>>8,0,0),eof=(n=8195)=>Uint8Array.of(254,0,0,n&255,n>>8);
function col(name:string,type=3,param=false){return Uint8Array.of(...str('def'),...str(param?'':'fixture'),...str(param?'':'notes'),...str(param?'':'notes'),...str(name),...str(param?'':name),12,type===253?255:63,0,20,0,0,0,type,0,0,0,0,0);}
const columns=()=>[col('id'),col('label',253),col('optional',253)];
const prepare=()=>[Uint8Array.of(0,42,0,0,0,3,0,1,0,0,0,0),col('?',6,true),eof(),...columns(),eof()];
const execute=()=>[Uint8Array.of(3),...columns(),eof(8227),Uint8Array.of(0,16,1,0,0,0,...str('exact')),eof(8227)];
function fixture(overrides:{prepare?:Uint8Array[];execute?:Uint8Array[];fragment?:boolean}={}){
 let pending:((b:Uint8Array|null)=>void)|undefined;const queue:Uint8Array[]=[];let closed=0;const writes:Uint8Array[]=[];
 const push=(b:Uint8Array)=>{for(const part of overrides.fragment?Array.from(b,v=>Uint8Array.of(v)):[b]){if(pending){const p=pending;pending=undefined;p(part);}else queue.push(part);}};
 const connection={readable:{read:()=>queue.length?Promise.resolve(queue.shift()!):new Promise<Uint8Array|null>(r=>pending=r),cancel:()=>{pending?.(null);pending=undefined;}},writable:{write:async(w:Uint8Array)=>{
 writes.push(w.slice());let packets:Uint8Array[];
 if(w[4]===22)packets=overrides.prepare??prepare();else if(w[4]===23)packets=overrides.execute??execute();else if(w[4]===25)return;else packets=[ok(new TextDecoder().decode(w.slice(5)).startsWith('START')?8195:2)];
 push(new Uint8Array(packets.flatMap((p,i)=>Array.from(encodeMysqlPacket(p,i+1)))));
 },cancel:()=>{}},close:async()=>{closed++;}} as unknown as PluginByteConnection;
 return {connection,writes,get closed(){return closed;}};
}
test('read-only prepared roundtrip handles empty param metadata names, binary NULL/text/int and statement cleanup',async()=>{
 for(const fragment of [false,true]){const f=fixture({fragment});const result=await executeMysqlPreparedRead(f.connection,opts());assert.deepEqual(result.rows,[['1','exact',null]]);assert.deepEqual(f.writes.map(w=>w[4]),[3,22,23,25,3]);assert.ok(f.writes.every(w=>w[3]===0));assert.deepEqual(Array.from(f.writes[3].slice(5)),[42,0,0,0]);assert.equal(new TextDecoder().decode(f.writes.at(-1)!.slice(5)),'ROLLBACK');assert.equal(f.closed,0);}
});
test('bound plan snapshots mutable inputs before awaits; no SQL interpolation',async()=>{
 const f=fixture(),input=opts();const promise=executeMysqlPreparedRead(f.connection,input);input.where[0].value.value='999';input.columns[0]='evil';input.table='other';const result=await promise;assert.equal(result.columns[0],'id');
 const wire=f.writes.find(w=>w[4]===23)!;assert.equal(new DataView(wire.buffer,wire.byteOffset+18,8).getBigInt64(0,true),1n);
});
test('metadata count/name/type changes, unknown status and extra frames reject before release success',async()=>{
 const wrong=prepare();wrong[0]=Uint8Array.of(0,42,0,0,0,3,0,2,0,0,0,0);
 const changed=execute();changed[1]=col('wrong');const nullUnknown=execute();nullUnknown[3]=col('optional',245);
 for(const settings of [{prepare:wrong},{execute:changed},{execute:nullUnknown},{execute:[...execute().slice(0,-1),eof(8195|8)]},{execute:[...execute(),ok()]}]){const f=fixture(settings);await assert.rejects(executeMysqlPreparedRead(f.connection,opts()));assert.equal(f.closed,1);assert.ok(!f.writes.some(w=>w[4]===25));}
});
test('server failure never echoes payload or claims rollback; row limit is not silent truncation',async()=>{
 const f=fixture({execute:[Uint8Array.of(255,...t('credential secret'))]});await assert.rejects(executeMysqlPreparedRead(f.connection,opts()),e=>e instanceof Error&&e.message==='MySQL prepared read server');assert.equal(f.closed,1);
 const data=execute();data.splice(data.length-1,0,data[data.length-2]);const many=fixture({execute:data});await assert.rejects(executeMysqlPreparedRead(many.connection,{...opts(),limit:1}),/limit/);
});
test('abort wipes pending wire, rejects reuse and late completion cannot send PREPARE',async()=>{
 const f=fixture();let wire!:Uint8Array,resolve!:()=>void;f.connection.writable.write=value=>{wire=value as Uint8Array;return new Promise<void>(r=>resolve=r);};const c=new AbortController();const p=executeMysqlPreparedRead(f.connection,{...opts(),signal:c.signal});c.abort();await assert.rejects(p,/aborted/);assert.ok(wire.every(v=>v===0));resolve();await new Promise(r=>setTimeout(r,0));assert.equal(f.closed,1);await assert.rejects(executeMysqlPreparedRead(f.connection,opts()),/closed/);
});
test('timeout, empty chunks, concurrent calls and microtask deadline remain bounded',async(tst)=>{
 const f=fixture();f.connection.writable.write=async()=>{};const p=executeMysqlPreparedRead(f.connection,{...opts(),timeoutMs:5});await assert.rejects(executeMysqlPreparedRead(f.connection,opts()),/busy/);await assert.rejects(p,/timeout/);
 const empty=fixture();empty.connection.writable.write=async()=>{};empty.connection.readable.read=async()=>new Uint8Array();await assert.rejects(executeMysqlPreparedRead(empty.connection,opts()),/protocol/);
 let now=0;tst.mock.method(performance,'now',()=>now);const micro=fixture();micro.connection.writable.write=async()=>{};micro.connection.readable.read=async()=>{now+=2;return Uint8Array.of(1);};await assert.rejects(executeMysqlPreparedRead(micro.connection,{...opts(),timeoutMs:5}),/timeout/);assert.equal(micro.closed,1);
});
test('total bytes and prepare warnings are rejected, and statement-close failure closes connection',async()=>{
 const b=fixture();b.connection.writable.write=async()=>{};b.connection.readable.read=async()=>new Uint8Array(96*1024+1);await assert.rejects(executeMysqlPreparedRead(b.connection,opts()),/limit/);
 const warnings=prepare();warnings[0][10]=1;const w=fixture({prepare:warnings});await assert.rejects(executeMysqlPreparedRead(w.connection,opts()));assert.equal(w.closed,1);
 const c=fixture(),write=c.connection.writable.write.bind(c.connection.writable);c.connection.writable.write=async value=>{if(new Uint8Array(value instanceof Uint8Array?value:value)[4]===25)throw new Error('private failure');await write(value);};await assert.rejects(executeMysqlPreparedRead(c.connection,opts()),e=>e instanceof Error&&!e.message.includes('private'));assert.equal(c.closed,1);assert.equal(c.writes.filter(w=>w[4]===3).length,1);
});

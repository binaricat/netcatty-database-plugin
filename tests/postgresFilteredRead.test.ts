import test from 'node:test';import assert from 'node:assert/strict';
import type {PluginByteConnection} from '@netcatty/plugin-sdk';
import {executePostgresFilteredRead} from '../src/postgresFilteredRead';
const text=(s:string)=>new TextEncoder().encode(s),integer=(n:number,size=4)=>{const b=new Uint8Array(size),d=new DataView(b.buffer);size===4?d.setInt32(0,n):d.setInt16(0,n);return b;};
const join=(parts:Uint8Array[])=>{const result=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}return result;};
const frame=(tag:string,b=new Uint8Array())=>join([text(tag),integer(b.length+4),b]);
const c=(s:string)=>frame('C',text(s+'\0')),z=(status='T')=>frame('Z',text(status));
const description=(oid=25)=>frame('T',join([integer(1,2),text('value\0'),integer(0),integer(0,2),integer(oid),integer(-1,2),integer(-1),integer(0,2)]));
const row=(value:string|null)=>frame('D',join([integer(1,2),value===null?integer(-1):join([integer(text(value).length),text(value)])]));
const options={schema:'public',table:'notes',columns:['value'],filters:[{column:'value',value:"a'); DROP TABLE notes;--"},{column:'value',value:null}],timeoutMs:1000};
const replies=(values:(string|null)[]=['你好',null,''])=>[c('BEGIN'),c('SET'),z(),frame('1'),frame('2'),description(),...values.map(row),c(`SELECT ${values.length}`),z(),c('ROLLBACK'),z('I')];
function harness(frames=replies(),fragment=false){let queue=fragment?Array.from(join(frames),b=>new Uint8Array([b])):frames.map(b=>b.slice()),closes=0;const writes:Uint8Array[]=[];const connection={readable:{read:async()=>queue.shift()??null,cancel:()=>{queue=[];}},writable:{write:async(b:Uint8Array)=>{writes.push(b.slice());},cancel(){}},close:async()=>{closes++;}} as unknown as PluginByteConnection;return {connection,writes,get closes(){return closes;}};}
test('fragmented extended read has correct transaction/message order, filters only in Bind and preserves NULL/text',async()=>{
 const h=harness(replies(),true),result=await executePostgresFilteredRead(h.connection,options);assert.deepEqual(result.rows,[['你好'],[null],['']]);assert.equal(result.transactionStatus,'I');assert.equal(result.valueFormat,'postgres-text');assert.equal(h.closes,0);assert.deepEqual(h.writes.map(b=>String.fromCharCode(b[0])),['Q','P','B','D','E','S','Q']);
 const parse=new TextDecoder().decode(h.writes[1]);assert.match(parse,/"value" IS NOT DISTINCT FROM \$1 AND "value" IS NOT DISTINCT FROM \$2 LIMIT 99/);assert.ok(!parse.includes(options.filters[0].value!));assert.ok(new TextDecoder().decode(h.writes[2]).includes(options.filters[0].value!));assert.equal(new DataView(h.writes[4].buffer).getInt32(h.writes[4].length-4),100);
});
test('input snapshot resists caller mutation and quoted identifiers cannot become SQL',async()=>{
 const h=harness();let release!:()=>void;const first=h.connection.writable.write;let once=true;h.connection.writable.write=async (b:Uint8Array)=>{await first(b);if(once){once=false;await new Promise<void>(r=>release=r);}};
 const input={...options,table:'n"; DROP TABLE other;--',columns:['value'],filters:[{column:'value',value:'original'}]};const pending=executePostgresFilteredRead(h.connection,input);input.columns[0]='bad';input.filters[0].value='mutated';await Promise.resolve();release();await pending;
 assert.ok(new TextDecoder().decode(h.writes[1]).includes('"n""; DROP TABLE other;--"'));assert.ok(new TextDecoder().decode(h.writes[2]).includes('original'));assert.ok(!new TextDecoder().decode(h.writes[2]).includes('mutated'));
});
test('safe text preserves numeric precision; unknown OID, unexpected completion and PortalSuspended close',async()=>{
 const frames=replies(['9007199254740993.123456789']);frames[5]=description(1700);const h=harness(frames);assert.deepEqual((await executePostgresFilteredRead(h.connection,options)).rows,[['9007199254740993.123456789']]);
 for(const replacement of [frame('s'),frame('n'),description(17),c('DELETE 1')]){const frames=replies();frames[5]=replacement;const bad=harness(frames);await assert.rejects(executePostgresFilteredRead(bad.connection,options));assert.equal(bad.closes,1);}
});
test('server errors at all phases do not leak SQL/context and close without claiming rollback',async()=>{
 for(const index of [0,1,3,5,9]){const frames=replies();frames[index]=frame('E',text('Mprivate-password-SQL\0\0'));const h=harness(frames);await assert.rejects(executePostgresFilteredRead(h.connection,options),{message:'PG filtered read server'});assert.equal(h.closes,1);await assert.rejects(executePostgresFilteredRead(h.connection,options),/closed/);}
});
test('limits, EOF, invalid Ready state and coalesced trailing bytes reject instead of truncating',async()=>{
 for(const change of [()=>[new Uint8Array(0)],()=>[new Uint8Array(98305)],()=>replies().slice(0,-1),()=>replies().map((f,i)=>i===2?z('I'):f),()=>replies().map((f,i)=>i===2?join([z(),new Uint8Array([1])]):f)]){const h=harness(change());await assert.rejects(executePostgresFilteredRead(h.connection,options));assert.equal(h.closes,1);}
 const rows=harness(replies(['one','two']));await assert.rejects(executePostgresFilteredRead(rows.connection,{...options,limit:1}),/limit/);
 for(const extra of [{limit:100},{filters:[]},{filters:Array(9).fill({column:'value',value:'x'})},{filters:[{column:'value',value:'x'.repeat(2049)}]}]){const h=harness();await assert.rejects(executePostgresFilteredRead(h.connection,{...options,...extra}));assert.equal(h.writes.length,0);}
});
test('pending Bind timeout zeros wire, closes once and suppresses late writes; pre-abort sends nothing',async()=>{
 const h=harness();let wire:Uint8Array|undefined,release!:()=>void;const write=h.connection.writable.write;h.connection.writable.write=async (b:Uint8Array)=>{await write(b);if(b[0]===66){wire=b;await new Promise<void>(r=>release=r);}};
 const pending=executePostgresFilteredRead(h.connection,{...options,timeoutMs:10});await assert.rejects(executePostgresFilteredRead(h.connection,options),/busy/);await assert.rejects(pending,/timeout/);assert.ok(wire!.every(b=>b===0));assert.equal(h.closes,1);const count=h.writes.length;release();await new Promise(r=>setTimeout(r,0));assert.equal(h.writes.length,count);
 const ctrl=new AbortController();ctrl.abort();const pre=harness();await assert.rejects(executePostgresFilteredRead(pre.connection,{...options,signal:ctrl.signal}),/aborted/);assert.equal(pre.writes.length,0);
});
test('owned late read buffer is cleared after cancellation',async()=>{
 const h=harness();let release!:(b:Uint8Array)=>void;h.connection.readable.read=()=>new Promise(r=>release=r);const ctrl=new AbortController();const pending=executePostgresFilteredRead(h.connection,{...options,signal:ctrl.signal});await Promise.resolve();await Promise.resolve();ctrl.abort();await assert.rejects(pending,/aborted/);const late=join(replies());release(late);await new Promise(r=>setTimeout(r,0));assert.ok(late.every(b=>b===0));assert.equal(h.closes,1);
});

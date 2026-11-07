import test from 'node:test';
import assert from 'node:assert/strict';
import type {PluginByteConnection} from '@netcatty/plugin-sdk';
import {PostgresDecoder} from '../src/postgresProtocol';
import {executePostgresRead} from '../src/postgresQuery';
const text=(s:string)=>new TextEncoder().encode(s);
const join=(parts:Uint8Array[])=>{const b=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const p of parts){b.set(p,offset);offset+=p.length;}return b;};
const int=(n:number,size=4)=>{const b=new Uint8Array(size),v=new DataView(b.buffer);if(size===4)v.setInt32(0,n);else v.setInt16(0,n);return b;};
const frame=(tag:string,body:Uint8Array)=>join([text(tag),int(body.length+4),body]);
const complete=(s:string)=>frame('C',text(s+'\0'));
const description=(columns:string[],oids:number[]=columns.map(()=>25),format=0)=>frame('T',join([int(columns.length,2),...columns.map((c,i)=>join([text(c+'\0'),int(0),int(0,2),int(oids[i]),int(-1,2),int(-1),int(format,2)]))]));
const row=(cells:(string|null)[])=>frame('D',join([int(cells.length,2),...cells.map(cell=>cell===null?int(-1):join([int(text(cell).length),text(cell)]))]));
const ready=()=>frame('Z',text('I'));
const options={schema:'public',table:'notes',columns:['id','body'],timeoutMs:1000};
const reply=(cells:(string|null)[][]=[['1','你好']])=>[complete('BEGIN'),complete('SET'),description(['id','body'],[23,25]),...cells.map(row),complete(`SELECT ${cells.length}`),complete('ROLLBACK'),ready()];
function connection(frames:Uint8Array[],fragment=false){let queue=fragment?Array.from(join(frames),b=>new Uint8Array([b])):frames.map(b=>b.slice());let writes=0,closes=0,cancels=0;let sent='';const conn={readable:{read:async()=>queue.shift()??null,cancel:()=>{cancels++;queue=[];}},writable:{write:async(wire:Uint8Array)=>{writes++;sent=new TextDecoder().decode(wire.slice(5));},cancel:()=>{cancels++;}},close:async()=>{closes++;}} as unknown as PluginByteConnection;return {conn,get writes(){return writes;},get closes(){return closes;},get cancels(){return cancels;},get sent(){return sent;}};}
test('fragmented typed rows, NULL and empty strings; fixed read-only transaction and quoted identifiers',async()=>{
 const h=connection(reply([['1','你好'],['2',null],['3','']]),true);const result=await executePostgresRead(h.conn,options);
 assert.deepEqual(result.rows,[[1,'你好'],[2,null],[3,'']]);assert.equal(result.rowCount,3);assert.equal(h.closes,0);assert.equal(h.writes,1);
 assert.equal(h.sent,'BEGIN READ ONLY; SET LOCAL statement_timeout = \'1000ms\'; SELECT "id", "body" FROM "public"."notes" LIMIT 100; ROLLBACK;\0');
 const quoted=connection(reply());await executePostgresRead(quoted.conn,{...options,table:'x"; DELETE FROM notes;--'});assert.ok(quoted.sent.includes('"x""; DELETE FROM notes;--"'));
});
test('int8/numeric preserve exact strings; boolean safely typed; unknown and binary OIDs reject even null',async()=>{
 const columns=['big','precise','flag'],h=connection([complete('BEGIN'),complete('SET'),description(columns,[20,1700,16]),row(['9223372036854775807','12345678901234567890.123456789','f']),complete('SELECT 1'),complete('ROLLBACK'),ready()]);
 assert.deepEqual((await executePostgresRead(h.conn,{...options,columns})).rows,[['9223372036854775807','12345678901234567890.123456789',false]]);
 for(const [oid,format] of [[17,0],[99999,0],[25,1]]){const bad=connection([complete('BEGIN'),complete('SET'),description(['id','body'],[23,oid],format),row(['1',null])]);await assert.rejects(executePostgresRead(bad.conn,options),/protocol/);assert.equal(bad.closes,1);}
});
test('errors after BEGIN/SET close rather than assume rollback; peer details never escape',async()=>{
 for(const prefix of [[],[complete('BEGIN')],[complete('BEGIN'),complete('SET')]]){const h=connection([...prefix,frame('E',text('Mprivate-SQL-password\0\0'))]);await assert.rejects(executePostgresRead(h.conn,options),{message:'PG read server'});assert.equal(h.closes,1);await assert.rejects(executePostgresRead(h.conn,options),/closed/);}
});
test('phase/order/count mismatch, EOF and ready tail fail closed',async()=>{
 const scenarios=[[ready()],[complete('BEGIN'),description(options.columns)],[complete('BEGIN'),complete('SET'),row(['1','x'])],[...reply().slice(0,-3),complete('SELECT 999'),complete('ROLLBACK'),ready()],[...reply().slice(0,-1)],[...reply().slice(0,-1),join([ready(),new Uint8Array([67])])],[...reply().slice(0,-1),join([ready(),complete('SELECT 0')])]];
 for(const frames of scenarios){const h=connection(frames);await assert.rejects(executePostgresRead(h.conn,options));assert.equal(h.closes,1);}
});
test('row/value/byte/read bounds reject instead of silently truncate or round integers',async()=>{
 const h=connection(reply([['1','x'],['2','y']]));await assert.rejects(executePostgresRead(h.conn,{...options,limit:1}),/limit/);
 for(const cell of ['2147483648','NaN','1.5']){const bad=connection(reply([[cell,'x']]));await assert.rejects(executePostgresRead(bad.conn,options),/value/);}
 const big=connection([new Uint8Array(96*1024+1)]);await assert.rejects(executePostgresRead(big.conn,options),/limit/);
 const empty=connection([new Uint8Array(0)]);await assert.rejects(executePostgresRead(empty.conn,options),/protocol/);
 const long=connection(reply([['1','a'.repeat(2049)]]));await assert.rejects(executePostgresRead(long.conn,options),/limit/);
});
test('timeout/pre-abort/pending write zeroes wire, closes once, rejects concurrent ownership and late work',async()=>{
 const h=connection([]);let wire:Uint8Array|undefined,resolveWrite!:()=>void;h.conn.writable.write=(b:Uint8Array)=>{wire=b;return new Promise<void>(resolve=>resolveWrite=resolve);};
 const pending=executePostgresRead(h.conn,{...options,timeoutMs:10});await assert.rejects(executePostgresRead(h.conn,options),/busy/);
 await assert.rejects(pending,{message:'PG read timeout'});assert.equal(h.closes,1);assert.equal(wire!.every(b=>b===0),true);resolveWrite();await new Promise(r=>setTimeout(r,0));assert.equal(h.closes,1);
 const ctrl=new AbortController();ctrl.abort();const pre=connection(reply());await assert.rejects(executePostgresRead(pre.conn,{...options,signal:ctrl.signal}),/aborted/);assert.equal(pre.writes,0);assert.equal(pre.closes,1);
 const c=new AbortController(),reading=connection([]);let resolveRead!:(b:Uint8Array|null)=>void;reading.conn.readable.read=()=>new Promise(r=>resolveRead=r);const task=executePostgresRead(reading.conn,{...options,signal:c.signal});await Promise.resolve();await Promise.resolve();c.abort();await assert.rejects(task,/aborted/);resolveRead?.(join(reply()));await new Promise(r=>setTimeout(r,0));assert.equal(reading.closes,1);
});
test('input rejects SQL injection surfaces without sending, and later unread frames remain in caller-owned stream',async()=>{
 for(const extra of [{columns:[]},{columns:['id','id']},{limit:101},{schema:'bad\0name'},{timeoutMs:0}]){const h=connection(reply());await assert.rejects(executePostgresRead(h.conn,{...options,...extra}));assert.equal(h.writes,0);}
 const tail=complete('unrequested');const h=connection([...reply(),tail]);await executePostgresRead(h.conn,options);assert.deepEqual(await h.conn.readable.read(),tail);
});

test('floating nonfinite/underflow and overlong microtask-only streams fail safely',async()=>{
 for(const cell of ['NaN','Infinity','1e-999','9007199254740992']){const h=connection([complete('BEGIN'),complete('SET'),description(options.columns,[23,701]),row(['1',cell])]);await assert.rejects(executePostgresRead(h.conn,options),/value/);}
 const h=connection([]);let reads=0;h.conn.readable.read=async()=>{reads++;return new Uint8Array([0]);};
 await assert.rejects(executePostgresRead(h.conn,{...options,timeoutMs:1}));assert.ok(reads<=4096);assert.equal(h.closes,1);
});

test('owned read chunks zero on normal parsing, budget failure and late read after timeout',async()=>{
 const normal=connection([]),chunks=reply(),owned=chunks.map(b=>b.slice());let i=0;normal.conn.readable.read=async()=>owned[i++]??null;
 await executePostgresRead(normal.conn,options);assert.ok(owned.every(b=>b.every(n=>n===0)));
 const oversized=new Uint8Array(96*1024+1).fill(65),bad=connection([]);bad.conn.readable.read=async()=>oversized;await assert.rejects(executePostgresRead(bad.conn,options),/limit/);assert.ok(oversized.every(n=>n===0));
 const late=connection([]);let resolveRead!:(b:Uint8Array)=>void;late.conn.readable.read=()=>new Promise(r=>resolveRead=r);
 const task=executePostgresRead(late.conn,{...options,timeoutMs:5});await assert.rejects(task,/timeout/);
 const lateChunk=join(reply());resolveRead(lateChunk);await new Promise(r=>setTimeout(r,0));assert.ok(lateChunk.every(n=>n===0));assert.equal(late.closes,1);
});
test('decoded row cell buffers zero even on wrong phase, wrong column count and row-limit failures',async()=>{
 const original=PostgresDecoder.prototype.feed;const captured:Uint8Array[]=[];
 PostgresDecoder.prototype.feed=function(chunk){const messages=original.call(this,chunk);for(const message of messages)if(message.type==='row')for(const cell of message.values)if(cell)captured.push(cell);return messages;};
 try{
  for(const frames of [[row(['private'])],[complete('BEGIN'),complete('SET'),description(options.columns),row(['private'])],reply([['1','first'],['2','second']])]){
   const h=connection(frames);await assert.rejects(executePostgresRead(h.conn,{...options,limit:1}));
  }
  assert.ok(captured.length>=3);assert.ok(captured.every(b=>b.every(n=>n===0)));
 }finally{PostgresDecoder.prototype.feed=original;}
});

test('decoder clears retained partial buffers without wiping caller input or returned cells',()=>{
 const encoded=row(['owned-secret',null]);const decoder=new PostgresDecoder();const prefix=encoded.slice(0,8);decoder.feed(prefix);
 const internal=(decoder as unknown as {buffer:Uint8Array}).buffer;assert.ok(internal.some(b=>b!==0));
 const messages=decoder.feed(encoded.slice(8));assert.ok(internal.every(b=>b===0));assert.ok(prefix.some(b=>b!==0));
 assert.equal(messages[0].type,'row');if(messages[0].type==='row'){assert.equal(new TextDecoder().decode(messages[0].values[0]!), 'owned-secret');messages[0].values[0]!.fill(0);}
 decoder.finish();assert.equal((decoder as unknown as {buffer:Uint8Array}).buffer.length,0);
 const truncated=new PostgresDecoder();truncated.feed(encoded.slice(0,8));const retained=(truncated as unknown as {buffer:Uint8Array}).buffer;assert.throws(()=>truncated.finish());assert.ok(retained.every(b=>b===0));
});

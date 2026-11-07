import test from 'node:test';import assert from 'node:assert/strict';
import {encodeMysqlPacket,MysqlPacketDecoder,parseMysqlHandshake,parseMysqlError,MYSQL_LIMITS} from '../src/mysqlProtocol';
const text=(s:string)=>new TextEncoder().encode(s);
function greeting(){const version=text('8.0.36\0'),plugin=text('caching_sha2_password\0');const b=new Uint8Array(1+version.length+4+8+1+2+1+2+2+1+10+13+plugin.length);let p=0;b[p++]=10;b.set(version,p);p+=version.length;b.set([255,255,255,255],p);p+=4;b.set([1,0,2,3,4,5,6,255],p);p+=8;b[p++]=0;b.set([0,0x8a],p);p+=2;b[p++]=45;b.set([2,0,8,128,21],p);p+=5;p+=10;b.set([8,9,10,11,12,13,14,15,16,17,18,19,0],p);p+=13;b.set(plugin,p);return b;}
test('packet header is little-endian and payload binary-safe; every fragmentation boundary',()=>{
 const payload=greeting(),wire=encodeMysqlPacket(payload,0);assert.deepEqual(Array.from(wire.slice(0,4)),[payload.length,0,0,0]);
 for(let split=0;split<=wire.length;split++){const d=new MysqlPacketDecoder();const packets=[...d.feed(wire.slice(0,split)),...d.feed(wire.slice(split))];d.finish();assert.equal(packets.length,1);assert.deepEqual(packets[0].payload,payload);}
 const d=new MysqlPacketDecoder();const packets=Array.from(wire).flatMap(b=>d.feed(Uint8Array.of(b)));d.finish();assert.deepEqual(packets[0].payload,payload);
});
test('unsigned capabilities and connection id, binary challenge, TLS advert not connection',()=>{
 const parsed=parseMysqlHandshake(greeting());assert.equal(parsed.connectionId,4294967295);assert.equal(parsed.capabilities,0x80088a00);assert.equal(parsed.authPlugin,'caching_sha2_password');assert.equal(parsed.authPluginData.length,20);assert.equal(parsed.authPluginData[1],0);assert.equal(parsed.tlsAdvertised,true);
 const maria=greeting();const offset=1+text('8.0.36\0').length+4+8+1+2+1+2+2+1;maria[offset+9]=255;assert.equal(parseMysqlHandshake(maria).protocol,10);
});
test('sequence strict, coalescing and modulo wrap; caller supplies cross-direction sequence',()=>{
 const d=new MysqlPacketDecoder(255);const wire=new Uint8Array([...encodeMysqlPacket(text('a'),255),...encodeMysqlPacket(text('b'),0)]);assert.deepEqual(d.feed(wire).map(p=>p.sequence),[255,0]);d.finish();
 const wrong=new MysqlPacketDecoder();assert.throws(()=>wrong.feed(encodeMysqlPacket(text('secret'),1)),/sequence/);assert.throws(()=>wrong.feed(new Uint8Array()),/closed/);
 assert.throws(()=>new MysqlPacketDecoder(-1));assert.throws(()=>encodeMysqlPacket(new Uint8Array(),256));
});
test('truncation, packet/exchange/frame-count and continuation budgets fail closed',()=>{
 const d=new MysqlPacketDecoder();d.feed(Uint8Array.of(1,0,0,0));assert.throws(()=>d.finish(),/truncated/);
 assert.throws(()=>new MysqlPacketDecoder().feed(Uint8Array.of(255,255,255,0)),/unsupported/);
 assert.throws(()=>new MysqlPacketDecoder().feed(Uint8Array.of(1,0,4,0)),/limit/);
 assert.throws(()=>new MysqlPacketDecoder().feed(new Uint8Array(MYSQL_LIMITS.exchangeBytes+1)),/limit/);
 const frames=new MysqlPacketDecoder();for(let i=0;i<128;i++)frames.feed(encodeMysqlPacket(new Uint8Array(),i));assert.throws(()=>frames.feed(encodeMysqlPacket(new Uint8Array(),128)),/limit/);
});
test('handshake rejects malformed, unsupported legacy capability, missing terminators and trailing bytes',()=>{
 const source=greeting();for(let n=0;n<source.length;n++)assert.throws(()=>parseMysqlHandshake(source.slice(0,n)));
 for(const [offset,value] of [[0,9],[1,255],[1+text('8.0.36\0').length+4+8,1],[1+text('8.0.36\0').length+4+8+2,0]]){const b=source.slice();b[offset]=value;assert.throws(()=>parseMysqlHandshake(b));}
 assert.throws(()=>parseMysqlHandshake(new Uint8Array([...source,0])));assert.throws(()=>parseMysqlHandshake(new Uint8Array(1025)),/limit/);
});
test('ERR exposes only integer code and SQLSTATE; never server text or credentials',()=>{
 const b=new Uint8Array([255,21,4,35,...text('28000private secret SQL'),255]);assert.deepEqual(parseMysqlError(b),{code:1045,sqlState:'28000'});
 assert.throws(()=>parseMysqlError(Uint8Array.of(255,21,4)),e=>e instanceof Error&&!e.message.includes('secret'));
 assert.throws(()=>parseMysqlError(Uint8Array.of(255,21,4,35,...text('ab000secret'))),/malformed/);
});
test('no TLS flag is merely reported; unsupported auth lengths/plugins never trigger fallback',()=>{
 const source=greeting(),low=1+text('8.0.36\0').length+4+8+1;
 const noTls=source.slice();noTls[low+1]&=~8;assert.equal(parseMysqlHandshake(noTls).tlsAdvertised,false);
 const noPlugin=source.slice();noPlugin[low+5]&=~8;assert.throws(()=>parseMysqlHandshake(noPlugin),/unsupported/);
 const length=source.slice();length[low+7]=0;assert.throws(()=>parseMysqlHandshake(length),/unsupported/);
 const bad=source.slice();bad[bad.length-2]=32;assert.throws(()=>parseMysqlHandshake(bad),/malformed/);
});
test('decoder wipes owned replaced/consumed buffers, but never caller input or returned payload',()=>{
 const input=encodeMysqlPacket(text('private challenge'),0),original=input.slice();const d=new MysqlPacketDecoder();
 const internal=d as unknown as {buffer:Uint8Array};d.feed(input.subarray(0,5));const replaced=internal.buffer;
 const result=d.feed(input.subarray(5));assert.ok(replaced.every(v=>v===0));assert.deepEqual(input,original);
 assert.deepEqual(result[0].payload,text('private challenge'));d.finish();assert.deepEqual(result[0].payload,text('private challenge'));
 const wrapped=new Uint8Array(greeting().length+7);wrapped.set(greeting(),7);const handshake=parseMysqlHandshake(wrapped.subarray(7));assert.equal(handshake.connectionId,4294967295);const challenge=handshake.authPluginData.slice();wrapped.fill(0);assert.deepEqual(handshake.authPluginData,challenge);
});
test('failed feed wipes produced-but-unreturned payloads and internal buffers only',()=>{
 // Synchronous test-only instrumentation; restore the prototype in finally.
 const first=encodeMysqlPacket(text('secret'),0),bad=encodeMysqlPacket(text('server'),2);
 const d=new MysqlPacketDecoder();d.feed(first.subarray(0,5));const internal=d as unknown as {buffer:Uint8Array};const replaced=internal.buffer;
 // Capture slices made on owned merged buffers via a temporary method wrapper.
 const originalSlice=Uint8Array.prototype.slice;const captured:Uint8Array[]=[];
 Uint8Array.prototype.slice=function(start?:number,end?:number){const value=originalSlice.call(this,start,end);captured.push(value);return value;};
 const input=new Uint8Array([...first.subarray(5),...bad]);const saved=originalSlice.call(input);
 try{assert.throws(()=>d.feed(input),/sequence/);}finally{Uint8Array.prototype.slice=originalSlice;}
 assert.ok(replaced.every(v=>v===0));assert.ok(captured.length>=2);assert.ok(captured.every(b=>b.every(v=>v===0)));
 assert.deepEqual(input,saved);assert.equal(internal.buffer.length,0);
});

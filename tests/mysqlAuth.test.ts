import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {MysqlTlsFastAuth} from '../src/mysqlAuth';import {encodeMysqlPacket} from '../src/mysqlProtocol';
const text=(s:string)=>new TextEncoder().encode(s);
function hello(plugin='caching_sha2_password'){
 const prefix=Uint8Array.of(10,...text('8.0.36\0'),1,0,0,0,1,2,3,4,5,6,7,8,0,0,0x8a,45,2,0,8,0,21,...new Uint8Array(10),9,10,11,12,13,14,15,16,17,18,19,20,0,...text(plugin+'\0'));
 return {sequence:0,payload:prefix};
}
const make=()=>new MysqlTlsFastAuth(hello(),'fixture','test-only-password',{verifiedTls:true});
const more=encodeMysqlPacket(Uint8Array.of(1,3),3),ok=encodeMysqlPacket(Uint8Array.of(0,0,0,2,0,0,0),4);
test('challenge proof agrees with independent Node SHA256 construction and never contains raw password',async()=>{
 const c=make(),wire=await c.start();assert.equal(wire[3],2);const p=wire.subarray(4),view=new DataView(p.buffer,p.byteOffset,p.length);assert.equal(view.getUint32(0,true),0x88a00);assert.equal(p[32+8],32);
 const hash=(b:Uint8Array|string)=>createHash('sha256').update(b).digest();const a=hash('test-only-password'),b=hash(a),scramble=Uint8Array.from({length:20},(_,i)=>i+1),mask=hash(Buffer.concat([b,scramble]));
 assert.deepEqual(p.slice(41,73),new Uint8Array(a.map((v,i)=>v^mask[i])));assert.ok(!new TextDecoder().decode(wire).includes('test-only-password'));assert.equal(c.state,'fast');c.close();assert.ok(wire.some(v=>v!==0),'returned buffer belongs to caller');wire.fill(0);
});
test('strict fast-auth then OK supports arbitrary byte fragmentation and coalescing',async()=>{
 for(const fragmented of [false,true]){const c=make();await c.start();const response=new Uint8Array([...more,...ok]);let status='pending';for(const b of fragmented?Array.from(response,v=>Uint8Array.of(v)):[response])status=c.receive(b);assert.equal(status,'authenticated');assert.equal(c.state,'authenticated');}
});
test('no verified TLS, old plugins, Unicode credentials, full auth, switch and wrong sequence fail closed',async()=>{
 assert.throws(()=>new MysqlTlsFastAuth(hello(),'u','p',{verifiedTls:false} as never),/tls-required/);
 assert.throws(()=>new MysqlTlsFastAuth(hello('mysql_native_password'),'u','p',{verifiedTls:true}),/unsupported/);
 assert.throws(()=>new MysqlTlsFastAuth(hello(),'u','秘密',{verifiedTls:true}),/input/);
 for(const response of [encodeMysqlPacket(Uint8Array.of(1,4),3),encodeMysqlPacket(Uint8Array.of(254,0),3),encodeMysqlPacket(Uint8Array.of(0,0,0,2,0,0,0),3),encodeMysqlPacket(Uint8Array.of(1,3),4)]){const c=make();await c.start();assert.throws(()=>c.receive(response));assert.equal(c.state,'failed');}
});
test('server error content never escapes and trailing/oversized/duplicate messages reject',async()=>{
 for(const response of [encodeMysqlPacket(Uint8Array.of(255,21,4,35,...text('28000private password')),3),new Uint8Array([...more,...ok,1]),new Uint8Array(96*1024+1),new Uint8Array([...more,...encodeMysqlPacket(Uint8Array.of(1,3),4)])]){const c=make();await c.start();assert.throws(()=>c.receive(response),e=>e instanceof Error&&!e.message.includes('private password'));assert.equal(c.state,'failed');}
});
test('close during crypto and repeated starts cannot yield a usable authentication result',async()=>{
 const c=make();const pending=c.start();c.close();await assert.rejects(pending);assert.equal(c.state,'closed');
 const d=make();const first=d.start();await assert.rejects(d.start());await assert.rejects(first);assert.equal(d.state,'failed');
});

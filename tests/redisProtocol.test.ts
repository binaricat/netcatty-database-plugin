import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeRedisCommand,RedisResp2Decoder,redisText,RedisProtocolError,REDIS_PROTOCOL_LIMITS} from '../src/redisProtocol';
const bytes=(text:string)=>new TextEncoder().encode(text);
test('binarysafe command encoder uses byte lengths and copies source',()=>{
 const binary=new Uint8Array([0,13,10,255]);const encoded=encodeRedisCommand(['SET','键',binary]);binary.fill(1);
 assert.deepEqual(encoded,new Uint8Array([...bytes('*3\r\n$3\r\nSET\r\n$3\r\n键\r\n$4\r\n'),0,13,10,255,13,10]));
 assert.throws(()=>encodeRedisCommand([]),/limit/);assert.throws(()=>encodeRedisCommand(['X'.repeat(262144)]),/limit/);
});
test('all RESP2 variants including empty/null arrays and binary bulk',()=>{
 const decoder=new RedisResp2Decoder();const values=decoder.feed(bytes('+OK\r\n-ERR denied\r\n:42\r\n:-5\r\n$0\r\n\r\n$-1\r\n*-1\r\n*0\r\n*2\r\n:1\r\n$3\r\n猫\r\n'));decoder.finish();
 assert.deepEqual(values,[{type:'simple',value:bytes('OK')},{type:'error',value:bytes('ERR denied')},{type:'integer',value:42},{type:'integer',value:-5},{type:'bulk',value:new Uint8Array()},{type:'bulk',value:null},{type:'array',value:null},{type:'array',value:[]},{type:'array',value:[{type:'integer',value:1},{type:'bulk',value:bytes('猫')}]}]);
 assert.equal(redisText(bytes('猫')),'猫');assert.throws(()=>redisText(new Uint8Array([255])),/malformed/);
});
test('every chunk boundary, one byte feeds and multiple pipelined frames agree',()=>{
 const wire=bytes('*3\r\n$6\r\n你好\r\n*2\r\n+OK\r\n$0\r\n\r\n:-99\r\n+END\r\n');const expected=new RedisResp2Decoder().feed(wire);
 for(let i=0;i<=wire.length;i++){const decoder=new RedisResp2Decoder();assert.deepEqual([...decoder.feed(wire.slice(0,i)),...decoder.feed(wire.slice(i))],expected);decoder.finish();}
 const decoder=new RedisResp2Decoder();const output=[];for(const byte of wire)output.push(...decoder.feed(new Uint8Array([byte])));assert.deepEqual(output,expected);decoder.finish();
});
test('binary bulk preserves NUL CRLF invalid UTF8 without decoding or aliasing',()=>{
 const wire=new Uint8Array([...bytes('$4\r\n'),0,13,10,255,13,10]);const decoder=new RedisResp2Decoder();const output=decoder.feed(wire);wire.fill(0);decoder.feed(bytes('+OK\r\n'));assert.deepEqual(output,[{type:'bulk',value:new Uint8Array([0,13,10,255])}]);
});
test('malformed frames poison decoder and errors never echo input secrets',()=>{
 for(const input of ['?AUTH secret\r\n','+secret\n','+secret\rX',':1x\r\n',':\r\n',':1.2\r\n','$-2\r\n','*-2\r\n','$1\r\nXxx','*1\r\n?secret\r\n']){
  const decoder=new RedisResp2Decoder();assert.throws(()=>decoder.feed(bytes(input)),e=>e instanceof RedisProtocolError&&!e.message.includes('secret'));assert.throws(()=>decoder.feed(bytes('+OK\r\n')),/closed/);
 }
});
test('unsafe integers and resource budgets reject before allocation',()=>{
 for(const input of [':9007199254740992\r\n',':-9007199254740992\r\n','$999999999999999999999999\r\n'])assert.throws(()=>new RedisResp2Decoder().feed(bytes(input)),/unsafe-integer/);
 for(const input of ['$98305\r\n','*10001\r\n','*1\r\n'.repeat(17)+'+x\r\n','+'+'x'.repeat(262144)])assert.throws(()=>new RedisResp2Decoder().feed(bytes(input)),/limit/);
 assert.throws(()=>new RedisResp2Decoder().feed(new Uint8Array(REDIS_PROTOCOL_LIMITS.frameBytes+1)),/limit/);
 const decoder=new RedisResp2Decoder();assert.throws(()=>decoder.feed(bytes('*2\r\n$50000\r\n'+'x'.repeat(50000)+'\r\n$50000\r\n')),/limit/);
});
test('exact result/item/depth boundaries and unfinished stream',()=>{
 const decoder=new RedisResp2Decoder();assert.equal(decoder.feed(bytes('$98304\r\n'+'x'.repeat(98304)+'\r\n')).length,1);decoder.finish();
 assert.equal(new RedisResp2Decoder().feed(bytes('*10000\r\n'+':0\r\n'.repeat(10000))).length,1);
 assert.equal(new RedisResp2Decoder().feed(bytes('*1\r\n'.repeat(16)+'+x\r\n')).length,1);
 for(const input of ['+OK\r','$3\r\nxx','*1\r\n','$0\r\n']){const d=new RedisResp2Decoder();d.feed(bytes(input));assert.throws(()=>d.finish(),/truncated/);}
});

test('integer signed decimal semantics include explicit plus; lengths are decimal headers',()=>{
 assert.deepEqual(new RedisResp2Decoder().feed(bytes(':+42\r\n:0002\r\n:-0\r\n')),[{type:'integer',value:42},{type:'integer',value:2},{type:'integer',value:-0}]);
});

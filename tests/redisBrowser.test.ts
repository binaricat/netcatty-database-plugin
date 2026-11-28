import test from 'node:test';
import assert from 'node:assert/strict';
import {createRedisBrowser,RedisBrowserError} from '../src/redisBrowser';
import type {RedisValue} from '../src/redisProtocol';
const bytes=(value:string)=>new TextEncoder().encode(value);
const bulk=(value:string|Uint8Array|null):RedisValue=>({type:'bulk',value:typeof value==='string'?bytes(value):value});
const arr=(...value:RedisValue[]):RedisValue=>({type:'array',value});
const int=(value:number):RedisValue=>({type:'integer',value});
const simple=(value:string):RedisValue=>({type:'simple',value:bytes(value)});
function setup(responses:RedisValue[]){const calls:(readonly(string|Uint8Array)[])[]=[];return {calls,browser:createRedisBrowser({request:async args=>{calls.push(args);const reply=responses.shift();assert.ok(reply);return reply;}})};}
const metadata=(type:string)=>[simple(type),int(-1),int(-1)];
const code=(expected:string)=>(error:unknown)=>error instanceof RedisBrowserError&&error.code===expected;
test('INFO splits only first colon and scan preserves binary key bytes/large cursor without auto-pagination',async()=>{
  const raw=new Uint8Array([255,0,65]);const f=setup([bulk('# Server\r\nredis_version:7.4.0\r\nconfig_file:/a:b\r\n'),arr(bulk('18446744073709551615'),arr(bulk(raw),bulk('中文'))),arr(bulk('0'),arr())]);
  const info=await f.browser.serverInfo();assert.equal(info.fields.config_file,'/a:b');
  const page=await f.browser.scan({pageSize:2});assert.equal(page.done,false);assert.equal(page.keys[0].hex,'ff0041');assert.equal(page.keys[0].utf8,null);assert.deepEqual(page.keys[0].bytes,raw);assert.equal(page.keys[1].utf8,'中文');
  raw[0]=1;assert.equal(page.keys[0].bytes[0],255);
  assert.equal(f.calls.length,2);const end=await f.browser.scan({cursor:page.nextCursor,pageSize:2});assert.equal(end.done,true);assert.deepEqual(f.calls[2],['SCAN','18446744073709551615','COUNT','2']);
});
test('TYPE TTL PTTL and string GET use binary keys and preserve empty/null values',async()=>{
  const name=new Uint8Array([255,0]);const f=setup([...metadata('string'),bulk(''),...metadata('string'),bulk(null)]);
  const value=await f.browser.readPage(name);assert.equal(value.kind,'string');if(value.kind==='string')assert.equal(value.value?.hex,'');assert.equal(value.metadata.ttl,-1);assert.deepEqual(f.calls[0],['TYPE',name]);assert.equal(f.calls[3][0],'GET');
  const gone=await f.browser.readPage(name);assert.equal(gone.kind,'string');if(gone.kind==='string')assert.equal(gone.value,null);
});
test('hash/set/zset use cursor scans with bounded COUNT, never whole-collection commands',async()=>{
  const f=setup([...metadata('hash'),arr(bulk('5'),arr(bulk('field'),bulk(new Uint8Array([128])))),...metadata('set'),arr(bulk('0'),arr(bulk('member'))),...metadata('zset'),arr(bulk('0'),arr(bulk('m'),bulk('-inf')))]);
  const hash=await f.browser.readPage(bytes('h'),{pageSize:1});assert.equal(hash.kind,'hash');if(hash.kind==='hash'){assert.equal(hash.nextCursor,'5');assert.equal(hash.entries[0].value.hex,'80');}
  const set=await f.browser.readPage(bytes('s'),{cursor:'12',pageSize:1});assert.equal(set.kind,'set');
  const zset=await f.browser.readPage(bytes('z'),{pageSize:1});assert.equal(zset.kind,'zset');if(zset.kind==='zset')assert.equal(zset.entries[0].score,'-inf');
  assert.deepEqual(f.calls.filter(call=>String(call[0]).endsWith('SCAN')).map(call=>[call[0],...call.slice(2)]),[['HSCAN','0','COUNT','1'],['SSCAN','12','COUNT','1'],['ZSCAN','0','COUNT','1']]);assert.ok(!f.calls.some(call=>['KEYS','HGETALL','SMEMBERS'].includes(String(call[0]))));
});
test('list pagination is explicit and an exactly full page requires caller to check the next page',async()=>{
  const f=setup([...metadata('list'),arr(bulk('a'),bulk('b')),...metadata('list'),arr()]);const page=await f.browser.readPage(bytes('l'),{offset:4,pageSize:2});assert.equal(page.kind,'list');if(page.kind==='list')assert.equal(page.nextOffset,6);assert.deepEqual(f.calls[3],['LRANGE',bytes('l'),'4','5']);
  const end=await f.browser.readPage(bytes('l'),{offset:6,pageSize:2});if(end.kind==='list')assert.equal(end.nextOffset,null);
});
test('independent page limit, malformed pairs and total formatted output budget fail explicitly without advancing',async()=>{
  const oversized=setup([arr(bulk('7'),arr(...Array.from({length:1001},()=>bulk('a'))))]);await assert.rejects(oversized.browser.scan({pageSize:1}),code('page-limit'));assert.equal(oversized.calls.length,1);
  const odd=setup([...metadata('hash'),arr(bulk('0'),arr(bulk('unpaired')))]);await assert.rejects(odd.browser.readPage(bytes('h')),code('response'));
  const large=setup([...metadata('string'),bulk(new Uint8Array(30000).fill(255))]);await assert.rejects(large.browser.readPage(bytes('s')),code('budget'));
});
test('MOVED/ASK errors never redirect or disclose reply; unsupported types and bad inputs do not trigger value reads',async()=>{
  for(const value of ['MOVED 1 private:6380','ASK 1 private:6380']){const f=setup([{type:'error',value:bytes(value)}]);await assert.rejects(f.browser.scan(),error=>code('transport')(error)&&!String(error).includes('private'));assert.equal(f.calls.length,1);}
  const f=setup(metadata('stream'));await assert.rejects(f.browser.readPage(bytes('x')),code('unsupported'));assert.equal(f.calls.length,3);
  const bad=setup([]);await assert.rejects(bad.browser.scan({cursor:'18446744073709551616'}),code('input'));await assert.rejects(bad.browser.scan({cursor:'-1'}),code('input'));await assert.rejects(bad.browser.readPage(bytes('x'),{pageSize:101}),code('input'));assert.equal(bad.calls.length,0);
});
test('COUNT 50 is only a hint: complete 512-key and 120-pair compact collection pages are retained',async()=>{
  const keys=Array.from({length:512},(_,i)=>bulk(String(i)));const pairs=Array.from({length:120},(_,i)=>[bulk(String(i)),bulk('v')]).flat();
  const f=setup([arr(bulk('17'),arr(...keys)),...metadata('hash'),arr(bulk('9'),arr(...pairs)),...metadata('set'),arr(bulk('0'),arr(...keys)),...metadata('zset'),arr(bulk('0'),arr(...Array.from({length:120},(_,i)=>[bulk(String(i)),bulk('1.5')]).flat()))]);
  const page=await f.browser.scan({pageSize:50});assert.equal(page.keys.length,512);assert.equal(page.keys[511].utf8,'511');assert.equal(page.nextCursor,'17');assert.equal(f.calls.length,1);
  const reassembled=[];for(let i=0;i<page.keys.length;i+=20)reassembled.push(...page.keys.slice(i,i+20));assert.deepEqual(reassembled,page.keys);
  const hash=await f.browser.readPage(bytes('h'),{pageSize:50});assert.equal(hash.kind,'hash');if(hash.kind==='hash'){assert.equal(hash.entries.length,120);assert.equal(hash.entries[119].field.utf8,'119');assert.equal(hash.nextCursor,'9');}
  const set=await f.browser.readPage(bytes('s'),{pageSize:50});if(set.kind==='set'){assert.equal(set.values.length,512);assert.equal(set.done,true);}else assert.fail('Expected set');
  const zset=await f.browser.readPage(bytes('z'),{pageSize:50});if(zset.kind==='zset'){assert.equal(zset.entries.length,120);assert.equal(zset.entries[119].score,'1.5');}else assert.fail('Expected zset');
  assert.ok(f.calls.filter(call=>String(call[0]).endsWith('SCAN')).every(call=>call.at(-1)==='50'));
});
test('1001 hash entries are rejected as a whole rather than advancing cursor after slicing',async()=>{
  const pairs=Array.from({length:1001},()=>[bulk('f'),bulk('v')]).flat();const f=setup([...metadata('hash'),arr(bulk('27'),arr(...pairs))]);
  await assert.rejects(f.browser.readPage(bytes('h'),{pageSize:50}),code('page-limit'));assert.equal(f.calls.length,4);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {PluginContext} from '@netcatty/plugin-sdk';
import {createRedisWorkbenchController} from '../src/useRedisWorkbench';
import {RedisWorkbench,redisDisplay,redisTextParts} from '../src/RedisWorkbench';
import type {RedisValue} from '../src/redisProtocol';
import {RedisSessionError} from '../src/redisSession';
const endpoint='tls://redis.example:6380';const bytes=(text:string)=>new TextEncoder().encode(text);
const bulk=(text:string):RedisValue=>({type:'bulk',value:bytes(text)});
function fake(){let closed=false,closes=0;const commands:(readonly(string|Uint8Array)[])[]=[];return {get closes(){return closes;},commands,session:{get isClosed(){return closed;},close:async()=>{closes++;closed=true;},request:async(args:readonly(string|Uint8Array)[]):Promise<RedisValue>=>{commands.push(args);switch(args[0]){case'INFO':return bulk('# Server\r\nredis_version:7.2.0\r\n');case'SCAN':return {type:'array',value:[bulk('0'),{type:'array',value:[{type:'bulk',value:new Uint8Array([255,0])}]}]};case'TYPE':return {type:'simple',value:bytes('string')};case'TTL':case'PTTL':return {type:'integer',value:-1};case'GET':return bulk('value');default:throw Error('unexpected');}}}};}
test('rendering empty declarations never contacts network and does not imply host lack of support',()=>{
 let calls=0;const context={environment:{locale:'en',theme:'light'},network:{connect:async()=>{calls++;throw Error('must not connect');}}} as unknown as PluginContext;
 const html=renderToStaticMarkup(React.createElement(RedisWorkbench,{context,declaredEndpoints:[]}));assert.equal(calls,0);assert.match(html,/No Redis TLS endpoint is declared/);assert.doesNotMatch(html,/Connect Redis|type="password"|Scan keys/);assert.doesNotMatch(html,/127\.0\.0\.1|localhost/);
});
test('controller admits only declared endpoint and performs no automatic browser queries after connect',async()=>{
 const f=fake();let calls=0;const vm=createRedisWorkbenchController({connect:async options=>{calls++;assert.equal(options.endpoint,endpoint);return f.session;}},[endpoint]);
 await vm.connect('tls://other.example:6380');assert.equal(calls,0);assert.equal(vm.getSnapshot().error,'not-declared');
 await vm.connect(endpoint);assert.equal(calls,1);assert.equal(vm.getSnapshot().status,'connected');assert.equal(f.commands.length,0);
 await vm.serverInfo();assert.equal(vm.getSnapshot().info?.fields.redis_version,'7.2.0');
 await vm.scan();assert.equal(vm.getSnapshot().scan?.keys.length,1);const key=vm.getSnapshot().scan!.keys[0];await vm.select(key);assert.equal(vm.getSnapshot().page?.kind,'string');assert.deepEqual(f.commands.find(args=>args[0]==='GET')?.[1],new Uint8Array([255,0]));
 vm.dispose();await Promise.resolve();assert.equal(f.closes,1);assert.equal(vm.getSnapshot().page,null);
});
test('cancelled delayed connection cannot resurrect a session and closes the late result',async()=>{
 const f=fake();let finish!:(session:typeof f.session)=>void;let signal:AbortSignal|undefined;
 const vm=createRedisWorkbenchController({connect:options=>{signal=options.signal;return new Promise(resolve=>{finish=resolve;});}},[endpoint]);
 const waiting=vm.connect(endpoint,{password:'synthetic'});vm.disconnect();assert.equal(signal?.aborted,true);finish(f.session);await waiting;assert.equal(vm.getSnapshot().status,'disconnected');assert.equal(f.closes,1);assert.ok(!JSON.stringify(vm.getSnapshot()).includes('synthetic'));
});
test('late query response after disconnect is discarded; idle closed session clears data',async()=>{
 const f=fake();let finish!:(value:RedisValue)=>void;const original=f.session.request;f.session.request=args=>args[0]==='INFO'?new Promise(resolve=>{finish=resolve;}):original(args);
 const vm=createRedisWorkbenchController({connect:async()=>f.session},[endpoint]);await vm.connect(endpoint);const pending=vm.serverInfo();vm.disconnect();finish(bulk('redis_version:9'));await pending;assert.equal(vm.getSnapshot().info,null);
 const second=fake(),other=createRedisWorkbenchController({connect:async()=>second.session},[endpoint]);await other.connect(endpoint);await other.scan();await second.session.close();other.checkClosed();assert.equal(other.getSnapshot().status,'closed');assert.equal(other.getSnapshot().scan,null);
});
test('errors are safe codes, never arbitrary server/transport text; failed scans retain previous cursor',async()=>{
 const f=fake(),vm=createRedisWorkbenchController({connect:async()=>f.session},[endpoint]);await vm.connect(endpoint);await vm.scan();const before=vm.getSnapshot().scan;f.session.request=async()=>{throw Error('secret-password server text');};await vm.scan();assert.equal(vm.getSnapshot().scan,before);assert.equal(vm.getSnapshot().error,'transport');assert.ok(!JSON.stringify(vm.getSnapshot()).includes('secret-password'));
 const bad=createRedisWorkbenchController({connect:async()=>{throw new RedisSessionError('authentication');}},[endpoint]);await bad.connect(endpoint,{password:'private'});assert.equal(bad.getSnapshot().error,'authentication');assert.ok(!JSON.stringify(bad.getSnapshot()).includes('private'));vm.dispose();
});
test('binary/long value display does not mutate data or omit fragments',()=>{
 const binary={bytes:new Uint8Array([255,0]),hex:'ff00',utf8:null};assert.equal(redisDisplay(binary),'hex:ff00');assert.deepEqual(binary.bytes,new Uint8Array([255,0]));
 const source='x'.repeat(3999)+'🦔'+'中'.repeat(9000);const parts=redisTextParts(source);assert.equal(parts.join(''),source);assert.ok(parts.every(part=>part.length<=4000&&!/[\uD800-\uDBFF]$/.test(part)));
});

test('configured UI masks credentials and host feature absence is distinct from missing endpoint',()=>{
 const enabled={environment:{locale:'en',theme:'light'},enabledFeatures:new Set(['network.byte-streams']),network:{}} as unknown as PluginContext;const html=renderToStaticMarkup(React.createElement(RedisWorkbench,{context:enabled,declaredEndpoints:[endpoint]}));assert.match(html,/type="password"/);assert.match(html,/disabled=""[^>]*>Connect Redis/);
 const disabled={environment:{locale:'en',theme:'light'},enabledFeatures:new Set(),network:{}} as unknown as PluginContext;const unavailable=renderToStaticMarkup(React.createElement(RedisWorkbench,{context:disabled,declaredEndpoints:[endpoint]}));assert.match(unavailable,/has not enabled the network.byte-streams/);assert.doesNotMatch(unavailable,/type="password"|Connect Redis/);
});

test('Chinese empty endpoint state follows host locale without exposing credential fields',()=>{
 const context={environment:{locale:'zh-CN',theme:'dark'},enabledFeatures:new Set(['network.byte-streams']),network:{}} as unknown as PluginContext;
 const html=renderToStaticMarkup(React.createElement(RedisWorkbench,{context,declaredEndpoints:[]}));
 assert.match(html,/未连接/);assert.match(html,/配置 Redis TLS 端点/);assert.doesNotMatch(html,/type="password"/);
});
test('controller retains complete COUNT-hint oversized pages and preserves them on independent 1001-item failure',async()=>{
 const f=fake();let tooLarge=false;
 f.session.request=async()=>({type:'array',value:[bulk(tooLarge?'19':'17'),{type:'array',value:Array.from({length:tooLarge?1001:120},(_,i)=>bulk(String(i)))}]});
 const vm=createRedisWorkbenchController({connect:async()=>f.session},[endpoint]);await vm.connect(endpoint);await vm.scan();
 const before=vm.getSnapshot().scan;assert.equal(before?.keys.length,120);assert.equal(before?.keys[119].utf8,'119');assert.equal(before?.nextCursor,'17');
 tooLarge=true;await vm.scan();assert.equal(vm.getSnapshot().error,'page-limit');assert.equal(vm.getSnapshot().scan,before);assert.equal(vm.getSnapshot().scan?.nextCursor,'17');vm.dispose();
});

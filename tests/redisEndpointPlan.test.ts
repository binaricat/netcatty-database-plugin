import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalRedisTlsEndpoint,planRedisEndpoint,type RedisHostSelection} from '../src/redisEndpointPlan';
const host:RedisHostSelection={target:{kind:'host.selection',scope:'metadata',handle:'opaque',revision:'rev',expiresAt:100},metadata:{label:'My SSH server',hostname:'ssh.example.test',username:'alice',port:22,group:'',tags:[],protocol:'ssh'}};
test('TLS exact endpoint canonicalization matches main host syntax',()=>{
 assert.equal(canonicalRedisTlsEndpoint('tls://DB.Example.test:6380'),'tls://db.example.test:6380');
 assert.equal(canonicalRedisTlsEndpoint('tls://[2001:0db8:0:0:0:0:0:1]:6380'),'tls://[2001:db8::1]:6380');
 assert.equal(canonicalRedisTlsEndpoint('tls://192.168.2.1:65535'),'tls://192.168.2.1:65535');
});
test('reject scan patterns, credentials, URL components and ambiguous host/port spellings',()=>{
 for(const value of ['tcp://db.test:6379','tls://*:6380','tls://db.test:1-65535','tls://user:secret@db.test:6380','tls://db.test:6380/','tls://db.test:6380?q=x','tls://db.test:6380#x','tls://db.test','tls://db.test:0','tls://db.test:65536','tls://db.test:06380','tls://127.1:6380','tls://0127.0.0.1:6380','tls://[fe80::1%25eth0]:6380','tls://[bad]:6380','tls://-db.test:6380',' tls://db.test:6380','tls://db.test.:6380'])assert.throws(()=>canonicalRedisTlsEndpoint(value),/invalid-endpoint/);
});
test('explicit DB address must match existing declaration; input lists stay unchanged',()=>{
 const endpoints=Object.freeze(['tls://db.example.test:6380']);
 const plan=planRedisEndpoint({endpoint:'tls://DB.EXAMPLE.test:6380',declaredEndpoints:endpoints,selectedHost:host},1);
 assert.equal(plan.endpoint,endpoints[0]);assert.equal(plan.hostLabel,'My SSH server');assert.equal(plan.databaseDiscovered,false);assert.equal(plan.endpointSource,'explicit-user-input');assert.doesNotMatch(JSON.stringify(plan),/alice|ssh.example|opaque|rev/);
 assert.deepEqual(endpoints,['tls://db.example.test:6380']);assert.throws(()=>planRedisEndpoint({endpoint:'tls://db.example.test:6379',declaredEndpoints:endpoints}),/not-declared/);
 assert.throws(()=>planRedisEndpoint({endpoint:'tls://db.example.test:6380',declaredEndpoints:['tls://*:6380']}),/invalid-declarations/);
});
test('selected host metadata never guesses DB endpoint or SSH port',()=>{
 assert.throws(()=>planRedisEndpoint({endpoint:'',declaredEndpoints:['tls://ssh.example.test:22'],selectedHost:host},1),/endpoint-required/);
 assert.equal(planRedisEndpoint({endpoint:'tls://[2001:db8::1]:6380',declaredEndpoints:['tls://[2001:0db8:0:0:0:0:0:1]:6380']}).hostLabel,null);
});
test('unsupported/expired metadata references refuse without leaking input',()=>{
 for(const target of [{...host.target,kind:'session'},{...host.target,scope:'credentials'},{...host.target,expiresAt:0},{...host.target,handle:''}])assert.throws(()=>planRedisEndpoint({endpoint:'tls://db.test:6380',declaredEndpoints:['tls://db.test:6380'],selectedHost:{...host,target} as RedisHostSelection},1),/unsupported-host-ref/);
});

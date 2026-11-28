import test from 'node:test';import assert from 'node:assert/strict';
import {declaredRedisEndpoints,PACKAGED_REDIS_ENDPOINTS} from '../src/redisDeclarations';
test('production package has no Redis network destination and grants nothing',()=>assert.deepEqual(PACKAGED_REDIS_ENDPOINTS,[]));
test('only declared TLS stream destinations with advertised capability are selectable',()=>{
 const value={features:{optional:['network.byte-streams']},permissions:{optional:[{permission:'network.stream',resources:['tls://REDIS.example:6380','tcp://other.example:6379']},{permission:'network',resources:['https://not-redis.example']}]}};
 assert.deepEqual(declaredRedisEndpoints(value),['tls://redis.example:6380']);
 assert.deepEqual(declaredRedisEndpoints({...value,features:{}}),[]);
 assert.deepEqual(declaredRedisEndpoints({...value,permissions:{required:[{permission:'network.stream',resources:['tls://*.example:6380']}]}}),[]);
});

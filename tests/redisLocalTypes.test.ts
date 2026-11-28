// Offline tests of harness assertions only, NOT real-server acceptance.
import test from 'node:test';import assert from 'node:assert/strict';
import {verifyRedisFixtureTypes} from '../scripts/redis-local-types';
import type {RedisBrowser} from '../src/redisBrowser';
const bin=(utf8:string)=>({utf8,bytes:new TextEncoder().encode(utf8),hex:''});
function fixture(corrupt=false){const offsets:number[]=[];const browser={readPage:async(raw:Uint8Array,input:{offset?:number;cursor?:string})=>{
 const kind=new TextDecoder().decode(raw).split(':').at(-1)!;const metadata={type:kind,ttl:-1,pttl:-1};
 if(kind==='list'){const offset=input.offset??0;offsets.push(offset);return {metadata,kind,offset,nextOffset:offset===0?2:null,values:(offset===0?['alpha','beta']:['gamma']).map(bin)};}
 const base={metadata,kind,cursor:input.cursor??'0',nextCursor:'0',done:true};
 if(kind==='hash')return {...base,entries:[['count','2'],['name','Netcatty TLS'],['status','verified']].map(([field,value])=>({field:bin(field),value:bin(value)}))};
 if(kind==='set')return {...base,values:['gamma','alpha','beta'].map(bin)};
 return {...base,entries:[['alpha','1'],['beta',corrupt?'9':'2.5'],['gamma','10']].map(([member,score])=>({member:bin(member),score}))};
 }} as unknown as RedisBrowser;return {browser,offsets};}
test('typed harness accepts complete compact scan pages beyond COUNT=1 and list offsets',async()=>{const f=fixture();const result=await verifyRedisFixtureTypes(f.browser);assert.deepEqual(f.offsets,[0,2]);assert.deepEqual(result.pageCounts,{list:2,hash:1,set:1,zset:1});});
test('typed harness refuses mismatched score instead of reporting successful read',async()=>{await assert.rejects(verifyRedisFixtureTypes(fixture(true).browser),/fixture mismatch/);});

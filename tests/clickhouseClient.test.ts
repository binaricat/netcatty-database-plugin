import test from 'node:test';import assert from 'node:assert/strict';
import type {PluginNetworkClient} from '@netcatty/plugin-sdk';
import {ClickHouseReadClient} from '../src/clickhouseClient';
function fixture(results:unknown[]){const requests:Parameters<PluginNetworkClient['request']>[0][]=[];let leases=0;const network={request:async(request:Parameters<PluginNetworkClient['request']>[0])=>{requests.push(request);return {url:request.url,status:200,headers:{},body:{encoding:'base64' as const,data:Buffer.from(JSON.stringify(results.shift())).toString('base64')}};}} as unknown as PluginNetworkClient;
 const options={endpoint:'https://db.test:8443/',declaredEndpoints:['https://db.test:8443/'],lease:async(operationId:string)=>({lease:{kind:'secret-lease' as const,id:`lease-${String(++leases).padStart(32,'0')}`,operationId,expiresAt:100},username:'reader'})};return {requests,network,options,client:new ClickHouseReadClient(network,options,()=>1)};}
const result=(name:string,rows:unknown[][])=>({meta:[{name,type:'String'}],data:rows,rows:rows.length});
test('fixed metadata query binds untrusted values, lease only auth and readonly settings',async()=>{const f=fixture([result('name',[['notes']])]);await f.client.listTables("x'; SELECT url('https://bad'); --");const r=f.requests[0],url=new URL(r.url);assert.equal(url.searchParams.get('param_db'),"x'; SELECT url('https://bad'); --");assert.equal(url.searchParams.get('readonly'),'1');assert.ok(!r.body!.data.includes('https://bad'));assert.deepEqual(r.authorization,{scheme:'Basic',username:'reader'});assert.equal(r.credentialLease?.operationId,'network:https://db.test:8443');assert.ok(!('password' in r));});
test('bounded table read requires local engine and fresh lease each request',async()=>{const f=fixture([result('engine',[['MergeTree']]),result('id',[[1]])]);assert.deepEqual((await f.client.readTable('db','notes',10)).rows,[[1]]);assert.equal(f.requests.length,2);assert.notEqual(f.requests[0].credentialLease?.id,f.requests[1].credentialLease?.id);assert.equal(f.requests[1].body?.data,'SELECT * FROM {db:Identifier}.{table:Identifier} LIMIT {limit:UInt16}');});
test('external/view engines refuse before table read, no settings fallback or automatic retries',async()=>{for(const engine of ['URL','Distributed','View','PostgreSQL','S3','MySQL']){const f=fixture([result('engine',[[engine]])]);await assert.rejects(f.client.readTable('db','t'),/table-engine/);assert.equal(f.requests.length,1);}});
test('endpoint declarations and leases are mandatory and fail closed',async()=>{const f=fixture([]);for(const endpoint of ['https://localhost./','https://service.local./','https://db.test./','https://LOCALHOST./','https://localhost/','https://127.0.0.1/','https://169.254.169.254/','https://[::1]/','https://[::ffff:7f00:1]/','https://0x7f000001/','https://service.local/','http://db.test/','https://u:pw@db.test/','https://db.test/path','https://db.test/?x=1','https://other.test/'])assert.throws(()=>new ClickHouseReadClient(f.network,{...f.options,endpoint}),/endpoint/);await assert.rejects(new ClickHouseReadClient(f.network,{...f.options,lease:async()=>({lease:{kind:'secret-lease',id:'a',operationId:'wrong',expiresAt:100},username:'a'})},()=>1).listTables('db'),/lease/);assert.equal(f.requests.length,0);});
test('bad responses and transport errors never echo credentials or server data',async()=>{const f=fixture([{meta:[],data:[],rows:1}]);await assert.rejects(f.client.listTables('db'),/response/);f.network.request=async()=>{throw new Error('password secret');};await assert.rejects(f.client.listTables('db'),e=>e instanceof Error&&e.message==='ClickHouse transport');});
test('redirected result, response budget, unsafe integer and nested values reject',async()=>{
 for(const response of [{url:'https://elsewhere.test/',status:200,headers:{},body:{encoding:'base64' as const,data:'e30='}},{url:'unused',status:200,headers:{},body:{encoding:'base64' as const,data:'A'.repeat(131073)}}]){
  const f=fixture([]);f.network.request=async r=>({...response,url:response.url==='unused'?r.url:response.url});await assert.rejects(f.client.listTables('db'),/response|limit/);
 }
 for(const value of [9007199254740992,{x:1},[1]]){const f=fixture([result('x',[[value]])]);await assert.rejects(f.client.listTables('db'),/response/);}
});
test('runtime malformed configuration fails with endpoint code, not raw TypeError',()=>{
 const f=fixture([]);for(const options of [null,undefined,{}, {...f.options,endpoint:42},{...f.options,declaredEndpoints:null},{...f.options,declaredEndpoints:'https://db.test/'},{...f.options,declaredEndpoints:Array(65).fill(f.options.endpoint)},{...f.options,declaredEndpoints:[{}]},{...f.options,lease:null}])assert.throws(()=>new ClickHouseReadClient(f.network,options as never),e=>e instanceof Error&&e.message==='ClickHouse endpoint');
});
test('null and malformed credentials are fixed lease errors and never dispatched',async()=>{
 const f=fixture([]);const valid={lease:{kind:'secret-lease',id:'opaque-'.padEnd(40,'x'),operationId:'network:https://db.test:8443',expiresAt:100},username:'reader'};
 for(const auth of [null,undefined,{}, {lease:null,username:'reader'},...['',129, 'x'.repeat(129),'secret\0name'].map(username=>({...valid,username})),...[NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1,0].map(expiresAt=>({...valid,lease:{...valid.lease,expiresAt}})),{...valid,lease:{...valid.lease,id:123}}]){
  const client=new ClickHouseReadClient(f.network,{...f.options,lease:async()=>auth as never},()=>1);await assert.rejects(client.listTables('db'),e=>e instanceof Error&&e.message==='ClickHouse lease');
 }assert.equal(f.requests.length,0);
});
test('valid lease is passed unchanged to SDK and no Authorization header is synthesized',async()=>{
 const f=fixture([result('x',[[1]])]);const lease={kind:'secret-lease' as const,id:'opaque-reference-'.padEnd(40,'x'),operationId:'network:https://db.test:8443',expiresAt:100};const client=new ClickHouseReadClient(f.network,{...f.options,lease:async()=>({lease,username:'reader'})},()=>1);await client.listTables('db');assert.equal(f.requests[0].credentialLease,lease);assert.deepEqual(f.requests[0].headers,{'content-type':'text/plain; charset=utf-8'});assert.deepEqual(f.requests[0].authorization,{scheme:'Basic',username:'reader'});
});
test('invalid base64, UTF8 and oversized column metadata fail with fixed response code',async()=>{
 for(const data of ['!bad','e30','e30=\n','e31=',Buffer.from([255]).toString('base64')]){const f=fixture([]);f.network.request=async r=>({url:r.url,status:200,headers:{},body:{encoding:'base64',data}});await assert.rejects(f.client.listTables('db'),/^Error: ClickHouse response$/);}
 for(const meta of [{name:'x'.repeat(257),type:'String'},{name:'x',type:'x'.repeat(1025)},{name:'x',type:''},{name:'x\0',type:'String'}]){const f=fixture([{meta:[meta],data:[],rows:0}]);await assert.rejects(f.client.listTables('db'),/response/);}
 for(const response of [null,{}, {body:null}]){const f=fixture([]);f.network.request=async()=>response as never;await assert.rejects(f.client.listTables('db'),/response/);}
});

test('lease identifiers match main contract minimum and maximum lengths before dispatch',async()=>{
 for(const id of ['', 'x'.repeat(31), 'x'.repeat(257)]){
  const f=fixture([]);const client=new ClickHouseReadClient(f.network,{...f.options,lease:async(operationId)=>({lease:{kind:'secret-lease',id,operationId,expiresAt:100},username:'reader'})},()=>1);
  await assert.rejects(client.listTables('db'),/^Error: ClickHouse lease$/);assert.equal(f.requests.length,0);
 }
 for(const id of ['x'.repeat(32),'x'.repeat(256)]){
  const f=fixture([result('name',[['notes']])]);const client=new ClickHouseReadClient(f.network,{...f.options,lease:async(operationId)=>({lease:{kind:'secret-lease',id,operationId,expiresAt:100},username:'reader'})},()=>1);
  await client.listTables('db');assert.equal(f.requests[0].credentialLease?.id,id);
 }
});

test('raw JSON Decimal numbers refuse before rounded values can escape; quoted decimals remain exact',async()=>{
 for(const type of ['Decimal(30, 1)','Nullable(Decimal128(18))','Decimal256(38)']){
  const f=fixture([]);f.network.request=async request=>({url:request.url,status:200,headers:{},body:{encoding:'base64',data:Buffer.from('{'+'"meta":[{"name":"money","type":'+JSON.stringify(type)+'}],"data":[[9007199254740990.9]],"rows":1}').toString('base64')}});
  await assert.rejects(f.client.listTables('db'),/^Error: ClickHouse response$/);
 }
 const exact='9007199254740990.900000000000000001';const f=fixture([{meta:[{name:'money',type:'Decimal(38, 18)'}],data:[[exact]],rows:1}]);
 assert.deepEqual((await f.client.listTables('db')).rows,[[exact]]);const url=new URL(f.requests[0].url);assert.equal(url.searchParams.get('output_format_json_quote_decimals'),'1');assert.equal(url.searchParams.get('output_format_json_quote_64bit_integers'),'1');
 const nullable=fixture([{meta:[{name:'money',type:'Nullable(Decimal(10, 2))'}],data:[[null]],rows:1}]);assert.deepEqual((await nullable.client.listTables('db')).rows,[[null]]);
});
test('HTTP 200 exception markers are errors, never successful partial data or echoed server text',async()=>{
 for(const marker of [{exception:'private late server error'},{exception_code:159},{exception:null}]){
  const f=fixture([{...result('name',[['partial']]),...marker}]);await assert.rejects(f.client.listTables('db'),error=>error instanceof Error&&error.message==='ClickHouse response'&&!String(error).includes('private'));
 }
 for(const header of ['X-ClickHouse-Exception-Code','x-clickhouse-exception-code']){
  const f=fixture([]);f.network.request=async request=>({url:request.url,status:200,headers:{[header]:'159'},body:{encoding:'base64',data:Buffer.from(JSON.stringify(result('name',[['partial']]))).toString('base64')}});
  await assert.rejects(f.client.listTables('db'),/^Error: ClickHouse response$/);
 }
});

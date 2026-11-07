// Read-only main-host contract validation, not real credentials, network or ClickHouse acceptance.
// Run: NETCATTY_HOST_ROOT=/absolute/main node --import tsx scripts/check-clickhouse-host-contract.mjs
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import {ClickHouseReadClient} from '../src/clickhouseClient.ts';
const root=process.env.NETCATTY_HOST_ROOT;
if(!root||!path.isAbsolute(root))throw Error('Set NETCATTY_HOST_ROOT to the audited main checkout.');
const host=createRequire(path.join(root,'package.json'));
const {PluginNetworkBroker}=host('./electron/plugins/networkBroker.cjs');
const {createDefinitionValidator}=host('./electron/plugins/contractValidator.cjs');
let fetched=false;
const broker=new PluginNetworkBroker({fetch:async()=>{fetched=true;throw Error('No network allowed in contract check');}});
const validate=createDefinitionValidator('SecretLeaseRef');
const lease={kind:'secret-lease',id:'contract-only-lease-'.padEnd(40,'x'),operationId:'network:https://db.test:8443',expiresAt:100};
assert.equal(validate({...lease,id:'lease-1'}),false);assert.equal(validate(lease),true);
const requests=[];
const client=new ClickHouseReadClient({request:async request=>{
 const validated=broker.validate(request);requests.push(validated);
 assert.deepEqual(validated.credentialLease,lease);assert.equal(broker.describeAuthorization(validated).operationId,lease.operationId);
 assert.deepEqual(validated.authorization,{scheme:'Basic',username:'reader'});
 assert.equal(Buffer.from(validated.body.data,'base64').toString('utf8'),request.body.data);
 return {url:request.url,status:200,headers:{},body:{encoding:'base64',data:Buffer.from(JSON.stringify({meta:[{name:'name',type:'String'}],data:[['notes']],rows:1})).toString('base64')}};
}},{endpoint:'https://db.test:8443/',declaredEndpoints:['https://db.test:8443/'],lease:async()=>({lease,username:'reader'})},()=>1);
await client.listTables('db');assert.equal(requests.length,1);assert.equal(fetched,false);
console.log(JSON.stringify({status:'PASS',scope:'Actual main SecretLeaseRef validator and networkBroker.validate/describeAuthorization, synthetic lease and response only; no lease issuance/consumption, network, TLS or ClickHouse acceptance.'},null,2));

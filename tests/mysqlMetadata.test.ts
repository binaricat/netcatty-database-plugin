import test from 'node:test';import assert from 'node:assert/strict';import type {PluginByteConnection} from '@netcatty/plugin-sdk';
import {createMysqlMetadataClient,type MysqlMetadataExecutor} from '../src/mysqlMetadata';import type {MysqlPreparedReadOptions} from '../src/mysqlPreparedRead';
function fixture(rows:(string|null)[][]){const calls:MysqlPreparedReadOptions[]=[];const execute:MysqlMetadataExecutor=async(_connection,options)=>{calls.push(options);return {columns:[...options.columns],rows,rowCount:rows.length,limit:options.limit!,scope:'limited-prepared-select'};};return {client:createMysqlMetadataClient({} as PluginByteConnection,execute),calls};}
test('metadata routes are fixed information_schema and names remain bound values',async()=>{
 const f=fixture([['netcatty_smoke','BASE TABLE','InnoDB']]);const result=await f.client.tables({schema:"x' OR 1=1--"});assert.equal(result.tables[0].kind,'table');assert.equal(result.possiblyTruncated,false);assert.equal(f.calls[0].schema,'information_schema');assert.equal(f.calls[0].table,'TABLES');assert.deepEqual(f.calls[0].where,[{column:'TABLE_SCHEMA',value:{kind:'text',value:"x' OR 1=1--"}}]);
});
test('columns preserve nullable/default/extra and sort only returned metadata by ordinal',async()=>{
 const f=fixture([['label','2','text','text','YES',null,''],['id','1','int','int','NO','0','auto_increment']]);const r=await f.client.columns({schema:'fixture',table:'notes'});assert.deepEqual(r.columns.map(c=>c.name),['id','label']);assert.equal(r.columns[1].defaultValue,null);assert.equal(r.columns[0].defaultValue,'0');assert.equal(f.calls[0].table,'COLUMNS');assert.equal(f.calls[0].where[1].column,'TABLE_NAME');
});
test('index parts preserve uniqueness/order/expression and explicitly flag full-limit uncertainty',async()=>{
 const f=fixture([['PRIMARY','0','1','id','A','BTREE',null],['functional','1','1',null,'D','BTREE','lower(`label`)']]);const r=await f.client.indexes({schema:'fixture',table:'notes',limit:2});assert.equal(r.possiblyTruncated,true);assert.equal(r.scope,'returned-metadata-only');assert.equal(r.parts[0].unique,true);assert.equal(r.parts[1].column,null);assert.equal(r.parts[1].direction,'DESC');assert.equal(r.parts[1].expression,'lower(`label`)');
});
test('missing scope, unknown flags, duplicate fields and unsupported row shapes fail closed',async()=>{
 await assert.rejects(fixture([]).client.columns({schema:'fixture'}),/input/);await assert.rejects(fixture([]).client.tables({schema:'fixture',table:'notes'}),/input/);
 await assert.rejects(fixture([['id','0','int','int','NO',null,'']]).client.columns({schema:'fixture',table:'notes'}),/response/);
 await assert.rejects(fixture([['idx','2','1','id','A','BTREE',null]]).client.indexes({schema:'fixture',table:'notes'}),/response/);
 await assert.rejects(fixture([['idx','0','1',null,'A','BTREE',null]]).client.indexes({schema:'fixture',table:'notes'}),/response/);
 await assert.rejects(fixture([['same','VIEW',null],['same','VIEW',null]]).client.tables({schema:'fixture'}),/response/);
});
test('metadata read errors are fixed and request budgets are not silently relaxed',async()=>{
 const c=createMysqlMetadataClient({} as PluginByteConnection,async()=>{throw new Error('private server credentials');});await assert.rejects(c.tables({schema:'fixture'}),{message:'MySQL metadata read'});
 const f=fixture([['one','BASE TABLE','InnoDB'],['two','BASE TABLE','InnoDB']]);await assert.rejects(f.client.tables({schema:'fixture',limit:1}),/response/);assert.equal(f.calls.length,1);
 await assert.rejects(f.client.tables({schema:'x\0y'}),/input/);await assert.rejects(f.client.tables({schema:'fixture',limit:101}),/input/);assert.equal(f.calls.length,1);
});

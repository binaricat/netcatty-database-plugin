import test from 'node:test';import assert from 'node:assert/strict';
import type {PluginByteConnection} from '@netcatty/plugin-sdk';
import {createPostgresMetadataTestReader,PostgresMetadataError} from '../src/postgresMetadata';
import type {PostgresFilteredReadOptions,PostgresFilteredReadResult} from '../src/postgresFilteredRead';
const connection={} as PluginByteConnection;
function fixture(rows:(string|null)[][],oids?:number[]){const calls:PostgresFilteredReadOptions[]=[];return {calls,reader:async(_c:PluginByteConnection,o:PostgresFilteredReadOptions):Promise<PostgresFilteredReadResult>=>{calls.push(o);return {columns:o.columns,typeOids:oids??o.columns.map((_,i)=>o.table==='columns'&&i===1?23:25),rows,rowCount:rows.length,limit:o.limit!,transactionStatus:'I',valueFormat:'postgres-text'};}};}
test('fixed metadata target and bound schema; extra row is an explicit truncation sentinel',async()=>{
 const f=fixture([['a','BASE TABLE'],['b','VIEW'],['c','FOREIGN']]);const page=await createPostgresMetadataTestReader(connection,f.reader).listTables('s";drop table x;--',{limit:2});
 assert.equal(page.truncated,true);assert.deepEqual(page.items.map(i=>i.name),['a','b']);assert.equal(page.continuation,null);assert.equal(page.ordering,'unspecified');
 assert.equal(f.calls[0].schema,'information_schema');assert.equal(f.calls[0].table,'tables');assert.equal(f.calls[0].limit,3);assert.deepEqual(f.calls[0].filters,[{column:'table_schema',value:'s";drop table x;--'}]);
});
test('columns preserve raw type identity and nullability without PK/default guesses',async()=>{
 const f=fixture([['label','2','YES','text','pg_catalog','text'],['id','1','NO','integer','pg_catalog','int4']]);const page=await createPostgresMetadataTestReader(connection,f.reader).listColumns('public','notes');
 assert.equal(page.truncated,false);assert.deepEqual(page.items[0],{name:'id',ordinal:1,nullable:false,dataType:'integer',udtSchema:'pg_catalog',udtName:'int4'});assert.equal(f.calls[0].limit,65);assert.deepEqual(f.calls[0].filters,[{column:'table_schema',value:'public'},{column:'table_name',value:'notes'}]);
});
test('empty and exact limit pages are not falsely marked truncated',async()=>{
 for(const rows of [[],[['a','BASE TABLE']]]){const f=fixture(rows);assert.equal((await createPostgresMetadataTestReader(connection,f.reader).listTables('public',{limit:1})).truncated,false);}
});
test('invalid inputs make no reader call',async()=>{
 const f=fixture([]),r=createPostgresMetadataTestReader(connection,f.reader);
 for(const limit of [0,99,1.2])await assert.rejects(r.listTables('public',{limit}),PostgresMetadataError);
 await assert.rejects(r.listColumns('public','\0'),PostgresMetadataError);assert.equal(f.calls.length,0);
});
test('unknown domain OIDs fail closed rather than extending the protocol allowlist',async()=>{
 const f=fixture([['a','BASE TABLE']],[123456,25]);await assert.rejects(createPostgresMetadataTestReader(connection,f.reader).listTables('public'),(e:unknown)=>e instanceof PostgresMetadataError&&e.code==='type');
});
test('malformed duplicate null oversized and unsupported metadata rejected',async()=>{
 for(const rows of [[['a','VIEW'],['a','VIEW']],[[null,'VIEW']],[['a','UNKNOWN']], [['a','VIEW'],['b','VIEW'],['c','VIEW']]]){const f=fixture(rows);await assert.rejects(createPostgresMetadataTestReader(connection,f.reader).listTables('public',{limit:1}));}
 for(const rows of [[['a','0','YES','text','pg_catalog','text']],[['a','1','MAYBE','text','pg_catalog','text']],[['a','1','YES','text','pg_catalog','text'],['b','1','NO','text','pg_catalog','text']]]){const f=fixture(rows);await assert.rejects(createPostgresMetadataTestReader(connection,f.reader).listColumns('public','t'));}
 const f=fixture(Array.from({length:65},(_,i)=>[`c${i}`,'1','YES','t'.repeat(2048),'s'.repeat(128),'n'.repeat(128)]));await assert.rejects(createPostgresMetadataTestReader(connection,f.reader).listColumns('public','t'),(e:unknown)=>e instanceof PostgresMetadataError&&e.code==='budget');
});
test('protocol failure is propagated without retry or invented metadata',async()=>{let calls=0;const expected=new Error('fixed protocol error');const reader=async()=>{calls++;throw expected;};await assert.rejects(createPostgresMetadataTestReader(connection,reader).listTables('public'),e=>e===expected);assert.equal(calls,1);});

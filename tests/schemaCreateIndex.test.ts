import test from 'node:test';
import assert from 'node:assert/strict';
import {previewCreateIndexSql} from '../src/schemaCreateIndex';
import type {DatabaseSchemaResult} from '../src/databaseTypes';
const schema=():DatabaseSchemaResult=>({tables:[{name:'Notes',kind:'table',columns:[{name:'Id',type:'INTEGER',primaryKey:true},{name:'body',type:'TEXT',primaryKey:false}],indexes:[]},{name:'view_notes',kind:'view',columns:[],indexes:[]}]});
const draft=()=>({name:'idx_notes',table:'notes',unique:false,columns:[{name:'id',direction:'ASC'},{name:'body',direction:'DESC'}]});
test('exact SQL, schema spelling normalization, detached allowlisted draft and explicit uniqueness',()=>{
 const input=draft(),actual=schema();const result=previewCreateIndexSql(input,actual);
 assert.equal(result.sql,'CREATE INDEX "idx_notes" ON "Notes" ("Id" ASC, "body" DESC);');
 assert.deepEqual(result.draft,{...input,table:'Notes',columns:[{name:'Id',direction:'ASC'},{name:'body',direction:'DESC'}]});
 result.draft.columns[0].name='changed';assert.equal(input.columns[0].name,'id');assert.equal(actual.tables[0].columns[0].name,'Id');
 assert.match(previewCreateIndexSql({...input,unique:true},actual).sql,/^CREATE UNIQUE INDEX /);
});
test('SQL-looking identifiers are quoted as single identifiers and never appended syntax',()=>{
 const name='a"; DROP TABLE Notes;--',actual=schema();actual.tables[0].name=name;actual.tables[0].columns[0].name=name;
 assert.equal(previewCreateIndexSql({name:`idx_${name}`,table:name,unique:false,columns:[{name,direction:'DESC'}]},actual).sql,'CREATE INDEX "idx_a""; DROP TABLE Notes;--" ON "a""; DROP TABLE Notes;--" ("a""; DROP TABLE Notes;--" DESC);');
});
test('rejects executable extensions, malformed types, implicit directions and column repetition',()=>{
 for(const input of [null,{...draft(),where:'1'},{...draft(),sql:'DROP TABLE Notes'},{...draft(),unique:1},{...draft(),columns:[]},{...draft(),columns:Array.from({length:33},()=>draft().columns[0])},{...draft(),columns:[{name:'Id'}]},{...draft(),columns:[{name:'Id',direction:'asc'}]},{...draft(),columns:[{name:'Id',direction:'ASC',expression:'random()'}]},{...draft(),columns:[{name:'Id',direction:'ASC'},{name:'ID',direction:'DESC'}]}])assert.throws(()=>previewCreateIndexSql(input,schema()));
});
test('rejects invalid names, absent columns/tables, views and reserved system identifiers',()=>{
 for(const name of ['', ' ', '\0', 'x'.repeat(129),'SQLITE_custom'])for(const field of ['name','table'])assert.throws(()=>previewCreateIndexSql({...draft(),[field]:name},schema()));
 for(const table of ['missing','view_notes'])assert.throws(()=>previewCreateIndexSql({...draft(),table},schema()),/table/);
 assert.throws(()=>previewCreateIndexSql({...draft(),columns:[{name:'missing',direction:'ASC'}]},schema()),/column/);
 assert.throws(()=>previewCreateIndexSql({...draft(),columns:[{name:'sqlite_hidden',direction:'ASC'}]},schema()),/identifier/);
});
test('global table/view/index namespaces and complete index metadata are checked',()=>{
 for(const name of ['NOTES','VIEW_NOTES'])assert.throws(()=>previewCreateIndexSql({...draft(),name},schema()),/exists/);
 const actual=schema();actual.tables[1].indexes=[{name:'IDX_NOTES',unique:false,origin:'c',partial:false,columns:[]}];assert.throws(()=>previewCreateIndexSql(draft(),actual),/exists/);
 delete actual.tables[1].indexes;assert.throws(()=>previewCreateIndexSql(draft(),actual),/schema/);
 const unknownKind=schema();delete unknownKind.tables[0].kind;assert.throws(()=>previewCreateIndexSql(draft(),unknownKind),/table/);
});
test('bounds metadata, index capacity and UTF-8 SQL bytes; preserves non-ASCII case distinctions',()=>{
 const actual=schema();actual.tables[0].indexes=Array.from({length:32},(_,i)=>({name:`idx_${i}`,unique:false,origin:'c',partial:false,columns:[]}));assert.throws(()=>previewCreateIndexSql(draft(),actual),/budget/);
 const large=schema();large.tables[0].columns=Array.from({length:32},(_,i)=>({name:`${i}`+'界'.repeat(120),type:'TEXT',primaryKey:false}));assert.throws(()=>previewCreateIndexSql({...draft(),columns:large.tables[0].columns.map(column=>({name:column.name,direction:'ASC'}))},large),/budget/);
 const unicode=schema();unicode.tables[0].columns=[{name:'Ä',type:'TEXT',primaryKey:false},{name:'ä',type:'TEXT',primaryKey:false}];assert.equal(previewCreateIndexSql({...draft(),columns:[{name:'Ä',direction:'ASC'},{name:'ä',direction:'DESC'}]},unicode).draft.columns.length,2);
 const many=schema();many.tables=Array.from({length:33},(_,i)=>({...schema().tables[0],name:`t${i}`}));assert.throws(()=>previewCreateIndexSql(draft(),many),/schema/);
});

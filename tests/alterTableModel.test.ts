import test from 'node:test';import assert from 'node:assert/strict';
import {previewAddColumnSql} from '../src/alterTableModel';
import type {DatabaseSchemaResult} from '../src/databaseTypes';
const schema=():DatabaseSchemaResult=>({tables:[{name:'Notes',kind:'table',definition:'CREATE TABLE "Notes" (id INTEGER)',columns:[{name:'id',type:'INTEGER',primaryKey:true}],triggers:[]}]});
const draft={table:'notes',name:'description',type:'TEXT'};
test('add-column preview is exact canonical table, nullable scalar only',()=>{
 assert.deepEqual(previewAddColumnSql(draft,schema()),{draft:{...draft,table:'Notes'},sql:'ALTER TABLE "Notes" ADD COLUMN "description" TEXT;'});
 for(const type of ['INTEGER','REAL','TEXT','BLOB','NUMERIC'])assert.ok(previewAddColumnSql({...draft,type},schema()).sql.endsWith(` ${type};`));
});
test('SQL-like identifiers are quoted; no expressions or constraint fields accepted',()=>{
 assert.equal(previewAddColumnSql({...draft,name:'x"; DROP TABLE Notes;--'},schema()).sql,'ALTER TABLE "Notes" ADD COLUMN "x""; DROP TABLE Notes;--" TEXT;');
 for(const extra of [{default:'CURRENT_TIMESTAMP'},{nullable:false},{primaryKey:true},{unique:true},{references:'other'},{type:'TEXT;DROP TABLE Notes'}])assert.throws(()=>previewAddColumnSql({...draft,...extra},schema()));
 for(const name of ['', ' ', 'x\0y','x'.repeat(129),'sqlite_internal'])assert.throws(()=>previewAddColumnSql({...draft,name},schema()));
});
test('requires complete non-virtual non-trigger table metadata',()=>{
 for(const change of [{kind:'view'},{definition:undefined},{definition:'CREATE VIRTUAL TABLE Notes USING fts5(id)'},{definition:'CREATE TABLE Notes (id INTEGER) STRICT'},{definition:'CREATE TABLE Notes (id INTEGER GENERATED ALWAYS AS (1))'},{triggers:undefined},{triggers:[{name:'t',definition:'CREATE TRIGGER t'}]}]){
 const s=schema();Object.assign(s.tables[0],change);assert.throws(()=>previewAddColumnSql(draft,s));
 }
 const s=schema();s.tables=[];assert.throws(()=>previewAddColumnSql(draft,s));
});
test('ASCII duplicate matching, column and schema budgets reject',()=>{
 assert.throws(()=>previewAddColumnSql({...draft,name:'ID'},schema()),{message:'Add column exists'});
 const s=schema();s.tables[0].columns=Array.from({length:64},(_,i)=>({name:'c'+i,type:'TEXT',primaryKey:false}));assert.throws(()=>previewAddColumnSql(draft,s),{message:'Add column budget'});
 const duplicate=schema();duplicate.tables.push({...duplicate.tables[0],name:'NOTES'});assert.throws(()=>previewAddColumnSql(draft,duplicate),{message:'Add column schema'});
 const unicode=schema();unicode.tables[0].columns[0].name='Ä';assert.doesNotThrow(()=>previewAddColumnSql({...draft,name:'ä'},unicode));
});

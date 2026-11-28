import test from 'node:test';
import assert from 'node:assert/strict';
import {previewRenameColumnSql} from '../src/schemaRenameColumn';
import type {DatabaseSchemaResult} from '../src/databaseTypes';
const schema=():DatabaseSchemaResult=>({tables:[{name:'notes',kind:'table',definition:'CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL)',columns:[{name:'id',type:'INTEGER',primaryKey:true,nullable:false},{name:'title',type:'TEXT',primaryKey:false,nullable:false}],indexes:[],foreignKeys:[],triggers:[]}]});
const draft=()=>({table:'NOTES',from:'TITLE',to:'new_title'});
test('canonical quoted SQL with detached draft and explicit unverified dependency state',()=>{
 const d=draft(),r=previewRenameColumnSql(d,schema());assert.equal(r.sql,'ALTER TABLE "notes" RENAME COLUMN "title" TO "new_title";');assert.deepEqual(r.draft,{table:'notes',from:'title',to:'new_title'});assert.equal(r.dependencyValidation,'adapter-required');r.draft.to='other';assert.equal(d.to,'new_title');
 const evil=previewRenameColumnSql({...d,to:'new"; DROP TABLE notes;--'},schema());assert.equal(evil.sql,'ALTER TABLE "notes" RENAME COLUMN "title" TO "new""; DROP TABLE notes;--";');
});
test('unrelated views/triggers are not globally forbidden, but preview is not safe-to-apply proof',()=>{
 const s=schema();s.tables.push({name:'v',kind:'view',definition:'CREATE VIEW v AS SELECT title FROM notes',columns:[],foreignKeys:[],triggers:[]});
 assert.equal(previewRenameColumnSql(draft(),s).dependencyValidation,'adapter-required');
 s.tables.push({...schema().tables[0],name:'other',triggers:[{name:'trigger_other',definition:'CREATE TRIGGER trigger_other AFTER INSERT ON other BEGIN SELECT title FROM notes; END'}]});assert.doesNotThrow(()=>previewRenameColumnSql(draft(),s));
});
test('target indexes/triggers/FK, inbound FK and PK renames refuse; missing metadata fails closed',()=>{
 for(const field of ['indexes','foreignKeys','triggers'] as const){const s=schema();delete s.tables[0][field];assert.throws(()=>previewRenameColumnSql(draft(),s),/schema/);}
 for(const field of ['indexes','foreignKeys','triggers'] as const){const s=schema();(s.tables[0][field] as unknown[])!.push({});assert.throws(()=>previewRenameColumnSql(draft(),s),/dependency/);}
 const inbound=schema();inbound.tables.push({...schema().tables[0],name:'other',foreignKeys:[{id:0,targetTable:'NOTES',columns:[],onDelete:'NO ACTION',onUpdate:'NO ACTION',match:'NONE'}]});assert.throws(()=>previewRenameColumnSql(draft(),inbound),/dependency/);
 assert.throws(()=>previewRenameColumnSql({...draft(),from:'id'},schema()),/dependency/);
});
test('nonordinary DDL and expression/constraint variants refuse without substring false positives',()=>{
 for(const definition of ['CREATE VIRTUAL TABLE notes USING fts5(title)','CREATE TABLE notes(id INTEGER PRIMARY KEY,title TEXT CHECK(length(title)>0))','CREATE TABLE notes(id INTEGER PRIMARY KEY,title TEXT GENERATED ALWAYS AS (id))','CREATE TABLE notes(id INTEGER PRIMARY KEY,title TEXT DEFAULT (random()))','CREATE TABLE notes(id INTEGER PRIMARY KEY,title TEXT UNIQUE)','CREATE TABLE notes(id INTEGER PRIMARY KEY,title TEXT);DROP TABLE notes','CREATE TABLE notes(id INTEGER PRIMARY KEY,title TEXT /* comment */ NOT NULL)']){const s=schema();s.tables[0].definition=definition;assert.throws(()=>previewRenameColumnSql(draft(),s),/definition/);}
 const s=schema();s.tables[0].columns[1].name='CHECK';s.tables[0].definition='CREATE TABLE "notes" ("id" INTEGER PRIMARY KEY, "CHECK" TEXT NOT NULL)';assert.doesNotThrow(()=>previewRenameColumnSql({...draft(),from:'CHECK'},s));
});
test('identifiers, unknown fields, collision, case-only rename and forged metadata reject',()=>{
 for(const to of ['', ' ', '\0', 'x'.repeat(129),'sqlite_hidden','TITLE','ID'])assert.throws(()=>previewRenameColumnSql({...draft(),to},schema()));
 for(const d of [{...draft(),sql:'DROP'},{...draft(),from:'missing'},{...draft(),table:'missing'}])assert.throws(()=>previewRenameColumnSql(d,schema()));
 const s=schema();s.tables[0].columns[1].nullable=true;assert.throws(()=>previewRenameColumnSql(draft(),s),/definition/);
 const v=schema();v.tables[0].kind='view';assert.throws(()=>previewRenameColumnSql(draft(),v),/table/);
});

test('bounded schema and tokenizer reject excess objects, columns or DDL bytes',()=>{
 const many=schema();many.tables=Array.from({length:33},()=>schema().tables[0]);assert.throws(()=>previewRenameColumnSql(draft(),many),/schema/);
 const wide=schema();wide.tables[0].columns=Array.from({length:65},(_,i)=>({...schema().tables[0].columns[1],name:`c${i}`}));assert.throws(()=>previewRenameColumnSql(draft(),wide),/schema/);
 const large=schema();large.tables[0].definition=' '.repeat(8193)+large.tables[0].definition;assert.throws(()=>previewRenameColumnSql(draft(),large),/budget/);
});

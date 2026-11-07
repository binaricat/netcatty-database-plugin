import test from 'node:test';
import assert from 'node:assert/strict';
import {previewCsvImport} from '../src/csvImportModel';
import type {DatabaseSchemaResult} from '../src/databaseTypes';
const schema=():DatabaseSchemaResult=>({tables:[{name:'Notes',kind:'table',triggers:[],columns:[{name:'id',type:'INTEGER',primaryKey:true,nullable:false},{name:'text',type:'TEXT',primaryKey:false,nullable:true}]}]});
const plan=(csv:string,s=schema())=>previewCsvImport({table:'notes',csv,nullMode:'backslash-N'},s);
test('RFC4180 quotes, embedded CRLF, Chinese, reordered headers and bound SQL injection text',()=>{
 const result=plan('TEXT,ID\r\n"你好, ""quoted""\r\nline",1\r\n"\'); DROP TABLE Notes;--",2\r\n');
 assert.equal(result.sql,'INSERT INTO "Notes" ("id", "text") VALUES (?, ?);');assert.deepEqual(result.rows,[[1,'你好, "quoted"\r\nline'],[2,"'); DROP TABLE Notes;--"]]);assert.equal(result.rowCount,2);
});
test('only explicit unquoted backslash-N is NULL; empty fields and quoted marker remain strings',()=>{
 assert.deepEqual(plan('id,text\n1,\\N\n2,"\\N"\n3,\n4,""').rows,[[1,null],[2,'\\N'],[3,''],[4,'']]);
 assert.throws(()=>plan('id,text\n\\N,a'),/value/);const s=schema();s.tables[0].columns[1].nullable=false;assert.throws(()=>plan('id,text\n1,\\N',s),/value/);
});
test('malformed quote grammar and inconsistent rows reject atomically',()=>{
 for(const csv of ['','id,text','id,text\n1,"unfinished','id,text\n1,a"b','id,text\n1,"a"junk','id,text\r1,a','id,text\n1,a,','id,text\n1','id,text\n1,a\n','id,text\n1,a\n\n']){
   if(csv==='id,text\n1,a\n')assert.equal(plan(csv).rowCount,1);else assert.throws(()=>plan(csv));
 }
});
test('requires complete unique known headers, plain table and known non-BLOB column metadata',()=>{
 for(const csv of ['id,id\n1,2','id,unknown\n1,x','text\nx'])assert.throws(()=>plan(csv),/columns/);
 for(const type of ['BLOB','','BOOLEAN']){const s=schema();s.tables[0].columns[1].type=type;assert.throws(()=>plan('id,text\n1,x',s),/columns/);}
 const s=schema();s.tables[0].kind='view';assert.throws(()=>plan('id,text\n1,x',s),/table/);
 const missing=schema();delete missing.tables[0].columns[1].nullable;assert.throws(()=>plan('id,text\n1,x',missing),/columns/);
 assert.throws(()=>plan('id,text\n1,<BLOB 12 bytes>'),/value/);
 assert.throws(()=>previewCsvImport({table:'notes',csv:'id,text\n1,x'},schema()),/input/);
});
test('safe numeric conversion, overflow, unsafe integers and expressions refuse',()=>{
 for(const value of ['9007199254740993','1.5','NaN','1e2','',"1); DROP TABLE Notes;--"])assert.throws(()=>plan(`id,text\n${value},x`),/value/);
 const s=schema();s.tables[0].columns[1].type='REAL';assert.deepEqual(plan('id,text\n1,1.25e2',s).rows,[[1,125]]);
 for(const value of ['1e999','1e-999','Infinity','random()'])assert.throws(()=>plan(`id,text\n1,${value}`,s),/value/);
});
test('hard row, column, cell and UTF-8 input budgets never silently truncate',()=>{
 assert.equal(plan('id,text\n'+Array.from({length:100},(_,i)=>`${i},x`).join('\n')).rowCount,100);
 assert.throws(()=>plan('id,text\n'+Array.from({length:101},(_,i)=>`${i},x`).join('\n')),/budget/);
 assert.throws(()=>plan('id,text\n1,'+'x'.repeat(2049)),/budget/);
 assert.throws(()=>plan('id,text\n'+Array.from({length:30},(_,i)=>`${i},`+'界'.repeat(1000)).join('\n')),/budget/);
 assert.throws(()=>plan(Array.from({length:17},(_,i)=>`c${i}`).join(',')+'\n'+Array(17).fill('x').join(',')),/budget/);
});

test('rejects triggers, virtual/generated/default-expression tables conservatively',()=>{
 for(const triggers of [undefined,[{name:'audit',definition:'CREATE TRIGGER audit'}]]){const s=schema();s.tables[0].triggers=triggers;assert.throws(()=>plan('id,text\n1,x',s),/table/);}
 for(const definition of ['CREATE VIRTUAL TABLE Notes USING fts5(text)','CREATE TABLE Notes(id INTEGER, text TEXT DEFAULT (random()))','CREATE TABLE Notes(id INTEGER, text TEXT GENERATED ALWAYS AS (id))']){const s=schema();s.tables[0].definition=definition;assert.throws(()=>plan('id,text\n1,x',s),/table/);}
});

test('schema conflict policies refuse implicit replacement/deletion or silent skip',()=>{
 for(const policy of ['REPLACE','IGNORE','ABORT','FAIL','ROLLBACK'])for(const gap of [' ', ' /* comment */ ', '\n']){
   const s=schema();s.tables[0].definition=`CREATE TABLE Notes(id INTEGER PRIMARY KEY ON${gap}CONFLICT ${policy}, text TEXT)`;
   assert.throws(()=>plan('id,text\n1,x',s),/table/);
 }
});
test('parser terminal commas, quote escaping and empty trailing records stay unambiguous',()=>{
 assert.deepEqual(plan('id,text\n1,').rows,[[1,'']]);
 assert.deepEqual(plan('id,text\r\n1,""\r\n').rows,[[1,'']]);
 assert.deepEqual(plan('id,text\n1,""""').rows,[[1,'"']]);
 assert.deepEqual(plan('id,text\n1,"a\rb"').rows,[[1,'a\rb']]);
 for(const csv of ['id,text\n1,"x" ', 'id,text\n1,"x"\r', 'id,text\n1,x\r\n\r\n', 'id,text\n1,x,', '\ufeffid,text\n1,x', 'id,text\n1,\0'])assert.throws(()=>plan(csv));
});

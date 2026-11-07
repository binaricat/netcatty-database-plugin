import test from 'node:test';
import assert from 'node:assert/strict';
import {previewGridMutation} from '../src/gridMutation';
import type {DatabaseSchemaResult} from '../src/databaseTypes';
const schema=():DatabaseSchemaResult=>({tables:[{name:'Notes',kind:'table',triggers:[],foreignKeys:[],columns:[{name:'id',type:'INTEGER',primaryKey:true,nullable:false},{name:'body',type:'TEXT',primaryKey:false,nullable:true},{name:'flag',type:'INTEGER',primaryKey:false,nullable:false}]}]});
const draft=()=>({kind:'update',table:'notes',original:{id:1,body:null,flag:false},changes:{body:'你好\nSQL\' ?'}});
test('update binds changes then all original columns with BINARY collation; delete includes nullable predicates',()=>{
 const input=draft(),result=previewGridMutation(input,schema());
 assert.equal(result.sql,'UPDATE "Notes" SET "body" = ? WHERE "id" COLLATE BINARY IS ? AND "body" COLLATE BINARY IS ? AND "flag" COLLATE BINARY IS ?;');
 assert.deepEqual(result.parameters,['你好\nSQL\' ?',1,null,false]);assert.equal(result.draft.table,'Notes');
 result.draft.original.id=7;result.draft.changes!.body='other';assert.equal(input.original.id,1);assert.equal(input.changes.body,'你好\nSQL\' ?');
 const deleted=previewGridMutation({kind:'delete',table:'Notes',original:input.original},schema());assert.match(deleted.sql,/^DELETE FROM "Notes" WHERE/);assert.deepEqual(deleted.parameters,[1,null,false]);assert.equal(Object.hasOwn(deleted.draft,'changes'),false);
});
test('requires exact complete rows, safe metadata, primary keys, and non-null original PK',()=>{
 for(const original of [{id:1,body:null},{id:1,body:null,flag:false,extra:1},{Id:1,body:null,flag:false}])assert.throws(()=>previewGridMutation({...draft(),original},schema()),/columns/);
 assert.throws(()=>previewGridMutation({...draft(),original:{...draft().original,id:null}},schema()),/primary-key/);
 for(const mutate of [(s:DatabaseSchemaResult)=>{s.tables[0].kind='view';},(s:DatabaseSchemaResult)=>{delete s.tables[0].kind;},(s:DatabaseSchemaResult)=>{s.tables[0].columns[0].primaryKey=false;},(s:DatabaseSchemaResult)=>{delete s.tables[0].columns[1].nullable;},(s:DatabaseSchemaResult)=>{s.tables[0].columns[1].type='BLOB';},(s:DatabaseSchemaResult)=>{s.tables[0].definition='CREATE VIRTUAL TABLE Notes USING fts5(body)';}]){const s=schema();mutate(s);assert.throws(()=>previewGridMutation(draft(),s));}
 assert.throws(()=>previewGridMutation({...draft(),changes:{id:2}},schema()),/primary-key/);
});
test('rejects malformed drafts, extra syntax, unchanged or unknown updates and invalid values',()=>{
 for(const input of [null,{...draft(),where:'1'},{...draft(),kind:'insert'},{...draft(),changes:{}},{...draft(),changes:{body:null}},{...draft(),changes:{BODY:'x'}},{...draft(),changes:{flag:null}},{...draft(),kind:'delete'},{...draft(),original:[]},{...draft(),table:'sqlite_master'}])assert.throws(()=>previewGridMutation(input,schema()));
 for(const value of [NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'x'.repeat(2049),'<BLOB 12 bytes>',new Uint8Array([1]),{},undefined]){
 assert.throws(()=>previewGridMutation({...draft(),changes:{body:value}},schema()),/value/);
 assert.throws(()=>previewGridMutation({...draft(),original:{...draft().original,body:value}},schema()),/value/);
 }
});
test('quoted identifiers and prototype-looking keys stay data; compound keys are all required',()=>{
 const s=schema(),name='x"; DROP TABLE Notes;--';s.tables[0].name=name;s.tables[0].columns[1].name='__proto__';s.tables[0].columns[2].primaryKey=true;
 const original=JSON.parse('{"id":1,"__proto__":null,"flag":false}'),changes=JSON.parse('{"__proto__":"value"}');
 const result=previewGridMutation({kind:'update',table:name,original,changes},s);
 assert.match(result.sql,/UPDATE "x""; DROP TABLE Notes;--" SET "__proto__" = \?/);assert.equal(Object.hasOwn(result.draft.changes!,'__proto__'),true);assert.deepEqual(result.parameters,['value',1,null,false]);
 assert.throws(()=>previewGridMutation({kind:'update',table:name,original,changes:{flag:true}},s),/primary-key/);
});
test('bounds columns and UTF-8 SQL; duplicate schema columns refuse',()=>{
 const many=schema();many.tables[0].columns=Array.from({length:17},(_,i)=>({name:`c${i}`,type:'TEXT',primaryKey:i===0,nullable:false}));assert.throws(()=>previewGridMutation(draft(),many),/columns/);
 const duplicated=schema();duplicated.tables[0].columns[1].name='ID';assert.throws(()=>previewGridMutation(draft(),duplicated),/columns/);
 const big=schema();big.tables[0].columns=Array.from({length:16},(_,i)=>({name:`${i}`+'界'.repeat(120),type:'TEXT',primaryKey:i===0,nullable:false}));const original=Object.fromEntries(big.tables[0].columns.map(c=>[c.name,'a']));const changes=Object.fromEntries(big.tables[0].columns.slice(1).map(c=>[c.name,'b']));assert.throws(()=>previewGridMutation({kind:'update',table:'Notes',original,changes},big),/budget/);
});

test('refuses unknown or active triggers and unsafe inbound delete actions including self references',()=>{
 for(const triggers of [undefined,[{name:'audit',definition:'CREATE TRIGGER audit'}]]){const s=schema();s.tables[0].triggers=triggers;assert.throws(()=>previewGridMutation(draft(),s),/table/);}
 const deletion={kind:'delete',table:'Notes',original:draft().original};
 for(const action of ['CASCADE','SET NULL','SET DEFAULT','unknown']){const s=schema();s.tables[0].foreignKeys=[{id:0,targetTable:'NOTES',columns:[{from:'body',to:'id'}],onDelete:action,onUpdate:'NO ACTION',match:'NONE'}];assert.throws(()=>previewGridMutation(deletion,s),/table/);}
 const unknown=schema();delete unknown.tables[0].foreignKeys;assert.throws(()=>previewGridMutation(deletion,unknown),/table/);
 for(const action of ['NO ACTION','RESTRICT']){const s=schema();s.tables[0].foreignKeys=[{id:0,targetTable:'Notes',columns:[{from:'body',to:'id'}],onDelete:action,onUpdate:'NO ACTION',match:'NONE'}];assert.match(previewGridMutation(deletion,s).sql,/^DELETE/);}
});

test('NOCASE column predicates override declared collation with BINARY',()=>{
 const s=schema();s.tables[0].definition='CREATE TABLE Notes(id INTEGER PRIMARY KEY, body TEXT COLLATE NOCASE, flag INTEGER NOT NULL)';
 const result=previewGridMutation({...draft(),original:{id:1,body:'Case',flag:false},changes:{body:'case'}},s);
 assert.equal(result.sql,'UPDATE "Notes" SET "body" = ? WHERE "id" COLLATE BINARY IS ? AND "body" COLLATE BINARY IS ? AND "flag" COLLATE BINARY IS ?;');
 assert.deepEqual(result.parameters,['case',1,'Case',false]);
});
test('UPDATE refuses inbound and self cascade on changed non-PK referenced columns; safe untouched references pass',()=>{
 for(const self of [true,false])for(const action of ['CASCADE','SET NULL','SET DEFAULT']){
   const s=schema();const target=self?s.tables[0]:{...schema().tables[0],name:'child'};if(!self)s.tables.push(target);
   target.foreignKeys=[{id:0,targetTable:'NOTES',columns:[{from:'body',to:'BODY'}],onDelete:'NO ACTION',onUpdate:action,match:'NONE'}];
   assert.throws(()=>previewGridMutation(draft(),s),/table/);
   assert.doesNotThrow(()=>previewGridMutation({...draft(),changes:{flag:true}},s));
   target.foreignKeys[0].onUpdate='RESTRICT';assert.doesNotThrow(()=>previewGridMutation(draft(),s));
   target.foreignKeys[0].columns[0].to=null;assert.throws(()=>previewGridMutation(draft(),s),/table/);
 }
 const unknown=schema();delete unknown.tables[0].foreignKeys;assert.throws(()=>previewGridMutation(draft(),unknown),/table/);
 const cascade=schema();cascade.tables.push({...schema().tables[0],name:'child',foreignKeys:[{id:0,targetTable:'Notes',columns:[{from:'body',to:'id'}],onDelete:'CASCADE',onUpdate:'NO ACTION',match:'NONE'}]});
 assert.throws(()=>previewGridMutation({kind:'delete',table:'Notes',original:draft().original},cascade),/table/);
});

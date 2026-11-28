import test from 'node:test';import assert from 'node:assert/strict';
import {addColumnController,addColumnErrorText} from '../src/AddColumn';
import {previewAddColumnSql} from '../src/alterTableModel';
import type {AddColumnReview,DatabaseSchemaResult} from '../src/databaseTypes';
const schema:DatabaseSchemaResult={tables:[{name:'notes',kind:'table',definition:'CREATE TABLE notes(id INTEGER)',columns:[{name:'id',type:'INTEGER',primaryKey:false}],triggers:[]}]};
function fixture(){let applied=0,refreshed=0;const database={previewAddColumn:async({handleId,draft}: {handleId:string;draft:{table:string;name:string;type:'TEXT'}})=>({handleId,...previewAddColumnSql(draft,schema),schemaRevision:1}),applyAddColumn:async()=>{applied++;return {schema,sql:'',changes:0 as const};}};const c=addColumnController(database as Parameters<typeof addColumnController>[0],'h',schema,()=>{refreshed++;});return {c,database,get applied(){return applied;},get refreshed(){return refreshed;}};}
test('explicit preview and confirm only; successful schema refresh once; cannot apply twice',async()=>{
 const f=fixture();f.c.edit({name:'extra'});await f.c.confirm();assert.equal(f.applied,0);await f.c.preview();assert.equal(f.applied,0);assert.match(f.c.getSnapshot().review!.sql,/ADD COLUMN/);await f.c.confirm();await f.c.confirm();assert.equal(f.applied,1);assert.equal(f.refreshed,1);assert.equal(f.c.getSnapshot().done,true);
});
test('editing or cancelling invalidates review and late preview; disposal cannot restore it',async()=>{
 for(const action of ['edit','cancel','dispose']){
 const f=fixture();f.c.edit({name:'extra'});let resolve!:(r:AddColumnReview)=>void;f.database.previewAddColumn=()=>new Promise(r=>resolve=r);const pending=f.c.preview();await Promise.resolve();const review={handleId:'h',...previewAddColumnSql(f.c.getSnapshot().draft,schema),schemaRevision:1};
 if(action==='edit')f.c.edit({name:'different'});else if(action==='cancel')f.c.cancel();else f.c.dispose();resolve(review);await pending;assert.equal(f.c.getSnapshot().review,null);await f.c.confirm();assert.equal(f.applied,0);
 }
});
test('applying locks edits/cancel/reentry; apply error requires a fresh preview',async()=>{
 const f=fixture();f.c.edit({name:'extra'});await f.c.preview();let reject!:(e:Error)=>void;f.database.applyAddColumn=()=>new Promise((_,r)=>reject=r);const pending=f.c.confirm();assert.equal(f.c.cancel(),false);f.c.edit({name:'different'});assert.equal(f.c.getSnapshot().draft.name,'extra');await f.c.confirm();reject(new Error('private engine text'));await pending;assert.equal(f.c.getSnapshot().review,null);assert.equal(f.c.getSnapshot().notice,'failed');
});
test('mismatched handle or draft rejected before confirmation',async()=>{
 const f=fixture();f.c.edit({name:'extra'});f.database.previewAddColumn=async()=>({handleId:'other',...previewAddColumnSql(f.c.getSnapshot().draft,schema),schemaRevision:1});await f.c.preview();assert.equal(f.c.getSnapshot().review,null);assert.equal(f.c.getSnapshot().notice,'review');await f.c.confirm();assert.equal(f.applied,0);
});

test('edit/cancel keeps preview locked until completion, and reopen serializes backend requests',async()=>{
 for(const cancel of [false,true]){
 const f=fixture();let calls=0,resolve!:(r:AddColumnReview)=>void;
 f.database.previewAddColumn=async()=>{calls++;return new Promise(r=>resolve=r);};
 f.c.edit({name:'old'});const pending=f.c.preview();await Promise.resolve();
 const review={handleId:'h',...previewAddColumnSql(f.c.getSnapshot().draft,schema),schemaRevision:1};
 if(cancel)f.c.cancel();else f.c.edit({name:'new'});
 assert.equal(f.c.getSnapshot().busy,'preview');await f.c.preview();assert.equal(calls,1);
 f.c.dispose();const reopened=addColumnController(f.database as Parameters<typeof addColumnController>[0],'h',schema,()=>{});reopened.edit({name:'reopened'});const next=reopened.preview();await Promise.resolve();assert.equal(calls,1);
 resolve(review);await pending;await Promise.resolve();assert.equal(calls,2);
 resolve({handleId:'h',...previewAddColumnSql(reopened.getSnapshot().draft,schema),schemaRevision:1});await next;
 assert.equal(reopened.getSnapshot().review?.draft.name,'reopened');assert.equal(reopened.getSnapshot().busy,'idle');
 }
});
test('error explanations give specific bilingual remediation rather than generic retry',()=>{
 assert.match(addColumnErrorText('table',false),/triggers.*STRICT.*shadow/);assert.match(addColumnErrorText('table',true),/触发器/);
 assert.match(addColumnErrorText('exists',false),/different column name/);assert.match(addColumnErrorText('exists',true),/更换列名/);
 assert.match(addColumnErrorText('budget',false),/64 columns.*1 MiB/);assert.match(addColumnErrorText('schema',true),/刷新/);
});
